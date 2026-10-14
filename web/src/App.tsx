import {useCallback, useEffect, useRef, useState} from 'react'
import {api, messageOf, parseSnapshot, providerEvents, PROVIDERS, PROVIDER_LABEL, type AppState, type Project, type Provider} from './api'
import {ProviderCard, type Action, type Scope} from './ProviderCard'
import {AddDialog, conversationsOf, ProjectRow, type TerminalTarget} from './Projects'
import {TerminalPane} from './Terminal'
type Tab = 'proyectos' | 'terminal' | 'registro'

export function App() {
  const [state,setState] = useState<AppState|null>(null)
  const lastState = useRef<AppState|null>(null)
  const [connectionError,setConnectionError] = useState('')
  const [actionErrors,setActionErrors] = useState<Partial<Record<Scope,string>>>({})
  const [busy,setBusy] = useState<Partial<Record<Scope,string>>>({})
  const [tab,setTab] = useState<Tab>('proyectos')
  const [terminal,setTerminal] = useState<TerminalTarget|null>(null)
  const [adding,setAdding] = useState(false)
  const [notice,setNotice] = useState('')
  const [lastSeen,setLastSeen] = useState<Date|null>(null)
  const [eventFilter,setEventFilter] = useState<'all'|Provider>('all')
  const fetching = useRef(false)
  const noticeTimer = useRef<number>()
  const refresh = useCallback(async () => {
    if (fetching.current) return
    fetching.current = true
    try {
      const next = parseSnapshot(await api('state'),lastState.current)
      lastState.current=next;setState(next);setConnectionError('');setLastSeen(new Date())
    } catch (error) {setConnectionError(messageOf(error))} finally {fetching.current=false}
  },[])
  useEffect(() => {
    void refresh()
    const timer=window.setInterval(() => void refresh(),2500)
    return () => {window.clearInterval(timer);window.clearTimeout(noticeTimer.current)}
  },[refresh])
  const act:Action = async (scope,key,work,success) => {
    setBusy(current => ({...current,[scope]:key}));setActionErrors(current => ({...current,[scope]:''}))
    try {
      await work();await refresh()
      if(success){setNotice(success);window.clearTimeout(noticeTimer.current);noticeTimer.current=window.setTimeout(() => setNotice(''),4000)}
      return true
    } catch(error){setActionErrors(current => ({...current,[scope]:messageOf(error)}));return false}
    finally {setBusy(current => ({...current,[scope]:''}))}
  }
  const openTerminal = (project:Project,provider:Provider) => void act(provider,`terminal-${project.id}`,async () => {
    const result=await api<{window:string;provider:Provider}>(`projects/${project.id}/providers/${provider}/terminal`,{method:'POST'})
    if(!result || typeof result.window !== 'string' || result.provider !== provider) throw new Error('La terminal devolvió una respuesta que no se reconoce. Revisa el registro.')
    setTerminal({window:result.window,provider,name:project.name});setTab('terminal')
  })
  const openAccountTerminal = () => void act('claude','terminal-account',async () => {
    const result=await api<{window:string;provider:Provider}>('providers/claude/terminal',{method:'POST',body:{}})
    if(!result || typeof result.window !== 'string' || result.provider !== 'claude') throw new Error('La terminal de la cuenta de Claude devolvió una respuesta que no se reconoce. Revisa el registro.')
    setTerminal({window:result.window,provider:'claude',name:'Cuenta de Claude',account:true});setTab('terminal')
  })
  const events=state ? PROVIDERS.flatMap(provider => providerEvents(state.providers[provider])).filter(event => eventFilter==='all' || event.provider===eventFilter).sort((a,b) => b.at.localeCompare(a.at)) : []
  const recovery=state?.unifiedProjects.flatMap(project => project.bindings.filter(binding => binding.provider==='claude').flatMap(binding => conversationsOf(state,binding).filter(conversation => conversation.state==='atencion' || conversation.state==='recuperando').map(conversation => ({...conversation,project})))) ?? []
  const claude=state?.providers.claude
  const catalogBlocked=!!busy.catalog || !!state?.catalogError
  return <div className="app-wrap">
    <header className="app-header"><div className="brand"><img src="./icon.svg" alt="" /><div><h1>Remote Control</h1><p>Claude Code y Codex en tu servidor.</p></div></div><div className="version">Una app, dos agentes<span>{state ? `Versión ${state.version}` : 'Conectando…'}</span></div></header>
    {connectionError && <section className="notice error" role="alert"><h2>{connectionError.includes('formato') ? 'El panel no reconoce la respuesta del servidor' : 'Se ha perdido la conexión con el panel'}</h2><p>{connectionError}</p><p>{lastSeen ? `Último estado: ${lastSeen.toLocaleTimeString('es-ES')}. Los datos pueden estar desactualizados.` : 'Aún no se ha recibido un estado válido.'}</p><button className="btn" onClick={() => void refresh()}>Comprobar conexión</button></section>}
    {state?.unknownProviders.length ? <section className="notice" role="alert"><h2>Agente no reconocido</h2><p>El servidor ha incluido {state.unknownProviders.join(', ')}. Este panel conserva los controles de Claude y Codex; revisa la compatibilidad de la app.</p></section> : null}
    <div className="providers-overview">{PROVIDERS.map(provider => <ProviderCard key={provider} provider={provider} state={state?.providers[provider] ?? null} schemaError={state?.providerErrors[provider]} actionError={actionErrors[provider]} busy={busy[provider]} act={act} onLog={() => {setEventFilter(provider);setTab('registro')}} onAccountTerminal={openAccountTerminal} />)}</div>
    {!state ? <section className="loading" aria-live="polite"><h2>{connectionError ? 'Esperando conexión' : 'Cargando proyectos…'}</h2><p>El panel está disponible aunque no hayas conectado ninguna cuenta.</p></section> : <>
      {state.catalogError && <section className="notice error" role="alert"><h2>Catálogo de proyectos sin actualizar</h2><p>{state.catalogError}</p></section>}
      {actionErrors.catalog && <section className="notice error" role="alert"><h2>El proyecto no pudo modificarse</h2><p>{actionErrors.catalog}</p><button className="btn small" onClick={() => setActionErrors(current => ({...current,catalog:''}))}>Cerrar aviso</button></section>}
      {recovery.length>0 && <section className="notice recovery-notice" aria-live="polite"><h2>Claude tiene {recovery.length} {recovery.length===1 ? 'conversación pendiente' : 'conversaciones pendientes'} de recuperación</h2><p>{claude?.details?.crash ? `Apagado inesperado registrado el ${new Date(claude.details.crash.at).toLocaleString('es-ES',{dateStyle:'short',timeStyle:'short'})}. ` : ''}Las conversaciones pendientes no responderán desde el móvil hasta recuperarse.{claude?.details?.autoRescue && claude.account.loggedIn ? ' Se están recuperando automáticamente.' : ''}</p><ul>{recovery.map(conversation => <li key={conversation.remoteId}>{conversation.title || conversation.remoteId} <span className="hint">({conversation.project.name})</span></li>)}</ul><button className="btn" disabled={!!busy.claude || !claude?.account.loggedIn || !!state.providerErrors.claude || recovery.every(c => c.state==='recuperando')} onClick={() => void act('claude','rescue-all',async () => {
        for(const project of state.unifiedProjects){const remoteIds=recovery.filter(c => c.project.id===project.id && c.state==='atencion').map(c => c.remoteId);if(remoteIds.length) await api(`projects/${project.id}/providers/claude/rescue`,{method:'POST',body:{remoteIds}})}
      },'Recuperación de conversaciones solicitada')}>Recuperar conversaciones de Claude</button></section>}
      <main><nav className="tabs" aria-label="Secciones del panel">{(['proyectos','terminal','registro'] as Tab[]).map(value => <button key={value} className="tab" aria-current={tab===value ? 'page' : undefined} onClick={() => setTab(value)}>{value==='proyectos' ? 'Proyectos' : value==='terminal' ? 'Terminales' : 'Registro'}{value==='proyectos' && <span className="count">{state.unifiedProjects.length}</span>}</button>)}</nav>
        {tab==='proyectos' && <section className="projects-section" aria-labelledby="projects-title"><div className="toolbar"><div><h2 id="projects-title">Carpetas de trabajo</h2><p className="hint">Elige qué agente trabaja en cada carpeta.</p></div><button className="btn primary" disabled={catalogBlocked} onClick={() => setAdding(true)}>Añadir proyecto</button></div>{state.unifiedProjects.length ? <div className="unified-projects">{state.unifiedProjects.map(project => <ProjectRow key={project.id} project={project} state={state} busy={busy} act={act} openTerminal={openTerminal} />)}</div> : <div className="empty-projects"><h3>Prepara tu primer proyecto</h3><p>Añade una carpeta existente o crea una nueva. Puedes asignarla a Claude, a Codex o a ambos.</p><button className="btn" disabled={catalogBlocked} onClick={() => setAdding(true)}>Elegir carpeta y agentes</button></div>}</section>}
        {tab==='terminal' && <section className="terminal-section" aria-labelledby="terminal-title">
          <div className="toolbar"><div><h2 id="terminal-title">{terminal ? terminal.account ? 'Terminal de la cuenta de Claude' : `${terminal.name} / ${PROVIDER_LABEL[terminal.provider]}` : 'Terminal de proyecto o cuenta'}</h2><p className="hint">{terminal?.account ? 'Consola de la cuenta de Claude en este servidor, independiente de los proyectos.' : 'Cada terminal pertenece a su agente y se abre dentro de la carpeta elegida.'}</p></div>
            <label className="terminal-select">Terminal<select value={terminal ? terminal.account ? '@account:claude' : `${terminal.name}:${terminal.provider}` : ''} onChange={event => {
              if(event.target.value==='@account:claude'){openAccountTerminal();return}
              const option=state.unifiedProjects.flatMap(project => project.bindings.map(binding => ({project,provider:binding.provider,value:`${project.name}:${binding.provider}`}))).find(option => option.value===event.target.value)
              if(option) openTerminal(option.project,option.provider)
            }}><option value="" disabled>Elegir terminal</option><option value="@account:claude" disabled={!!busy.claude || !!state.providerErrors.claude || state.providers.claude?.worker?.state!=='ready'}>Cuenta de Claude</option>{state.unifiedProjects.flatMap(project => project.bindings.map(binding => <option key={`${project.id}:${binding.provider}`} value={`${project.name}:${binding.provider}`} disabled={!!busy[binding.provider] || !!state.providerErrors[binding.provider] || !binding.trust}>{project.name} / {PROVIDER_LABEL[binding.provider]}</option>))}</select></label>
          </div>
          {terminal ? <TerminalPane key={`${terminal.provider}:${terminal.window}`} provider={terminal.provider} window={terminal.window} /> : <div className="empty-projects"><h3>Elige una terminal</h3><p>Abre un proyecto de Claude o Codex, o usa la terminal de la cuenta de Claude. Cambiar de sección no cierra la sesión en el servidor.</p><div className="actions"><button className="btn" disabled={!!busy.claude || !!state.providerErrors.claude || state.providers.claude?.worker?.state!=='ready'} onClick={openAccountTerminal}>Terminal de la cuenta de Claude</button><button className="btn" onClick={() => setTab('proyectos')}>Ver proyectos</button></div></div>}
        </section>}
        {tab==='registro' && <section className="events-section" aria-labelledby="events-title"><div className="toolbar"><div><h2 id="events-title">Actividad de los agentes</h2><p className="hint">Los errores y cambios de estado aparecen por separado.</p></div><button className="btn" onClick={() => void refresh()}>Actualizar</button></div><div className="event-filters" aria-label="Filtrar actividad">{(['all',...PROVIDERS] as const).map(provider => <button className="btn small" key={provider} aria-pressed={eventFilter===provider} onClick={() => setEventFilter(provider)}>{provider==='all' ? 'Todos' : PROVIDER_LABEL[provider]}</button>)}</div>{events.length ? <ol className="events">{events.map((event,index) => <li className={`event event-${event.level}`} key={`${event.provider}-${event.at}-${index}`}><time dateTime={event.at}>{new Date(event.at).toLocaleString('es-ES',{dateStyle:'short',timeStyle:'medium'})}</time><span className="event-level">{event.provider==='claude' ? 'Claude' : 'Codex'}<br />{event.level==='error' ? 'Error' : event.level==='warn' ? 'Aviso' : 'Info'}</span><p>{event.message}</p></li>)}</ol> : <p className="empty-log">Todavía no hay eventos de {eventFilter==='all' ? 'los agentes' : PROVIDER_LABEL[eventFilter]}.</p>}</section>}
      </main><footer><span>Remote Control {state.version}</span><span>Versiones fijadas con la app; cuentas independientes</span></footer>
    </>}
    {adding && <AddDialog onClose={() => setAdding(false)} onDone={async () => {setAdding(false);await refresh()}} />}
    {notice && <div className="toast" role="status">{notice}</div>}
  </div>
}
