import net from 'node:net'
import WebSocket from 'ws'

export class CodexFailure extends Error {
  constructor(public kind: 'network' | 'timeout' | 'protocol' | 'rpc', message: string) { super(message) }
}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const incompatible = () => new CodexFailure('protocol', 'El formato del app-server ha cambiado; se detuvo la supervisión automática')

export function validateInitialize(value: unknown, expectedVersion: string) {
  if (!isObject(value) || typeof value.userAgent !== 'string' || typeof value.codexHome !== 'string' ||
      typeof value.platformFamily !== 'string' || typeof value.platformOs !== 'string') throw incompatible()
  const version = value.userAgent.match(/\/(\d+\.\d+\.\d+)(?:\s|$|\()/)?.[1]
  if (version !== expectedVersion) throw new CodexFailure('protocol', 'La versión del app-server no coincide con CODEX_VERSION')
}

export type Account = {loggedIn: boolean; method?: string; plan?: string}
export function validateAccount(value: unknown): Account {
  if (!isObject(value) || typeof value.requiresOpenaiAuth !== 'boolean' || !('account' in value)) throw incompatible()
  if (value.account === null) return {loggedIn: false}
  if (!isObject(value.account)) throw incompatible()
  if (value.account.type === 'apiKey') return {loggedIn: true, method: 'API key'}
  if (value.account.type === 'amazonBedrock' && typeof value.account.usesCodexManagedCredentials === 'boolean')
    return {loggedIn: true, method: 'Amazon Bedrock'}
  if (value.account.type === 'chatgpt' && (value.account.email === null || typeof value.account.email === 'string') &&
      typeof value.account.planType === 'string') {
    const plan = value.account.planType.toLowerCase()
    const plans = ['free','go','plus','pro','team','business','enterprise','education','edu','unknown','prolite','promax',
      'ent26','self_serve_business_prolite','self_serve_business_usage_based','enterprise_cbp_automation',
      'enterprise_cbp_usage_based','edu_plus','edu_pro']
    if (!plans.includes(plan)) throw incompatible()
    return {loggedIn: true, method: 'ChatGPT', plan}
  }
  throw incompatible()
}

export type RemoteStatus = 'disabled' | 'connecting' | 'connected' | 'errored'
export function validateRemoteStatus(value: unknown): RemoteStatus {
  if (!isObject(value) || !['disabled','connecting','connected','errored'].includes(String(value.status)) ||
      typeof value.serverName !== 'string' || typeof value.installationId !== 'string' ||
      !(value.environmentId === null || typeof value.environmentId === 'string')) throw incompatible()
  return value.status as RemoteStatus
}

export function validatePairing(value: unknown) {
  if (!isObject(value) || typeof value.pairingCode !== 'string' || value.pairingCode.length<1 || value.pairingCode.length>4096 || /[\u0000-\u0020\u007f]/.test(value.pairingCode) ||
      !(value.manualPairingCode===null || typeof value.manualPairingCode==='string') || typeof value.environmentId!=='string' ||
      typeof value.expiresAt!=='number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt<=0 || !Number.isSafeInteger(value.expiresAt*1000)) throw incompatible()
  if (value.manualPairingCode!==null && (value.manualPairingCode.length<1 || value.manualPairingCode.length>64 || !/^[A-Z0-9 -]+$/i.test(value.manualPairingCode))) throw incompatible()
  return {pairingCode:value.pairingCode,manualPairingCode:value.manualPairingCode,expiresAt:value.expiresAt}
}

export function validatePairingStatus(value:unknown):boolean {
  if (!isObject(value) || typeof value.claimed!=='boolean') throw incompatible()
  return value.claimed
}

type Waiting = {resolve: (value: unknown) => void; reject: (error: CodexFailure) => void; timer: NodeJS.Timeout}
// En Codex 0.162.1 unix:// lleva WebSocket sobre un socket Unix; no JSON-lines.
// Nunca se conserva ni se registra el contenido recibido de la cuenta o errores remotos.
export class RpcClient {
  private ws?: WebSocket
  private nextId = 1
  private waiting = new Map<number, Waiting>()
  private disposed = false
  constructor(private socketPath: string, private onBroken: (error: CodexFailure) => void) {}

  async connect(timeoutMs = 5000) {
    await new Promise<void>((resolve,reject) => {
      const ws = new WebSocket('ws://localhost/', {
        createConnection: () => net.connect(this.socketPath),
        maxPayload: 1024 * 1024,
      })
      this.ws = ws
      const timer = setTimeout(() => {
        reject(new CodexFailure('timeout','El app-server no respondió a tiempo'))
        this.close()
      },timeoutMs)
      ws.once('open', () => { clearTimeout(timer); resolve() })
      ws.once('error', () => {
        clearTimeout(timer)
        reject(new CodexFailure('network','No se pudo conectar al socket del app-server'))
      })
      ws.on('error', () => this.broken(new CodexFailure('network','Se perdió la conexión con el app-server')))
      ws.on('close', () => this.broken(new CodexFailure('network','Se cerró la conexión con el app-server')))
      ws.on('message', raw => {
        let msg: unknown
        try { msg = JSON.parse(raw.toString()) } catch { return this.broken(incompatible()) }
        if (!isObject(msg)) return this.broken(incompatible())
        // Notificaciones nuevas no afectan a las consultas expresamente validadas.
        if (!('id' in msg) && typeof msg.method === 'string') return
        if (typeof msg.id !== 'number' || ('result' in msg) === ('error' in msg)) return this.broken(incompatible())
        const pending = this.waiting.get(msg.id)
        if (!pending) return // Puede llegar una respuesta tardía después de un timeout.
        clearTimeout(pending.timer)
        this.waiting.delete(msg.id)
        if ('error' in msg) {
          if (!isObject(msg.error) || typeof msg.error.code !== 'number' || typeof msg.error.message !== 'string') {
            pending.reject(incompatible())
            return this.broken(incompatible())
          }
          // Los códigos JSON-RPC de método/parámetro indican deriva del contrato.
          pending.reject(msg.error.code === -32601 || msg.error.code === -32602 ? incompatible() :
            new CodexFailure('rpc','El app-server rechazó la operación; consulta su estado en el panel'))
        } else pending.resolve(msg.result)
      })
    })
  }

  call(method: string, params: object, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve,reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.disposed)
        return reject(new CodexFailure('network','El app-server no está conectado'))
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new CodexFailure('timeout','El app-server no respondió a tiempo'))
      },timeoutMs)
      this.waiting.set(id,{resolve,reject,timer})
      this.ws.send(JSON.stringify({id,method,params}), error => {
        if (error) this.broken(new CodexFailure('network','No se pudo enviar la operación al app-server'))
      })
    })
  }

  notify(method: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new CodexFailure('network','El app-server no está conectado')
    this.ws.send(JSON.stringify({method}))
  }

  private broken(error: CodexFailure) {
    if (this.disposed) return
    this.close()
    this.onBroken(error)
  }

  close() {
    if (this.disposed) return
    this.disposed = true
    for (const pending of this.waiting.values()) {
      clearTimeout(pending.timer)
      pending.reject(new CodexFailure('network','El app-server no está conectado'))
    }
    this.waiting.clear()
    this.ws?.terminate()
  }
}
