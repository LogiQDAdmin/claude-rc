export type Provider = 'claude' | 'codex'
export const PROVIDERS: Provider[] = ['claude', 'codex']
export const PROVIDER_LABEL = {claude: 'Claude Code', codex: 'Codex'}
export type ServerState = 'iniciando' | 'disponible' | 'caido' | 'incompatible' | 'detenido'
export type LoginState = 'idle' | 'pending' | 'success' | 'error' | 'expired'
export type Conversation = {remoteId: string; title: string; lastActivity: number; state: string; rescueError?: string | null; url: string}
export type Binding = {provider: Provider; key: string; trust: boolean; spawn?: 'same-dir' | 'worktree'; state?: string; detail?: string; desired?: 'running' | 'stopped'; prompt?: string | null; autostart?: boolean; capacity?: {used:number;max:number}|null; conversations?: Conversation[]}
export type Project = {id: number; name: string; path: string; bindings: Binding[]}
export type Event = {at: string; level: string; message: string; provider: Provider}
export type LegacyProject = {name: string; dir: string; remoteName?:string; capacity?:{used:number;max:number}|null; desired?: 'running' | 'stopped'; spawn?: 'same-dir' | 'worktree'; state?: string; detail?: string; prompt?: string | null; conversations?: Conversation[]}
export type ProviderState = {
  provider: Provider
  cliVersion: string
  account: {loggedIn: boolean; email?: string; method?: string; plan?: string; stale?: boolean}
  server: {state: ServerState; detail: string; restarts: number; experimental?: boolean; remoteControl?: 'disabled' | 'connecting' | 'connected' | 'errored'; lastError?: string}
  login: {state: LoginState; verificationUrl?: string; userCode?: string; needsCodeInput?: boolean; message?: string}
  worker?: {state: 'starting' | 'ready' | 'failed' | 'stopped'; restarts: number}
  details?: {autoRescue?: boolean; crash?: {at: string; pending: number} | null; namePrefix?: string; projects?: LegacyProject[]; events?: unknown[]}
  events?: unknown[]
}
export type AppState = {version: string; providers: Record<Provider, ProviderState | null>; unifiedProjects: Project[]; providerErrors: Partial<Record<Provider, string>>; catalogError: string; unknownProviders: string[]}
export type FolderRoot = {root: string; mounted: boolean; folders: {path: string; name: string; git: boolean; used: boolean}[]}

export async function api<T = unknown>(path: string, init: {method?: string; body?: unknown} = {}): Promise<T> {
  const controller = new AbortController()
  const method = (init.method ?? 'GET').toUpperCase()
  const mutation = method !== 'GET' && method !== 'HEAD'
  const timeout = window.setTimeout(() => controller.abort(), mutation ? 75000 : 20000)
  try {
    const res = await fetch(`api/${path}`, {method, credentials: 'same-origin', headers: {'content-type': 'application/json', 'x-rc': '1'}, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: controller.signal, cache: 'no-store'})
    if (res.status === 401) throw new Error('El panel necesita autenticación. Recarga la página e introduce la contraseña en el navegador.')
    let data: unknown
    try { data = await res.json() } catch { throw new Error(`El panel recibió una respuesta que no reconoce (HTTP ${res.status}). Consulta el registro.`) }
    if (!res.ok) throw new Error(data && typeof data === 'object' && 'error' in data ? String(data.error) : `La operación falló (HTTP ${res.status}).`)
    return data as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error(mutation ? 'El servidor tardó demasiado en responder. Comprueba el estado antes de volver a intentarlo.' : 'El servidor tardó demasiado en responder. Se volverá a comprobar la conexión.')
    if (error instanceof TypeError) throw new Error('No se puede conectar con el panel. Comprueba la conexión con el servidor.')
    throw error
  } finally { window.clearTimeout(timeout) }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const optionalString = (value: unknown) => value === undefined || value === null || typeof value === 'string'
const optionalBoolean = (value: unknown) => value === undefined || typeof value === 'boolean'
const conversationValid = (value: unknown) => object(value) && typeof value.remoteId === 'string' && typeof value.title === 'string' && typeof value.lastActivity === 'number' && typeof value.state === 'string' && typeof value.url === 'string' && optionalString(value.rescueError)
function providerState(raw: unknown, provider: Provider): ProviderState {
  if (!object(raw) || raw.provider !== provider || typeof raw.cliVersion !== 'string' || !object(raw.account) || typeof raw.account.loggedIn !== 'boolean' ||
    !object(raw.server) || typeof raw.server.state !== 'string' || !['iniciando','disponible','caido','incompatible','detenido'].includes(raw.server.state) || typeof raw.server.detail !== 'string' || typeof raw.server.restarts !== 'number' ||
    !object(raw.login) || typeof raw.login.state !== 'string' || !['idle','pending','success','error','expired'].includes(raw.login.state) ||
    !optionalString(raw.login.verificationUrl) || !optionalString(raw.login.userCode) || !optionalString(raw.login.message) || !optionalString(raw.account.email) || !optionalString(raw.account.plan) || !optionalString(raw.server.lastError) || !optionalBoolean(raw.account.stale) || !optionalBoolean(raw.login.needsCodeInput) || !Number.isFinite(raw.server.restarts)) throw new Error(`El formato de ${PROVIDER_LABEL[provider]} ha cambiado. Se conserva su último estado conocido.`)
  if (raw.worker && (!object(raw.worker) || typeof raw.worker.state !== 'string' || !['starting','ready','failed','stopped'].includes(raw.worker.state) || typeof raw.worker.restarts !== 'number')) throw new Error(`El gestor de ${PROVIDER_LABEL[provider]} devolvió un estado desconocido.`)
  if (raw.server.remoteControl !== undefined && !['disabled','connecting','connected','errored'].includes(String(raw.server.remoteControl))) throw new Error(`El acceso remoto de ${PROVIDER_LABEL[provider]} devolvió un estado desconocido.`)
  if (raw.details !== undefined && !object(raw.details)) throw new Error(`No se reconocen los detalles de ${PROVIDER_LABEL[provider]}.`)
  if (object(raw.details)) {
    if (raw.details.autoRescue !== undefined && typeof raw.details.autoRescue !== 'boolean') throw new Error('No se reconoce el ajuste de recuperación de Claude.')
    if (raw.details.crash && (!object(raw.details.crash) || typeof raw.details.crash.at !== 'string' || typeof raw.details.crash.pending !== 'number')) throw new Error('No se reconoce el estado del apagado inesperado de Claude.')
    if (provider === 'claude' && raw.details.projects !== undefined && (!Array.isArray(raw.details.projects) || !raw.details.projects.every(project => object(project) && typeof project.name === 'string' && typeof project.dir === 'string' && optionalString(project.prompt) && (project.conversations === undefined || Array.isArray(project.conversations) && project.conversations.every(conversationValid))))) throw new Error('No se reconoce el estado original de los proyectos de Claude.')
  }
  return raw as ProviderState
}
export function parseSnapshot(raw: unknown, previous: AppState | null): AppState {
  if (!object(raw) || typeof raw.version !== 'string' || !object(raw.providers)) throw new Error('El formato del panel ha cambiado. Se conserva el último estado recibido.')
  const result: AppState = {version: raw.version, providers: {claude:null,codex:null}, unifiedProjects: previous?.unifiedProjects ?? [], providerErrors: {}, catalogError:'', unknownProviders: Object.keys(raw.providers).filter(key => !PROVIDERS.includes(key as Provider))}
  for (const provider of PROVIDERS) {
    try { result.providers[provider] = providerState(raw.providers[provider], provider) }
    catch (error) {
      result.providerErrors[provider] = messageOf(error)
      const prior = previous?.providers[provider]
      if (prior) result.providers[provider] = {...prior, account: {...prior.account, stale: true}}
    }
  }
  if (!Array.isArray(raw.unifiedProjects) || !raw.unifiedProjects.every(project => object(project) && typeof project.id === 'number' && typeof project.name === 'string' && typeof project.path === 'string' && Array.isArray(project.bindings) && project.bindings.every(binding => object(binding) && PROVIDERS.includes(binding.provider as Provider) && typeof binding.key === 'string' && typeof binding.trust === 'boolean' && optionalString(binding.state) && optionalString(binding.detail) && optionalString(binding.prompt) && (binding.conversations === undefined || Array.isArray(binding.conversations) && binding.conversations.every(conversationValid))))) {
    result.catalogError = 'No se reconoce el catálogo de proyectos. Se conserva la última lista conocida hasta recuperar una respuesta válida.'
  } else result.unifiedProjects = raw.unifiedProjects as Project[]
  return result
}
export function providerEvents(state: ProviderState | null): Event[] {
  if (!state) return []
  const raw = state.events ?? state.details?.events ?? []
  if (!Array.isArray(raw)) return []
  return raw.flatMap(event => {
    if (!object(event)) return []
    const at = typeof event.at === 'string' ? event.at : typeof event.ts === 'string' ? event.ts : undefined
    const message = typeof event.message === 'string' ? event.message : typeof event.msg === 'string' ? event.msg : undefined
    return at && message ? [{at, message, provider: state.provider, level: typeof event.level === 'string' ? event.level : 'info'}] : []
  })
}
export function legacyProject(state: ProviderState | null, binding: Binding): LegacyProject | undefined {
  const projects = state?.details?.projects
  return Array.isArray(projects) ? projects.find(project => project && project.name === binding.key) : undefined
}
export function messageOf(error: unknown) { return error instanceof Error ? error.message : 'La operación no se pudo completar.' }
export const SERVER_LABEL: Record<ServerState, string> = {iniciando:'Iniciando', disponible:'Disponible', caido:'Detenido inesperadamente', incompatible:'Formato incompatible', detenido:'Detenido'}
export const LABEL: Record<string, string> = {detenida:'Detenida', iniciando:'Iniciando', disponible:'Disponible', trabajando:'Trabajando', esperando:'Esperando respuesta', recuperando:'Recuperando', atencion:'Requiere atención', reposo:'En reposo', detenido:'Detenido', caido:'Caído', incompatible:'Incompatible'}
export function loginUrl(value: string | undefined, provider: Provider) {
  if (!value) return undefined
  try { const url = new URL(value); const hosts = provider === 'codex' ? ['auth.openai.com','chatgpt.com','openai.com'] : ['claude.ai','console.anthropic.com','platform.claude.com','auth.anthropic.com','anthropic.com']; if (url.protocol === 'https:' && hosts.includes(url.hostname)) return url.href } catch { /* Visible account error instead of opening an unknown link. */ }
  return undefined
}
export function conversationUrl(value: string) { try { const url = new URL(value); if (url.protocol === 'https:') return url.href } catch {} return undefined }
export function timeAgo(ms: number) { const seconds = Math.max(0,(Date.now()-ms)/1000); if (seconds < 60) return 'ahora'; if (seconds < 3600) return `hace ${Math.round(seconds/60)} min`; return new Date(ms).toLocaleString('es-ES',{dateStyle:'short',timeStyle:'short'}) }
