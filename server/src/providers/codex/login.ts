import {spawn, type ChildProcess} from 'node:child_process'

export type LoginState = {state: 'idle' | 'pending' | 'success' | 'error' | 'expired'; verificationUrl?: string; userCode?: string; message?: string}
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'')
export function parseDeviceOutput(raw: string): {verificationUrl: string; userCode: string} | undefined {
  const text = stripAnsi(raw)
  const url = text.match(/https:\/\/auth\.openai\.com\/codex\/device(?:\s|$)/)?.[0].trim()
  // Codex's device auth prints an isolated line after its "one-time code" label.
  const code = text.match(/one-time code[^\n]*\n\s*([A-Z0-9-]{1,64})(?:\s|$)/)?.[1]
  if (!url || !code) return undefined
  return {verificationUrl: url,userCode: code}
}

export function killOwnProcess(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return
  // Native children inherit the provider's process group. The common supervisor
  // owns that group; local cancellation must only signal this child.
  try { child.kill('SIGTERM') } catch {}
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode) return
    try { child.kill('SIGKILL') } catch {}
  },2000)
  timer.unref()
}

type LoginOptions = {binary: string; env: NodeJS.ProcessEnv; timeoutMs?: number; outputTimeoutMs?: number; onComplete: () => void; onEvent: (message: string) => void; spawnProcess?: typeof spawn}
export class DeviceLogin {
  state: LoginState = {state:'idle'}
  private child?: ChildProcess
  private timers: NodeJS.Timeout[] = []
  private buffer = ''
  private generation = 0
  constructor(private options: LoginOptions) {}

  start() {
    if (this.state.state === 'pending') return {...this.state}
    this.cancel(false)
    this.state = {state:'pending',message:'Solicitando un enlace y un código nuevos…'}
    const generation = ++this.generation
    // La rama login no utiliza el arranque gestionado ni comprueba actualizaciones.
    const child = (this.options.spawnProcess ?? spawn)(this.options.binary,['login','--device-auth'],{
      env:this.options.env,stdio:['ignore','pipe','pipe'],detached:false,
    })
    this.child = child
    const collect = (chunk: Buffer) => {
      if (generation !== this.generation || this.state.state !== 'pending') return
      this.buffer += chunk.toString()
      if (this.buffer.length > 16_384) return this.finish('error','La salida del login cambió de formato; vuelve a intentarlo')
      const parsed = parseDeviceOutput(this.buffer)
      if (parsed) this.state = {state:'pending',...parsed,message:'Abre el enlace e introduce el código. Caduca en 15 minutos.'}
    }
    child.stdout?.on('data',collect)
    child.stderr?.on('data',collect)
    child.once('error',() => {
      if (generation === this.generation) this.finish('error','No se pudo iniciar el login con la versión fijada de Codex')
    })
    child.once('exit',code => {
      if (generation !== this.generation || this.state.state !== 'pending') return
      if (code === 0) {
        this.finish('success','Sesión iniciada. Comprobando la cuenta…')
        this.options.onComplete()
      } else this.finish('error','El login terminó sin completar la autorización; solicita un código nuevo')
    })
    this.timers.push(setTimeout(() => {
      if (generation === this.generation && !this.state.userCode) this.finish('error','Codex no entregó el enlace y el código esperados; su salida puede haber cambiado')
    },this.options.outputTimeoutMs ?? 25_000))
    this.timers.push(setTimeout(() => {
      if (generation === this.generation) this.finish('expired','El código ha caducado. Solicita uno nuevo.')
    },this.options.timeoutMs ?? 15 * 60_000))
    this.options.onEvent('Se inició el flujo de dispositivo; el código solo existe en memoria')
    return {...this.state}
  }

  cancel(announce = true) {
    ++this.generation
    killOwnProcess(this.child)
    this.child = undefined
    this.clear()
    this.state = {state:'idle',message:announce ? 'Login cancelado' : undefined}
    if (announce) this.options.onEvent('Se canceló el flujo de dispositivo')
    return {...this.state}
  }
  private clear() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    this.buffer = ''
  }
  private finish(state: 'success' | 'error' | 'expired',message: string) {
    ++this.generation
    killOwnProcess(this.child)
    this.child = undefined
    this.clear()
    this.state = {state,message} // Retira el enlace y el código al terminar.
    this.options.onEvent(message)
  }
}
