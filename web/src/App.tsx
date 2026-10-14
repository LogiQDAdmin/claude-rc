import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react'
import {api, LABEL, timeAgo, type AppState, type Event, type FolderRoot, type Project, type State} from './api'
import {TerminalPane} from './Terminal'

type Tab = 'proyectos' | 'terminal' | 'registro' | 'cuenta'

const Pill = ({s}: {s: State}) => <span className={`pill s-${s}`}>{LABEL[s]}</span>

export function App() {
  const [st, setSt] = useState<AppState | null>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<Tab>('proyectos')
  const [termWin, setTermWin] = useState('cuenta')
  const [toast, setToast] = useState('')
  const [adding, setAdding] = useState(false)
  const toastTimer = useRef<number>()

  const refresh = useCallback(async () => {
    try {
      setSt(await api('state'))
      setErr('')
    } catch (e: any) {
      setErr(e.message)
    }
  }, [])

  useEffect(() => {
    refresh()
    const t = window.setInterval(refresh, 2000)
    return () => window.clearInterval(t)
  }, [refresh])

  const say = (msg: string) => {
    setToast(msg)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2600)
  }

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      const r = await fn()
      if (r && typeof r === 'object' && 'projects' in (r as any)) setSt(r as AppState)
      if (ok) say(ok)
    } catch (e: any) {
      say(e.message)
    }
  }

  const openTerminal = (win: string) => {
    setTermWin(win)
    setTab('terminal')
  }

  if (!st) {
    return <div className="wrap"><p className="hint">{err ? `No se puede hablar con el gestor: ${err}` : 'Cargando…'}</p></div>
  }

  const convs = st.projects.flatMap((p) => p.conversations.map((c) => ({...c, project: p.name})))
  const orphans = convs.filter((c) => c.state === 'atencion' || c.state === 'recuperando')
  const attention = st.projects.filter((p) => p.state === 'atencion').length + orphans.length

  return (
    <div className="wrap">
      <header className="app">
        <div className="brand">
          <img src="./icon.svg" alt="" />
          <div>
            <h1>Remote Control</h1>
            <p>Claude Code en este servidor, desde el móvil</p>
          </div>
        </div>
        <div className="chip">
          <span className={`dot ${st.account.loggedIn ? '' : 'off'}`} aria-hidden="true" />
          <span>{st.account.loggedIn ? `${st.account.email ?? 'Cuenta conectada'}${st.account.plan ? ` · ${st.account.plan}` : ''}` : 'Sin sesión de Claude'}</span>
          <button className="btn small ghost" onClick={() => setTab('cuenta')}>Cuenta</button>
        </div>
      </header>

      {err && <div className="notice bad"><p>Se ha perdido la conexión con el gestor ({err}). Reintentando…</p></div>}

      {!st.account.loggedIn && (
        <section className="notice warn">
          <h2>Conecta tu cuenta de Claude</h2>
          <p>Remote Control necesita el inicio de sesión de claude.ai (Pro, Max, Team o Enterprise). Mientras tanto los proyectos esperan.</p>
          <div className="actions"><button className="btn warn" onClick={() => setTab('cuenta')}>Iniciar sesión</button></div>
        </section>
      )}

      {orphans.length > 0 && (
        <section className="notice warn" aria-live="polite">
          <h2>⚠ Apagado inesperado{st.crash ? ` (${new Date(st.crash.at).toLocaleString('es-ES', {dateStyle: 'short', timeStyle: 'short'})})` : ''}</h2>
          <p>
            El servidor se cortó sin cerrar bien. Estas conversaciones estaban abiertas y no responden desde el móvil hasta rescatarlas.
            {st.autoRescue && st.account.loggedIn ? ' Se están rescatando automáticamente.' : ''}
          </p>
          <div className="rows">
            {orphans.map((c) => (
              <div className="row" key={c.remoteId}>
                <span><b>{c.title || c.remoteId}</b> · {c.project}{c.rescueError ? ` · ${c.rescueError}` : ''}</span>
                <Pill s={c.state} />
              </div>
            ))}
          </div>
          <div className="actions">
            <button className="btn warn" disabled={!st.account.loggedIn || orphans.every((c) => c.state === 'recuperando')}
              onClick={() => act(async () => { for (const c of orphans) await api(`conversations/${c.remoteId}/rescue`, {method: 'POST'}) }, 'Rescate en marcha')}>
              Rescatar {orphans.length === 1 ? 'la conversación' : `las ${orphans.length}`}
            </button>
          </div>
        </section>
      )}

      <nav className="tabs" role="tablist">
        {(['proyectos', 'terminal', 'registro', 'cuenta'] as Tab[]).map((t) => (
          <button key={t} className="tab" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {{proyectos: 'Proyectos', terminal: 'Terminal', registro: 'Registro', cuenta: 'Cuenta'}[t]}
            {t === 'proyectos' && <span className="count">{st.projects.length}</span>}
          </button>
        ))}
      </nav>

      {tab === 'proyectos' && (
        <section style={{display: 'flex', flexDirection: 'column', gap: 14}}>
          <div className="toolbar">
            <div className="summary">
              <span><b>{st.projects.filter((p) => p.desired === 'running').length}</b> de {st.projects.length} proyectos en marcha</span>
              <span><b>{convs.filter((c) => c.state !== 'reposo').length}</b> conversaciones activas · {convs.length} en total</span>
              {attention > 0 && <span className="bad"><b>{attention}</b> requieren atención</span>}
            </div>
            <button className="btn primary" onClick={() => setAdding(true)}>+ Añadir proyecto</button>
          </div>
          {st.projects.length === 0 ? (
            <div className="panel">
              <h2>Todavía no hay proyectos</h2>
              <p className="hint">Un proyecto es una carpeta donde Claude Code trabaja. Cada uno aparece en el móvil y en claude.ai/code como «{st.namePrefix}-nombre», y desde ahí abres conversaciones nuevas.</p>
              <div><button className="btn primary" onClick={() => setAdding(true)}>Añadir el primero</button></div>
            </div>
          ) : (
            <div className="projects">
              {st.projects.map((p) => <ProjectCard key={p.name} p={p} act={act} openTerminal={openTerminal} />)}
            </div>
          )}
        </section>
      )}

      {tab === 'terminal' && (
        <section style={{display: 'flex', flexDirection: 'column', gap: 10}}>
          <div className="term-box">
            <div className="term-bar">
              {['cuenta', ...st.projects.map((p) => `p-${p.name}`)].map((w) => (
                <button key={w} aria-pressed={termWin === w} onClick={() => setTermWin(w)}>{w === 'cuenta' ? 'cuenta' : w.slice(2)}</button>
              ))}
            </div>
            <TerminalPane key={termWin} window={termWin} />
          </div>
          <p className="hint">Es la consola real de cada servidor. Para pegar usa Ctrl+Shift+V o el clic derecho. Si sales de un servidor con Ctrl+C, el gestor lo vuelve a arrancar salvo que lo pares desde Proyectos.</p>
        </section>
      )}

      {tab === 'registro' && <EventsView />}
      {tab === 'cuenta' && <AccountView st={st} act={act} refresh={refresh} />}

      {adding && <AddDialog onClose={() => setAdding(false)} onDone={(s) => { setSt(s); setAdding(false); say('Proyecto añadido') }} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

function ProjectCard({p, act, openTerminal}: {p: Project; act: (fn: () => Promise<unknown>, ok?: string) => void; openTerminal: (w: string) => void}) {
  const running = p.desired === 'running'
  const [confirmDelete, setConfirmDelete] = useState(false)
  const showDetail = ['atencion', 'iniciando', 'recuperando', 'detenida'].includes(p.state) && p.detail && !p.prompt
  return (
    <article className="proj">
      <div className="proj-head">
        <div style={{minWidth: 0}}>
          <div className="proj-title"><h3>{p.name}</h3><Pill s={p.state} /></div>
          <div className="path">{p.dir}</div>
          <div className="meta">
            <span>En el móvil: <b>{p.remoteName}</b></span>
            <span>En uso <b>{p.capacity ? `${p.capacity.used}/${p.capacity.max}` : '—'}</b></span>
            <span className="hide-sm">Modo <b>{p.spawn}</b></span>
            <label className="inline">
              <input type="checkbox" className="switch" checked={p.autostart}
                onChange={(e) => act(() => api(`projects/${p.name}`, {method: 'PATCH', body: {autostart: e.target.checked}}),
                  e.target.checked ? 'Arrancará al encender' : 'No arrancará al encender')} />
              Al encender
            </label>
          </div>
          {showDetail && <div className="detail">{p.detail}</div>}
        </div>
        <div className="proj-actions">
          {running
            ? <button className="btn" onClick={() => act(() => api(`projects/${p.name}/stop`, {method: 'POST'}), `${p.name} parado`)}>Parar</button>
            : <button className="btn primary" onClick={() => act(() => api(`projects/${p.name}/start`, {method: 'POST'}), `${p.name} arrancando`)}>Arrancar</button>}
          <a className="btn" href="https://claude.ai/code" target="_blank" rel="noopener">Abrir en Claude ↗</a>
          <button className="btn ghost" onClick={() => openTerminal(`p-${p.name}`)}>Terminal</button>
          {confirmDelete
            ? <>
                <button className="btn danger" onClick={() => act(() => api(`projects/${p.name}`, {method: 'DELETE'}), `${p.name} quitado del panel`)}>Quitar (la carpeta se queda)</button>
                <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancelar</button>
              </>
            : <button className="btn ghost" onClick={() => setConfirmDelete(true)} aria-label={`Quitar ${p.name}`}>Quitar</button>}
        </div>
      </div>
      {p.prompt && (
        <div className="prompt">
          <span>Claude Code pregunta: <code>{p.prompt}</code></span>
          <span style={{display: 'flex', gap: 6}}>
            <button className="btn small primary" onClick={() => act(() => api(`projects/${p.name}/answer`, {method: 'POST', body: {yes: true}}), 'Respondido: sí')}>Sí</button>
            <button className="btn small" onClick={() => act(() => api(`projects/${p.name}/answer`, {method: 'POST', body: {yes: false}}), 'Respondido: no')}>No</button>
          </span>
        </div>
      )}
      <details className="convs" open={p.conversations.some((c) => c.state !== 'reposo')}>
        <summary><span className="chev">▸</span> Conversaciones ({p.conversations.length})</summary>
        {p.conversations.length === 0 ? (
          <p className="empty">Sin conversaciones todavía. Ábrelas desde el móvil o claude.ai/code en «{p.remoteName}».</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Conversación</th><th>Estado</th><th className="hide-sm">ID remoto</th><th>Actividad</th><th /></tr></thead>
              <tbody>
                {p.conversations.map((c) => (
                  <tr key={c.remoteId}>
                    <td>{c.title || <span style={{color: 'var(--muted)'}}>Sin mensajes</span>}{c.rescueError && <span className="err">{c.rescueError}</span>}</td>
                    <td><Pill s={c.state} /></td>
                    <td className="id hide-sm">{c.remoteId.slice(0, 20)}…</td>
                    <td className="when">{timeAgo(c.lastActivity)}</td>
                    <td className="act">
                      {c.state === 'atencion'
                        ? <button className="btn small warn" onClick={() => act(() => api(`conversations/${c.remoteId}/rescue`, {method: 'POST'}), 'Rescate en marcha')}>Rescatar</button>
                        : <a className="btn small ghost" href={c.url} target="_blank" rel="noopener">Abrir ↗</a>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </article>
  )
}

function AddDialog({onClose, onDone}: {onClose: () => void; onDone: (s: AppState) => void}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [roots, setRoots] = useState<FolderRoot[]>([])
  const [dir, setDir] = useState('')
  const [newName, setNewName] = useState('')
  const [name, setName] = useState('')
  const [spawn, setSpawn] = useState<'same-dir' | 'worktree'>('same-dir')
  const [autostart, setAutostart] = useState(true)
  const [trust, setTrust] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
    api<FolderRoot[]>('folders').then((r) => {
      setRoots(r)
      const first = r.flatMap((x) => x.folders).find((f) => !f.used)
      if (first) { setDir(first.path); setName(first.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 31)) }
      else { const root = r.find((x) => x.mounted)?.root ?? r[0]?.root; if (root) setDir(`new:${root}`) }
    }).catch((e) => setError(e.message))
  }, [])

  const isNew = dir.startsWith('new:')
  const chosen = roots.flatMap((r) => r.folders).find((f) => f.path === dir)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const target = isNew ? `${dir.slice(4)}/${newName.trim()}` : dir
      onDone(await api('projects', {method: 'POST', body: {name, dir: target, create: isNew, spawn, autostart, trust}}))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose}>
      <form onSubmit={submit}>
        <h2>Añadir proyecto</h2>
        <label className="field">Carpeta
          <select value={dir} onChange={(e) => {
            setDir(e.target.value)
            const f = roots.flatMap((r) => r.folders).find((x) => x.path === e.target.value)
            if (f) setName(f.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 31))
          }}>
            {roots.map((r) => (
              <optgroup key={r.root} label={r.mounted ? r.root : `${r.root} (no montada)`}>
                {r.folders.map((f) => <option key={f.path} value={f.path} disabled={f.used}>{f.name}{f.git ? ' · git' : ''}{f.used ? ' (ya es un proyecto)' : ''}</option>)}
                {r.mounted && <option value={`new:${r.root}`}>+ Carpeta nueva en {r.root}</option>}
              </optgroup>
            ))}
          </select>
          <small>Sólo las carpetas que la app tiene autorizadas. En Umbrel se eligen en los ajustes de la app.</small>
        </label>
        {isNew && (
          <label className="field">Nombre de la carpeta nueva
            <input type="text" required value={newName} pattern="[A-Za-z0-9._-]+" onChange={(e) => { setNewName(e.target.value); setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 31)) }} />
          </label>
        )}
        <label className="field">Nombre del proyecto
          <input type="text" required value={name} pattern="[a-z0-9][a-z0-9-]{0,30}" onChange={(e) => setName(e.target.value)} />
          <small>Minúsculas, números y guiones.</small>
        </label>
        <label className="field">Conversaciones nuevas
          <select value={spawn} onChange={(e) => setSpawn(e.target.value as any)}>
            <option value="same-dir">Comparten la carpeta (same-dir)</option>
            <option value="worktree" disabled={!isNew && !chosen?.git}>Una copia git por conversación (worktree){!isNew && !chosen?.git ? ' — necesita git' : ''}</option>
          </select>
        </label>
        <label className="inline"><input type="checkbox" className="switch" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} /> Arrancar al encender</label>
        <label className="inline"><input type="checkbox" className="switch" checked={trust} onChange={(e) => setTrust(e.target.checked)} /> Confío en esta carpeta (Claude podrá leer, editar y ejecutar en ella)</label>
        {error && <p className="error-text">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={() => ref.current?.close()}>Cancelar</button>
          <button className="btn primary" disabled={busy || !dir}>{busy ? 'Añadiendo…' : 'Añadir'}</button>
        </div>
      </form>
    </dialog>
  )
}

function EventsView() {
  const [events, setEvents] = useState<Event[]>([])
  useEffect(() => {
    const load = () => api<Event[]>('events?limit=300').then(setEvents).catch(() => {})
    load()
    const t = window.setInterval(load, 4000)
    return () => window.clearInterval(t)
  }, [])
  return (
    <div className="log">
      {events.length === 0 && <div className="t">Sin eventos.</div>}
      {events.map((e) => (
        <div key={e.id}>
          <span className="t">{new Date(e.ts).toLocaleString('es-ES', {dateStyle: 'short', timeStyle: 'medium'})}</span>{'  '}
          <span className="t">[{e.project}]</span>{'  '}<span className={e.level}>{e.msg}</span>
        </div>
      ))}
    </div>
  )
}

function AccountView({st, act, refresh}: {st: AppState; act: (fn: () => Promise<unknown>, ok?: string) => void; refresh: () => void}) {
  const [url, setUrl] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const start = async () => {
    setBusy(true)
    setMsg('')
    setCode('')
    try {
      const r = await api<{url: string | null}>('account/login', {method: 'POST'})
      setUrl(r.url)
      if (!r.url) setMsg('No apareció el enlace. Mira la pestaña Terminal → cuenta.')
    } catch (e: any) {
      setMsg(e.message)
    } finally {
      setBusy(false)
    }
  }

  const sendCode = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await api<{ok: boolean; message: string}>('account/code', {method: 'POST', body: {code}})
      setMsg(r.message)
      if (r.ok) { setUrl(null); setCode(''); refresh() }
    } catch (e: any) {
      setMsg(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{display: 'flex', flexDirection: 'column', gap: 14}}>
      <div className="panel">
        <h2>Cuenta de Claude</h2>
        <dl className="kv">
          <dt>Estado</dt><dd><Pill s={st.account.loggedIn ? 'disponible' : 'atencion'} /> {st.account.loggedIn ? 'Conectada' : 'Sin sesión'}</dd>
          {st.account.email && <><dt>Cuenta</dt><dd>{st.account.email}{st.account.plan ? ` · plan ${st.account.plan}` : ''}</dd></>}
          <dt>Claude Code</dt><dd className="mono">{st.claudeVersion} · actualizaciones con la app</dd>
          <dt>App</dt><dd className="mono">{st.version}</dd>
        </dl>

        {!url ? (
          <div><button className="btn primary" disabled={busy} onClick={start}>{st.account.loggedIn ? 'Volver a iniciar sesión' : 'Iniciar sesión'}</button></div>
        ) : (
          <ol className="steps">
            <li>Abre este enlace, entra con tu cuenta y autoriza: <a className="login-link" href={url} target="_blank" rel="noopener">Autorizar en claude.ai ↗</a></li>
            <li>Copia el código que te muestra y pégalo aquí:
              <form className="row-form" onSubmit={sendCode} style={{marginTop: 6}}>
                <input type="text" autoComplete="off" spellCheck={false} placeholder="Código de autorización" value={code} onChange={(e) => setCode(e.target.value)} required />
                <button className="btn primary" disabled={busy || !code.trim()}>{busy ? 'Comprobando…' : 'Conectar'}</button>
                <button type="button" className="btn ghost" onClick={() => setUrl(null)}>Cancelar</button>
              </form>
            </li>
          </ol>
        )}
        {msg && <p className="hint">{msg}</p>}
        <p className="hint">El código sólo vale para el enlace de este intento. Las credenciales se quedan en el servidor y nunca se muestran aquí.</p>
      </div>

      <div className="panel">
        <h2>Recuperación</h2>
        <label className="inline" style={{fontSize: 14, color: 'var(--fg)'}}>
          <input type="checkbox" className="switch" checked={st.autoRescue}
            onChange={(e) => act(() => api('settings', {method: 'PATCH', body: {autoRescue: e.target.checked}}), e.target.checked ? 'Rescate automático activado' : 'Rescate automático desactivado')} />
          Rescatar automáticamente las conversaciones tras un apagado inesperado
        </label>
        <p className="hint">Tras un corte de luz, las conversaciones que estaban abiertas no vuelven solas. El gestor las rescata una a una y después el servidor del proyecto las sigue atendiendo como siempre.</p>
      </div>
    </section>
  )
}
