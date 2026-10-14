#!/usr/local/bin/node
// Fixture only: use a disposable validation container with a fresh volume and
// an explicit entrypoint override. Never replace a real provider's binary.
import http from 'node:http'
import fs from 'node:fs'
import {WebSocketServer} from '/app/server/node_modules/ws/wrapper.mjs'
if (process.argv.includes('--version')) { console.log('codex-cli 0.162.1'); process.exit(0) }
if (!process.argv.includes('app-server')) process.exit(64)
const socket=process.env.CODEX_SOCKET_PATH??'/data/codex-rc/app-server.sock'
fs.mkdirSync('/data/codex-rc',{recursive:true})
try { fs.unlinkSync(socket) } catch(error) { if (error.code!=='ENOENT') throw error }
const server=http.createServer(),wss=new WebSocketServer({server})
wss.on('connection',ws=>ws.on('message',data=>{
  const request=JSON.parse(String(data))
  if (request.id===undefined) return
  let result
  if (request.method==='initialize') result={userAgent:'codex/0.162.1 (linux)',codexHome:'/data/codex',platformFamily:'unix',platformOs:'linux'}
  else if (request.method==='account/read') result={account:'changed-schema',requiresOpenaiAuth:true}
  else if (request.method==='remoteControl/status/read') result={status:'disabled',serverName:'fixture',installationId:'fixture',environmentId:null}
  else { ws.send(JSON.stringify({id:request.id,error:{code:-32601,message:'Unsupported fixture method'}})); return }
  ws.send(JSON.stringify({id:request.id,result}))
}))
server.listen(socket)
process.on('SIGTERM',()=>server.close(()=>process.exit(0)))
