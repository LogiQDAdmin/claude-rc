import fs from 'node:fs'
import path from 'node:path'
import {spawn, execFile, type ChildProcess} from 'node:child_process'
import {promisify} from 'node:util'
import {config} from './config.js'
import {q} from './db.js'
import {DeviceLogin, killOwnProcess} from './login.js'
import {RpcClient, CodexFailure, validateInitialize, validateAccount, validateRemoteStatus, validatePairing, type Account, type RemoteStatus} from './protocol.js'
import {projectPath} from './projects.js'
import * as tmux from './tmux.js'

const run = promisify(execFile)
type ServerState = {state:'iniciando'|'disponible'|'caido'|'incompatible'|'detenido'; detail:string; restarts:number; experimental:true; lastError?:string; remoteControl?:RemoteStatus}
const env = () => ({...process.env,HOME:config.home,CODEX_HOME:config.codexHome})
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve,ms))

export class Manager {
  account: Account = {loggedIn:false}
  server: ServerState = {state:'detenido',detail:'El app-server está detenido',restarts:Number(q.meta('restarts') ?? 0),experimental:true}
  login = new DeviceLogin({binary:config.codexBinary,env:env(),timeoutMs:config.loginTimeoutMs,
    onEvent:message => q.event('info',message),
    onComplete:() => { this.restartServer().catch(() => {/* El estado ya contiene el fallo. */}) },
  })
  private child?: ChildProcess
  private rpc?: RpcClient
  private generation = 0
  private retry?: NodeJS.Timeout
  private monitor?: NodeJS.Timeout
  private refreshing = false
  private closing = false
  private launched = false
  private failures = 0
  private chain: Promise<void> = Promise.resolve()
  private windows = new Set<string>()

  state() {
    return {
      version:config.version,codexVersion:config.codexVersion,account:{...this.account},server:{...this.server},
      login:{...this.login.state},
      projects:q.projects().map(p => ({id:p.id,name:p.name,path:p.path,trust:p.trust===1,
        ...(this.windows.has(`p-${p.id}`) ? {terminalWindow:`p-${p.id}`} : {})})),events:q.events(),
    }
  }

  async boot() {
    fs.mkdirSync(config.home,{recursive:true,mode:0o700})
    fs.mkdirSync(config.codexHome,{recursive:true})
    fs.mkdirSync(path.dirname(config.codexSocket),{recursive:true})
    fs.mkdirSync(path.join(config.dataDir,'proyectos'),{recursive:true})
    if (q.meta('serverDesired') !== '0') await this.startServer()
    this.monitor = setInterval(() => { void this.refreshAccount().catch(() => {}) },5000)
    this.monitor.unref()
  }

  private serial(task: () => Promise<void>) {
    const result = this.chain.then(task)
    this.chain = result.catch(() => {})
    return result
  }

  startServer() {
    q.setMeta('serverDesired','1')
    return this.serial(async () => {
      if (this.closing || this.server.state === 'disponible' || this.server.state === 'iniciando') return
      clearTimeout(this.retry)
      await this.launch()
    })
  }

  stopServer() {
    q.setMeta('serverDesired','0')
    return this.serial(async () => {
      await this.stopOwnServer()
      this.account = {loggedIn:false}
      this.server = {...this.server,state:'detenido',detail:'El app-server está detenido',remoteControl:undefined,lastError:undefined}
      q.event('info','App-server detenido por el usuario')
    })
  }

  restartServer() {
    q.setMeta('serverDesired','1')
    return this.serial(async () => {
      await this.stopOwnServer()
      this.failures = 0
      await this.launch()
    })
  }

  private async stopOwnServer() {
    ++this.generation
    clearTimeout(this.retry)
    this.rpc?.close()
    this.rpc = undefined
    const child = this.child
    this.child = undefined
    if (child?.pid && child.exitCode === null) {
      killOwnProcess(child)
      await Promise.race([new Promise<void>(resolve => child.once('exit',() => resolve())),pause(3000)])
    }
  }

  private async launch() {
    await this.stopOwnServer()
    if (this.closing) return
    const generation = ++this.generation
    this.account = {loggedIn:false}
    this.server = {...this.server,state:'iniciando',detail:'Comprobando Codex y abriendo su API local…',lastError:undefined,remoteControl:undefined}
    try {
      const {stdout} = await run(config.codexBinary,['--version'],{env:env(),timeout:5000,maxBuffer:4096})
      if (stdout.trim() !== `codex-cli ${config.codexVersion}`)
        throw new CodexFailure('protocol','El binario no coincide con CODEX_VERSION; se bloqueó el arranque')
    } catch (error) {
      this.failed(error instanceof CodexFailure ? error : new CodexFailure('network','No se pudo comprobar el binario fijado de Codex'),generation)
      return
    }
    if (generation !== this.generation) return
    // Solo se elimina el socket privado de esta app, después de parar su proceso.
    try { fs.unlinkSync(config.codexSocket) } catch {}
    if (this.launched) {
      this.server.restarts++
      q.setMeta('restarts',String(this.server.restarts))
    }
    this.launched = true
    const child = spawn(config.codexBinary,[
      '-c','check_for_update_on_startup=false',
      'app-server','--listen',`unix://${config.codexSocket}`,'--remote-control',
    ],{env:env(),cwd:config.dataDir,stdio:['ignore','ignore','ignore'],detached:false})
    this.child = child
    child.once('error',() => this.failed(new CodexFailure('network','No se pudo iniciar el app-server'),generation))
    child.once('exit',code => this.failed(new CodexFailure('network',`El app-server terminó (${code === null ? 'señal' : `código ${code}`})`),generation))
    q.event('info','Se inició el app-server directo con la versión fijada; no se usa el daemon gestionado')
    // Se espera al socket sin lanzar ni actualizar otro servidor.
    const deadline = Date.now()+15_000
    while (generation === this.generation && !fs.existsSync(config.codexSocket) && Date.now()<deadline) await pause(100)
    if (generation !== this.generation) return
    if (!fs.existsSync(config.codexSocket)) {
      this.failed(new CodexFailure('timeout','El app-server no creó su socket a tiempo'),generation)
      return
    }
    const rpc = new RpcClient(config.codexSocket,error => this.failed(error,generation))
    this.rpc = rpc
    try {
      await rpc.connect()
      const initialize = await rpc.call('initialize',{clientInfo:{name:'codex_rc_panel',title:'Codex RC',version:config.version},capabilities:{experimentalApi:true}})
      validateInitialize(initialize,config.codexVersion)
      rpc.notify('initialized')
      if (generation !== this.generation) return
      await this.refreshAccount(true)
      if (generation !== this.generation) return
      this.server.state = 'disponible'
      this.failures = 0
      this.describe()
      q.event('ok','API del app-server disponible y compatible con la versión fijada')
    } catch (error) {
      this.failed(error instanceof CodexFailure ? error : new CodexFailure('protocol','No se pudo validar el contrato del app-server'),generation)
    }
  }

  private describe() {
    if (!this.account.loggedIn) this.server.detail = 'API local disponible. Inicia sesión con el flujo de dispositivo para conectar Remote Control.'
    else if (this.server.remoteControl === 'connected') this.server.detail = 'API local y Remote Control conectados. Puedes generar un código de emparejamiento.'
    else if (this.server.remoteControl === 'errored') this.server.detail = 'API local disponible, pero Remote Control ha fallado. Reinicia el servidor para reintentar.'
    else if (this.server.remoteControl === 'disabled') this.server.detail = 'API local disponible; Remote Control está desactivado.'
    else this.server.detail = 'API local disponible. Remote Control está conectando…'
  }

  async refreshAccount(initial = false) {
    if (!this.rpc || this.refreshing || (!initial && this.server.state !== 'disponible')) return
    const rpc = this.rpc
    const generation = this.generation
    this.refreshing = true
    try {
      const account = validateAccount(await rpc.call('account/read',{refreshToken:false}))
      const remote = validateRemoteStatus(await rpc.call('remoteControl/status/read',{}))
      if (generation !== this.generation) return
      this.account = account
      this.server.remoteControl = remote
      if (this.server.state === 'disponible') this.describe()
    } catch (error) {
      if (initial) throw error
      this.failed(error instanceof CodexFailure ? error : new CodexFailure('protocol','El formato del app-server ha cambiado'),generation)
    } finally { this.refreshing = false }
  }

  private failed(error: CodexFailure,generation: number) {
    if (generation !== this.generation || this.closing) return
    ++this.generation // Ignora el exit que causa nuestra parada y callbacks antiguos.
    this.rpc?.close()
    this.rpc = undefined
    killOwnProcess(this.child)
    this.child = undefined
    this.account = {loggedIn:false}
    const incompatible = error.kind === 'protocol'
    this.server = {...this.server,state:incompatible ? 'incompatible' : 'caido',detail:error.message,lastError:error.message,remoteControl:undefined}
    q.event('error',error.message)
    clearTimeout(this.retry)
    if (incompatible || q.meta('serverDesired') === '0') return
    const delay = Math.min(120_000,10_000*2**Math.min(this.failures++,4))
    this.server.detail += ` Reintento automático en ${delay/1000} segundos.`
    this.retry = setTimeout(() => { void this.startServer().catch(() => {}) },delay)
    this.retry.unref()
  }

  startLogin() {
    if (this.server.state === 'incompatible') throw new Error('Corrige la incompatibilidad de Codex antes de iniciar sesión')
    return this.login.start()
  }
  cancelLogin() { return this.login.cancel() }

  async pair() {
    if (!this.rpc || this.server.state !== 'disponible' || !this.account.loggedIn) throw new Error('Inicia sesión y espera a que el app-server esté disponible')
    const rpc = this.rpc
    const generation = this.generation
    try { return validatePairing(await rpc.call('remoteControl/pairing/start',{manualCode:true})) }
    catch (error) {
      if (error instanceof CodexFailure && error.kind === 'protocol') this.failed(error,generation)
      throw new Error(error instanceof CodexFailure ? error.message : 'No se pudo generar el código de emparejamiento')
    }
  }

  async terminal(id: number) {
    if (this.server.state === 'incompatible') throw new Error('Corrige la incompatibilidad de Codex antes de abrir un terminal')
    const project = q.project(id)
    if (!project) throw new Error('Proyecto no encontrado')
    if (!project.trust) throw new Error('Confirma la confianza en el proyecto antes de abrir su terminal')
    if (projectPath(project.path,config.projectRoots) !== project.path) throw new Error('La carpeta del proyecto cambió; vuelve a añadirla')
    const window = `p-${id}`
    await tmux.ensureSession()
    const panes = await tmux.panes()
    if (!panes.has(window) || panes.get(window)?.dead) {
      // Wrapper root-owned: limita daemon/updater. Mantiene las aprobaciones y sandbox por defecto.
      await tmux.runIn(window,project.path,['/usr/local/bin/codex'],{HOME:config.home,CODEX_HOME:config.codexHome})
    }
    this.windows.add(window)
    return {window}
  }

  hasTerminal(window: string) {
    const match = /^p-(\d+)$/.exec(window)
    return Boolean(match && this.windows.has(window) && q.project(Number(match[1]))?.trust)
  }
  async revokeTerminal(id: number) {
    this.windows.delete(`p-${id}`)
    await tmux.killWindow(`p-${id}`)
  }
  async removeProject(id: number) { await this.revokeTerminal(id); q.deleteProject(id) }

  async shutdown() {
    this.closing = true
    clearInterval(this.monitor)
    this.login.cancel(false)
    await this.serial(() => this.stopOwnServer())
    await tmux.killServer()
  }
}

export const manager = new Manager()
