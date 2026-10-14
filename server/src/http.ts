import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import {WebSocketServer, type WebSocket} from 'ws'
import {config} from './config.js'
import type {Catalog} from './catalog.js'
import {Supervisor, ProviderError} from './supervisor.js'
import type {ProjectBinding,ProviderId,UnifiedProject} from './provider-types.js'
import {projectPath, ProjectPathError, listFolders} from './providers/codex/projects.js'

class HttpError extends Error { constructor(readonly status:number,message:string) { super(message) } }
const TYPES:Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2','.json':'application/json'}
const PROVIDERS:ProviderId[] = ['claude','codex']
function provider(input:string):ProviderId { if (!PROVIDERS.includes(input as ProviderId)) throw new HttpError(404,'Proveedor no encontrado'); return input as ProviderId }
function json(res:http.ServerResponse,status:number,value:unknown) { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(value)) }
async function body(req:http.IncomingMessage):Promise<Record<string,any>> {
  let bytes=0,raw=''
  for await (const chunk of req) { bytes+=chunk.length; if (bytes>64*1024) throw new HttpError(413,'Petición demasiado grande'); raw+=chunk }
  try { const value=raw?JSON.parse(raw):{}; if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error(); return value } catch { throw new HttpError(400,'JSON no válido') }
}
type Terminal = {provider:ProviderId;window:string;tmuxSocket:string;tmuxSession:string;project?:number;clients:Set<WebSocket>}
export type PanelOptions = typeof config

export function createPanel(catalog:Catalog,supervisor:Supervisor,options:PanelOptions=config) {
  const terminals = new Map<string,Terminal>()
  const terminalKey = (p:ProviderId,w:string) => `${p}:${w}`
  const revoke = (p:ProviderId,id?:number) => {
    for (const [key,terminal] of terminals) if (terminal.provider===p && (id===undefined || terminal.project===id)) {
      for (const ws of terminal.clients) ws.close(1012,'Terminal detenido')
      terminals.delete(key)
    }
  }
  function authorized(req:http.IncomingMessage) {
    if (!options.panelPassword) return true
    const header=req.headers.authorization??''
    if (!header.startsWith('Basic ')) return false
    const decoded=Buffer.from(header.slice(6),'base64').toString(),colon=decoded.indexOf(':')
    if (decoded.slice(0,colon)!=='admin') return false
    const got=Buffer.from(decoded.slice(colon+1)),expected=Buffer.from(options.panelPassword)
    return got.length===expected.length && crypto.timingSafeEqual(got,expected)
  }
  const sameOrigin = (req:http.IncomingMessage) => {
    const origin=req.headers.origin
    if (!origin) return false
    try { const parsed=new URL(origin); return ['http:','https:'].includes(parsed.protocol) && parsed.host===req.headers.host } catch { return false }
  }
  function binding(p:UnifiedProject,pid:ProviderId):ProjectBinding {
    const found=p.bindings.find(row=>row.provider===pid)
    if (!found) throw new HttpError(404,'Ese proveedor no está asociado al proyecto')
    return found
  }
  function project(identifier:string,legacy=false):UnifiedProject {
    const projects=catalog.projects()
    const found=legacy?projects.find(row=>row.bindings.some(b=>b.provider==='claude'&&b.key===identifier)):projects.find(row=>String(row.id)===identifier)
    if (!found) throw new HttpError(404,'Proyecto no encontrado')
    return found
  }
  function legacyArgs(b:ProjectBinding) { return b.provider==='claude'?{name:b.key}:{id:Number(b.key)} }
  const detailFor = (_p:UnifiedProject,b:ProjectBinding) => {
    const state=supervisor.state(b.provider),records=state.details?.projects
    const found=Array.isArray(records)?records.find(row=>b.provider==='claude'?row.name===b.key:String(row.id)===b.key):undefined
    if (state.worker?.state!=='ready') return {...b,state:state.server.state,detail:state.server.detail,conversations:found?.conversations??[]}
    return {...b,...(found??{}),provider:b.provider,key:b.key,trust:found?.trust??b.trust}
  }
  function state() {
    const claude=supervisor.state('claude'),codex=supervisor.state('codex')
    return {...(claude.details??{}),version:options.version,providers:{claude,codex},unifiedProjects:catalog.projects().map(p=>({...p,bindings:p.bindings.map(b=>detailFor(p,b))}))}
  }
  let imported=false
  supervisor.subscribe(()=>{
    if (!imported && supervisor.state('claude').worker?.state==='ready') { catalog.importLegacy(); imported=true }
    for (const p of PROVIDERS) if (supervisor.state(p).worker?.state!=='ready') revoke(p)
  })
  async function addBinding(p:UnifiedProject,pid:ProviderId,b:Record<string,any>) {
    if (p.bindings.some(row=>row.provider===pid)) throw new HttpError(409,'El proveedor ya está asociado')
    const spawn=b.spawn==='worktree'?'worktree':'same-dir'
    if (pid==='codex'&&spawn==='worktree') throw new HttpError(400,'Para Codex elige directamente la carpeta de un worktree existente')
    if (spawn==='worktree'&&!fs.existsSync(path.join(p.path,'.git'))) throw new HttpError(400,'El modo worktree necesita un repositorio git con al menos un commit')
    const legacyName=/^[a-z0-9][a-z0-9-]{0,30}$/.test(p.name) && !catalog.projects().some(row=>row.bindings.some(link=>link.provider==='claude'&&link.key===p.name))?p.name:`rc-${p.id}`
    const record=await supervisor.request(pid,'projects.add',{name:pid==='claude'?legacyName:p.name,path:p.path,spawn,trust:b.trust===true,autostart:b.autostart})
    const key=pid==='claude'?legacyName:String(record?.id)
    if (!key||key==='undefined') throw new HttpError(502,'El proveedor devolvió un proyecto sin identificador')
    catalog.bind(p.id,pid,key,b.trust===true,spawn)
  }
  async function removeBinding(p:UnifiedProject,pid:ProviderId) {
    const b=binding(p,pid); revoke(pid,p.id)
    await supervisor.request(pid,'projects.remove',legacyArgs(b)); catalog.unbind(p.id,pid)
  }
  async function openTerminal(pid:ProviderId,p?:UnifiedProject) {
    const b=p?binding(p,pid):undefined
    if (b&&!b.trust) throw new HttpError(403,'Da confianza al proyecto antes de abrir su terminal')
    if (p) projectPath(p.path,options.projectRoots)
    if (!p&&pid==='codex') throw new HttpError(409,'Abre Codex desde un proyecto; su login de dispositivo está en el panel')
    const spec=await supervisor.request(pid,'terminal.open',b?legacyArgs(b):{})
    const socket=pid==='claude'?(process.env.CLAUDE_TMUX_SOCKET??'agent-rc-claude'):(process.env.CODEX_TMUX_SOCKET??'agent-rc-codex')
    if (!spec || typeof spec.window!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(spec.window) || spec.tmuxSocket!==socket || typeof spec.tmuxSession!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(spec.tmuxSession)) throw new HttpError(502,'El proveedor cambió el formato del terminal')
    const key=terminalKey(pid,spec.window),existing=terminals.get(key)
    terminals.set(key,{provider:pid,window:spec.window,tmuxSocket:spec.tmuxSocket,tmuxSession:spec.tmuxSession,project:p?.id,clients:existing?.clients??new Set()})
    return {provider:pid,window:spec.window}
  }
  async function projectAction(p:UnifiedProject,pid:ProviderId,action:string,b:Record<string,any>) {
    if (action==='terminal') return openTerminal(pid,p)
    if (pid==='codex') throw new HttpError(409,'Codex usa el app-server del proveedor y un terminal por proyecto')
    if (!['start','stop','restart','rescue','prompt','answer'].includes(action)) throw new HttpError(404,'Acción desconocida')
    const args={...b,...legacyArgs(binding(p,pid))}
    if (action==='stop'||action==='restart') revoke(pid,p.id)
    await supervisor.request(pid,action==='rescue'?'projects.rescue':action==='prompt'||action==='answer'?'projects.prompt':`projects.${action}`,args)
    return state()
  }
  async function api(req:http.IncomingMessage,res:http.ServerResponse,url:URL) {
    const method=req.method??'GET',parts=url.pathname.split('/').filter(Boolean).slice(1)
    if (method!=='GET' && (req.headers['x-rc']!=='1'||(req.headers.origin&&!sameOrigin(req)))) throw new HttpError(403,'Petición de otro origen o falta X-RC')
    if (method==='GET'&&parts[0]==='state') return json(res,200,state())
    if (method==='GET'&&parts[0]==='folders') return json(res,200,listFolders(options.projectRoots,catalog.projects().map(p=>p.path)))
    if (method==='GET'&&parts[0]==='events') return json(res,200,supervisor.state('claude').details?.events??[])
    if (parts[0]==='providers') {
      const pid=provider(parts[1])
      if (method==='GET'&&parts[2]==='events') return json(res,200,supervisor.state(pid).details?.events??[])
      if (method==='POST'&&parts[2]==='account') {
        const action=parts[3]
        if (!['login','cancel','code','refresh'].includes(action)) throw new HttpError(404,'Acción de cuenta desconocida')
        if (pid==='codex'&&action==='code') throw new HttpError(400,'Completa el código de dispositivo en la web de OpenAI')
        return json(res,200,await supervisor.request(pid,`login.${action==='login'?'start':action}`,await body(req)))
      }
      if (method==='POST'&&parts[2]==='server') {
        const action=parts[3]; revoke(pid)
        if (action==='stop') await supervisor.stop(pid)
        else if (action==='start') supervisor.start(pid)
        else if (action==='restart') await supervisor.restart(pid)
        else throw new HttpError(404,'Acción de servidor desconocida')
        return json(res,200,state())
      }
      if (method==='PATCH'&&parts[2]==='settings') return json(res,200,await supervisor.request(pid,'settings.update',await body(req)))
      if (method==='POST'&&parts[2]==='pair'&&pid==='codex') return json(res,200,await supervisor.request(pid,'remote.pair'))
      if (method==='POST'&&parts[2]==='terminal') return json(res,200,await openTerminal(pid))
    }
    // Compatibility routes keep the 0.1.1 account and project actions available.
    if (parts[0]==='account'&&method==='POST') {
      const action=parts[1]
      if (!['login','code','refresh','cancel'].includes(action)) throw new HttpError(404,'Acción desconocida')
      return json(res,200,await supervisor.request('claude',`login.${action==='login'?'start':action}`,await body(req)))
    }
    if (parts[0]==='settings'&&method==='PATCH') { await supervisor.request('claude','settings.update',await body(req)); return json(res,200,state()) }
    if (parts[0]==='conversations'&&method==='POST'&&parts[2]==='rescue') {
      const p=catalog.projects().find(row=>row.bindings.some(b=>b.provider==='claude'&&(detailFor(row,b).conversations??[]).some((c:any)=>c.remoteId===parts[1])))
      if (!p) throw new HttpError(404,'Conversación no encontrada')
      await projectAction(p,'claude','rescue',{remoteIds:[parts[1]]}); return json(res,202,{ok:true})
    }
    if (parts[0]==='projects') {
      if (method==='POST'&&parts.length===1) {
        const b=await body(req),name=typeof b.name==='string'?b.name.trim():''
        if (!name||name.length>80||/[\x00-\x1f\x7f]/.test(name)) throw new HttpError(400,'Nombre de proyecto no válido')
        const selected=b.providers===undefined?['claude']:b.providers
        if (!Array.isArray(selected)||!selected.length||selected.length>2||new Set(selected).size!==selected.length||!selected.every(p=>PROVIDERS.includes(p))) throw new HttpError(400,'Elige Claude, Codex o ambos')
        for (const pid of selected as ProviderId[]) if (supervisor.state(pid).worker?.state!=='ready') throw new ProviderError(`El proceso de ${pid} no está disponible`)
        const directory=projectPath(b.path??b.dir,options.projectRoots,b.create===true)
        if (catalog.projects().some(p=>p.path===directory||p.name===name)) throw new HttpError(409,'El nombre o la carpeta ya están en el gestor; añade el otro proveedor al proyecto existente')
        const p=catalog.add(name,directory)
        try { for (const pid of selected as ProviderId[]) await addBinding(catalog.project(p.id)!,pid,{...b,spawn:pid==='codex'?'same-dir':b.spawn}) }
        catch (error) {
          // Retain a successfully linked provider if its sibling rejects creation.
          // Never delete the user's files as compensation for a failed request.
          if (!catalog.bindings(p.id).length) catalog.remove(p.id)
          throw error
        }
        return json(res,201,state())
      }
      const legacy=parts.length<3||parts[2]!=='providers'
      // Legacy action URLs carry a name, which can legally be all digits.
      // Provider URLs and the new catalog deletion route use numeric IDs.
      const legacyAction=method==='POST'&&parts.length===3&&parts[2]!=='providers'
      const p=project(parts[1],legacyAction||(legacy&&!/^\d+$/.test(parts[1])))
      if (method==='DELETE'&&parts.length===2) { for (const b of p.bindings) await removeBinding(p,b.provider); catalog.remove(p.id); return json(res,200,state()) }
      if (parts[2]==='providers') {
        if (method==='POST'&&parts.length===3) { const b=await body(req); await addBinding(p,provider(b.provider),b); return json(res,201,state()) }
        const pid=provider(parts[3]),link=binding(p,pid)
        if (method==='DELETE'&&parts.length===4) { await removeBinding(p,pid); return json(res,200,state()) }
        if (method==='PATCH'&&parts.length===4) {
          const b=await body(req)
          if (b.trust===false||b.spawn!==undefined) revoke(pid,p.id)
          await supervisor.request(pid,'projects.update',{...b,...legacyArgs(link)})
          catalog.bind(p.id,pid,link.key,typeof b.trust==='boolean'?b.trust:link.trust,b.spawn==='same-dir'||b.spawn==='worktree'?b.spawn:link.spawn)
          return json(res,200,state())
        }
        if (method==='POST'&&parts.length===5) return json(res,200,await projectAction(p,pid,parts[4],await body(req)))
      }
      if (method==='PATCH'&&parts.length===2) { const b=await body(req),link=binding(p,'claude'); if (b.trust===false||b.spawn!==undefined) revoke('claude',p.id); await supervisor.request('claude','projects.update',{...b,...legacyArgs(link)}); catalog.bind(p.id,'claude',link.key,typeof b.trust==='boolean'?b.trust:link.trust,b.spawn==='worktree'?'worktree':link.spawn); return json(res,200,state()) }
      if (method==='POST'&&parts.length===3) return json(res,200,await projectAction(p,'claude',parts[2],await body(req)))
    }
    throw new HttpError(404,'No encontrado')
  }
  function serveStatic(res:http.ServerResponse,pathname:string) {
    const decoded=decodeURIComponent(pathname),candidate=path.resolve(options.webDir,'.'+decoded)
    if (candidate!==path.resolve(options.webDir)&&!candidate.startsWith(path.resolve(options.webDir)+path.sep)) throw new HttpError(404,'No encontrado')
    const file=fs.existsSync(candidate)&&fs.statSync(candidate).isFile()?candidate:path.join(options.webDir,'index.html')
    if (!fs.existsSync(file)) throw new HttpError(503,'Falta el panel compilado')
    res.writeHead(200,{'content-type':TYPES[path.extname(file)]??'application/octet-stream','cache-control':file.includes(`${path.sep}assets${path.sep}`)?'public, max-age=31536000, immutable':'no-cache'})
    fs.createReadStream(file).pipe(res)
  }
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url??'/','http://localhost')
      // Health probes belong to the panel, even without credentials or workers.
      if (req.method==='GET'&&url.pathname==='/healthz') return json(res,200,{ok:true,service:'remote-control',version:options.version})
      if (!authorized(req)) { res.writeHead(401,{'www-authenticate':'Basic realm="Remote Control"'}).end(); return }
      if (url.pathname.startsWith('/api/')) await api(req,res,url)
      else serveStatic(res,url.pathname)
    } catch(error) {
      const status=error instanceof HttpError||error instanceof ProviderError?error.status:error instanceof ProjectPathError?400:500
      json(res,status,{error:status===500?'Error interno del gestor':(error as Error).message})
    }
  })
  const wss=new WebSocketServer({noServer:true,maxPayload:64*1024})
  server.on('upgrade',(req,socket,head)=>{
    void (async()=>{
      const url=new URL(req.url??'/','http://localhost')
      if (url.pathname!=='/api/term'||!authorized(req)||!sameOrigin(req)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return }
      const pid=provider(url.searchParams.get('provider')??'claude'),window=url.searchParams.get('w')??'cuenta'
      let terminal=terminals.get(terminalKey(pid,window))
      // The old panel opened Claude windows directly. Validate their project and
      // trust before creating the explicit terminal registry used by the new UI.
      if (!terminal&&pid==='claude') {
        if (window==='cuenta') await openTerminal(pid)
        else {
          const p=catalog.projects().find(row=>row.bindings.some(b=>b.provider==='claude'&&`p-${b.key}`===window))
          if (p) await openTerminal(pid,p)
        }
        terminal=terminals.get(terminalKey(pid,window))
      }
      if (!terminal||supervisor.state(pid).worker?.state!=='ready') throw new HttpError(403,'Terminal no autorizado')
      const spec=terminal
      wss.handleUpgrade(req,socket,head,async ws=>{
        spec.clients.add(ws)
        try {
          const pty=await import('node-pty'),client=`term-${crypto.randomBytes(6).toString('hex')}`
          const dimension=(value:string|null|undefined,fallback:number,max:number)=>Math.min(max,Math.max(1,Number.isFinite(Number(value))&&Number(value)>0?Math.floor(Number(value)):fallback))
          const term=pty.spawn('tmux',['-L',spec.tmuxSocket,'new-session','-t',spec.tmuxSession,'-s',client,';','set-option','destroy-unattached','on',';','set-option','status','off',';','select-window','-t',`${client}:${spec.window}`],{name:'xterm-256color',cols:dimension(url.searchParams.get('cols'),100,400),rows:dimension(url.searchParams.get('rows'),30,200),env:{...process.env,TERM:'xterm-256color'} as Record<string,string>})
          term.onData(data=>{ if (ws.readyState===ws.OPEN) ws.send(data) })
          term.onExit(()=>ws.close())
          ws.on('message',raw=>{
            const value=raw.toString()
            if (value.startsWith('\u0000resize:')) { const [cols,rows]=value.slice(8).split('x'); term.resize(dimension(cols,100,400),dimension(rows,30,200)) }
            else term.write(value)
          })
          ws.on('close',()=>{ spec.clients.delete(ws); try { term.kill() } catch {} })
          if (ws.readyState!==ws.OPEN) { try { term.kill() } catch {} }
        } catch { spec.clients.delete(ws); ws.close(1011,'El terminal del proveedor no pudo abrirse') }
      })
    })().catch(()=>{ socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy() })
  })
  server.on('close',()=>{ for (const p of PROVIDERS) revoke(p); wss.close() })
  return {server,state,revoke,terminals}
}
