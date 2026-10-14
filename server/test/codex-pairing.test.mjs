import test from 'node:test'
import assert from 'node:assert/strict'
import {PairingService,PAIRING_RPC_TIMEOUT_MS} from '../dist/providers/codex/pairing.js'
import {CodexFailure,validatePairingStatus} from '../dist/providers/codex/protocol.js'

const wrongId='11111111-1111-4111-8111-111111111111'
function deferred() { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject} }
function fixture(options={}) {
  let now=1_700_000_000_000
  const calls=[],events=[],schema=[]
  const expiry=()=>Math.floor(now/1000)+300
  const native=()=>({pairingCode:'OPAQUE-TEST-ONLY',manualPairingCode:options.opaque?null:'TEST-PAIR',environmentId:'synthetic-environment',expiresAt:expiry()})
  const rpc={async call(method,params,timeout) {
    calls.push({method,params,timeout})
    if (options.call) return options.call(method,params,timeout,native())
    return method.endsWith('/start')?native():{claimed:options.claimed??false}
  }}
  const service=new PairingService({rpc:()=>rpc,available:()=>true,event:(level,message)=>events.push({level,message}),
    incompatible:error=>{schema.push(error);service.clear()},now:()=>now})
  return {service,calls,events,schema,advance:ms=>now+=ms,expires:expiry,native}
}
const purged=service=>assert(!JSON.stringify(service).includes('TEST-PAIR')&&!JSON.stringify(service).includes('OPAQUE-TEST-ONLY'))

test('manual start preserves the compatible code, uses local correlation and the upstream 40s deadline',async()=> {
  const f=fixture()
  try {
    const response=await f.service.start()
    assert.equal(response.code,'TEST-PAIR');assert.equal(response.manualPairingCode,'TEST-PAIR');assert.equal(response.kind,'manual')
    assert.equal(response.expiresAt,f.expires())
    assert.match(response.attemptId,/^[0-9a-f-]{36}$/)
    assert.notEqual(response.attemptId,'synthetic-environment')
    assert.deepEqual(f.calls[0],{method:'remoteControl/pairing/start',params:{manualCode:true},timeout:40000})
    assert.equal(PAIRING_RPC_TIMEOUT_MS,40000)
    assert.deepEqual(await f.service.status(response.attemptId),{state:'pending'})
    assert.deepEqual(f.calls[1],{method:'remoteControl/pairing/status',params:{manualPairingCode:'TEST-PAIR'},timeout:40000})
    assert(!JSON.stringify(f.events).includes('TEST-PAIR'));assert(!JSON.stringify(f.events).includes('OPAQUE-TEST-ONLY'))
  } finally { f.service.clear() }
})

test('opaque fallback sends exactly pairingCode, never pretends to be a manual code, and claimed erases code payloads',async()=> {
  const f=fixture({opaque:true,claimed:true})
  try {
    const response=await f.service.start()
    assert.equal(response.kind,'opaque');assert.equal(response.manualPairingCode,null);assert.equal(response.code,'OPAQUE-TEST-ONLY')
    assert.deepEqual(await f.service.status(response.attemptId),{state:'claimed'})
    assert.deepEqual(f.calls[1].params,{pairingCode:'OPAQUE-TEST-ONLY'})
    purged(f.service)
    assert.deepEqual(await f.service.status(response.attemptId),{state:'claimed'})
    assert.equal(f.calls.length,2)
    assert.deepEqual(await f.service.status(wrongId),{state:'idle'})
  } finally { f.service.clear() }
})

test('strict claimed boolean is required and a changed schema emits only a fixed sanitized event',async()=> {
  assert.equal(validatePairingStatus({claimed:false}),false)
  assert.equal(validatePairingStatus({claimed:true}),true)
  for (const value of [null,{},[],{claimed:'true'},{claimed:1}]) assert.throws(()=>validatePairingStatus(value),/formato/)
  const f=fixture({call:async(method,_params,_timeout,native)=>method.endsWith('/start')?native:{claimed:'true',token:'private-fixture-token'}})
  try {
    const started=await f.service.start()
    await assert.rejects(f.service.status(started.attemptId),/confirmar/)
    assert.equal(f.schema.length,1);assert.equal(f.schema[0].kind,'protocol')
    assert(!JSON.stringify(f.events).includes('private-fixture-token'))
    purged(f.service)
  } finally { f.service.clear() }
})

test('transient status timeout preserves the attempt and records sanitized diagnostics without native codes or errors',async()=> {
  let fail=true
  const f=fixture({call:async(method,_params,_timeout,native)=>{
    if(method.endsWith('/start'))return native
    if(fail)throw new CodexFailure('timeout','raw-private-fixture-token-TEST-PAIR')
    return {claimed:false}
  }})
  try {
    const started=await f.service.start()
    await assert.rejects(f.service.status(started.attemptId),/confirmar/)
    assert(f.events.some(e=>e.message.includes('tardó demasiado')))
    assert(!JSON.stringify(f.events).includes('raw-private'));assert(!JSON.stringify(f.events).includes('TEST-PAIR'))
    assert.equal(f.schema.length,0)
    fail=false
    assert.deepEqual(await f.service.status(started.attemptId),{state:'pending'})
  } finally { f.service.clear() }
})

test('start timeout and malformed payload errors are visible without exposing native data',async()=> {
  for (const error of [new CodexFailure('timeout','raw-fixture-secret'),new Error('raw-fixture-secret')]) {
    const f=fixture({call:async()=>{throw error}})
    try {
      await assert.rejects(f.service.start(),e=>!e.message.includes('raw-fixture-secret'))
      assert(f.events.length);assert(!JSON.stringify(f.events).includes('raw-fixture-secret'))
      purged(f.service)
    } finally { f.service.clear() }
  }
  const f=fixture({call:async()=>({pairingCode:'OPAQUE-TEST-ONLY',manualPairingCode:42,environmentId:'synthetic-environment',expiresAt:1900000000})})
  try { await assert.rejects(f.service.start());assert.equal(f.schema.length,1);purged(f.service) }
  finally { f.service.clear() }
})

test('expiry and cancel clear RAM locally without issuing cancellation or restarting a native service',async()=> {
  const f=fixture()
  try {
    assert.deepEqual(await f.service.status(wrongId),{state:'idle'});assert.equal(f.calls.length,0)
    const started=await f.service.start()
    f.advance(300_001)
    assert.deepEqual(await f.service.status(started.attemptId),{state:'expired'});purged(f.service)
    assert.equal(f.calls.length,1)
    const fresh=await f.service.start()
    assert.deepEqual(f.service.cancel(fresh.attemptId),{state:'idle'});purged(f.service)
    assert.deepEqual(await f.service.status(fresh.attemptId),{state:'idle'})
    assert.equal(f.calls.length,2)
  } finally { f.service.clear() }
})

test('old status and cancel cannot consume a new attempt, and a late claimed reply cannot resurrect cancelled codes',async()=> {
  const pending=deferred()
  const f=fixture({call:async(method,_params,_timeout,native)=>method.endsWith('/start')?native:pending.promise})
  try {
    const first=await f.service.start()
    const oldStatus=f.service.status(first.attemptId)
    const second=await f.service.start()
    assert.notEqual(first.attemptId,second.attemptId)
    f.service.cancel(first.attemptId)
    assert.deepEqual(await f.service.status(first.attemptId),{state:'idle'})
    assert.equal(f.calls.length,3,'stale status must not query the new code')
    pending.resolve({claimed:true})
    assert.deepEqual(await oldStatus,{state:'idle'})
    assert.equal(f.service.active.attemptId,second.attemptId)
    f.service.cancel(second.attemptId);purged(f.service)
  } finally { f.service.clear() }
  const later=deferred(),g=fixture({call:async(method,_params,_timeout,native)=>method.endsWith('/start')?native:later.promise})
  try {
    const started=await g.service.start(),checking=g.service.status(started.attemptId)
    g.service.cancel(started.attemptId);later.resolve({claimed:true})
    assert.deepEqual(await checking,{state:'idle'});purged(g.service)
  } finally { g.service.clear() }
})

test('pending start cannot reinsert its response after provider lifecycle reset or a newer start',async()=> {
  const pending=deferred();let starts=0
  const f=fixture({call:async(method,_params,_timeout,native)=>method.endsWith('/start')&&++starts===1?pending.promise:native})
  try {
    const first=f.service.start()
    f.service.clear()
    const next=await f.service.start()
    pending.resolve(f.native())
    await assert.rejects(first)
    assert.equal(f.service.active.attemptId,next.attemptId)
    assert.equal(f.events.filter(e=>e.level==='info').length,1)
  } finally { f.service.clear() }
})

test('Codex manager lifecycle erases pairing on stop, login, restart and crash without exposing it in public snapshots',async()=> {
  const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path')
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-rc-pair-manager-'))
  process.env.DATA_DIR=temp;process.env.CODEX_HOME=path.join(temp,'codex');process.env.CODEX_USER_HOME=path.join(temp,'codex-home')
  process.env.PROJECT_ROOTS=path.join(temp,'projects');process.env.CODEX_TMUX_SOCKET=`agent-rc-pairing-fixture-${process.pid}`
  const {Manager}=await import('../dist/providers/codex/manager.js')
  const {db}=await import('../dist/providers/codex/db.js')
  try {
    for(const action of ['stop','login','cancel-login','restart','crash','account-loss','shutdown']) {
      const manager=new Manager()
      manager.server.state='disponible';manager.account={loggedIn:true,method:'ChatGPT',plan:'plus'}
      manager.launch=async()=>{} // No native CLI, login, sockets, model calls or account access.
      manager.login={state:{state:'idle'},start:()=>({state:'pending'}),cancel:()=>({state:'idle'})}
      manager.rpc={call:async method=>method==='account/read'?{account:null,requiresOpenaiAuth:true}
        :method==='remoteControl/status/read'?{status:'connected',serverName:'fixture-server',installationId:'fixture-installation',environmentId:null}
        :{pairingCode:'OPAQUE-TEST-ONLY',manualPairingCode:'TEST-PAIR',environmentId:'fixture-env',expiresAt:Math.floor(Date.now()/1000)+300},close:()=>{}}
      const started=await manager.pair()
      assert(!JSON.stringify(manager.state()).includes('TEST-PAIR'))
      assert(!JSON.stringify(manager.state()).includes('OPAQUE-TEST-ONLY'))
      if(action==='stop')await manager.stopServer()
      else if(action==='login')manager.startLogin()
      else if(action==='cancel-login')manager.cancelLogin()
      else if(action==='restart')await manager.restartServer()
      else if(action==='crash')manager.failed(new CodexFailure('network','Synthetic app-server closed'),manager.generation)
      else if(action==='account-loss'){await manager.refreshAccount();assert.equal(manager.account.loggedIn,false)}
      else await manager.shutdown() // Only nonexistent, fixture-specific tmux socket cleanup.
      assert.deepEqual(await manager.pairStatus(started.attemptId),{state:'idle'})
      purged(manager.pairing)
      clearTimeout(manager.retry)
      manager.pairing.clear()
    }
  } finally { db.close();fs.rmSync(temp,{recursive:true,force:true}) }
})
