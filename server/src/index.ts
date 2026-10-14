import fs from 'node:fs'
import {config} from './config.js'
import {Catalog} from './catalog.js'
import {Supervisor} from './supervisor.js'
import {createPanel} from './http.js'

fs.mkdirSync(config.dataDir,{recursive:true})
fs.mkdirSync(`${config.dataDir}/proyectos`,{recursive:true})
const catalog=new Catalog(config.dataDir)
catalog.importLegacy()
const supervisor=new Supervisor(catalog,config.workers)
const {server}=createPanel(catalog,supervisor)
server.listen(config.port,()=>{ console.log(`Remote Control ${config.version}: panel en ${config.port}`); supervisor.boot() })
let closing=false
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{
  if (closing) return
  closing=true
  const deadline=setTimeout(()=>process.exit(1),45000)
  void supervisor.shutdown().finally(()=>{ server.closeAllConnections(); server.close(()=>{ clearTimeout(deadline); catalog.close(); process.exit(0) }) })
})
