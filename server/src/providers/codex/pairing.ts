import {randomUUID} from 'node:crypto'
import {CodexFailure,validatePairing,validatePairingStatus,type RpcClient} from './protocol.js'

export type PairingStatus = {state:'idle'|'pending'|'claimed'|'expired'}
export type PairingCode = {code:string;kind:'manual'|'opaque';expiresAt:number;manualPairingCode:string|null;attemptId:string}
type ActiveAttempt = PairingCode & {nonce:number}
type Options = {
  rpc:()=>Pick<RpcClient,'call'>|undefined
  available:()=>boolean
  event:(level:'info'|'ok'|'warn'|'error',message:string)=>void
  incompatible:(error:CodexFailure)=>void
  now?:()=>number
}
// Native pairing/start and pairing/status each have a 30s HTTP budget in 0.162.1.
// The outer provider IPC (60s) and browser mutation (75s) still bound these 40s calls.
export const PAIRING_RPC_TIMEOUT_MS = 40_000

export class PairingService {
  private active?:ActiveAttempt
  private phase:PairingStatus['state']='idle'
  private attemptId?:string
  private nonce=0
  private expiry?:NodeJS.Timeout
  private starting?:Promise<PairingCode>
  private checking?:Promise<PairingStatus>
  private now:()=>number
  constructor(private options:Options) { this.now=options.now??Date.now }
  clear() {
    ++this.nonce
    clearTimeout(this.expiry)
    this.active=undefined
    this.starting=undefined
    this.checking=undefined
    this.phase='idle'
    this.attemptId=undefined
    return {state:'idle'} as PairingStatus
  }
  private expire() {
    if (this.active && this.active.expiresAt*1000<=this.now()) {
      const attemptId=this.active.attemptId
      this.clear()
      this.attemptId=attemptId;this.phase='expired'
    }
    return {state:this.phase} as PairingStatus
  }
  private arm(attempt:ActiveAttempt) {
    clearTimeout(this.expiry)
    const delay=Math.max(0,Math.min(2_147_483_647,attempt.expiresAt*1000-this.now()))
    this.expiry=setTimeout(()=> {
      if (this.active!==attempt) return
      this.expire()
      if (this.active===attempt) this.arm(attempt)
    },delay)
    this.expiry.unref()
  }
  private transport() {
    const rpc=this.options.rpc()
    if (!rpc || !this.options.available()) throw new CodexFailure('rpc','El app-server no está disponible para emparejar')
    return rpc
  }
  private report(error:unknown,operation:'start'|'status') {
    if (error instanceof CodexFailure && error.kind==='protocol') {
      const failure=new CodexFailure('protocol','El formato de emparejamiento de Codex ha cambiado; revisa la compatibilidad')
      this.options.event('error',failure.message)
      this.options.incompatible(failure)
    } else if (error instanceof CodexFailure && error.kind==='timeout') {
      this.options.event('error',operation==='start'
        ?'Codex tardó demasiado en generar el código de emparejamiento. Comprueba la conexión y vuelve a intentarlo.'
        :'Codex tardó demasiado en confirmar el emparejamiento. El intento se conserva hasta que caduque.')
    } else this.options.event('warn',operation==='start'
      ?'No se pudo generar el código de emparejamiento de Codex. Comprueba la sesión y el estado del relay.'
      :'No se pudo comprobar el emparejamiento de Codex. El intento se conserva hasta que caduque.')
  }
  start():Promise<PairingCode> {
    this.clear()
    const nonce=this.nonce
    const attemptId=randomUUID()
    this.attemptId=attemptId
    const task=(async():Promise<PairingCode>=> {
      try {
        const response=validatePairing(await this.transport().call('remoteControl/pairing/start',{manualCode:true},PAIRING_RPC_TIMEOUT_MS))
        if (nonce!==this.nonce) throw new Error('El intento de emparejamiento ya no está activo')
        if (response.expiresAt*1000<=this.now()) {
          this.phase='expired'
          throw new CodexFailure('rpc','El código de emparejamiento ya había caducado')
        }
        const kind=response.manualPairingCode===null?'opaque':'manual'
        const code=response.manualPairingCode??response.pairingCode
        const attempt:ActiveAttempt={code,kind,expiresAt:response.expiresAt,manualPairingCode:response.manualPairingCode,attemptId,nonce}
        this.active=attempt;this.phase='pending';this.arm(attempt)
        this.options.event('info','Se generó un intento de emparejamiento de Codex; su código sólo existe en memoria')
        return {code,kind,expiresAt:attempt.expiresAt,manualPairingCode:attempt.manualPairingCode,attemptId}
      } catch (error) {
        if (nonce===this.nonce) this.report(error,'start')
        throw new Error('No se pudo generar el emparejamiento de Codex. Consulta su registro y vuelve a intentarlo.')
      }
    })()
    this.starting=task
    void task.then(()=>{if(this.starting===task)this.starting=undefined},()=>{if(this.starting===task)this.starting=undefined})
    return task
  }
  private validateAttemptId(attemptId:string) {
    if (typeof attemptId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId))
      throw new Error('Identificador local de emparejamiento no válido')
  }
  cancel(attemptId:string):PairingStatus {
    this.validateAttemptId(attemptId)
    if (attemptId===this.attemptId) this.clear()
    return {state:'idle'}
  }
  async status(attemptId:string):Promise<PairingStatus> {
    this.validateAttemptId(attemptId)
    this.expire()
    if (attemptId!==this.attemptId) return {state:'idle'}
    const attempt=this.active
    if (!attempt) return {state:this.phase}
    if (this.checking) return this.checking
    const task=(async()=> {
      try {
        const params=attempt.kind==='manual'?{manualPairingCode:attempt.code}:{pairingCode:attempt.code}
        const claimed=validatePairingStatus(await this.transport().call('remoteControl/pairing/status',params,PAIRING_RPC_TIMEOUT_MS))
        this.expire()
        if (this.active!==attempt || attempt.nonce!==this.nonce) return {state:attemptId===this.attemptId?this.phase:'idle'} as PairingStatus
        if (claimed) {
          this.clear();this.attemptId=attemptId;this.phase='claimed'
          this.options.event('ok','El cliente confirmó el intento de emparejamiento de Codex')
        }
        return {state:this.phase} as PairingStatus
      } catch (error) {
        this.expire()
        if (this.active!==attempt || attempt.nonce!==this.nonce) return {state:attemptId===this.attemptId?this.phase:'idle'} as PairingStatus
        this.report(error,'status')
        throw new Error('No se pudo confirmar el emparejamiento de Codex. Consulta su registro.')
      }
    })()
    this.checking=task
    void task.then(()=>{if(this.checking===task)this.checking=undefined},()=>{if(this.checking===task)this.checking=undefined})
    return task
  }
}
