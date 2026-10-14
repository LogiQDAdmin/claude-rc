import type {ProviderDriver, ProviderState} from '../../provider-types.js'
import {manager, type Manager} from './manager.js'
import {config} from './config.js'
import {q} from './db.js'
import {projectPath} from './projects.js'

function projectId(value: unknown) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || !q.project(id)) throw new Error('Proyecto de Codex no encontrado')
  return id
}

export function createCodexDriver(service: Manager = manager): ProviderDriver {
  const state = (): ProviderState => {
    const value = service.state()
    // Ephemeral login material has one owner. Duplicating it under details
    // would bypass the common supervisor's cleanup after a worker failure.
    const details = {version:value.version,codexVersion:value.codexVersion,projects:value.projects,events:value.events}
    return {provider:'codex',cliVersion:config.codexVersion,account:value.account,server:value.server,login:value.login,details}
  }
  return {
    boot: async () => {
      if (process.env.RC_CODEX_INTEGRITY_ERROR) throw new Error('No se pudo verificar la integridad del binario fijado de Codex')
      await service.boot()
    },
    state,
    shutdown: () => service.shutdown(),
    async request(action, args) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Parámetros de Codex no válidos')
      switch (action) {
        case 'state': return state()
        case 'login.start': return service.startLogin()
        case 'login.cancel': return service.cancelLogin()
        case 'server.start': await service.startServer(); return state()
        case 'server.stop': await service.stopServer(); return state()
        case 'server.restart': await service.restartServer(); return state()
        case 'remote.pair': return service.pair()
        case 'projects.add': {
          const name = typeof args.name === 'string' ? args.name.trim() : ''
          if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Nombre de proyecto no válido')
          const path = projectPath(args.path,config.projectRoots,args.create === true)
          if (q.projects().some(project => project.path === path || project.name === name)) throw new Error('Ese proyecto ya está asociado a Codex')
          const id = q.addProject(name,path,args.trust === true)
          q.event('info','Se asoció un proyecto a Codex')
          return service.state().projects.find(project => project.id === id)
        }
        case 'projects.update': {
          const id = projectId(args.id)
          if (typeof args.trust !== 'boolean') throw new Error('La confianza debe ser un booleano')
          if (!args.trust) await service.revokeTerminal(id)
          q.setTrust(id,args.trust)
          return service.state().projects.find(project => project.id === id)
        }
        case 'projects.remove': await service.removeProject(projectId(args.id)); return state()
        case 'terminal.open': {
          const result = await service.terminal(projectId(args.id))
          return {...result,tmuxSocket:config.tmuxSocket,tmuxSession:config.tmuxSession}
        }
        default: throw new Error('Acción de Codex no admitida')
      }
    },
  }
}
