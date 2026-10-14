export type State = 'detenida' | 'iniciando' | 'disponible' | 'trabajando' | 'esperando' | 'recuperando' | 'atencion' | 'reposo'

export type Conversation = {
  remoteId: string
  title: string
  lastActivity: number
  state: State
  rescueError: string | null
  url: string
}

export type Project = {
  name: string
  dir: string
  spawn: 'same-dir' | 'worktree'
  autostart: boolean
  desired: 'running' | 'stopped'
  trust: boolean
  remoteName: string
  state: State
  detail: string
  prompt: string | null
  capacity: {used: number; max: number} | null
  conversations: Conversation[]
}

export type AppState = {
  version: string
  claudeVersion: string
  account: {loggedIn: boolean; email?: string; plan?: string; method?: string; error?: string}
  autoRescue: boolean
  crash: {at: string; pending: number} | null
  namePrefix: string
  projects: Project[]
}

export type FolderRoot = {
  root: string
  mounted: boolean
  folders: {path: string; name: string; git: boolean; used: boolean}[]
}

export type Event = {id: number; ts: string; project: string; level: 'info' | 'ok' | 'warn' | 'error'; msg: string}

export async function api<T = AppState>(path: string, init: {method?: string; body?: unknown} = {}): Promise<T> {
  const res = await fetch(`api/${path}`, {
    method: init.method ?? 'GET',
    headers: {'content-type': 'application/json', 'x-rc': '1'},
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`)
  return data as T
}

export const LABEL: Record<State, string> = {
  detenida: 'Detenida',
  iniciando: 'Iniciando',
  disponible: 'Disponible',
  trabajando: 'Trabajando',
  esperando: 'Esperando respuesta',
  recuperando: 'Recuperando',
  atencion: 'Requiere atención',
  reposo: 'En reposo',
}

export function timeAgo(ms: number) {
  if (!ms) return '—'
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'ahora'
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  const d = new Date(ms)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString('es-ES', {hour: '2-digit', minute: '2-digit'}) : d.toLocaleDateString('es-ES', {day: 'numeric', month: 'short'}) + ' ' + d.toLocaleTimeString('es-ES', {hour: '2-digit', minute: '2-digit'})
}
