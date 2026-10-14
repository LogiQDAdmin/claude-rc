import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Exclusivamente datos y registros sintéticos: ningún montaje, cuenta o CLI real.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'agent-rc-claude-fixture-'))
process.env.DATA_DIR = path.join(tmp,'data')
process.env.CLAUDE_CONFIG_DIR = path.join(tmp,'claude')
process.env.PROJECT_ROOTS = path.join(tmp,'projects')
process.env.CLAUDE_BINARY = '/fixed-test/claude'
process.env.CLAUDE_TMUX_SOCKET = 'agent-rc-claude-fixture'
fs.mkdirSync(process.env.PROJECT_ROOTS)
const {Manager,convState} = await import('../dist/providers/claude/manager.js')
const {ClaudeDriver,approvedPath} = await import('../dist/providers/claude/driver.js')
const {q,db} = await import('../dist/providers/claude/db.js')
const {parseServerScreen,sessionRecord,conversationTitle} = await import('../dist/providers/claude/claude.js')
const {config,cliEnvironment} = await import('../dist/providers/claude/config.js')
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms))

function fixture(options={}) {
  db.exec('DELETE FROM projects; DELETE FROM conversations; DELETE FROM meta; DELETE FROM events;')
  let now = 100_000
  const calls = [],panes = new Map(),screens = new Map()
  let sessions = []
  const tmux = {
    ensureSession:async()=>{ calls.push(['ensure']); if (!panes.has('cuenta')) panes.set('cuenta',{window:'cuenta',dead:false,status:0,pid:1}) },
    panes:async()=>panes,
    runIn:async(window,cwd,command,env)=>{
      calls.push(['run',window,cwd,command,env]); panes.set(window,{window,dead:false,status:0,pid:2})
      if (!screens.has(window)) screens.set(window,'Connected ·\nCapacity: 0/10')
    },
    capture:async(window)=>screens.get(window)??'',
    sendKeys:async(window,...keys)=>{ calls.push(['keys',window,...keys]); if (keys[0]==='C-c' && panes.has(window)) panes.get(window).dead=true },
    sendText:async(window,text)=>calls.push(['text',window,text]),
    killWindow:async(window)=>{ calls.push(['kill',window]); panes.delete(window); screens.delete(window) },
    killServer:async()=>{ calls.push(['kill-server']); panes.clear() },
    tmuxAttachCommand:()=>[],
  }
  const manager = new Manager({store:q,tmux,automaticTick:false,claudeVersion:async()=>options.version??'2.1.294',
    authStatus:async()=>({loggedIn:options.loggedIn??true,method:'oauth',email:'fixture@example.test',plan:'max'}),
    scanSessions:()=>sessions,conversationTitle:()=> 'Synthetic conversation',now:()=>now,
    sleep:async(ms)=>{ now+=ms; await Promise.resolve() },
  })
  const driver = new ClaudeDriver({manager,expectedVersion:'2.1.294',loginTimeoutMs:options.loginTimeoutMs??1000})
  const project = (name='alpha',extra={})=>{
    const dir = path.join(process.env.PROJECT_ROOTS,name)
    fs.mkdirSync(dir,{recursive:true})
    const entry = {name,dir,spawn:'same-dir',autostart:1,trust:1,...extra}
    q.addProject(entry)
    if (extra.desired) q.setProject(name,'desired',extra.desired)
    return entry
  }
  return {manager,driver,tmux,calls,panes,screens,project,setSessions:value=>sessions=value,advance:ms=>now+=ms}
}
function conversation(project='alpha',remote='remote-fixture',extra={}) {
  q.upsertConversation({remote_id:remote,local_id:'local-fixture',project,title:'Fixture title',status:'working',active:1,last_activity:100,...extra})
}

test('fixed binary/env/private socket and legacy schema retain persistence layout',()=> {
  fixture()
  assert.equal(config.claudeBinary,'/fixed-test/claude')
  assert.equal(config.tmuxSocket,'agent-rc-claude-fixture')
  assert.equal(cliEnvironment().DISABLE_UPDATES,'1')
  assert.equal(cliEnvironment().CLAUDE_CONFIG_DIR,process.env.CLAUDE_CONFIG_DIR)
  const projects = db.prepare('PRAGMA table_info(projects)').all()
  assert.deepEqual(projects.map(column=>column.name),['name','dir','spawn','autostart','desired','trust','created_at'])
  assert.equal(projects.find(column=>column.name==='name').pk,1)
  assert.equal(projects.some(column=>column.name==='id'),false)
})

test('pinned-version mismatch is visible and makes no CLI/tmux/state changes',async()=> {
  const f = fixture({version:'9.9.9'})
  f.project()
  q.setMeta('running','1')
  await f.driver.boot()
  assert.equal(f.driver.state().server.state,'incompatible')
  assert.equal(q.meta('running'),'1')
  assert.equal(f.calls.length,0)
  await assert.rejects(f.driver.request('projects.start',{name:'alpha'}))
  await f.driver.shutdown()
  assert.equal(q.project('alpha').desired,'running')
})

test('manual stopped desired survives boot; legacy autostart=0 still follows desired',async()=> {
  const f = fixture()
  f.project('stopped',{desired:'stopped'})
  f.project('legacy-zero',{autostart:0})
  await f.driver.boot(); await f.manager.tick()
  assert.equal(f.manager.runtime('stopped').state,'detenida')
  assert(!f.calls.some(call=>call[0]==='run'&&call[1]==='p-stopped'))
  const run = f.calls.find(call=>call[0]==='run'&&call[1]==='p-legacy-zero')
  assert(run)
  assert(run[3][2].includes('exec "$RC_BINARY" remote-control'))
  assert.equal(run[4].RC_BINARY,'/fixed-test/claude')
  assert.equal(run[4].RC_NAME,'rc-legacy-zero')
  assert.equal(run[4].RC_SPAWN,'same-dir')
  assert.equal(run[4].DISABLE_UPDATES,'1')
  await f.driver.shutdown()
  assert.equal(q.project('stopped').desired,'stopped')
  assert.equal(q.meta('running'),'0')
})

test('worktree, trust prompt, capacity and connected conversation states remain original',async()=> {
  const f = fixture()
  const p = f.project('worktree',{spawn:'worktree'})
  await f.driver.boot(); await f.manager.tick()
  assert.equal(f.calls.find(call=>call[0]==='run')[4].RC_SPAWN,'worktree')
  f.screens.set('p-worktree','Trust this folder? [y/N]')
  await f.manager.tick(); await f.manager.tick()
  assert.equal(f.calls.filter(call=>call[0]==='keys'&&call[2]==='y').length,1)
  f.screens.set('p-worktree','Connected ·\nCapacity: 2/10')
  f.setSessions([{pid:42,localId:'local-fixture',remoteId:'stable-remote',cwd:p.dir+'/.claude/worktrees/task',status:'waiting_for_input',updatedAt:200,alive:true}])
  await f.manager.tick()
  const projected = f.driver.state().details.projects[0]
  assert.equal(projected.state,'esperando')
  assert.deepEqual(projected.capacity,{used:2,max:10})
  assert.equal(projected.conversations[0].url,'https://claude.ai/code/stable-remote')
  assert.equal(projected.conversations[0].remoteId,'stable-remote')
  assert.equal(projected.remoteName,'rc-worktree')
  await f.driver.shutdown()
})

test('untrusted prompt waits for explicit answer and missing mount is visible',async()=> {
  const f = fixture()
  const p = f.project('untrusted',{trust:0})
  await f.driver.boot(); await f.manager.tick()
  f.screens.set('p-untrusted','Trust this folder? [y/N]')
  await f.manager.tick()
  assert.equal(f.manager.runtime('untrusted').state,'atencion')
  assert.equal(f.calls.filter(call=>call[0]==='keys'&&call[2]==='y').length,0)
  await f.driver.request('projects.prompt',{name:'untrusted',yes:false})
  assert(f.calls.some(call=>call[0]==='keys'&&call[2]==='n'))
  fs.rmSync(p.dir,{recursive:true,force:true})
  f.panes.delete('p-untrusted')
  await f.manager.tick()
  assert(f.manager.runtime('untrusted').detail.includes('no existe'))
  await f.driver.shutdown()
})

test('closed CLI retries with backoff; manual start resets it',async()=> {
  const f = fixture()
  f.project()
  await f.driver.boot(); await f.manager.tick()
  f.panes.get('p-alpha').dead=true
  await f.manager.tick()
  assert.equal(f.manager.runtime('alpha').backoff,15000)
  const before = f.calls.filter(call=>call[0]==='run').length
  await f.manager.tick()
  assert.equal(f.calls.filter(call=>call[0]==='run').length,before)
  await f.driver.request('projects.start',{name:'alpha'})
  await f.manager.tick()
  assert.equal(f.calls.filter(call=>call[0]==='run').length,before+1)
  await f.driver.shutdown()
})

test('unexpected shutdown preserves orphan IDs, lastTick and recovery setting',async()=> {
  const f = fixture({loggedIn:false})
  f.project(); conversation()
  q.setMeta('running','1'); q.setMeta('lastTick','2020-01-01T00:00:00Z'); q.setMeta('autoRescue','0')
  await f.driver.boot(); await f.manager.tick()
  assert.equal(q.conversation('remote-fixture').orphan,1)
  assert.equal(q.conversation('remote-fixture').local_id,'local-fixture')
  assert.equal(q.meta('crashAt'),'2020-01-01T00:00:00Z')
  assert.equal(f.driver.state().details.autoRescue,false)
  assert.equal(f.driver.state().details.crash.pending,1)
  assert(!f.calls.some(call=>call[0]==='run'&&call[1]==='r-alpha'))
  await f.driver.shutdown()
})

test('rescue stops normal server, reuses remote ID and waits before restart',async()=> {
  const f = fixture()
  f.project(); conversation(); q.setOrphan('remote-fixture',1)
  await f.driver.boot(); await f.manager.tick()
  assert.deepEqual(await f.driver.request('projects.rescue',{name:'alpha',remoteIds:['remote-fixture']}),{accepted:true})
  await sleep(0)
  const stopIndex = f.calls.findIndex(call=>call[0]==='keys'&&call[1]==='p-alpha'&&call[2]==='C-c')
  const rescueIndex = f.calls.findIndex(call=>call[0]==='run'&&call[1]==='r-alpha')
  assert(stopIndex>=0&&rescueIndex>stopIndex)
  assert.equal(f.calls[rescueIndex][4].RC_SID,'remote-fixture')
  assert(f.calls[rescueIndex][3][2].includes('--session-id "$RC_SID"'))
  assert.equal(q.conversation('remote-fixture').orphan,0)
  assert.equal(q.conversation('remote-fixture').remote_id,'remote-fixture')
  await assert.rejects(f.driver.request('projects.rescue',{name:'alpha',remoteIds:['other-project-remote']}))
  await f.driver.shutdown()
})

test('failed rescue retains orphan identity with a sanitized diagnostic',async()=> {
  const f = fixture()
  f.project(); conversation(); q.setOrphan('remote-fixture',1)
  f.screens.set('r-alpha','Login expired; run claude auth login')
  await f.driver.boot()
  await f.driver.request('projects.rescue',{name:'alpha'})
  await sleep(0)
  assert.equal(q.conversation('remote-fixture').orphan,1)
  assert.equal(q.conversation('remote-fixture').rescue_error,'Hace falta iniciar sesión')
  assert.equal(q.conversation('remote-fixture').local_id,'local-fixture')
  await f.driver.shutdown()
})

test('enabled crash recovery runs the legacy rescue before normal project starts',async()=> {
  const f = fixture()
  f.project();conversation()
  q.setMeta('running','1');q.setMeta('autoRescue','1')
  await f.driver.boot();await f.manager.tick();await sleep(0)
  assert(f.calls.some(call=>call[0]==='run'&&call[1]==='r-alpha'))
  assert.equal(f.calls.some(call=>call[0]==='run'&&call[1]==='p-alpha'),false)
  assert.equal(q.conversation('remote-fixture').orphan,0)
  assert.equal(q.conversation('remote-fixture').remote_id,'remote-fixture')
  await f.manager.tick()
  assert(f.calls.some(call=>call[0]==='run'&&call[1]==='p-alpha'))
  assert.equal(f.driver.state().details.crash,null)
  await f.driver.shutdown()
})

test('revoking trust stops the project and cannot be undone by changing spawn in the same request',async()=> {
  const f = fixture()
  const p = f.project('revoke')
  fs.mkdirSync(path.join(p.dir,'.git'),{recursive:true})
  await f.driver.boot();await f.manager.tick()
  assert.equal((await f.driver.request('terminal.open',{name:'revoke'})).window,'p-revoke')
  await f.driver.request('projects.update',{name:'revoke',trust:false,spawn:'worktree'})
  assert.equal(q.project('revoke').trust,0)
  assert.equal(q.project('revoke').desired,'stopped')
  assert.equal(f.panes.has('p-revoke'),false)
  await assert.rejects(f.driver.request('terminal.open',{name:'revoke'}),/confianza/)
  await f.manager.tick()
  assert.equal(f.manager.runtime('revoke').state,'detenida')
  await f.driver.shutdown()
})

test('a live project replaced by an escaping symlink loses terminal and cannot start or rescue',async()=> {
  const f = fixture()
  const p = f.project('swapped')
  conversation('swapped')
  await f.driver.boot();await f.manager.tick()
  const outside = path.join(tmp,'outside-swapped')
  fs.mkdirSync(outside,{recursive:true})
  fs.rmSync(p.dir,{recursive:true,force:true})
  fs.symlinkSync(outside,p.dir,process.platform==='win32'?'junction':'dir')
  await assert.rejects(f.driver.request('terminal.open',{name:'swapped'}))
  await f.manager.tick()
  assert.equal(f.panes.has('p-swapped'),false)
  assert.equal(f.manager.runtime('swapped').state,'atencion')
  const runs = f.calls.filter(call=>call[0]==='run').length
  await f.driver.request('projects.start',{name:'swapped'});await f.manager.tick()
  assert.equal(f.calls.filter(call=>call[0]==='run').length,runs)
  await assert.rejects(f.manager.rescue('swapped',['remote-fixture']))
  assert.equal(q.conversation('remote-fixture').remote_id,'remote-fixture')
  await f.driver.shutdown()
})

test('official OAuth login/code/cancel never publishes captured text or input in events',async()=> {
  const f = fixture()
  await f.driver.boot()
  f.screens.set('cuenta','── rc: login ──\nhttps://claude.ai/oauth/authorize?fixture=opaque\nEnter your code:')
  const result = await f.driver.request('login.start',{})
  assert.equal(result.needsCodeInput,true)
  assert.equal(result.url,'https://claude.ai/oauth/authorize?fixture=opaque')
  f.screens.set('cuenta','── rc: login ──\nLogin successful')
  assert.equal((await f.driver.request('login.code',{code:'fixture-test-code'})).ok,true)
  assert.equal(f.driver.state().login.state,'success')
  assert.equal(f.driver.state().login.verificationUrl,undefined)
  assert(!JSON.stringify(q.events(100)).includes('fixture-test-code'))
  assert(!JSON.stringify(q.events(100)).includes('oauth/authorize'))
  f.screens.set('cuenta','── rc: login ──\nhttps://claude.ai/oauth/authorize?fixture=again')
  await f.driver.request('login.start',{})
  await f.driver.request('login.cancel',{})
  assert.equal(f.driver.state().login.state,'idle')
  assert.equal(f.driver.state().login.verificationUrl,undefined)
  assert(f.calls.some(call=>call[0]==='kill'&&call[1]==='cuenta'))
  await f.driver.shutdown()
})

test('login expires and only kills its account window',async()=> {
  const f = fixture({loginTimeoutMs:20})
  await f.driver.boot()
  f.screens.set('cuenta','https://claude.ai/oauth/authorize?fixture=expires')
  await f.driver.request('login.start',{})
  await sleep(40)
  assert.equal(f.driver.state().login.state,'expired')
  assert.equal(f.driver.state().login.verificationUrl,undefined)
  assert(!f.calls.some(call=>call[0]==='kill-server'))
  await f.driver.shutdown()
})

test('new Claude project path refuses symlink escapes and manual stop persists',async()=> {
  const f = fixture()
  await f.driver.boot()
  const outside = path.join(tmp,'outside')
  fs.mkdirSync(outside,{recursive:true})
  const link = path.join(process.env.PROJECT_ROOTS,'escape')
  fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir')
  assert.throws(()=>approvedPath(link),/raíces/)
  await assert.rejects(f.driver.request('projects.add',{name:'bad',path:link,trust:true}))
  assert.equal(q.projects().length,0)
  const dir = path.join(process.env.PROJECT_ROOTS,'fresh')
  fs.mkdirSync(dir)
  await f.driver.request('projects.add',{name:'fresh',path:dir,trust:true,spawn:'same-dir'})
  await f.driver.request('projects.stop',{name:'fresh'})
  assert.equal(q.project('fresh').desired,'stopped')
  await f.driver.shutdown()
  assert.equal(q.project('fresh').desired,'stopped')
})

test('session PID reuse, titles, screen reconnect and conversation statuses stay compatible',()=> {
  fixture()
  const record = {pid:42,procStart:'100',sessionId:'local-fixture',bridgeSessionId:'remote-fixture',cwd:'/projects/fixture',status:'working',updatedAt:22}
  assert.equal(sessionRecord(record,()=> '100').alive,true)
  assert.equal(sessionRecord(record,()=> '101').alive,false)
  assert.equal(sessionRecord({...record,procStart:null},()=> '100').alive,false)
  assert.equal(sessionRecord({pid:42},()=> '100'),null)
  const folder = path.join(config.claudeConfigDir,'projects','-projects-fixture')
  fs.mkdirSync(folder,{recursive:true})
  fs.writeFileSync(path.join(folder,'local-title-fixture.jsonl'),[
    JSON.stringify({type:'user',message:{content:'<injected-system-metadata>'}}),
    JSON.stringify({type:'assistant',message:{content:'Ignore assistant message'}}),
    JSON.stringify({type:'user',message:{content:[{type:'text',text:'Synthetic\n first title'}]}}),
  ].join('\n'))
  assert.equal(conversationTitle('/projects/fixture','local-title-fixture'),'Synthetic first title')
  assert.equal(parseServerScreen('Connected ·\nConnection lost').connected,false)
  assert.equal(convState('waiting_for_permission'),'esperando')
  assert.equal(convState('streaming'),'trabajando')
  assert.equal(convState('idle'),'disponible')
})

test.after(()=>{ db.close(); fs.rmSync(tmp,{recursive:true,force:true}) })
