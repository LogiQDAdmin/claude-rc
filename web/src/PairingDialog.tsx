import {useEffect,useRef,useState} from 'react'
import {api} from './api'
import {createPairingController,type PairSnapshot} from './pairing'
import './PairingDialog.css'
export function PairingDialog({onClose,onCancelAttempt}:{onClose:() => void;onCancelAttempt:(attemptId:string) => Promise<unknown>}) {
  const dialog=useRef<HTMLDialogElement>(null)
  const [state,setState]=useState<PairSnapshot>({phase:'idle'})
  const [manualEntry,setManualEntry]=useState(false)
  const [copyMessage,setCopyMessage]=useState('')
  const [controller]=useState(() => createPairingController({start:() => api('providers/codex/pair',{method:'POST',body:{}}),readStatus:attemptId => api('providers/codex/pair/status',{method:'POST',body:{attemptId}}),cancelAttempt:onCancelAttempt,onChange:setState}))
  useEffect(() => {dialog.current?.showModal();return () => controller.dispose()},[controller])
  const close=() => {controller.cancel();controller.dispose();onClose()}
  const terminal=['claimed','expired','cancelled','error'].includes(state.phase)
  return <dialog ref={dialog} className="pairing-dialog" aria-labelledby="pairing-title" onCancel={event => {event.preventDefault();close()}}>
    <div className="pairing-dialog-content">
      <div><h2 id="pairing-title">Emparejar otro dispositivo</h2><p className="hint">Experimental. Iniciar sesión y conectar el relay no empareja un cliente ni hace aparecer este servidor automáticamente.</p></div>
      <div className="pairing-compatibility"><p><b>Compatibilidad sin verificar en Linux sin escritorio.</b> La guía oficial documenta hosts con la app de macOS o Windows. La conexión de este servidor con tu cliente no está confirmada.</p><a href="https://learn.chatgpt.com/docs/remote-connections" target="_blank" rel="noopener noreferrer">Consultar guía oficial de conexiones remotas</a></div>
      <ol className="pairing-steps"><li>En el cliente de escritorio, abre <b>Ajustes → Conexiones → Controlar otros dispositivos</b>, si está disponible. Usa en el cliente la misma cuenta de ChatGPT y espacio de trabajo que has conectado a Codex en este servidor.</li><li>Comprueba si ofrece entrada manual. Usa el código de este panel únicamente en esa opción. Si sólo ofrece otro flujo, consulta la guía; este panel no genera un QR ni un enlace de conexión.</li></ol>
      <label className="manual-entry-check"><input type="checkbox" checked={manualEntry} onChange={event => {setManualEntry(event.target.checked);setCopyMessage('')}} />Mi cliente ofrece introducir un código manual</label>
      <div className={`pairing-progress pairing-${state.phase}`} aria-live="polite">
        {state.phase==='idle' && <p>El intento comienza sólo cuando pulsas el botón de abajo.</p>}
        {state.phase==='starting' && <p>Preparando intento de emparejamiento…</p>}
        {state.phase==='pending' && <><h3>Pendiente de emparejamiento</h3><p>Se está comprobando este intento. El cliente todavía no lo ha confirmado.</p>{state.kind==='manual' ? manualEntry ? <div className="device-code"><code aria-label="Código temporal de emparejamiento">{state.manualCode}</code><button className="btn small" onClick={async () => {try{await navigator.clipboard.writeText(state.manualCode!);setCopyMessage('Código copiado')}catch{setCopyMessage('Selecciona el código y cópialo manualmente.')}}}>Copiar código</button></div> : <p>Marca la opción anterior sólo si tu cliente tiene entrada manual para mostrar el código.</p> : <p className="inline-error">Este intento devuelve un código interno que no sirve para entrada manual. No hay un método confirmado para introducirlo en este cliente.</p>}{state.expiresAt && <p className="hint">Caduca a las {new Date(state.expiresAt).toLocaleTimeString('es-ES')}.</p>}</>}
        {state.phase==='claimed' && <><h3>Emparejamiento confirmado</h3><p>El servicio ha confirmado que un cliente ha aceptado este intento. Comprueba en ese cliente si el servidor aparece y permite abrir el proyecto; el funcionamiento completo sigue sin verificar aquí.</p></>}
        {state.phase==='expired' && <><h3>Intento caducado</h3><p>No se obtuvo confirmación a tiempo. Revisa la compatibilidad del cliente antes de iniciar otro intento.</p></>}
        {state.phase==='cancelled' && <><h3>Comprobación detenida</h3>{state.message && <p>{state.message}</p>}</>}
        {state.phase==='error' && <><h3>No se pudo confirmar el emparejamiento</h3><p role="alert">{state.message}</p></>}
      </div>
      {copyMessage && state.phase==='pending' && state.kind==='manual' && manualEntry && <p className="hint" role="status">{copyMessage}</p>}
      <p className="hint">Cerrar elimina el código de este panel y detiene la comprobación. El código puede seguir válido hasta su caducidad. No se guarda en el almacenamiento o historial de la app.</p>
      <div className="dialog-actions"><button className="btn" onClick={close}>Cerrar</button>{(state.phase==='idle' || terminal && state.phase!=='claimed') && <button className="btn primary" onClick={() => {setCopyMessage('');void controller.start()}}>{state.phase==='idle' ? 'Iniciar intento experimental' : 'Iniciar otro intento'}</button>}</div>
    </div>
  </dialog>
}
