import {useEffect, useState, type FormEvent} from 'react'
import {api, loginUrl, PROVIDER_LABEL, SERVER_LABEL, type Provider, type ProviderState} from './api'
export type Scope = Provider | 'catalog'
export type Action = (scope: Scope, key: string, work: () => Promise<unknown>, success?: string) => Promise<boolean>

export function ProviderCard({provider, state, schemaError, actionError, busy, act, onLog, onAccountTerminal}: {provider: Provider; state: ProviderState | null; schemaError?: string; actionError?: string; busy?: string; act: Action; onLog: () => void; onAccountTerminal: () => void}) {
  const [code, setCode] = useState('')
  const [copyMessage, setCopyMessage] = useState('')
  const [pair, setPair] = useState<{manualPairingCode: string; expiresAt: number} | null>(null)
  const root = `providers/${provider}`
  const login = state?.login
  const pending = login?.state === 'pending'
  const url = loginUrl(login?.verificationUrl, provider)
  const workerUnavailable = !state || state.worker && state.worker.state !== 'ready'
  const stale = state?.account.stale || !!schemaError
  const unavailable = !!workerUnavailable || stale
  const accountName = provider === 'claude' ? 'Cuenta de Claude' : 'Cuenta de ChatGPT'
  const failed = login?.state === 'error' || login?.state === 'expired'
  useEffect(() => { if (login?.state !== 'pending') setCode('') }, [login?.state])
  useEffect(() => { if (!pair) return; const timer = window.setTimeout(() => setPair(null),Math.max(0,pair.expiresAt-Date.now())); return () => window.clearTimeout(timer) }, [pair])
  useEffect(() => { if (!state?.account.loggedIn || state.account.stale || schemaError || state.server.state !== 'disponible') setPair(null) }, [state?.account.loggedIn,state?.account.stale,state?.server.state,schemaError])
  const connect = () => { setCopyMessage(''); setCode(''); void act(provider,'login',() => api(`${root}/account/login`,{method:'POST'})) }
  const submitCode = async (event: FormEvent) => {
    event.preventDefault()
    if (await act(provider,'code',() => api(`${root}/account/code`,{method:'POST',body:{code:code.trim()}}),'Cuenta de Claude conectada')) setCode('')
  }
  return <section className={`provider-panel provider-${provider}`} aria-labelledby={`${provider}-title`}>
    <div className="provider-heading"><div><h2 id={`${provider}-title`}>{PROVIDER_LABEL[provider]}</h2><p className="provider-version">{state ? `CLI ${state.cliVersion}` : 'Estado sin recibir'}</p></div>{state && <span className={`status status-${state.server.state}`}>{SERVER_LABEL[state.server.state]}</span>}</div>
    {provider === 'codex' && <p className="experimental-provider"><b>Experimental.</b> La conexión remota de Codex puede cambiar; sus fallos aparecen en este bloque y en el registro.</p>}
    {schemaError && <div className="provider-alert" role="alert"><b>Formato no reconocido</b><p>{schemaError}</p></div>}
    {workerUnavailable && <div className="provider-alert" role="alert"><b>El gestor de {PROVIDER_LABEL[provider]} no está disponible</b><p>{state?.worker?.state === 'starting' ? 'Se está iniciando. El otro agente puede seguir trabajando.' : 'Reinicia este agente para recuperar la conexión. El otro agente funciona de forma independiente.'}</p></div>}
    {state && <>
      {(state.server.state === 'caido' || state.server.state === 'incompatible') && <div className="provider-alert" role="alert"><b>{state.server.state === 'incompatible' ? 'El servidor usa un formato incompatible' : 'El servidor se ha detenido inesperadamente'}</b><p>{state.server.detail}</p>{state.server.lastError && <p className="error-detail">{state.server.lastError}</p>}<button className="btn small" onClick={onLog}>Ver registro</button></div>}
      {state.server.state !== 'caido' && state.server.state !== 'incompatible' && <p className="server-detail">{state.server.detail}</p>}
      {state.server.remoteControl && <p className={state.server.remoteControl === 'errored' ? 'inline-error' : 'hint'} role={state.server.remoteControl === 'errored' ? 'alert' : undefined}>{{disabled:'Acceso remoto desactivado',connecting:'Acceso remoto conectando…',connected:'Acceso remoto conectado',errored:'El acceso remoto ha fallado. Consulta el registro.'}[state.server.remoteControl]}</p>}
    </>}
    <div className="actions server-actions">
      {(!state || workerUnavailable || state.server.state === 'detenido' || state.server.state === 'caido') ? <button className="btn" disabled={!!busy} onClick={() => void act(provider,'start',() => api(`${root}/server/start`,{method:'POST'}),'Inicio solicitado')}>{busy === 'start' ? 'Iniciando…' : `Iniciar ${provider === 'claude' ? 'Claude' : 'Codex'}`}</button> : <button className="btn" disabled={!!busy || !!schemaError} onClick={() => void act(provider,'stop',() => api(`${root}/server/stop`,{method:'POST'}),'Parada solicitada')}>Parar {provider === 'claude' ? 'Claude' : 'Codex'}</button>}
      <button className="btn text" disabled={!!busy} onClick={() => void act(provider,'restart',() => api(`${root}/server/restart`,{method:'POST'}),'Reinicio solicitado')}>{busy === 'restart' ? 'Reiniciando…' : 'Reiniciar'}</button>
    </div>
    <p className="hint">{provider === 'codex' ? 'Codex comparte un servidor remoto para todos sus proyectos. Pararlo interrumpe sus conexiones.' : 'Los proyectos de Claude tienen controles independientes debajo. Parar este agente interrumpe sus conexiones.'}</p>
    {actionError && <div className="provider-alert" role="alert"><b>La acción no se pudo completar</b><p>{actionError}</p></div>}
    <div className="provider-account">
      <div className="section-heading"><h3>{accountName}</h3><span className={`status ${state?.account.loggedIn && !stale ? 'status-disponible' : 'status-detenido'}`}>{stale ? 'Estado sin actualizar' : state?.account.loggedIn ? 'Conectada' : 'Sin conectar'}</span></div>
      {state?.account.email && <p className="hint">{state.account.email}{state.account.plan ? ` · ${state.account.plan}` : ''}</p>}
      {provider === 'codex' && state?.account.plan && <p className="hint">Plan {state.account.plan}</p>}
      {stale && <p className="inline-error">El último estado de la cuenta puede estar desactualizado. Recupera la conexión antes de iniciar sesión.</p>}
      {pending && !unavailable ? <div className="device-flow" aria-live="polite">
        <ol className="login-steps"><li>{provider === 'codex' ? 'Abre la autorización de OpenAI.' : 'Abre la autorización de Claude e inicia sesión.'}{url ? <a className="btn primary" href={url} target="_blank" rel="noopener noreferrer">Abrir autorización {provider === 'claude' ? 'de Claude' : 'de OpenAI'}</a> : <p className="hint">{login?.verificationUrl ? 'El enlace recibido no se reconoce. Cancela este intento y consulta el registro.' : 'Preparando enlace de autorización…'}</p>}</li><li>{provider === 'codex' ? 'Introduce este código en esa página.' : 'Copia el código que aparece al terminar y pégalo aquí.'}{provider === 'codex' ? login?.userCode ? <div className="device-code"><code aria-label="Código de dispositivo de Codex">{login.userCode}</code><button className="btn small" onClick={async () => { try { await navigator.clipboard.writeText(login.userCode!); setCopyMessage('Código copiado') } catch { setCopyMessage('Selecciona el código y cópialo manualmente.') } }}>Copiar</button></div> : <p className="hint">Esperando código de dispositivo…</p> : <form className="authorization-form" onSubmit={event => void submitCode(event)}><label className="field">Código de autorización de Claude<input type="password" value={code} autoComplete="off" spellCheck={false} required onChange={event => setCode(event.target.value)} disabled={!!busy} /></label><button className="btn primary" disabled={!!busy || !code.trim()}>{busy === 'code' ? 'Conectando…' : 'Conectar Claude'}</button></form>}</li></ol>
        {provider === 'codex' && <p className="hint">Completa el inicio de sesión allí. Este panel detectará la conexión automáticamente.</p>}
        {copyMessage && <p className="hint" role="status">{copyMessage}</p>}<button className="btn" disabled={!!busy} onClick={() => { setCode(''); void act(provider,'cancel',() => api(`${root}/account/cancel`,{method:'POST'})) }}>Cancelar inicio de sesión</button>
      </div> : <div className="actions"><button className="btn primary" disabled={!!busy || unavailable} onClick={connect}>{busy === 'login' ? 'Preparando autorización…' : failed ? `Reintentar ${provider === 'claude' ? 'Claude' : 'Codex'}` : state?.account.loggedIn ? `Volver a conectar ${provider === 'claude' ? 'Claude' : 'Codex'}` : `Conectar ${provider === 'claude' ? 'Claude' : 'ChatGPT para Codex'}`}</button></div>}
      {(login?.message || failed) && <p className={failed ? 'inline-error' : 'hint'} role={failed ? 'alert' : 'status'}>{login?.state === 'expired' ? 'El código ha caducado. ' : ''}{login?.message || 'Inicia un nuevo intento para obtener otro código.'}</p>}
      {login?.state === 'success' && !login.message && <p className="success-message" role="status">Cuenta conectada correctamente.</p>}
      <p className="hint">{provider === 'codex' ? 'El código de dispositivo se introduce en OpenAI. Las credenciales se guardan en este servidor.' : 'El código de autorización se envía sólo a este servidor. Cada agente conserva sus propias credenciales.'}</p>
      {provider === 'claude' && <button className="btn text" disabled={!!busy || unavailable} onClick={onAccountTerminal}>{busy === 'terminal-account' ? 'Abriendo terminal…' : 'Terminal de la cuenta de Claude'}</button>}
    </div>
    {provider === 'codex' && <><button className="btn text" disabled={!!busy || unavailable || !state?.account.loggedIn || state?.server.state !== 'disponible'} onClick={() => void act(provider,'pair',async () => {
      const result = await api<{manualPairingCode:string;expiresAt:number}>(`${root}/pair`,{method:'POST'})
      if (!result || typeof result.manualPairingCode !== 'string' || typeof result.expiresAt !== 'number' || !Number.isFinite(result.expiresAt)) throw new Error('Esta versión no devolvió un código de conexión válido.')
      const expiresAt = result.expiresAt < 1e12 ? result.expiresAt*1000 : result.expiresAt
      if (expiresAt <= Date.now()) throw new Error('El código de conexión ha caducado. Solicita otro.')
      setPair({...result,expiresAt})
    })}>{busy === 'pair' ? 'Preparando código…' : 'Conectar Codex desde otro dispositivo'}</button>{pair && <div className="pair-code" role="status"><p>Código de conexión de Codex</p><code>{pair.manualPairingCode}</code><p className="hint">Caduca a las {new Date(pair.expiresAt).toLocaleTimeString('es-ES')}. Trátalo como un código privado.</p><button className="btn small" onClick={() => setPair(null)}>Ocultar código</button></div>}</>}
    {provider === 'claude' && typeof state?.details?.autoRescue === 'boolean' && <label className="recovery-setting"><input type="checkbox" checked={state.details.autoRescue} disabled={!!busy || unavailable} onChange={event => void act(provider,'autoRescue',() => api(`${root}/settings`,{method:'PATCH',body:{autoRescue:event.target.checked}}),'Recuperación automática actualizada')} />Recuperar conversaciones tras un apagado inesperado</label>}
    {state && (state.server.restarts > 0 || (state.worker?.restarts ?? 0) > 0) && <p className="hint">Reinicios del servidor: {state.server.restarts}{state.worker ? `; del gestor: ${state.worker.restarts}` : ''}. Consulta el registro para ver qué ocurrió.</p>}
  </section>
}
