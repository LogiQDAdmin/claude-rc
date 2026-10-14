import fs from 'node:fs'
import path from 'node:path'
import {config} from './config.js'
import {q, type Project} from './db.js'
import * as tmux from './tmux.js'
import {approvedPath} from './paths.js'
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const serverWindow = (name: string) => `p-${name}`
const rescueWindow = (name: string) => `r-${name}`
const MIN_BACKOFF = 15_000
const MAX_BACKOFF = 300_000

export type ManagerDependencies = {
  store: typeof q
  tmux: typeof tmux
  authStatus: typeof authStatus
  claudeVersion: typeof claudeVersion
  scanSessions: typeof scanSessions
  conversationTitle: typeof conversationTitle
  now: () => number
  sleep: (ms:number) => Promise<void>
  automaticTick: boolean
}

export class Manager {
  readonly dependencies: ManagerDependencies
  private interval?: NodeJS.Timeout
  constructor(dependencies: Partial<ManagerDependencies> = {}) {
    this.dependencies = {store:q,tmux,authStatus,claudeVersion,scanSessions,conversationTitle,now:Date.now,sleep,automaticTick:true,...dependencies}
  }
  private get store() { return this.dependencies.store }
  private get tmux() { return this.dependencies.tmux }
  account: Account = {loggedIn: false}
  claudeVersion = '?'
  lastLoginSucceeded = false
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
    return (this.store.meta('autoRescue') ?? '1') === '1'
  }

  async boot() {
    fs.mkdirSync(config.claudeConfigDir, {recursive: true})
    for (const root of config.projectRoots) {
      if (root.startsWith(config.dataDir)) fs.mkdirSync(root, {recursive: true})
    }
    const settings = path.join(config.claudeConfigDir, 'settings.json')
    if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({cleanupPeriodDays: 3650}, null, 2))

    // Apagado inesperado: la última vez no llegó a guardar la marca de parada limpia.
    if (this.store.meta('running') === '1') {
      const orphans = this.store.conversations().filter((c) => c.active === 1)
      this.store.markOrphans()
      const at = this.store.meta('lastTick') ?? new Date().toISOString()
      this.store.setMeta('crashAt', at)
      this.store.event('sistema', 'error', `Apagado inesperado. ${orphans.length} conversación(es) estaban abiertas y hay que rescatarlas.`)
      for (const c of orphans) this.pendingRescue.add(c.project)
    }
    this.store.setMeta('running', '1')
    this.store.event('sistema', 'info', `Gestor arrancado (versión ${config.version})`)
    this.claudeVersion = await this.dependencies.claudeVersion()
    await this.tmux.ensureSession()
    await this.checkAuth(true)
    if (this.dependencies.automaticTick) {
      this.interval = setInterval(() => this.tick().catch(() => console.error('No se pudo completar la supervisión de Claude')),2500)
      this.interval.unref()
      this.tick().catch(() => {})
    }
  }

  async checkAuth(force = false) {
    if (!force && this.dependencies.now() - this.lastAuth < 15_000) return
    this.lastAuth = this.dependencies.now()
    const before = this.account.loggedIn
    this.account = await this.dependencies.authStatus()
    if (!before && this.account.loggedIn) {
      this.store.event('cuenta', 'ok', `Sesión iniciada (${this.account.email ?? 'cuenta de claude.ai'})`)
      // Lo que esperaba al login arranca ya, sin esperar a su próximo reintento.
      for (const r of this.rt.values()) {
        r.nextStartAt = 0
        r.backoff = 0
      }
    }
  }

  orphanCount() {
    return this.store.conversations().filter((c) => c.orphan === 1).length
  }

  private projectForCwd(cwd: string, projects: Project[]) {
    return projects.find((p) => cwd === p.dir || cwd.startsWith(p.dir + '/') || cwd.startsWith(p.dir + '/.claude/worktrees/'))
  }

  private syncConversations(projects: Project[]) {
    const live: string[] = []
    for (const s of this.dependencies.scanSessions()) {
      const p = this.projectForCwd(s.cwd, projects)
      if (!p) continue
      if (s.alive) live.push(s.remoteId)
      const prev = this.store.conversation(s.remoteId)
      // Un registro muerto no debe pisar el estado de uno vivo más reciente.
      if (!s.alive && prev && prev.last_activity > s.updatedAt) continue
      this.store.upsertConversation({
        remote_id: s.remoteId, local_id: s.localId, project: p.name,
        title: this.dependencies.conversationTitle(s.cwd, s.localId), status: s.status,
        active: s.alive ? 1 : 0, last_activity: s.updatedAt,
      })
      if (s.alive && prev?.orphan === 1) {
        this.store.setOrphan(s.remoteId, 0)
        this.store.event(p.name, 'ok', `«${prev.title || s.remoteId}» vuelve a estar activa`)
      }
    }
    this.store.setInactiveExcept(live)
  }

  async tick() {
    if (this.ticking || this.stopping) return
    this.ticking = true
    try {
      this.store.setMeta('lastTick', new Date().toISOString())
      await this.checkAuth()
      const projects = this.store.projects()
      this.syncConversations(projects)
      const crashAt = this.store.meta('crashAt')
      const pending = this.orphanCount()
      this.crash = crashAt && pending > 0 ? {at: crashAt, pending} : null

      // Rescates pendientes tras un apagado (necesitan la sesión iniciada).
      if (this.account.loggedIn && this.autoRescue && this.pendingRescue.size) {
        for (const name of [...this.pendingRescue]) {
          this.pendingRescue.delete(name)
          const ids = this.store.conversations().filter((c) => c.project === name && c.orphan === 1).map((c) => c.remote_id)
          if (ids.length) this.rescue(name, ids).catch(() => console.error('No se pudo completar el rescate de Claude'))
        }
      }

      const panes = await this.tmux.panes()
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
    const now = this.dependencies.now()

    if (p.desired === 'stopped') {
      r.prompt = null
      r.capacity = null
      if (alive) {
        if (!r.stopSentAt) {
          r.stopSentAt = now
          await this.tmux.sendKeys(w, 'C-c')
        } else if (now - r.stopSentAt > 25_000) {
          await this.tmux.killWindow(w)
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
    try {
      if (approvedPath(p.dir)!==p.dir) throw new Error('Destino cambiado')
    } catch {
      if (alive) await this.tmux.killWindow(w)
      r.state = 'atencion'
      r.detail = 'La carpeta cambió o sale de las raíces autorizadas; revisa su montaje'
      r.prompt = null
      return
    }

    if (!alive) {
      const screen = pane ? sinceLastStart(await this.tmux.capture(w, 80)) : ''
      const parsed = parseServerScreen(screen)
      if (pane && !r.exitHandled) {
        r.exitHandled = true
        const ran = now - r.startedAt
        r.backoff = ran > 600_000 ? MIN_BACKOFF : Math.min(MAX_BACKOFF, Math.max(MIN_BACKOFF, r.backoff * 2))
        r.nextStartAt = now + r.backoff
        this.store.event(p.name, parsed.needsLogin ? 'warn' : 'warn',
          parsed.needsLogin ? 'El servidor necesita que inicies sesión' : `El servidor se ha cerrado (código ${pane.status ?? '?'}); reintento en ${Math.round(r.backoff / 1000)} s`)
      }
      if (now >= r.nextStartAt && (this.account.loggedIn || !parsed.needsLogin || now - r.startedAt > MAX_BACKOFF)) {
        if (!(await this.startServer(p))) return
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

    const parsed = parseServerScreen(await this.tmux.capture(w, 120))
    r.capacity = parsed.capacity
    if (parsed.prompt) {
      // La confianza en la carpeta ya la dio el usuario al añadir el proyecto.
      if (/^Trust /.test(parsed.prompt) && p.trust && !r.autoAnswered.has(parsed.prompt + r.startedAt)) {
        r.autoAnswered.add(parsed.prompt + r.startedAt)
        await this.tmux.sendKeys(w, 'y', 'Enter')
        this.store.event(p.name, 'info', `Carpeta ${p.dir} marcada de confianza`)
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
    const convs = this.store.conversations().filter((c) => c.project === p.name && c.active === 1)
    const st = convs.map((c) => convState(c.status))
    r.state = st.includes('esperando') ? 'esperando' : st.includes('trabajando') ? 'trabajando' : 'disponible'
    r.detail = 'Conectado'
    if (r.backoff && now - r.startedAt > 600_000) r.backoff = 0
  }

  private async startServer(p: Project) {
    const r = this.runtime(p.name)
    try {
      if (approvedPath(p.dir)!==p.dir) throw new Error('Destino cambiado')
    } catch {
      r.state = 'atencion'
      r.detail = 'La carpeta cambió o sale de las raíces autorizadas; revisa su montaje'
      return false
    }
    r.startedAt = this.dependencies.now()
    r.exitHandled = false
    await this.tmux.runIn(serverWindow(p.name), p.dir, [
      'bash', '-c', `echo; echo "${START_MARK} $(date +%T) ──"; exec "$RC_BINARY" remote-control --name "$RC_NAME" --spawn "$RC_SPAWN"`,
    ], {RC_BINARY:config.claudeBinary,DISABLE_UPDATES:'1',RC_NAME: `${config.namePrefix}-${p.name}`, RC_SPAWN: p.spawn})
    this.store.event(p.name, 'info', `Arranco el servidor (${p.spawn})`)
    return true
  }

  private async stopServerAndWait(p: Project) {
    const w = serverWindow(p.name)
    let pane = (await this.tmux.panes()).get(w)
    if (!pane || pane.dead) return
    await this.tmux.sendKeys(w, 'C-c')
    for (let i = 0; i < 25; i++) {
      await this.dependencies.sleep(1000)
      pane = (await this.tmux.panes()).get(w)
      if (!pane || pane.dead) return
    }
    await this.tmux.killWindow(w)
  }

  // Rescate breve validado en las pruebas: con el servidor del proyecto parado, cada
  // conversación huérfana se levanta con --session-id, se cierra con Ctrl+C y después el
  // servidor normal vuelve a atenderla. Nunca hay dos procesos en la misma carpeta.
  async rescue(name: string, remoteIds: string[]) {
    const p = this.store.project(name)
    const r = this.runtime(name)
    if (!p || r.rescuing) return
    if (approvedPath(p.dir)!==p.dir) throw new Error('La carpeta cambió de destino')
    r.rescuing = true
    r.state = 'recuperando'
    try {
      this.store.event(name, 'warn', `Rescatando ${remoteIds.length} conversación(es)`)
      await this.stopServerAndWait(p)
      for (const id of remoteIds) {
        const c = this.store.conversation(id)
        const label = c?.title || id
        const w = rescueWindow(name)
        await this.tmux.runIn(w, p.dir, ['bash', '-c', `echo "${START_MARK} rescate $(date +%T) ──"; exec "$RC_BINARY" remote-control --session-id "$RC_SID"`], {RC_BINARY:config.claudeBinary,DISABLE_UPDATES:'1',RC_SID: id})
        let ok = false
        let error = 'No se conectó en 90 s'
        for (let i = 0; i < 90; i++) {
          await this.dependencies.sleep(1000)
          const pane = (await this.tmux.panes()).get(w)
          const screen = parseServerScreen(await this.tmux.capture(w, 60))
          if (screen.prompt && /^Trust /.test(screen.prompt) && p.trust) await this.tmux.sendKeys(w, 'y', 'Enter')
          if (screen.connected) { ok = true; break }
          if (screen.needsLogin) { error = 'Hace falta iniciar sesión'; break }
          if (!pane || pane.dead) { error = 'El proceso de rescate terminó con error'; break }
        }
        if (ok) {
          await this.dependencies.sleep(3000)
          await this.tmux.sendKeys(w, 'C-c')
          for (let i = 0; i < 20; i++) {
            await this.dependencies.sleep(1000)
            const pane = (await this.tmux.panes()).get(w)
            if (!pane || pane.dead) break
          }
          this.store.setOrphan(id, 0)
          this.store.event(name, 'ok', `«${label}» rescatada: vuelve a responder desde el móvil`)
        } else {
          this.store.setOrphan(id, 1, error)
          this.store.event(name, 'error', `No se pudo rescatar «${label}»: ${error}`)
        }
        await this.tmux.killWindow(w)
      }
      if (this.orphanCount() === 0) this.store.setMeta('crashAt', '')
    } finally {
      r.rescuing = false
      r.nextStartAt = 0
      r.backoff = 0
      r.exitHandled = true
    }
  }

  // --- Acciones del panel ---

  async startProject(name: string) {
    this.store.setProject(name, 'desired', 'running')
    const r = this.runtime(name)
    r.nextStartAt = 0
    r.backoff = 0
    this.store.event(name, 'info', 'Arrancado a mano')
  }

  async stopProject(name: string) {
    this.store.setProject(name, 'desired', 'stopped')
    this.store.event(name, 'info', 'Parado a mano (seguirá parado al reiniciar)')
  }

  async restartProject(name: string) {
    const p = this.store.project(name)
    if (!p) return
    await this.stopServerAndWait(p)
    this.store.setProject(name, 'desired', 'running')
    this.runtime(name).nextStartAt = 0
  }

  async answer(name: string, yes: boolean) {
    await this.tmux.sendKeys(serverWindow(name), yes ? 'y' : 'n', 'Enter')
    this.store.event(name, 'info', `Respuesta a Claude Code: ${yes ? 'sí' : 'no'}`)
  }

  async removeProject(name: string) {
    const p = this.store.project(name)
    if (!p) return
    await this.stopServerAndWait(p)
    await this.tmux.killWindow(serverWindow(name))
    this.store.deleteProject(name)
    this.rt.delete(name)
    this.store.event(name, 'info', 'Proyecto quitado del panel (la carpeta no se toca)')
  }

  // Login con el flujo oficial: el panel muestra el enlace y recoge el código.
  async startLogin(): Promise<{url: string | null}> {
    this.lastLoginSucceeded = false
    await this.tmux.runIn('cuenta', config.dataDir, ['bash', '-c', 'echo "── rc: login ──"; "$RC_BINARY" auth login; echo "── rc: fin del login (código $?) ──"; exec bash'],{RC_BINARY:config.claudeBinary,DISABLE_UPDATES:'1'})
    for (let i = 0; i < 20; i++) {
      await this.dependencies.sleep(500)
      const screen = sinceLastLogin(await this.tmux.capture('cuenta', 200))
      // capture-pane -J ya une líneas partidas por el ancho del terminal. Mantener
      // los saltos reales evita anexar instrucciones a la URL OAuth.
      const url = screen.match(/https:\/\/\S*oauth\/authorize\S*/)?.[0]
      if (url) return {url}
      if (/Login successful/i.test(screen)) { await this.checkAuth(true); this.lastLoginSucceeded=this.account.loggedIn; return {url: null} }
    }
    return {url: null}
  }

  async sendLoginCode(code: string): Promise<{ok: boolean; message: string}> {
    await this.tmux.sendText('cuenta', code.trim())
    await this.tmux.sendKeys('cuenta', 'Enter')
    for (let i = 0; i < 30; i++) {
      await this.dependencies.sleep(500)
      const screen = sinceLastLogin(await this.tmux.capture('cuenta', 200))
      if (/Login successful/i.test(screen)) {
        await this.checkAuth(true)
        return {ok: true, message: 'Sesión iniciada'}
      }
      const fail = screen.match(/Login failed[^\n]*/)
      if (fail) return {ok: false, message: 'El inicio de sesión falló. Pide un enlace nuevo y usa el código de ese intento.'}
    }
    return {ok: false, message: 'Sin respuesta de Claude Code. Revisa la pestaña Terminal → cuenta.'}
  }

  async shutdown() {
    if (this.stopping) return
    this.stopping = true
    clearInterval(this.interval)
    this.store.event('sistema', 'info', 'Parada limpia: Ctrl+C a cada servidor')
    const panes = await this.tmux.panes().catch(() => new Map<string, tmux.Pane>())
    const windows = [...panes.values()].filter((p) => !p.dead && /^[pr]-/.test(p.window)).map((p) => p.window)
    for (const w of windows) await this.tmux.sendKeys(w, 'C-c').catch(() => {})
    for (let i = 0; i < 25; i++) {
      const now = await this.tmux.panes().catch(() => new Map<string, tmux.Pane>())
      if (windows.every((w) => !now.get(w) || now.get(w)!.dead)) break
      await this.dependencies.sleep(1000)
    }
    this.store.setMeta('running', '0')
    this.store.event('sistema', 'ok', 'Parada completa')
    await this.tmux.killServer()
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
