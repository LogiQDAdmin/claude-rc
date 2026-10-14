import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {WebSocketServer} from 'ws'
import {RpcClient,validateInitialize,validateAccount,validateRemoteStatus,validatePairing} from '../dist/providers/codex/protocol.js'

const initialization = {userAgent:'codex_rc_panel/0.162.1 (Linux 6.8; x86_64) codex_cli_rs/0.162.1',codexHome:'/fresh/codex',platformFamily:'unix',platformOs:'linux'}
test('fixed version and experimental response envelopes are checked',()=> {
  validateInitialize(initialization,'0.162.1')
  assert.throws(()=>validateInitialize({...initialization,userAgent:'codex/0.162.2'},'0.162.1'),/versión/)
  assert.throws(()=>validateInitialize({userAgent:'codex/0.162.1'},'0.162.1'),/formato/)
  assert.throws(()=>validateAccount({account:'changed-schema',requiresOpenaiAuth:true}),/formato/)
  assert.throws(()=>validateAccount({account:null}),/formato/)
  assert.deepEqual(validateAccount({account:null,requiresOpenaiAuth:true}),{loggedIn:false})
  const account = validateAccount({account:{type:'chatgpt',email:'private@example.test',planType:'plus',token:'fake-secret'},requiresOpenaiAuth:true})
  assert.deepEqual(account,{loggedIn:true,method:'ChatGPT',plan:'plus'})
  assert(!JSON.stringify(account).includes('private'))
  assert(!JSON.stringify(account).includes('secret'))
  for (const planType of ['promax','ent26','edu_plus','enterprise_cbp_automation'])
    assert.equal(validateAccount({account:{type:'chatgpt',email:null,planType},requiresOpenaiAuth:true}).plan,planType)
  assert.throws(()=>validateAccount({account:{type:'new-auth'},requiresOpenaiAuth:true}),/formato/)
})
test('remote status and pairing validate changed schemas without exposing opaque IDs',()=> {
  assert.equal(validateRemoteStatus({status:'errored',serverName:'private-name',installationId:'private-id',environmentId:null}),'errored')
  assert.throws(()=>validateRemoteStatus({status:'new-format'}),/formato/)
  assert.deepEqual(validatePairing({pairingCode:'opaque-secret',manualPairingCode:'TEST-PAIR',environmentId:'private-id',expiresAt:1900000000}),{pairingCode:'opaque-secret',manualPairingCode:'TEST-PAIR',expiresAt:1900000000})
  assert.throws(()=>validatePairing({manualPairingCode:'TEST-PAIR',expiresAt:'tomorrow'}),/formato/)
})

async function withPeer(reply,fn) {
  const socketPath = process.platform==='win32' ? `\\\\.\\pipe\\codex-rc-test-${crypto.randomUUID()}` : path.join(os.tmpdir(),`codex-rc-${crypto.randomUUID()}.sock`)
  const server = http.createServer()
  const wss = new WebSocketServer({server})
  wss.on('connection',ws=>ws.on('message',raw=>reply(ws,JSON.parse(raw.toString()))))
  await new Promise(resolve=>server.listen(socketPath,resolve))
  const broken = []
  const client = new RpcClient(socketPath,error=>broken.push(error))
  try { await client.connect(1000); await fn(client,broken) }
  finally {
    client.close()
    for (const ws of wss.clients) ws.terminate()
    await new Promise(resolve=>wss.close(resolve))
    await new Promise(resolve=>server.close(resolve))
  }
}
test('RPC uses WebSocket over the private socket and has bounded calls',async()=> {
  await withPeer((ws,msg)=> {
    if (msg.method==='initialize') ws.send(JSON.stringify({id:msg.id,result:initialization}))
  },async client=> {
    validateInitialize(await client.call('initialize',{},200),'0.162.1')
    await assert.rejects(client.call('neverReplies',{},20),/a tiempo/)
  })
})
test('invalid protocol is reported explicitly and remote errors are sanitized',async()=> {
  await withPeer((ws,msg)=>ws.send(JSON.stringify({id:msg.id,result:1,error:{code:123,message:'fake-token-private'}})),async(client,broken)=> {
    await assert.rejects(client.call('account/read',{},200))
    assert.equal(broken[0]?.kind,'protocol')
    assert(!broken[0]?.message.includes('fake-token'))
  })
  await withPeer((ws,msg)=>ws.send(JSON.stringify({id:msg.id,error:{code:-32601,message:'fake-token-private'}})),async client=> {
    await assert.rejects(client.call('unknownMethod',{},200),error=>error.kind==='protocol'&&!error.message.includes('fake-token'))
  })
})
