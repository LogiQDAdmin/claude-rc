import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {createRequire} from 'node:module'
import ts from 'typescript'

// Exercise the source parser, not a copied implementation or a stale dist bundle.
const compiled = ts.transpileModule(fs.readFileSync(new URL('../src/api.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const module = {exports:{}}
new Function('module','exports','require',compiled)(module,module.exports,createRequire(import.meta.url))
const {api,parseSnapshot,loginUrl,providerEvents,legacyProject} = module.exports
const provider = name => ({provider:name,cliVersion:name==='codex'?'0.162.1':'2.1.294',account:{loggedIn:false},server:{state:'disponible',detail:'Disponible',restarts:0,experimental:name==='codex'},login:{state:'idle'},worker:{state:'ready',restarts:0},details:name==='codex'?{projects:[{id:7,name:'sample',path:'/projects/sample',trust:true}],events:[]}:{autoRescue:true,crash:null,namePrefix:'test',projects:[],events:[]}})
const snapshot = () => ({version:'0.2.0',providers:{claude:provider('claude'),codex:provider('codex')},unifiedProjects:[{id:1,name:'sample',path:'/projects/sample',bindings:[{provider:'claude',key:'sample',trust:true,spawn:'same-dir'},{provider:'codex',key:'7',trust:true,id:7,path:'/projects/sample'}]}]})

test('accepts the unified HTTP schema including merged Codex binding fields',() => {
  const parsed=parseSnapshot(snapshot(),null)
  assert.deepEqual(parsed.providerErrors,{})
  assert.equal(parsed.catalogError,'')
  assert.equal(parsed.unifiedProjects.length,1)
  assert.equal(parsed.unifiedProjects[0].bindings[1].key,'7')
})

for (const name of ['claude','codex']) {
  test(`${name}: unknown schema preserves its cached account and leaves the other provider usable`,() => {
    const raw=snapshot()
    raw.providers[name].account.loggedIn=true
    const previous=parseSnapshot(raw,null)
    const other=name==='claude'?'codex':'claude'
    const failures=[{...provider(name),server:{state:'unknown-format',detail:'changed',restarts:0}},{...provider(name),worker:{state:'unknown-worker',restarts:0}},{...provider(name),account:{}},{...provider(name),account:{loggedIn:false,stale:'unknown'}},{...provider(name),login:{state:'pending',verificationUrl:{unknown:true}}}]
    for (const broken of failures) {
      const next=parseSnapshot({...raw,providers:{...raw.providers,[name]:broken}},previous)
      assert.ok(next.providerErrors[name])
      assert.equal(next.providerErrors[other],undefined)
      assert.equal(next.providers[name].account.loggedIn,true)
      assert.equal(next.providers[name].account.stale,true)
      assert.equal(next.providers[other].account.stale,undefined)
      assert.deepEqual(next.unifiedProjects,previous.unifiedProjects)
    }
    assert.equal(previous.providers[name].account.stale,undefined,'must not mutate the last valid snapshot')
  })
  test(`${name}: missing first snapshot does not suppress the healthy provider`,() => {
    const raw=snapshot();delete raw.providers[name]
    const next=parseSnapshot(raw,null)
    assert.equal(next.providers[name],null)
    assert.ok(next.providerErrors[name])
    assert.ok(next.providers[name==='claude'?'codex':'claude'])
  })
}

test('accepts stopped and failed workers with explicit stale accounts',() => {
  for (const phase of ['starting','stopped','failed']) {
    const raw=snapshot()
    raw.providers.codex.worker={state:phase,restarts:2}
    raw.providers.codex.account={loggedIn:true,stale:true}
    raw.providers.codex.server={state:phase==='starting'?'iniciando':phase==='stopped'?'detenido':'caido',detail:'Estado del gestor',restarts:2}
    const next=parseSnapshot(raw,null)
    assert.deepEqual(next.providerErrors,{})
    assert.equal(next.providers.codex.worker.state,phase)
    assert.equal(next.providers.codex.account.stale,true)
  }
})

test('catalog schema drift retains projects and does not stale either account',() => {
  const previous=parseSnapshot(snapshot(),null)
  const raw=snapshot();raw.unifiedProjects[0].bindings[0].provider='new-provider'
  const next=parseSnapshot(raw,previous)
  assert.ok(next.catalogError)
  assert.deepEqual(next.unifiedProjects,previous.unifiedProjects)
  assert.deepEqual(next.providerErrors,{})
})

test('unknown providers remain visible without replacing supported providers',() => {
  const raw=snapshot();raw.providers.newagent={}
  const next=parseSnapshot(raw,null)
  assert.deepEqual(next.unknownProviders,['newagent'])
  assert.ok(next.providers.claude)
  assert.ok(next.providers.codex)
})

test('rejects an unreadable top-level snapshot',() => {
  for (const invalid of [null,[],{}, {version:'0.2.0',providers:[]}]) assert.throws(() => parseSnapshot(invalid,null),/formato/)
})

test('keeps legacy Claude identifiers, conversation links and recovery state',() => {
  const raw=snapshot()
  const conversation={remoteId:'fixture-remote-id',title:'Fixture conversation',lastActivity:1700000000000,state:'atencion',rescueError:null,url:'https://claude.ai/code/fixture-remote-id'}
  raw.providers.claude.details={...raw.providers.claude.details,crash:{at:'2026-01-01T00:00:00Z',pending:1},projects:[{name:'sample',dir:'/projects/sample',desired:'running',spawn:'worktree',autostart:false,remoteName:'test-sample',capacity:{used:1,max:6},conversations:[conversation]}]}
  raw.unifiedProjects[0].bindings[0].conversations=[conversation]
  const next=parseSnapshot(raw,null)
  assert.deepEqual(next.providerErrors,{})
  const legacy=legacyProject(next.providers.claude,next.unifiedProjects[0].bindings[0])
  assert.equal(legacy.remoteName,'test-sample')
  assert.equal(legacy.autostart,false)
  assert.equal(legacy.conversations[0].remoteId,conversation.remoteId)
  assert.equal(legacy.conversations[0].url,conversation.url)
  assert.equal(next.providers.claude.details.crash.pending,1)
})

test('unreadable original Claude conversations do not break Codex',() => {
  const raw=snapshot();raw.providers.claude.details.projects=[{name:'sample',dir:'/projects/sample',conversations:[{remoteId:'fixture',title:{changed:true}}]}]
  const next=parseSnapshot(raw,null)
  assert.ok(next.providerErrors.claude)
  assert.equal(next.providerErrors.codex,undefined)
})

test('normalizes both event formats while preserving source attribution',() => {
  const claude=provider('claude'),codex=provider('codex')
  claude.details.events=[{id:1,ts:'2026-01-01T00:00:00Z',project:'sample',level:'warn',msg:'Claude fixture event'}]
  codex.details.events=[{at:'2026-01-01T00:00:01Z',level:'error',message:'Codex fixture event'}]
  assert.deepEqual(providerEvents(claude),[{at:'2026-01-01T00:00:00Z',level:'warn',message:'Claude fixture event',provider:'claude'}])
  assert.equal(providerEvents(codex)[0].provider,'codex')
})

test('authorization URLs cannot mix the two login flows',() => {
  const claude='https://claude.ai/oauth/authorize',codex='https://auth.openai.com/codex/device'
  assert.ok(loginUrl(claude,'claude'))
  assert.ok(loginUrl(codex,'codex'))
  assert.equal(loginUrl(claude,'codex'),undefined)
  assert.equal(loginUrl(codex,'claude'),undefined)
  for (const unsafe of ['javascript:alert(1)','https://example.invalid/authorize','http://claude.ai/oauth/authorize']) assert.equal(loginUrl(unsafe,'claude'),undefined)
})

function mockBrowser(t,fetcher) {
  const priorWindow=globalThis.window,priorFetch=globalThis.fetch,scheduled=[],cleared=[]
  globalThis.window={setTimeout:(callback,ms)=>{scheduled.push({callback,ms});return scheduled.length},clearTimeout:id=>cleared.push(id)}
  globalThis.fetch=fetcher
  t.after(()=>{if(priorWindow===undefined)delete globalThis.window;else globalThis.window=priorWindow;globalThis.fetch=priorFetch})
  return {scheduled,cleared}
}

test('bounded GET polling and longer mutations accommodate provider shutdown and login',async t => {
  const requests=[]
  const {scheduled,cleared}=mockBrowser(t,async (url,init)=>{requests.push({url,init});return {status:200,ok:true,json:async()=>({ok:true})}})
  await api('state')
  for (const method of ['POST','PATCH','DELETE']) await api('providers/claude/server/stop',{method,body:{fixture:true}})
  assert.deepEqual(scheduled.map(timer=>timer.ms),[20000,75000,75000,75000])
  assert.equal(cleared.length,4)
  assert.equal(requests[0].init.credentials,'same-origin')
  assert.equal(requests[1].init.headers['x-rc'],'1')
  assert.equal(requests[1].init.body,JSON.stringify({fixture:true}))
})

test('mutation timeout explains that state must be checked before retrying',async t => {
  const {scheduled,cleared}=mockBrowser(t,(_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')))))
  const pending=api('providers/codex/account/login',{method:'POST'})
  scheduled[0].callback()
  await assert.rejects(pending,/Comprueba el estado antes/)
  assert.equal(cleared.length,1)
})

test('Basic auth failures produce a visible instruction without requesting credentials in the panel',async t => {
  mockBrowser(t,async()=>({status:401,ok:false}))
  await assert.rejects(api('state'),/Recarga la página/)
})
