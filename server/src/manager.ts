import fs from 'node:fs'
import path from 'node:path'
import {config} from './config.js'
import {q, type Project} from './db.js'
import * as tmux from './tmux.js'
import {
  authStatus, claudeVersion, conversationTitle, parseServerScreen, scanSessions, sinceLastStart, START_MARK, type Account,
} from './claude.js'

// Estados que ve el usuario (los mismos nombres que el plan).
export type State = 'detenida' | 'iniciando' | 'disponible' | 'trabajando' | 'esperando' | 'recuperando' | 'atencion'

type Runtime = {
  state: State
  detail: string
  prompt: string | null
  capacity: {used: number; max: number} | null
  startedAt: number
  exitHandled: boolean
  backoff: number
  nextStartAt: number
  stopSentAt: number
  rescuing: boolean
  autoAnswered: Set<string>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const serverWindow = (name: string) => `p-${name}`
const rescueWindow = (name: string) => `r-${name}`
const MIN_BACKOFF = 15_000
const MAX_BACKOFF = 300_000

export class Manager {
  account: Account = {loggedIn: false}
  claudeVersion = '?'
  crash: {at: string; pending: number} | null = null
  stopping = false
  private rt = new Map<string, Runtime>()
  private lastAuth = 0
  private ticking = false
  private pendingRescue = new Set<string>()

  runtime(name: string): Runtime {
    let r = this.rt.get(name)
    if (!r) {
      r = {state: 'detenida', detail: '', prompt: null, capacity: null, startedAt: 0, exitHandled: true,
        backoff: 0, nextStartAt: 0, stopSentAt: 0, rescuing: false, autoAnswered: new Set()}
      this.rt.set(name, r)
    }
    return r
  }

  get autoRescue() {
    return (q.meta('autoRescue') ?? '1') === '1'
  }

  async boot() {
    fs.mkdirSync(config.claudeConfigDir, {recursive: true})
    for (const root of config.projectRoots) {
      if (root.startsWith(config.dataDir)) fs.mkdirSync(root, {recursive: true})
    }
    const settings = path.join(config.claudeConfigDir, 'settings.json')
    if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({cleanupPeriodDays: 3650}, null, 2))

    // Apagado inesperado: la última vez no llegó a guardar la marca de parada limpia.
    if (q.meta('running') === '1') {
      const orphans = q.conversations().filter((c) => c.active === 1)
      q.markOrphans()
      const at = q.meta('lastTick') ?? new Date().toISOString()
      q.setMeta('crashAt', at)
      q.event('sistema', 'error', `Apagado inesperado. ${orphans.length} conversación(es) estaban abiertas y hay que rescatarlas.`)
      for (const c of orphans) this.pendingRescue.add(c.project)
    }
    q.setMeta('running', '1')
    q.event('sistema', 'info', `Gestor arrancado (versión ${config.version})`)
    this.claudeVersion = await claudeVersion()
    await tmux.ensureSession()
    await this.checkAuth(true)
    setInterval(() => this.tick().catch((e) => console.error('tick', e)), 2500)
    this.tick().catch(() => {})
  }

  async checkAuth(force = false) {
    if (!force && Date.now() - this.lastAuth < 15_000) return
    this.lastAuth = Date.now()
    const before = this.account.loggedIn
    this.account = await authStatus()
    if (!before && this.account.loggedIn) {
      q.event('cuenta', 'ok', `Sesión iniciada (${this.account.email ?? 'cuenta de claude.ai'})`)
      // Lo que esperaba al login arranca ya, sin esperar a su próximo reintento.
      for (const r of this.rt.values()) {
        r.nextStartAt = 0
        r.backoff = 0
      }
    }
  }

  orphanCount() {
    return q.conversations().filter((c) => c.orphan === 1).length
  }

  private projectForCwd(cwd: string, projects: Project[]) {
    return projects.find((p) => cwd === p.dir || cwd.startsWith(p.dir + '/') || cwd.startsWith(p.dir + '/.claude/worktrees/'))
  }

  private syncConversations(projects: Project[]) {
    const live: string[] = []
    for (const s of scanSessions()) {
      const p = this.projectForCwd(s.cwd, projects)
      if (!p) continue
      if (s.alive) live.push(s.remoteId)
      const prev = q.conversation(s.remoteId)
      // Un registro muerto no debe pisar el estado de uno vivo más reciente.
      if (!s.alive && prev && prev.last_activity > s.updatedAt) continue
      q.upsertConversation({
        remote_id: s.remoteId, local_id: s.localId, project: p.name,
        title: conversationTitle(s.cwd, s.localId), status: s.status,
        active: s.alive ? 1 : 0, last_activity: s.updatedAt,
      })
      if (s.alive && prev?.orphan === 1) {
        q.setOrphan(s.remoteId, 0)
        q.event(p.name, 'ok', `«${prev.title || s.remoteId}» vuelve a estar activa`)
      }
    }
    q.setInactiveExcept(live)
  }

  async tick() {
    if (this.ticking || this.stopping) return
    this.ticking = true
    try {
      q.setMeta('lastTick', new Date().toISOString())
      await this.checkAuth()
      const projects = q.projects()
      this.syncConversations(projects)
      const crashAt = q.meta('crashAt')
      const pending = this.orphanCount()
      this.crash = crashAt && pending > 0 ? {at: crashAt, pending} : null

      // Rescates pendientes tras un apagado (necesitan la sesión iniciada).
      if (this.account.loggedIn && this.autoRescue && this.pendingRescue.size) {
        for (const name of [...this.pendingRescue]) {
          this.pendingRescue.delete(name)
          const ids = q.conversations().filter((c) => c.project === name && c.orphan === 1).map((c) => c.remote_id)
          if (ids.length) this.rescue(name, ids).catch((e) => console.error('rescue', e))
        }
      }

      const panes = await tmux.panes()
      for (const p of projects) await this.superviseProject(p, panes)
    } finally {
      this.ticking = false
    }
  }

  private async superviseProject(p: Project, panes: Map<string, tmux.Pane>) {
    const r = this.runtime(p.name)
    // Con conversaciones por rescatar, el servidor no arranca hasta que acabe el rescate:
    // así nunca hay dos procesos de Claude en la misma carpeta.
    if (r.rescuing || (this.pendingRescue.has(p.name) && this.autoRescue)) {
      r.state = 'recuperando'
      r.detail = this.account.loggedIn ? 'Rescatando conversaciones' : 'Esperando al inicio de sesión para rescatar'
      return
    }
    const w = serverWindow(p.name)
    const pane = panes.get(w)
    const alive = pane && !pane.dead
    const now = Date.now()

    if (p.desired === 'stopped') {
      r.prompt = null
      r.capacity = null
      if (alive) {
        if (!r.stopSentAt) {
          r.stopSentAt = now
          await tmux.sendKeys(w, 'C-c')
        } else if (now - r.stopSentAt > 25_000) {
          await tmux.killWindow(w)
        }
        r.state = 'iniciando'
        r.detail = 'Parando…'
      } else {
        r.state = 'detenida'
        r.detail = 'Parado'
        r.stopSentAt = 0
        r.exitHandled = true
      }
      return
    }
    r.stopSentAt = 0

    if (!fs.existsSync(p.dir)) {
      r.state = 'atencion'
      r.detail = `La carpeta ${p.dir} no existe o no está montada`
      r.prompt = null
      return
    }

    if (!alive) {
      const screen = pane ? sinceLastStart(await tmux.capture(w, 80)) : ''
      const parsed = parseServerScreen(screen)
      if (pane && !r.exitHandled) {
        r.exitHandled = true
        const ran = now - r.startedAt
        r.backoff = ran > 600_000 ? MIN_BACKOFF : Math.min(MAX_BACKOFF, Math.max(MIN_BACKOFF, r.backoff * 2))
        r.nextStartAt = now + r.backoff
        q.event(p.name, parsed.needsLogin ? 'warn' : 'warn',
          parsed.needsLogin ? 'El servidor necesita que inicies sesión' : `El servidor se ha cerrado (código ${pane.status ?? '?'}); reintento en ${Math.round(r.backoff / 1000)} s`)
      }
      if (now >= r.nextStartAt && (this.account.loggedIn || !parsed.needsLogin || now - r.startedAt > MAX_BACKOFF)) {
        await this.startServer(p)
        r.state = 'iniciando'
        r.detail = 'Arrancando el servidor'
        return
      }
      r.capacity = null
      if (parsed.needsLogin || !this.account.loggedIn) {
        r.state = 'atencion'
        r.detail = 'Inicia sesión con tu cuenta de Claude (pestaña Cuenta)'
      } else {
        r.state = 'iniciando'
        r.detail = `Reintento en ${Math.max(0, Math.round((r.nextStartAt - now) / 1000))} s`
      }
      return
    }

    const parsed = parseServerScreen(await tmux.capture(w, 120))
    r.capacity = parsed.capacity
    if (parsed.prompt) {
      // La confianza en la carpeta ya la dio el usuario al añadir el proyecto.
      if (/^Trust /.test(parsed.prompt) && p.trust && !r.autoAnswered.has(parsed.prompt + r.startedAt)) {
        r.autoAnswered.add(parsed.prompt + r.startedAt)
        await tmux.sendKeys(w, 'y', 'Enter')
        q.event(p.name, 'info', `Carpeta ${p.dir} marcada de confianza`)
        r.state = 'iniciando'
        r.detail = 'Confiando en la carpeta'
        return
      }
      r.state = 'atencion'
      r.prompt = parsed.prompt
      r.detail = 'Claude Code pregunta algo'
      return
    }
    r.prompt = null
    if (parsed.needsLogin) {
      r.state = 'atencion'
      r.detail = 'Inicia sesión con tu cuenta de Claude (pestaña Cuenta)'
      return
    }
    if (!parsed.connected) {
      r.state = 'iniciando'
      r.detail = parsed.lastLine.slice(0, 120) || 'Conectando…'
      return
    }
    const convs = q.conversations().filter((c) => c.project === p.name && c.active === 1)
    const st = convs.map((c) => convState(c.status))
    r.state = st.includes('esperando') ? 'esperando' : st.includes('trabajando') ? 'trabajando' : 'disponible'
    r.detail = 'Conectado'
    if (r.backoff && now - r.startedAt > 600_000) r.backoff = 0
  }

  private async startServer(p: Project) {
    const r = this.runtime(p.name)
    r.startedAt = Date.now()
    r.exitHandled = false
    await tmux.runIn(serverWindow(p.name), p.dir, [
      'bash', '-c', `echo; echo "${START_MARK} $(date +%T) ──"; exec claude remote-control --name "$RC_NAME" --spawn "$RC_SPAWN"`,
    ], {RC_NAME: `${config.namePrefix}-${p.name}`, RC_SPAWN: p.spawn})
    q.event(p.name, 'info', `Arranco el servidor (${p.spawn})`)
  }

  private async stopServerAndWait(p: Project) {
    const w = serverWindow(p.name)
    let pane = (await tmux.panes()).get(w)
    if (!pane || pane.dead) return
    await tmux.sendKeys(w, 'C-c')
    for (let i = 0; i < 25; i++) {
      await sleep(1000)
      pane = (await tmux.panes()).get(w)
      if (!pane || pane.dead) return
    }
    await tmux.killWindow(w)
  }

  // Rescate breve validado en las pruebas: con el servidor del proyecto parado, cada
  // conversación huérfana se levanta con --session-id, se cierra con Ctrl+C y después el
  // servidor normal vuelve a atenderla. Nunca hay dos procesos en la misma carpeta.
  async rescue(name: string, remoteIds: string[]) {
    const p = q.project(name)
    const r = this.runtime(name)
    if (!p || r.rescuing) return
    r.rescuing = true
    r.state = 'recuperando'
    try {
      q.event(name, 'warn', `Rescatando ${remoteIds.length} conversación(es)`)
      await this.stopServerAndWait(p)
      for (const id of remoteIds) {
        const c = q.conversation(id)
        const label = c?.title || id
        const w = rescueWindow(name)
        await tmux.runIn(w, p.dir, ['bash', '-c', `echo "${START_MARK} rescate $(date +%T) ──"; exec claude remote-control --session-id "$RC_SID"`], {RC_SID: id})
        let ok = false
        let error = 'No se conectó en 90 s'
        for (let i = 0; i < 90; i++) {
          await sleep(1000)
          const pane = (await tmux.panes()).get(w)
          const screen = parseServerScreen(await tmux.capture(w, 60))
          if (screen.prompt && /^Trust /.test(screen.prompt) && p.trust) await tmux.sendKeys(w, 'y', 'Enter')
          if (screen.connected) { ok = true; break }
          if (screen.needsLogin) { error = 'Hace falta iniciar sesión'; break }
          if (!pane || pane.dead) { error = screen.lastLine.slice(0, 160) || 'El proceso de rescate terminó con error'; break }
        }
        if (ok) {
          await sleep(3000)
          await tmux.sendKeys(w, 'C-c')
          for (let i = 0; i < 20; i++) {
            await sleep(1000)
            const pane = (await tmux.panes()).get(w)
            if (!pane || pane.dead) break
          }
          q.setOrphan(id, 0)
          q.event(name, 'ok', `«${label}» rescatada: vuelve a responder desde el móvil`)
        } else {
          q.setOrphan(id, 1, error)
          q.event(name, 'error', `No se pudo rescatar «${label}»: ${error}`)
        }
        await tmux.killWindow(w)
      }
      if (this.orphanCount() === 0) q.setMeta('crashAt', '')
    } finally {
      r.rescuing = false
      r.nextStartAt = 0
      r.backoff = 0
      r.exitHandled = true
    }
  }

  // --- Acciones del panel ---

  async startProject(name: string) {
    q.setProject(name, 'desired', 'running')
    const r = this.runtime(name)
    r.nextStartAt = 0
    r.backoff = 0
    q.event(name, 'info', 'Arrancado a mano')
  }

  async stopProject(name: string) {
    q.setProject(name, 'desired', 'stopped')
    q.event(name, 'info', 'Parado a mano (seguirá parado al reiniciar)')
  }

  async restartProject(name: string) {
    const p = q.project(name)
    if (!p) return
    await this.stopServerAndWait(p)
    q.setProject(name, 'desired', 'running')
    this.runtime(name).nextStartAt = 0
  }

  async answer(name: string, yes: boolean) {
    await tmux.sendKeys(serverWindow(name), yes ? 'y' : 'n', 'Enter')
    q.event(name, 'info', `Respuesta a Claude Code: ${yes ? 'sí' : 'no'}`)
  }

  async removeProject(name: string) {
    const p = q.project(name)
    if (!p) return
    await this.stopServerAndWait(p)
    await tmux.killWindow(serverWindow(name))
    q.deleteProject(name)
    this.rt.delete(name)
    q.event(name, 'info', 'Proyecto quitado del panel (la carpeta no se toca)')
  }

  // Login con el flujo oficial: el panel muestra el enlace y recoge el código.
  async startLogin(): Promise<{url: string | null}> {
    await tmux.runIn('cuenta', config.dataDir, ['bash', '-c', 'echo "── rc: login ──"; claude auth login; echo "── rc: fin del login (código $?) ──"; exec bash'])
    for (let i = 0; i < 20; i++) {
      await sleep(500)
      const screen = sinceLastLogin(await tmux.capture('cuenta', 200))
      const url = screen.replace(/\n/g, '').match(/https:\/\/\S*oauth\/authorize\S*/)?.[0]
      if (url) return {url}
      if (/Login successful/i.test(screen)) return {url: null}
    }
    return {url: null}
  }

  async sendLoginCode(code: string): Promise<{ok: boolean; message: string}> {
    await tmux.sendText('cuenta', code.trim())
    await tmux.sendKeys('cuenta', 'Enter')
    for (let i = 0; i < 30; i++) {
      await sleep(500)
      const screen = sinceLastLogin(await tmux.capture('cuenta', 200))
      if (/Login successful/i.test(screen)) {
        await this.checkAuth(true)
        return {ok: true, message: 'Sesión iniciada'}
      }
      const fail = screen.match(/Login failed[^\n]*/)
      if (fail) return {ok: false, message: `${fail[0]}. Pide un enlace nuevo y usa el código de ese intento.`}
    }
    return {ok: false, message: 'Sin respuesta de Claude Code. Revisa la pestaña Terminal → cuenta.'}
  }

  async shutdown() {
    if (this.stopping) return
    this.stopping = true
    q.event('sistema', 'info', 'Parada limpia: Ctrl+C a cada servidor')
    const panes = await tmux.panes().catch(() => new Map<string, tmux.Pane>())
    const windows = [...panes.values()].filter((p) => !p.dead && /^[pr]-/.test(p.window)).map((p) => p.window)
    for (const w of windows) await tmux.sendKeys(w, 'C-c').catch(() => {})
    for (let i = 0; i < 25; i++) {
      const now = await tmux.panes().catch(() => new Map<string, tmux.Pane>())
      if (windows.every((w) => !now.get(w) || now.get(w)!.dead)) break
      await sleep(1000)
    }
    q.setMeta('running', '0')
    q.event('sistema', 'ok', 'Parada completa')
    await tmux.killServer()
  }
}

export function convState(status: string): State {
  const s = status.toLowerCase()
  if (/wait|input|permission|action|question|approval/.test(s)) return 'esperando'
  if (/busy|run|work|think|stream|tool/.test(s)) return 'trabajando'
  return 'disponible'
}

function sinceLastLogin(screen: string) {
  const i = screen.lastIndexOf('── rc: login')
  return i >= 0 ? screen.slice(i) : screen
}

export const manager = new Manager()
