import fs from 'node:fs'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {config, cliEnvironment} from './config.js'

const run = promisify(execFile)

export type Account = {loggedIn: boolean; email?: string; plan?: string; method?: string; error?: string}

export async function authStatus(): Promise<Account> {
  try {
    const {stdout} = await run(config.claudeBinary, ['auth', 'status'], {timeout: 20_000,env:cliEnvironment(),maxBuffer:64*1024})
    const s = JSON.parse(stdout)
    return {loggedIn: Boolean(s.loggedIn), email: s.email, plan: s.subscriptionType, method: s.authMethod}
  } catch (e: any) {
    // `claude auth status` sale con código 1 si no hay sesión, pero imprime el JSON igualmente.
    try {
      const s = JSON.parse(e.stdout ?? '')
      return {loggedIn: Boolean(s.loggedIn), method: s.authMethod}
    } catch {
      return {loggedIn: false, error:'No se pudo comprobar la cuenta de Claude'}
    }
  }
}

export async function claudeVersion() {
  try {
    const {stdout} = await run(config.claudeBinary, ['--version'], {timeout: 10_000,env:cliEnvironment(),maxBuffer:4096})
    return stdout.trim().split(' ')[0]
  } catch {
    return '?'
  }
}

// Registro de procesos que Claude Code mantiene en <config>/sessions/<pid>.json.
// Formato interno (no documentado): se lee con tolerancia y sólo los campos necesarios.
export type LiveSession = {
  pid: number
  localId: string
  remoteId: string
  cwd: string
  status: string
  updatedAt: number
  alive: boolean
}

function procStart(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // El nombre del proceso va entre paréntesis y puede tener espacios: cortar tras el último ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] ?? null // campo 22 de /proc/<pid>/stat (starttime)
  } catch {
    return null
  }
}

// La comprobación de starttime distingue una sesión viva de un PID reutilizado.
// Separada para probar fixtures sin consultar procesos ni sesiones reales.
export function sessionRecord(s:any,readStart:(pid:number)=>string|null = procStart):LiveSession|null {
  if (!s?.bridgeSessionId || !s.sessionId || !s.cwd) return null
  return {
    pid:Number(s.pid),localId:String(s.sessionId),remoteId:String(s.bridgeSessionId),cwd:String(s.cwd),
    status:String(s.status??''),updatedAt:Number(s.statusUpdatedAt??s.updatedAt??s.startedAt??0),
    alive:s.procStart!=null && readStart(Number(s.pid))===String(s.procStart),
  }
}

export function scanSessions(): LiveSession[] {
  const dir = path.join(config.claudeConfigDir, 'sessions')
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
  } catch {
    return []
  }
  const out: LiveSession[] = []
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      const session = sessionRecord(s)
      if (session) out.push(session)
    } catch {}
  }
  return out
}

// Título legible: el primer mensaje del usuario en la transcripción.
const titleCache = new Map<string, string>()
export function conversationTitle(cwd: string, localId: string): string {
  const key = `${cwd}|${localId}`
  if (titleCache.has(key)) return titleCache.get(key)!
  const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const file = path.join(config.claudeConfigDir, 'projects', projectDir, `${localId}.jsonl`)
  let title = ''
  try {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(512 * 1024)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      if (!line.includes('"type":"user"')) continue
      try {
        const e = JSON.parse(line)
        const c = e.message?.content
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((p: any) => p.type === 'text')?.text : ''
        if (text && !text.startsWith('<')) {
          title = text.replace(/\s+/g, ' ').trim().slice(0, 80)
          break
        }
      } catch {}
    }
  } catch {}
  if (title) titleCache.set(key, title)
  return title
}

// Pregunta por consola pendiente en la última línea útil de una ventana.
export function pendingPrompt(screen: string): string | null {
  const lines = screen.split('\n').map((l) => l.trimEnd()).filter(Boolean)
  const last = lines.at(-1) ?? ''
  if (/\[y\/N\]\s*$|\(y\/n\)\s*$|\[Y\/n\]\s*$/i.test(last)) return last
  return null
}

// Marca que el gestor imprime antes de cada arranque: sólo se analiza lo que viene después.
export const START_MARK = '── rc: arranque'

export function sinceLastStart(screen: string) {
  const i = screen.lastIndexOf(START_MARK)
  return i >= 0 ? screen.slice(i) : screen
}

export function parseServerScreen(fullScreen: string) {
  const text = sinceLastStart(fullScreen)
  const tail = text.split('\n').filter((l) => l.trim()).slice(-8).join('\n')
  const cap = text.match(/Capacity:\s*(\d+)\/(\d+)/g)?.at(-1)?.match(/(\d+)\/(\d+)/)
  return {
    connected: /Connected ·/.test(text) && !/Reconnecting|Disconnected|Connection lost/i.test(tail),
    capacity: cap ? {used: Number(cap[1]), max: Number(cap[2])} : null,
    needsLogin: /must be logged in|requires a claude\.ai subscription|Login expired|run `?claude auth login|run \/login/i.test(text),
    prompt: pendingPrompt(text),
    lastLine: text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '',
  }
}
