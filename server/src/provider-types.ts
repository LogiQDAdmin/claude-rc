export type ProviderId = 'claude' | 'codex'
export type ServerStatus = 'iniciando' | 'disponible' | 'caido' | 'incompatible' | 'detenido'
export type LoginStatus = 'idle' | 'pending' | 'success' | 'error' | 'expired'
export interface ProviderState {
  provider: ProviderId
  cliVersion: string
  account: {loggedIn: boolean; email?: string; plan?: string; method?: string; stale?: boolean}
  server: {state: ServerStatus; detail: string; restarts: number; experimental?: boolean; remoteControl?: string; lastError?: string}
  login: {state: LoginStatus; verificationUrl?: string; userCode?: string; needsCodeInput?: boolean; message?: string}
  // Original provider state for its detailed projects and compatibility routes.
  details?: Record<string, any>
  worker?: {state: 'starting' | 'ready' | 'failed' | 'stopped'; restarts: number}
}
export interface ProviderDriver {
  boot(): Promise<void>
  state(): ProviderState
  request(action: string, args: Record<string, any>): Promise<unknown>
  shutdown(): Promise<void>
}
export type WorkerRequest = {type: 'request'; id: number; action: string; args: Record<string, any>}
export type WorkerResponse = {type: 'response'; id: number; ok: true; result: unknown} | {type: 'response'; id: number; ok: false; error: string}
export type WorkerUpdate = {type: 'state'; state: ProviderState}
export interface ProjectBinding {provider: ProviderId; key: string; trust: boolean; spawn?: 'same-dir' | 'worktree'; state?: string; detail?: string; conversations?: any[]}
export interface UnifiedProject {id: number; name: string; path: string; bindings: ProjectBinding[]}
