import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {config, cliEnvironment} from './config.js'

// Los procesos de Claude viven en un servidor tmux propio: así sobreviven a un reinicio del
// gestor y sus preguntas por consola (Trust, Enable Remote Control) se pueden contestar.
const run = promisify(execFile)
const S = config.tmuxSession

async function tmux(...args: string[]) {
  const {stdout} = await run('tmux', ['-L', config.tmuxSocket, ...args], {maxBuffer: 4 * 1024 * 1024,timeout:10_000,env:cliEnvironment()})
  return stdout
}

export async function ensureSession() {
  try {
    await tmux('has-session', '-t', S)
  } catch {
    await tmux('new-session', '-d', '-s', S, '-n', 'cuenta', '-x', '200', '-y', '50', '-c', config.dataDir)
    await tmux('set-option', '-g', 'remain-on-exit', 'on')
    await tmux('set-option', '-g', 'history-limit', '20000')
    await tmux('set-option', '-g', 'mouse', 'off')
  }
}

export type Pane = {window: string; dead: boolean; status: number | null; pid: number}

export async function panes(): Promise<Map<string, Pane>> {
  const out = await tmux('list-panes', '-s', '-t', S, '-F', '#{window_name}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}')
  const map = new Map<string, Pane>()
  for (const line of out.trim().split('\n')) {
    if (!line) continue
    const [window, dead, status, pid] = line.split('\t')
    map.set(window, {window, dead: dead === '1', status: status === '' ? null : Number(status), pid: Number(pid)})
  }
  return map
}

// Ventana con un comando. Si ya existe (viva o muerta) se sustituye su proceso.
export async function runIn(window: string, cwd: string, command: string[], env: Record<string, string> = {}) {
  const envArgs = Object.entries({CLAUDE_CONFIG_DIR:config.claudeConfigDir,DISABLE_UPDATES:'1',...env}).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const existing = await panes()
  if (existing.has(window)) {
    await tmux('respawn-pane', '-k', '-t', `${S}:${window}`, '-c', cwd, ...envArgs, ...command)
  } else {
    await tmux('new-window', '-d', '-t', S, '-n', window, '-c', cwd, ...envArgs, ...command)
  }
}

export async function capture(window: string, lines = 60) {
  try {
    return await tmux('capture-pane', '-p', '-J', '-S', `-${lines}`, '-t', `${S}:${window}`)
  } catch {
    return ''
  }
}

export async function sendKeys(window: string, ...keys: string[]) {
  await tmux('send-keys', '-t', `${S}:${window}`, ...keys)
}

export async function sendText(window: string, text: string) {
  await tmux('send-keys', '-l', '-t', `${S}:${window}`, text)
}

export async function killWindow(window: string) {
  try {
    await tmux('kill-window', '-t', `${S}:${window}`)
  } catch {}
}

export async function killServer() {
  try {
    await tmux('kill-server')
  } catch {}
}

export const tmuxAttachCommand = (window: string, client: string) => [
  'tmux', '-L', config.tmuxSocket,
  'new-session', '-t', S, '-s', client, ';',
  'set-option', 'destroy-unattached', 'on', ';',
  'set-option', 'status', 'off', ';',
  'select-window', '-t', `${client}:${window}`,
]
