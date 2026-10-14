import {manager} from './manager.js'
import {startHttp} from './http.js'

const server = startHttp()
await manager.boot()

let closing = false
async function stop(signal: string) {
  if (closing) return
  closing = true
  console.log(`${signal}: parada limpia`)
  server.close()
  await manager.shutdown()
  process.exit(0)
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
