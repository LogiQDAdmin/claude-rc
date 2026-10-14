import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {WebSocket} from 'ws'
import {Catalog} from '../dist/catalog.js'
import {createPanel} from '../dist/http.js'

const initial=p=>({provider:p,cliVersion:p==='claude'?'2.1.294':'0.162.1',account:{loggedIn:false},server:{state:'disponible',detail:'Ready',restarts:0},login:{state:'idle'},worker:{state:'ready',restarts:0},details:{projects:[],events:[]}})
async function setup(password='') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-rc-http-')),projects=path.join(root,'projects'),web=path.join(root,'web')
  fs.mkdirSync(projects); fs.mkdirSync(web); fs.writeFileSync(path.join(web,'index.html'),'<title>Remote Control</title>')
  const catalog=new Catalog(path.join(root,'data')),states={claude:initial('claude'),codex:initial('codex')},calls=[]
  let sequence=0,callback
  const supervisor={state:p=>structuredClone(states[p]),subscribe:fn=>callback=fn,async request(p,action,args={}) {
    calls.push({p,action,args})
    if (action==='projects.add') {
      const record=p==='claude'?{name:args.name,dir:args.path,trust:args.trust,state:'detenida',conversations:[],autostart:true,desired:'running',spawn:args.spawn}:{id:++sequence,name:args.name,path:args.path,trust:args.trust}
      states[p].details.projects.push(record); return p==='claude'?states[p]:record
    }
    if (action==='projects.update') {
      const record=states[p].details.projects.find(row=>p==='claude'?row.name===args.name:row.id===args.id)
      if (record) Object.assign(record,args); return states[p]
    }
    if (action==='terminal.open') return {window:p==='claude'?`p-${args.name}`:`p-${args.id}`,tmuxSocket:`agent-rc-${p}`,tmuxSession:'rc'}
    if (action==='projects.remove') states[p].details.projects=states[p].details.projects.filter(row=>p==='claude'?row.name!==args.name:row.id!==args.id)
    return {ok:true}
  },async stop(p){states[p].worker.state='stopped';states[p].server.state='detenido';callback?.()},start(p){states[p].worker.state='ready';states[p].server.state='disponible';callback?.()},async restart(p){this.start(p)}}
  const panel=createPanel(catalog,supervisor,{port:0,dataDir:catalog.dataDir,projectRoots:[projects],panelPassword:password,webDir:web,version:'0.2.0',workers:{claude:'',codex:''}})
  await new Promise(resolve=>panel.server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${panel.server.address().port}`
  const request=async(url,method='GET',value,headers={})=>{ const response=await fetch(base+url,{method,headers:{'x-rc':'1',...(value===undefined?{}:{'content-type':'application/json'}),...headers},body:value===undefined?undefined:JSON.stringify(value)});const result=await response.text();return {status:response.status,value:result?JSON.parse(result):undefined} }
  return {root,projects,catalog,states,calls,panel,base,request,async close(){await new Promise(resolve=>panel.server.close(resolve));catalog.close();fs.rmSync(root,{recursive:true,force:true})}}
}
test('dual project bindings, provider-only stop, legacy aliases and removal preserve files',async()=>{
  const s=await setup()
  try {
    const directory=path.join(s.projects,'dual')
    const added=await s.request('/api/projects','POST',{name:'dual',path:directory,create:true,providers:['claude','codex'],trust:true})
    assert.equal(added.status,201)
    const p=added.value.unifiedProjects[0]
    assert.equal(p.bindings.length,2)
    assert.equal(p.bindings.find(b=>b.provider==='claude').autostart,true)
    fs.writeFileSync(path.join(directory,'keep.txt'),'file stays')
    assert.equal((await s.request(`/api/projects/${p.id}/providers/codex/terminal`,'POST',{})).status,200)
    assert.equal((await s.request('/api/providers/codex/server/stop','POST',{})).value.providers.claude.server.state,'disponible')
    assert.equal((await s.request('/healthz')).status,200)
    assert.equal((await s.request('/api/projects/dual/stop','POST',{})).status,200)
    assert.equal(s.calls.at(-1).action,'projects.stop')
    assert.equal((await s.request(`/api/projects/${p.id}/providers/claude`,'PATCH',{trust:false,name:'another'})).status,200)
    assert.equal(s.calls.at(-1).args.name,'dual')
    assert.equal((await s.request(`/api/projects/${p.id}/providers/claude/terminal`,'POST',{})).status,403)
    assert.equal((await s.request(`/api/projects/${p.id}/providers/codex`,'DELETE')).status,200)
    assert.equal(s.catalog.project(p.id).bindings.length,1)
    assert.equal((await s.request(`/api/projects/${p.id}`,'DELETE')).status,200)
    assert.equal(s.catalog.projects().length,0)
    assert.equal(fs.readFileSync(path.join(directory,'keep.txt'),'utf8'),'file stays')
  } finally { await s.close() }
})
test('no login runs on page/state/folders; CSRF, root escape and unknown providers reject',async()=>{
  const s=await setup()
  try {
    await s.request('/api/state');await s.request('/api/folders');await fetch(s.base)
    assert.equal(s.calls.length,0)
    assert.equal((await s.request('/api/providers/codex/account/login','POST',{}, {'x-rc':'0'})).status,403)
    assert.equal((await s.request('/api/providers/claude/account/login','POST',{}, {origin:'https://other.example'})).status,403)
    assert.equal((await s.request('/api/providers/unknown/account/login','POST',{})).status,404)
    assert.equal((await s.request('/api/projects','POST',{name:'escape',path:s.root,providers:['codex']})).status,400)
    assert.equal((await s.request('/api/providers/codex/account/login','POST',{})).status,200)
    assert.deepEqual(s.calls.at(-1),{p:'codex',action:'login.start',args:{}})
  } finally { await s.close() }
})
test('password and missing workers never disable public health; unauthorized WS rejected before PTY',async()=>{
  const s=await setup('only-fixture-password')
  try {
    s.states.codex.worker.state='failed';s.states.claude.worker.state='failed'
    assert.equal((await s.request('/healthz')).status,200)
    assert.equal((await s.request('/api/state')).status,401)
    const authorization='Basic '+Buffer.from('admin:only-fixture-password').toString('base64')
    const good=await s.request('/api/state','GET',undefined,{authorization})
    assert.equal(good.status,200); assert.equal(good.value.providers.codex.worker.state,'failed')
    const ws=new WebSocket(s.base.replace('http:','ws:')+'/api/term?provider=codex&w=guessed',{headers:{origin:s.base,authorization}})
    const status=await new Promise((resolve,reject)=>{ws.once('unexpected-response',(_request,response)=>{response.resume();resolve(response.statusCode);ws.terminate()});ws.once('open',()=>reject(new Error('Guessed terminal admitted')));ws.on('error',()=>{})})
    assert.equal(status,403)
  } finally { await s.close() }
})
