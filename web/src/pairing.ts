export type PairPhase = 'idle' | 'starting' | 'pending' | 'claimed' | 'expired' | 'cancelled' | 'error'
export type PairSnapshot = {phase:PairPhase;kind?:'manual'|'opaque';manualCode?:string;expiresAt?:number;message?:string}
export type PairAttempt = {attemptId:string;kind:'manual'|'opaque';manualCode?:string;expiresAt:number}
export type PairScheduler = {now:() => number;setTimeout:(callback:() => void,delay:number) => number;clearTimeout:(handle:number) => void}
export class PairProtocolError extends Error {}
function returnedAttemptId(raw:unknown):string|undefined {
  if(!raw || typeof raw !== 'object' || !('attemptId' in raw))return undefined
  return typeof raw.attemptId==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.attemptId) ? raw.attemptId : undefined
}
export function parsePairStart(raw:unknown,now=Date.now()):PairAttempt {
  if(!raw || typeof raw !== 'object')throw new PairProtocolError('No se reconoce la respuesta de emparejamiento.')
  const value=raw as Record<string,unknown>,attemptId=returnedAttemptId(raw)
  if(!attemptId || (value.kind!=='manual' && value.kind!=='opaque') || typeof value.expiresAt!=='number' || !Number.isFinite(value.expiresAt))throw new PairProtocolError('La respuesta de emparejamiento usa un formato que esta versión no reconoce.')
  const expiresAt=value.expiresAt<1e12 ? value.expiresAt*1000 : value.expiresAt
  if(expiresAt>now+24*60*60*1000)throw new PairProtocolError('No se reconoce la caducidad del intento de emparejamiento.')
  if(value.kind==='opaque')return {attemptId,kind:'opaque',expiresAt}
  const code=value.manualPairingCode
  if(typeof code!=='string' || !code || code.length>64 || !/^[A-Z0-9 -]+$/i.test(code) || (typeof value.code==='string' && value.code!==code))throw new PairProtocolError('No se recibió un código manual válido.')
  return {attemptId,kind:'manual',manualCode:code,expiresAt}
}
export function parsePairStatus(raw:unknown):'pending'|'claimed'|'expired'|'idle' {
  if(!raw || typeof raw!=='object' || !('state' in raw) || !['pending','claimed','expired','idle'].includes(String(raw.state)))throw new PairProtocolError('No se reconoce el estado de emparejamiento. No se puede confirmar la conexión.')
  return (raw as {state:'pending'|'claimed'|'expired'|'idle'}).state
}

// Only a user starts an attempt. Status/cancel carry its local correlation ID,
// never its native pairing code. Late responses cannot restore forgotten codes.
export function createPairingController(options:{start:() => Promise<unknown>;readStatus:(attemptId:string) => Promise<unknown>;cancelAttempt:(attemptId:string) => Promise<unknown>;onChange:(value:PairSnapshot) => void;scheduler?:PairScheduler}) {
  const clock=options.scheduler ?? {now:() => Date.now(),setTimeout:(callback:() => void,delay:number) => globalThis.setTimeout(callback,delay),clearTimeout:(handle:number) => globalThis.clearTimeout(handle)}
  let snapshot:PairSnapshot={phase:'idle'},generation=0,active=false
  let activeAttemptId:string|undefined,pollTimer:number|undefined,expiryTimer:number|undefined
  const cleanup=(id:string|undefined) => {if(id)void options.cancelAttempt(id).catch(() => {/* The caller displays any cleanup failure in the Codex card. */})}
  function timersOff(){if(pollTimer!==undefined)clock.clearTimeout(pollTimer);if(expiryTimer!==undefined)clock.clearTimeout(expiryTimer);pollTimer=undefined;expiryTimer=undefined}
  function emit(value:PairSnapshot){snapshot=value;options.onChange({...value})}
  function finish(phase:'claimed'|'expired'|'cancelled'|'error',message?:string){
    const id=activeAttemptId;activeAttemptId=undefined;active=false;generation++;timersOff();emit({phase,message})
    if(phase!=='claimed')cleanup(id)
  }
  const valid=(id:number) => active && generation===id
  async function poll(id:number,attemptId:string){
    pollTimer=undefined
    if(!valid(id))return
    try {
      const result=await options.readStatus(attemptId)
      if(!valid(id))return
      const state=parsePairStatus(result)
      if(state==='claimed'){finish('claimed');return}
      if(state==='expired'){finish('expired');return}
      if(state==='idle'){finish('cancelled','El servidor ya no conserva este intento. Inicia uno nuevo si quieres seguir.');return}
      pollTimer=clock.setTimeout(() => void poll(id,attemptId),3000)
    } catch(error) {
      if(valid(id))finish('error',error instanceof PairProtocolError ? error.message : 'No se pudo comprobar el emparejamiento. Consulta el registro de Codex antes de volver a intentarlo.')
    }
  }
  return {
    get current(){return {...snapshot}},
    async start(){
      cleanup(activeAttemptId);activeAttemptId=undefined;timersOff();generation++;active=true;const id=generation;emit({phase:'starting'})
      try {
        const result=await options.start(),returnedId=returnedAttemptId(result)
        if(!valid(id)){cleanup(returnedId);return}
        activeAttemptId=returnedId
        const attempt=parsePairStart(result,clock.now())
        if(attempt.expiresAt<=clock.now()){finish('expired');return}
        const {attemptId,...display}=attempt
        emit({phase:'pending',...display})
        expiryTimer=clock.setTimeout(() => {if(valid(id))finish('expired')},attempt.expiresAt-clock.now())
        pollTimer=clock.setTimeout(() => void poll(id,attemptId),3000)
      } catch(error) {
        if(valid(id))finish('error',error instanceof PairProtocolError ? error.message : 'No se pudo iniciar el emparejamiento. Consulta el registro de Codex antes de volver a intentarlo.')
      }
    },
    cancel(){finish('cancelled')},
    dispose(){cleanup(activeAttemptId);activeAttemptId=undefined;active=false;generation++;timersOff();snapshot={phase:'idle'}},
  }
}

export function relayPresentation(loggedIn:boolean,state:string):{text:string;error:boolean} {
  if(!loggedIn)return {text:'Conecta tu cuenta de ChatGPT para habilitar el relay de Codex.',error:false}
  const text:Record<string,string>={disabled:'Relay desactivado',connecting:'Conectando con el relay…',connected:'Relay conectado',errored:'La conexión con el relay ha fallado. Consulta el registro.'}
  return {text:text[state] ?? 'El relay ha devuelto un estado desconocido. Consulta el registro.',error:state==='errored' || !(state in text)}
}
