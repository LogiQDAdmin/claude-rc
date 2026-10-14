import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import {WebSocketServer} from 'ws'
import * as pty from 'node-pty'
import {config} from './config.js'
import {q} from './db.js'
import {manager, convState} from './manager.js'
import * as tmux from './tmux.js'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'})
  res.end(JSON.stringify(body))
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 64 * 1024) throw new HttpError(413, 'Petición demasiado grande')
  }
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw new HttpError(400, 'JSON no válido')
  }
}

function authorized(req: http.IncomingMessage) {
  if (!config.panelPassword) return true
  const h = req.headers.authorization ?? ''
  if (!h.startsWith('Basic ')) return false
  const [, pass] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s)
  const a = Buffer.from(pass ?? '')
  const b = Buffer.from(config.panelPassword)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function insideRoots(dir: string) {
  const abs = path.resolve(dir)
  return config.projectRoots.some((root) => abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep))
}

function listFolders() {
  const used = new Set(q.projects().map((p) => p.dir))
  return config.projectRoots.map((root) => {
    let dirs: string[] = []
    let mounted = false
    try {
      dirs = fs.readdirSync(root, {withFileTypes: true}).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort()
      mounted = true
    } catch {}
    return {
      root,
      mounted,
      folders: dirs.map((d) => {
        const full = path.join(root, d)
        return {path: full, name: d, git: fs.existsSync(path.join(full, '.git')), used: used.has(full)}
      }),
    }
  })
}

function state() {
  const convs = q.conversations()
  return {
    version: config.version,
    claudeVersion: manager.claudeVersion,
    account: manager.account,
    autoRescue: manager.autoRescue,
    crash: manager.crash,
    namePrefix: config.namePrefix,
    projects: q.projects().map((p) => {
      const r = manager.runtime(p.name)
      return {
        name: p.name, dir: p.dir, spawn: p.spawn, autostart: p.autostart === 1, desired: p.desired, trust: p.trust === 1,
        remoteName: `${config.namePrefix}-${p.name}`,
        state: r.state, detail: r.detail, prompt: r.prompt, capacity: r.capacity,
        conversations: convs.filter((c) => c.project === p.name).map((c) => ({
          remoteId: c.remote_id, title: c.title, lastActivity: c.last_activity,
          state: c.orphan ? (r.rescuing ? 'recuperando' : 'atencion') : c.active ? convState(c.status) : 'reposo',
          rescueError: c.rescue_error || null,
          url: `https://claude.ai/code/${c.remote_id}`,
        })),
      }
    }),
  }
}

async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const method = req.method ?? 'GET'
  const parts = url.pathname.split('/').filter(Boolean).slice(1) // sin "api"
  // Las peticiones que cambian algo llevan esta cabecera: un formulario de otra web no puede ponerla.
  if (method !== 'GET' && req.headers['x-rc'] !== '1') throw new HttpError(403, 'Falta la cabecera X-RC')

  if (method === 'GET' && parts[0] === 'state') return send(res, 200, state())
  if (method === 'GET' && parts[0] === 'events') return send(res, 200, q.events(Math.min(500, Number(url.searchParams.get('limit') ?? 200))))
  if (method === 'GET' && parts[0] === 'folders') return send(res, 200, listFolders())

  if (parts[0] === 'settings' && method === 'PATCH') {
    const body = await readJson(req)
    if (typeof body.autoRescue === 'boolean') q.setMeta('autoRescue', body.autoRescue ? '1' : '0')
    return send(res, 200, state())
  }

  if (parts[0] === 'account') {
    if (method === 'POST' && parts[1] === 'login') return send(res, 200, await manager.startLogin())
    if (method === 'POST' && parts[1] === 'code') {
      const {code} = await readJson(req)
      if (typeof code !== 'string' || !/^[\w#.~\-]{8,400}$/.test(code.trim())) throw new HttpError(400, 'Ese código no tiene el formato esperado')
      return send(res, 200, await manager.sendLoginCode(code))
    }
    if (method === 'POST' && parts[1] === 'refresh') {
      await manager.checkAuth(true)
      return send(res, 200, manager.account)
    }
  }

  if (parts[0] === 'projects') {
    if (method === 'POST' && parts.length === 1) {
      const b = await readJson(req)
      const name = String(b.name ?? '').trim()
      if (!NAME_RE.test(name)) throw new HttpError(400, 'Nombre: minúsculas, números y guiones (máx. 31)')
      if (q.project(name)) throw new HttpError(409, `Ya hay un proyecto llamado ${name}`)
      const dir = path.resolve(String(b.dir ?? ''))
      if (!insideRoots(dir)) throw new HttpError(400, 'La carpeta tiene que estar dentro de las carpetas autorizadas')
      if (q.projects().some((p) => p.dir === dir)) throw new HttpError(409, 'Esa carpeta ya es de otro proyecto')
      if (!fs.existsSync(dir)) {
        if (!b.create) throw new HttpError(400, 'La carpeta no existe')
        fs.mkdirSync(dir, {recursive: true})
      }
      const spawn = b.spawn === 'worktree' ? 'worktree' : 'same-dir'
      if (spawn === 'worktree' && !fs.existsSync(path.join(dir, '.git')))
        throw new HttpError(400, 'El modo worktree necesita que la carpeta sea un repositorio git con al menos un commit')
      q.addProject({name, dir, spawn, autostart: b.autostart === false ? 0 : 1, trust: b.trust ? 1 : 0})
      q.event(name, 'info', `Proyecto añadido: ${dir}`)
      return send(res, 201, state())
    }
    const name = parts[1]
    if (!name || !q.project(name)) throw new HttpError(404, 'Proyecto no encontrado')
    if (method === 'PATCH') {
      const b = await readJson(req)
      if (typeof b.autostart === 'boolean') q.setProject(name, 'autostart', b.autostart ? 1 : 0)
      if (b.spawn === 'same-dir' || b.spawn === 'worktree') {
        q.setProject(name, 'spawn', b.spawn)
        await manager.restartProject(name)
      }
      return send(res, 200, state())
    }
    if (method === 'DELETE') {
      await manager.removeProject(name)
      return send(res, 200, state())
    }
    if (method === 'POST') {
      const action = parts[2]
      if (action === 'start') await manager.startProject(name)
      else if (action === 'stop') await manager.stopProject(name)
      else if (action === 'restart') await manager.restartProject(name)
      else if (action === 'answer') await manager.answer(name, Boolean((await readJson(req)).yes))
      else throw new HttpError(404, 'Acción desconocida')
      return send(res, 200, state())
    }
  }

  if (parts[0] === 'conversations' && method === 'POST' && parts[2] === 'rescue') {
    const c = q.conversation(parts[1])
    if (!c) throw new HttpError(404, 'Conversación no encontrada')
    manager.rescue(c.project, [c.remote_id]).catch((e) => console.error(e))
    return send(res, 202, {ok: true})
  }

  throw new HttpError(404, 'No encontrado')
}

function serveStatic(res: http.ServerResponse, pathname: string) {
  const safe = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = path.join(config.webDir, safe)
  if (!file.startsWith(config.webDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(config.webDir, 'index.html')
  }
  if (!fs.existsSync(file)) {
    res.writeHead(500).end('Falta el panel compilado')
    return
  }
  const immutable = file.includes(`${path.sep}assets${path.sep}`)
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  fs.createReadStream(file).pipe(res)
}

export function startHttp() {
  const server = http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) {
        res.writeHead(401, {'www-authenticate': 'Basic realm="Remote Control"'}).end()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname.startsWith('/api/')) await api(req, res, url)
      else serveStatic(res, url.pathname)
    } catch (e: any) {
      if (e instanceof HttpError) send(res, e.status, {error: e.message})
      else {
        console.error(e)
        send(res, 500, {error: 'Error interno del gestor'})
      }
    }
  })

  // Terminal web: cada conexión es un cliente tmux propio (sesión agrupada) en la ventana pedida.
  const wss = new WebSocketServer({noServer: true})
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/api/term' || !authorized(req)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      const win = url.searchParams.get('w') ?? 'cuenta'
      if (!/^(cuenta|[pr]-[a-z0-9-]+)$/.test(win)) return ws.close()
      await tmux.ensureSession()
      const client = `term-${crypto.randomBytes(4).toString('hex')}`
      const [cmd, ...args] = tmux.tmuxAttachCommand(win, client)
      const term = pty.spawn(cmd, args, {
        name: 'xterm-256color', cols: Number(url.searchParams.get('cols') ?? 100), rows: Number(url.searchParams.get('rows') ?? 30),
        env: {...process.env, TERM: 'xterm-256color'} as Record<string, string>,
      })
      term.onData((d) => ws.readyState === ws.OPEN && ws.send(d))
      term.onExit(() => ws.close())
      ws.on('message', (raw) => {
        const msg = raw.toString()
        if (msg.startsWith('\u0000resize:')) {
          const [cols, rows] = msg.slice(8).split('x').map(Number)
          if (cols > 0 && rows > 0) term.resize(cols, rows)
        } else term.write(msg)
      })
      ws.on('close', () => term.kill())
    })
  })

  server.listen(config.port, () => console.log(`Panel en el puerto ${config.port}`))
  return server
}
