import {useEffect, useRef} from 'react'
import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// Terminal de verdad (tmux dentro del contenedor). Pegar funciona con Ctrl+Shift+V o clic derecho.
export function TerminalPane({window: win}: {window: string}) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: {background: '#0f131a', foreground: '#d6dbe6'},
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    fit.fit()

    const url = new URL(`api/term?w=${encodeURIComponent(win)}&cols=${term.cols}&rows=${term.rows}`, location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : '')
    ws.onclose = () => term.write('\r\n\x1b[90m[conexión cerrada]\x1b[0m\r\n')
    const sub = term.onData((d) => ws.readyState === ws.OPEN && ws.send(d))
    const onResize = () => {
      fit.fit()
      if (ws.readyState === ws.OPEN) ws.send(`\u0000resize:${term.cols}x${term.rows}`)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(host.current!)
    ws.onopen = onResize
    term.focus()
    return () => {
      ro.disconnect()
      sub.dispose()
      ws.close()
      term.dispose()
    }
  }, [win])

  return <div className="term-host" ref={host} />
}
