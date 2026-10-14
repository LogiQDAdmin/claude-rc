import {fork,execFile,type ChildProcess} from 'node:child_process'
import type {Catalog} from './catalog.js'
import type {ProviderId,ProviderState,WorkerRequest} from './provider-types.js'

export class ProviderError extends Error { constructor(message:string,readonly status=503) { super(message) } }
type Pending = {resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}
type Slot = {
  provider:ProviderId;child?:ChildProcess;enabled:boolean;phase:'starting'|'ready'|'failed'|'stopped';restarts:number;
  state:ProviderState;pending:Map<number,Pending>;retry?:NodeJS.Timeout;boot?:NodeJS.Timeout;watch?:NodeJS.Timeout;
  failure?:string;blocked:boolean;lastStateAt:number;cleaning?:Promise<void>;stopping?:Promise<void>
}
const STATES = new Set(['iniciando','disponible','caido','incompatible','detenido'])
const object = (value:any) => Boolean(value && typeof value==='object' && !Array.isArray(value))
const optionalString = (value:any,limit=8192) => value===undefined || (typeof value==='string' && value.length<=limit)
export function validState(value:any,provider:ProviderId):value is ProviderState {
  return object(value) && value.provider===provider && typeof value.cliVersion==='string' && value.cliVersion.length<=100 &&
    object(value.account) && typeof value.account.loggedIn==='boolean' && optionalString(value.account.email) &&
    optionalString(value.account.plan) && optionalString(value.account.method) && (value.account.stale===undefined || typeof value.account.stale==='boolean') &&
    object(value.server) && STATES.has(value.server.state) && typeof value.server.detail==='string' && value.server.detail.length<=8192 &&
    Number.isSafeInteger(value.server.restarts) && value.server.restarts>=0 &&
    object(value.login) && ['idle','pending','success','error','expired'].includes(value.login.state) &&
    optionalString(value.login.verificationUrl) && optionalString(value.login.userCode,1024) && optionalString(value.login.message) &&
    (value.login.needsCodeInput===undefined || typeof value.login.needsCodeInput==='boolean') &&
    (value.details===undefined || object(value.details))
}

export class Supervisor {
  readonly slots:Record<ProviderId,Slot>
  private sequence = 0
  private closing = false
  private onState?:()=>void
  constructor(readonly catalog:Catalog,readonly paths:Record<ProviderId,string>,readonly retryMs=2000,
    readonly env:NodeJS.ProcessEnv=process.env,readonly heartbeatMs=10_000,readonly bootMs=45_000) {
    const make = (provider:ProviderId):Slot => ({provider,enabled:catalog.enabled(provider),phase:'stopped',restarts:0,
      pending:new Map(),blocked:false,lastStateAt:0,state:{provider,cliVersion:provider==='claude'?'2.1.294':'0.162.1',
        account:{loggedIn:false},server:{state:'detenido',detail:'Proveedor detenido',restarts:0,experimental:provider==='codex'},login:{state:'idle'}}})
    this.slots = {claude:make('claude'),codex:make('codex')}
  }
  subscribe(callback:()=>void) { this.onState=callback }
  private clearEphemeral(state:ProviderState) {
    state.login={state:'idle'}
    // details is a compatibility DTO; never retain a second copy of a login
    // challenge after its worker no longer owns a live authorization flow.
    if (state.details) delete state.details.login
  }
  boot() { for (const provider of ['claude','codex'] as const) if (this.slots[provider].enabled) this.launch(provider) }
  state(provider:ProviderId):ProviderState {
    const slot=this.slots[provider]
    const value=structuredClone(slot.state)
    value.worker={state:slot.phase,restarts:slot.restarts}
    if (slot.phase!=='ready' || !slot.enabled || slot.stopping) this.clearEphemeral(value)
    if (slot.phase!=='ready') {
      value.account.stale=true
      value.server={...value.server,state:slot.phase==='starting'?'iniciando':slot.phase==='stopped'?'detenido':slot.blocked?'incompatible':'caido',
        detail:slot.failure??(slot.phase==='starting'?'Iniciando el proceso del proveedor':'Proveedor detenido'),lastError:slot.failure,restarts:slot.restarts}
    }
    return value
  }
  private launch(provider:ProviderId) {
    const slot=this.slots[provider]
    if (this.closing || !slot.enabled || slot.child || slot.cleaning || slot.stopping || slot.blocked) return
    clearTimeout(slot.retry)
    const integrity=provider==='claude'?this.env.RC_CLAUDE_INTEGRITY_ERROR:this.env.RC_CODEX_INTEGRITY_ERROR
    if (integrity) {
      slot.phase='failed';slot.blocked=true;slot.failure='La integridad del binario del proveedor no coincide con la versión fijada'
      this.onState?.();return
    }
    slot.phase='starting';slot.failure=undefined;slot.lastStateAt=Date.now()
    const child=fork(this.paths[provider],[],{
      env:{...this.env,HOME:provider==='claude'?(this.env.CLAUDE_HOME??'/data/home'):(this.env.CODEX_USER_HOME??'/data/codex-home')},
      detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc'],execArgv:[],
    })
    slot.child=child
    child.stdout?.resume();child.stderr?.resume() // Nunca registrar URLs/códigos/credenciales de CLI.
    slot.boot=setTimeout(()=>this.fail(slot,child,'El proceso del proveedor no terminó de arrancar'),this.bootMs)
    slot.boot.unref()
    slot.watch=setInterval(()=> {
      if (slot.child===child && slot.phase==='ready' && Date.now()-slot.lastStateAt>this.heartbeatMs)
        this.fail(slot,child,'El proceso del proveedor dejó de emitir su estado; se reiniciará')
    },Math.max(50,Math.min(1000,Math.floor(this.heartbeatMs/3))))
    slot.watch.unref()
    child.on('message',(message:any)=> {
      if (slot.child!==child || slot.phase==='failed' || slot.phase==='stopped') return
      if (message?.type==='state') {
        if (!validState(message.state,provider)) return this.fail(slot,child,'El proveedor cambió el formato de su estado; revisa la compatibilidad',true)
        slot.state=message.state
        if (!slot.enabled || slot.stopping) this.clearEphemeral(slot.state)
        slot.phase='ready';slot.failure=undefined;slot.lastStateAt=Date.now()
        clearTimeout(slot.boot);this.onState?.()
      } else if (message?.type==='response' && Number.isSafeInteger(message.id) && [true,false].includes(message.ok)) {
        const pending=slot.pending.get(message.id)
        if (!pending) return
        slot.pending.delete(message.id);clearTimeout(pending.timer)
        if (message.ok===true) pending.resolve(message.result)
        else pending.reject(new ProviderError('La operación del proveedor no pudo completarse. Revisa su estado y registro.',409))
      } else this.fail(slot,child,'El proveedor cambió el formato de su protocolo interno',true)
    })
    child.once('error',()=>this.fail(slot,child,'No se pudo iniciar el proceso del proveedor'))
    child.once('exit',()=>this.exited(slot,child))
    this.onState?.()
  }
  private exited(slot:Slot,child:ChildProcess) {
    if (slot.child!==child) return
    clearTimeout(slot.boot);clearInterval(slot.watch)
    slot.child=undefined
    this.clearEphemeral(slot.state)
    this.rejectPending(slot)
    if (slot.enabled && !this.closing) {
      slot.phase='failed';slot.failure??='El proceso del proveedor se cayó; se reintentará su arranque'
    } else slot.phase='stopped'
    // cleaning se establece antes de devolver el control. Ningún nuevo worker
    // puede abrir su socket hasta terminar la limpieza del worker anterior.
    const cleaning=this.cleanup(slot.provider,child.pid)
    slot.cleaning=cleaning
    this.onState?.()
    void cleaning.finally(()=> {
      if (slot.cleaning!==cleaning) return
      slot.cleaning=undefined
      if (!slot.enabled || this.closing || slot.blocked || slot.stopping) return
      slot.restarts++
      slot.retry=setTimeout(()=>this.launch(slot.provider),Math.min(30_000,this.retryMs*Math.max(1,slot.restarts)))
      slot.retry.unref()
    })
  }
  private fail(slot:Slot,child:ChildProcess,message:string,blocked=false) {
    if (slot.child!==child || slot.phase==='failed' || slot.phase==='stopped') return
    slot.failure=message;slot.phase='failed';slot.blocked=blocked
    this.clearEphemeral(slot.state)
    clearTimeout(slot.boot);clearInterval(slot.watch);this.rejectPending(slot);this.onState?.()
    child.kill('SIGKILL')
  }
  private rejectPending(slot:Slot) {
    for (const pending of slot.pending.values()) { clearTimeout(pending.timer);pending.reject(new ProviderError(slot.failure??'El proveedor dejó de responder')) }
    slot.pending.clear()
  }
  protected async cleanup(provider:ProviderId,pid?:number) {
    if (pid && process.platform!=='win32') { try { process.kill(-pid,'SIGKILL') } catch {} }
    if (this.env.RC_TEST_NO_TMUX==='1') return
    const socket=provider==='claude'?(this.env.CLAUDE_TMUX_SOCKET??'agent-rc-claude'):(this.env.CODEX_TMUX_SOCKET??'agent-rc-codex')
    await new Promise<void>(resolve=>execFile('tmux',['-L',socket,'kill-server'],{timeout:3000},()=>resolve()))
  }
  request(provider:ProviderId,action:string,args:Record<string,any>={},timeoutMs=60_000):Promise<any> {
    const slot=this.slots[provider],child=slot.child
    if (!child?.connected || (slot.phase!=='ready' && action!=='shutdown')) return Promise.reject(new ProviderError(`El proceso de ${provider} no está disponible`))
    const id=++this.sequence
    return new Promise((resolve,reject)=> {
      const timer=setTimeout(()=> {
        slot.pending.delete(id);reject(new ProviderError('El proveedor no respondió a tiempo'))
        this.fail(slot,child,'El proveedor no responde; se reiniciará su proceso')
      },timeoutMs)
      slot.pending.set(id,{resolve,reject,timer})
      child.send({type:'request',id,action,args} satisfies WorkerRequest,error=> {
        if (error) this.fail(slot,child,'No se pudo comunicar con el proceso del proveedor')
      })
    })
  }
  async stop(provider:ProviderId,persist=true) {
    const slot=this.slots[provider]
    slot.enabled=false
    this.clearEphemeral(slot.state)
    if (persist) this.catalog.setEnabled(provider,false)
    clearTimeout(slot.retry);clearTimeout(slot.boot);clearInterval(slot.watch)
    if (slot.stopping) return slot.stopping
    const stopping=(async()=> {
      const child=slot.child
      if (child) {
        const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()))
        try { await this.request(provider,'shutdown',{},40_000) } catch { child.kill('SIGKILL') }
        let timer:NodeJS.Timeout|undefined
        await Promise.race([exited,new Promise<void>(resolve=> {
          timer=setTimeout(()=>{ if (slot.child===child) child.kill('SIGKILL');resolve() },3000)
          timer.unref()
        })])
        clearTimeout(timer)
        // El handler exit es el único propietario de limpieza (sin kill-server duplicado).
        if (slot.child===child) await exited
      }
      await slot.cleaning
      slot.phase='stopped';slot.failure=undefined
      this.clearEphemeral(slot.state)
      this.onState?.()
    })()
    slot.stopping=stopping
    try { await stopping }
    finally {
      if (slot.stopping===stopping) slot.stopping=undefined
      if (slot.enabled && !this.closing) this.launch(provider)
    }
  }
  start(provider:ProviderId) {
    const slot=this.slots[provider]
    slot.enabled=true;slot.blocked=false;this.catalog.setEnabled(provider,true)
    clearTimeout(slot.retry)
    if (slot.cleaning) {
      void slot.cleaning.then(()=> { if (slot.enabled && !this.closing) this.launch(provider) })
    } else this.launch(provider)
  }
  async restart(provider:ProviderId) { await this.stop(provider,false);this.start(provider) }
  async shutdown() { this.closing=true;await Promise.allSettled([this.stop('claude',false),this.stop('codex',false)]) }
}
