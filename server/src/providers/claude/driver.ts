import fs from 'node:fs'
import path from 'node:path'
import type {ProviderDriver,ProviderState} from '../../provider-types.js'
import {config} from './config.js'
import {q} from './db.js'
import * as tmux from './tmux.js'
import {Manager,convState} from './manager.js'
import {approvedPath} from './paths.js'
export {approvedPath} from './paths.js'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/

export type ClaudeDriverOptions = {manager?:Manager; store?:typeof q; tmux?:typeof tmux; expectedVersion?:string; loginTimeoutMs?:number}
export class ClaudeDriver implements ProviderDriver {
  readonly manager: Manager
  private store: typeof q
  private tmux: typeof tmux
  private server: ProviderState['server'] = {state:'iniciando',detail:'Comprobando la versión fijada de Claude…',restarts:0}
  private login: ProviderState['login'] = {state:'idle'}
  private loginTimer?: NodeJS.Timeout
  private loginGeneration = 0
  private expectedVersion: string
  private managerStarted = false
  private closing = false
  constructor(private options:ClaudeDriverOptions = {}) {
    this.manager = options.manager ?? new Manager()
    this.store = options.store ?? this.manager.dependencies.store
    this.tmux = options.tmux ?? this.manager.dependencies.tmux
    this.expectedVersion = options.expectedVersion ?? config.expectedVersion
  }

  async boot() {
    if (process.env.RC_CLAUDE_INTEGRITY_ERROR) throw new Error('La comprobación de integridad de Claude falló')
    const version = await this.manager.dependencies.claudeVersion()
    if (this.closing) return
    this.manager.claudeVersion = version
    if (version!==this.expectedVersion) {
      this.server = {state:'incompatible',detail:'El binario de Claude no coincide con CLAUDE_VERSION; su gestor quedó detenido',restarts:0}
      return
    }
    try {
      this.managerStarted = true
      await this.manager.boot()
      if (this.closing) return
      this.server = {state:'disponible',detail:'Gestor de Claude disponible; cada proyecto conserva su estado y recuperación propios',restarts:0}
    } catch {
      this.server = {state:'caido',detail:'No se pudo iniciar el gestor de Claude. Sus datos se conservan.',restarts:0}
    }
  }

  private legacyState() {
    const conversations = this.store.conversations()
    return {
      version:config.version,claudeVersion:this.manager.claudeVersion,account:{...this.manager.account},
      autoRescue:this.manager.autoRescue,crash:this.manager.crash,namePrefix:config.namePrefix,
      projects:this.store.projects().map(project=> {
        const runtime = this.manager.runtime(project.name)
        return {
          name:project.name,dir:project.dir,spawn:project.spawn,autostart:project.autostart===1,
          desired:project.desired,trust:project.trust===1,remoteName:`${config.namePrefix}-${project.name}`,
          state:runtime.state,detail:runtime.detail,prompt:runtime.prompt,capacity:runtime.capacity,
          conversations:conversations.filter(conversation=>conversation.project===project.name).map(conversation=>({
            remoteId:conversation.remote_id,title:conversation.title,lastActivity:conversation.last_activity,
            state:conversation.orphan ? (runtime.rescuing?'recuperando':'atencion') : conversation.active ? convState(conversation.status) : 'reposo',
            rescueError:conversation.rescue_error||null,url:`https://claude.ai/code/${conversation.remote_id}`,
          })),
        }
      }),events:this.store.events(200),
    }
  }

  state(): ProviderState {
    const account = this.manager.account
    return {
      provider:'claude',cliVersion:this.manager.claudeVersion,
      account:{loggedIn:account.loggedIn,
        ...(typeof account.email==='string'?{email:account.email}:{}),
        ...(typeof account.plan==='string'?{plan:account.plan}:{}),
        ...(typeof account.method==='string'?{method:account.method}:{})},
      server:{...this.server},login:{...this.login},details:this.legacyState(),
    }
  }

  private assertReady() {
    if (this.server.state!=='disponible') throw new Error('El gestor de Claude no está disponible')
  }
  private projectName(args:Record<string,any>) {
    const name = args.name
    if (typeof name!=='string' || !NAME_RE.test(name)) throw new Error('Nombre de proyecto no válido')
    if (!this.store.project(name)) throw new Error('Proyecto no encontrado')
    return name
  }
  private finishLogin(state:ProviderState['login']['state'],message:string) {
    ++this.loginGeneration
    clearTimeout(this.loginTimer)
    this.login = {state,message}
  }

  async request(action:string,args:Record<string,any>):Promise<unknown> {
    if (action==='state') return this.state()
    this.assertReady()
    if (action==='login.start') {
      if (this.login.state==='pending') return {url:this.login.verificationUrl??null,...this.login}
      clearTimeout(this.loginTimer)
      const generation = ++this.loginGeneration
      this.login = {state:'pending',needsCodeInput:true,message:'Solicitando el enlace oficial de Claude…'}
      this.loginTimer = setTimeout(()=> {
        if (generation!==this.loginGeneration) return
        this.finishLogin('expired','El intento de inicio de sesión caducó. Solicita un enlace nuevo.')
        void this.tmux.killWindow('cuenta')
      },this.options.loginTimeoutMs??15*60_000)
      this.loginTimer.unref()
      try {
        const result = await this.manager.startLogin()
        if (generation!==this.loginGeneration) return {url:null,...this.login}
        if (result.url) this.login = {state:'pending',verificationUrl:result.url,needsCodeInput:true,message:'Abre el enlace oficial y pega aquí el código que entregue Claude.'}
        else if (this.manager.lastLoginSucceeded) this.finishLogin('success','Sesión iniciada')
        else this.finishLogin('error','Claude no entregó el enlace esperado. Solicita otro intento o revisa su terminal de cuenta.')
      } catch { if (generation===this.loginGeneration) this.finishLogin('error','No se pudo iniciar el flujo oficial de Claude') }
      return {url:this.login.verificationUrl??null,...this.login}
    }
    if (action==='login.code') {
      if (this.login.state!=='pending') throw new Error('Solicita primero un enlace de inicio de sesión')
      if (typeof args.code!=='string' || !/^[\w#.~\-]{8,400}$/.test(args.code.trim())) throw new Error('El código no tiene el formato esperado')
      const generation = this.loginGeneration
      const result = await this.manager.sendLoginCode(args.code)
      if (generation===this.loginGeneration) this.finishLogin(result.ok?'success':'error',result.message)
      return result
    }
    if (action==='login.cancel') {
      this.finishLogin('idle','Inicio de sesión cancelado')
      await this.tmux.killWindow('cuenta')
      return {...this.login}
    }
    if (action==='account.refresh' || action==='login.refresh') { await this.manager.checkAuth(true); return this.state().account }
    if (action==='settings.update') {
      if (typeof args.autoRescue!=='boolean') throw new Error('Ajuste de recuperación no válido')
      this.store.setMeta('autoRescue',args.autoRescue?'1':'0')
      return this.state()
    }
    if (action==='projects.add') {
      if (typeof args.name!=='string' || !NAME_RE.test(args.name)) throw new Error('Nombre de proyecto no válido')
      if (this.store.project(args.name)) throw new Error('Ya existe ese proyecto de Claude')
      const dir = approvedPath(args.path)
      if (this.store.projects().some(project=>project.dir===dir)) throw new Error('Claude ya tiene un proyecto para esa carpeta')
      const spawn = args.spawn==='worktree'?'worktree':'same-dir'
      if (spawn==='worktree' && !fs.existsSync(path.join(dir,'.git'))) throw new Error('El modo worktree necesita un repositorio git')
      this.store.addProject({name:args.name,dir,spawn,autostart:args.autostart===false?0:1,trust:args.trust===true?1:0})
      this.store.event(args.name,'info','Proyecto de Claude añadido desde el panel')
      return this.state()
    }
    if (action==='terminal.open') {
      await this.tmux.ensureSession()
      const window = args.name===undefined ? 'cuenta' : `p-${this.projectName(args)}`
      if (args.name!==undefined) {
        const project = this.store.project(args.name)!
        if (!project.trust) throw new Error('Confirma la confianza antes de abrir el terminal')
        if (approvedPath(project.dir)!==project.dir) throw new Error('La carpeta cambió de destino; revisa el proyecto')
      }
      const panes = await this.tmux.panes()
      if (window==='cuenta' && (!panes.has(window) || panes.get(window)?.dead))
        await this.tmux.runIn(window,config.dataDir,['bash'],{DISABLE_UPDATES:'1'})
      else if (!panes.has(window)) throw new Error('Arranca el proyecto para crear su terminal de Remote Control')
      return {window,tmuxSocket:config.tmuxSocket,tmuxSession:config.tmuxSession}
    }
    if (action.startsWith('projects.')) {
      const name = this.projectName(args)
      if (action==='projects.start') await this.manager.startProject(name)
      else if (action==='projects.stop') await this.manager.stopProject(name)
      else if (action==='projects.restart') await this.manager.restartProject(name)
      else if (action==='projects.remove') await this.manager.removeProject(name)
      else if (action==='projects.prompt') {
        if (typeof args.yes!=='boolean') throw new Error('Respuesta no válida')
        await this.manager.answer(name,args.yes)
      } else if (action==='projects.update') {
        if (typeof args.trust==='boolean') {
          this.store.setProject(name,'trust',args.trust?1:0)
          if (!args.trust) {
            await this.manager.stopProject(name)
            await this.tmux.killWindow(`p-${name}`)
          }
        }
        if (typeof args.autostart==='boolean') this.store.setProject(name,'autostart',args.autostart?1:0)
        if (args.spawn!==undefined) {
          if (!['same-dir','worktree'].includes(args.spawn)) throw new Error('Modo de ejecución no válido')
          if (args.spawn==='worktree' && !fs.existsSync(path.join(this.store.project(name)!.dir,'.git'))) throw new Error('El modo worktree necesita un repositorio git')
          this.store.setProject(name,'spawn',args.spawn)
          if (args.trust!==false) await this.manager.restartProject(name)
        }
      } else if (action==='projects.rescue') {
        const candidates = this.store.conversations().filter(conversation=>conversation.project===name)
        const ids = args.remoteIds===undefined ? candidates.filter(conversation=>conversation.orphan).map(conversation=>conversation.remote_id) : args.remoteIds
        if (!Array.isArray(ids) || ids.some(id=>typeof id!=='string' || !candidates.some(conversation=>conversation.remote_id===id))) throw new Error('Conversación ajena al proyecto')
        // Igual que la ruta legacy202: el rescate puede tardar90s por conversación;
        // su progreso sale por state sin agotar el timeout IPC del supervisor.
        void this.manager.rescue(name,ids).catch(()=>this.store.event(name,'error','No se pudo completar el rescate de Claude; las conversaciones se conservan'))
        return {accepted:true}
      } else throw new Error('Acción de Claude desconocida')
      return this.state()
    }
    throw new Error('Acción de Claude desconocida')
  }

  async shutdown() {
    this.closing = true
    this.finishLogin('idle','Gestor detenido')
    if (this.managerStarted) await this.manager.shutdown()
    this.server = {...this.server,state:'detenido',detail:'Gestor de Claude detenido; las preferencias de sus proyectos se conservan'}
  }
}
