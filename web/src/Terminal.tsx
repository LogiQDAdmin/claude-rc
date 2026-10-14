import {useEffect, useRef, useState} from 'react'
import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type {Provider} from './api'

// Copied common terminal adapter: each WebSocket attaches to a persistent tmux window.
export function TerminalPane({window: win, provider}: {window: string; provider: Provider}) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal>()
  const [connection, setConnection] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let disposed = false
    setConnection('connecting')
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 14, cursorBlink: true,
      theme: {background: '#102638', foreground: '#e4edf3', cursor: '#8cddd2'}, scrollback: 5000,
    })
    terminal.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    fit.fit()
    const url = new URL(`api/term?provider=${encodeURIComponent(provider)}&w=${encodeURIComponent(win)}&cols=${term.cols}&rows=${term.rows}`, location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    ws.onmessage = e => { if (!disposed && typeof e.data === 'string') term.write(e.data) }
    ws.onerror = () => { if (!disposed) setConnection('error') }
    ws.onclose = event => {
      if (!disposed) {
        setConnection(event.wasClean ? 'closed' : 'error')
        term.write('\r\n\x1b[90m[conexión cerrada; usa Reconectar para volver a la sesión]\x1b[0m\r\n')
      }
    }
    const sub = term.onData(data => { if (ws.readyState === WebSocket.OPEN) ws.send(data) })
    const onResize = () => {
      if (disposed) return
      fit.fit()
      if (ws.readyState === WebSocket.OPEN) ws.send(`\u0000resize:${term.cols}x${term.rows}`)
    }
    const observer = new ResizeObserver(onResize)
    observer.observe(host.current!)
    ws.onopen = () => { if (!disposed) { setConnection('open'); onResize(); term.focus() } }
    return () => { disposed = true; observer.disconnect(); sub.dispose(); ws.close(); term.dispose(); terminal.current = undefined }
  }, [win, provider, attempt])
  return <div className="terminal-box"><div className="terminal-bar" aria-live="polite"><span className={`terminal-state terminal-${connection}`}>{connection === 'open' ? 'Terminal conectada' : connection === 'connecting' ? 'Conectando terminal…' : connection === 'error' ? 'No se puede conectar con la terminal' : 'Terminal desconectada'}</span><div>{(connection === 'closed' || connection === 'error') && <button className="terminal-button" onClick={() => setAttempt(value => value + 1)}>Reconectar</button>}<button className="terminal-button" onClick={() => terminal.current?.focus()}>Escribir en terminal</button></div></div><div className="term-host" ref={host} aria-label="Terminal interactiva del proyecto" /><p className="terminal-help">Para pegar, usa Ctrl+Shift+V o el menú contextual. Los comandos se ejecutan con los permisos de la app.</p></div>
}
