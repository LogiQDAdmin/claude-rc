import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {Supervisor,validState} from '../dist/supervisor.js'
import {Catalog} from '../dist/catalog.js'

const delay = ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(check,timeout=5000) {
  const end = Date.now()+timeout
  while (Date.now()<end) { if (check()) return; await delay(10) }
  assert.fail('Synthetic worker did not reach expected state')
}
function fixture(env={},Class=Supervisor) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'agent-rc-supervisor-'))
  const catalog = new Catalog(tmp)
  const paths = {
    claude:fileURLToPath(new URL('./fixtures/supervisor-claude-worker.mjs',import.meta.url)),
    codex:fileURLToPath(new URL('./fixtures/supervisor-codex-worker.mjs',import.meta.url)),
  }
  const supervisor = new Class(catalog,paths,20,{...process.env,RC_TEST_NO_TMUX:'1',...env},800,1000)
  return {supervisor,catalog,tmp,close:async()=> {
    await supervisor.shutdown();catalog.close();fs.rmSync(tmp,{recursive:true,force:true})
  }}
}
const ready = supervisor=>supervisor.slots.claude.phase==='ready'&&supervisor.slots.codex.phase==='ready'
function noChallenge(supervisor,provider) {
  for (const state of [supervisor.state(provider),supervisor.slots[provider].state]) {
    assert.equal(state.login.userCode,undefined)
    assert.equal(state.login.verificationUrl,undefined)
    assert.equal(state.details?.login,undefined)
    assert(!JSON.stringify(state).includes('TEST-ONLY'))
    assert(!JSON.stringify(state).includes('fixture.invalid/device'))
  }
}

test('real IPC worker crash preserves the other provider and clears ephemeral login',async()=> {
  const f = fixture()
  try {
    f.supervisor.boot();await until(()=>ready(f.supervisor))
    const other = await f.supervisor.request('codex','identity')
    await f.supervisor.request('claude','pending-login')
    assert.equal(f.supervisor.state('claude').login.userCode,'TEST-ONLY')
    assert.equal(f.supervisor.state('claude').details.login.userCode,'TEST-ONLY')
    let clearedDuringFailure=false
    f.supervisor.subscribe(()=> {
      if (f.supervisor.slots.claude.phase==='failed') { noChallenge(f.supervisor,'claude');clearedDuringFailure=true }
    })
    const pid = f.supervisor.slots.claude.child.pid
    await f.supervisor.request('claude','crash')
    await until(()=>f.supervisor.slots.claude.child?.pid!==pid&&f.supervisor.slots.claude.phase==='ready')
    assert.deepEqual(await f.supervisor.request('codex','identity'),other)
    assert.equal(f.supervisor.state('claude').login.userCode,undefined)
    noChallenge(f.supervisor,'claude')
    assert.equal(clearedDuringFailure,true)
    assert(f.supervisor.slots.claude.restarts>=1)
  } finally { await f.close() }
})

test('malformed protocol and explicit stop discard normalized and legacy login copies from RAM',async()=> {
  const f = fixture({AGENT_FIXTURE_CODEX_MODE:'slow-stop'})
  try {
    f.supervisor.boot();await until(()=>ready(f.supervisor))
    await f.supervisor.request('claude','pending-login')
    assert.equal(f.supervisor.state('claude').details.login.userCode,'TEST-ONLY')
    await assert.rejects(f.supervisor.request('claude','bad-state'))
    await until(()=>f.supervisor.state('claude').server.state==='incompatible')
    noChallenge(f.supervisor,'claude')
    assert.equal(f.supervisor.state('claude').details.marker,'keep metadata')
    await f.supervisor.request('codex','pending-login')
    assert.equal(f.supervisor.state('codex').details.login.userCode,'TEST-ONLY')
    const stopped=f.supervisor.stop('codex')
    noChallenge(f.supervisor,'codex')
    await stopped
    noChallenge(f.supervisor,'codex')
    assert.equal(f.supervisor.state('codex').details.marker,'keep metadata')
    // Projection also strips a future compatibility DTO accidentally restored
    // while the provider is down, without touching unrelated cached metadata.
    f.supervisor.slots.codex.state.login={state:'pending',userCode:'TEST-ONLY'}
    f.supervisor.slots.codex.state.details.login={state:'pending',userCode:'TEST-ONLY'}
    const projected=f.supervisor.state('codex')
    assert.equal(projected.details.login,undefined)
    assert.equal(projected.login.userCode,undefined)
    assert(!JSON.stringify(projected).includes('TEST-ONLY'))
  } finally { await f.close() }
})

test('idle event-loop hang is detected by heartbeat without blocking its peer',async()=> {
  const f = fixture()
  try {
    f.supervisor.boot();await until(()=>ready(f.supervisor))
    const other = await f.supervisor.request('claude','identity')
    const pid = f.supervisor.slots.codex.child.pid
    await f.supervisor.request('codex','stall')
    await until(()=>f.supervisor.slots.codex.child?.pid!==pid&&f.supervisor.slots.codex.phase==='ready')
    assert.deepEqual(await f.supervisor.request('claude','identity'),other)
    assert(f.supervisor.slots.codex.restarts>=1)
  } finally { await f.close() }
})

test('startup hang never sends ready states and has a bounded isolated restart',async()=> {
  const f = fixture({AGENT_FIXTURE_CLAUDE_MODE:'boot-hang'})
  let falselyReady=false
  f.supervisor.subscribe(()=>{ if (f.supervisor.slots.claude.phase==='ready') falselyReady=true })
  try {
    f.supervisor.boot()
    await until(()=>f.supervisor.slots.codex.phase==='ready')
    const other = await f.supervisor.request('codex','identity')
    await until(()=>f.supervisor.slots.claude.restarts>=1)
    assert.equal(falselyReady,false)
    assert.deepEqual(await f.supervisor.request('codex','identity'),other)
  } finally { await f.close() }
})

test('changed worker protocol stays incompatible until explicit restart',async()=> {
  const f = fixture({AGENT_FIXTURE_CLAUDE_MODE:'bad-state'})
  try {
    f.supervisor.boot()
    await until(()=>f.supervisor.state('claude').server.state==='incompatible'&&!f.supervisor.slots.claude.cleaning)
    await until(()=>f.supervisor.slots.codex.phase==='ready')
    const other = await f.supervisor.request('codex','identity')
    await delay(1000)
    assert.equal(f.supervisor.state('claude').server.state,'incompatible')
    assert.equal(f.supervisor.slots.claude.child,undefined)
    assert.equal(f.supervisor.slots.claude.restarts,0)
    f.supervisor.env.AGENT_FIXTURE_CLAUDE_MODE='normal'
    f.supervisor.start('claude')
    await until(()=>f.supervisor.slots.claude.phase==='ready')
    assert.deepEqual(await f.supervisor.request('codex','identity'),other)
  } finally { await f.close() }
})

test('a pending request timeout kills only its captured worker and remote exceptions are sanitized',async()=> {
  const f = fixture()
  try {
    f.supervisor.boot();await until(()=>ready(f.supervisor))
    const other = await f.supervisor.request('codex','identity')
    await assert.rejects(f.supervisor.request('claude','throw-private'),error=>!error.message.includes('synthetic-private-token'))
    const pid = f.supervisor.slots.claude.child.pid
    await assert.rejects(f.supervisor.request('claude','hang-request',{},50),/a tiempo/)
    await until(()=>f.supervisor.slots.claude.child?.pid!==pid&&f.supervisor.slots.claude.phase==='ready')
    assert.deepEqual(await f.supervisor.request('codex','identity'),other)
  } finally { await f.close() }
})

test('new worker waits for old cleanup; stop/start races clean each worker once',async()=> {
  class ControlledCleanup extends Supervisor {
    counts={claude:0,codex:0}
    hold=false
    release
    async cleanup(provider,pid) {
      this.counts[provider]++
      if (provider==='claude'&&this.hold) await new Promise(resolve=>{ this.release=resolve })
      return super.cleanup(provider,pid)
    }
  }
  const f = fixture({},ControlledCleanup)
  try {
    f.supervisor.boot();await until(()=>ready(f.supervisor))
    const other = await f.supervisor.request('codex','identity')
    f.supervisor.hold=true
    await f.supervisor.request('claude','crash')
    await until(()=>f.supervisor.slots.claude.cleaning&&f.supervisor.release)
    f.supervisor.start('claude')
    await delay(60)
    assert.equal(f.supervisor.slots.claude.child,undefined)
    f.supervisor.hold=false;f.supervisor.release()
    await until(()=>f.supervisor.slots.claude.phase==='ready')
    assert.equal(f.supervisor.counts.claude,1)
    const stopped = f.supervisor.stop('claude')
    f.supervisor.start('claude')
    await stopped
    await until(()=>f.supervisor.slots.claude.phase==='ready')
    assert.equal(f.supervisor.counts.claude,2)
    assert.equal(f.catalog.enabled('claude'),true)
    assert.deepEqual(await f.supervisor.request('codex','identity'),other)
  } finally { f.supervisor.release?.(); await f.close() }
})

test('integrity failure stays local to its provider and state validation rejects nested format drift',async()=> {
  const f = fixture({RC_CLAUDE_INTEGRITY_ERROR:'1'})
  try {
    f.supervisor.boot();await until(()=>f.supervisor.slots.codex.phase==='ready')
    assert.equal(f.supervisor.state('claude').server.state,'incompatible')
    assert.equal(f.supervisor.slots.claude.child,undefined)
    assert.equal((await f.supervisor.request('codex','identity')).provider,'codex')
    const valid=f.supervisor.state('codex')
    assert.equal(validState(valid,'codex'),true)
    assert.equal(validState({...valid,login:{state:'pending',verificationUrl:7}},'codex'),false)
    assert.equal(validState({...valid,server:{...valid.server,restarts:-1}},'codex'),false)
  } finally { await f.close() }
})
