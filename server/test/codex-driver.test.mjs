import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const scratch = path.resolve('.validation/codex-driver');
fs.mkdirSync(scratch,{recursive:true});
const root = fs.mkdtempSync(path.join(scratch,'isolated-'));
const projects = path.join(root,'projects');
fs.mkdirSync(projects);
process.env.DATA_DIR = root;
process.env.PROJECT_ROOTS = projects;
process.env.CODEX_USER_HOME = path.join(root,'codex-home');
process.env.CODEX_TMUX_SOCKET = 'agent-rc-codex-test';
const {createCodexDriver} = await import('../dist/providers/codex/driver.js');
const {q,db} = await import('../dist/providers/codex/db.js');
const lifecycle = [];
const service = {
  state: () => ({account:{loggedIn:false},server:{state:'incompatible',detail:'changed schema',restarts:1,experimental:true},
    login:{state:'idle'},projects:q.projects().map(p=>({...p,trust:p.trust===1})),events:[]}),
  boot:async()=>lifecycle.push('boot'),shutdown:async()=>lifecycle.push('shutdown'),
  startLogin:()=>({state:'pending'}),cancelLogin:()=>({state:'idle'}),
  startServer:async()=>lifecycle.push('start'),stopServer:async()=>lifecycle.push('stop'),restartServer:async()=>lifecycle.push('restart'),
  pair:async()=>({manualPairingCode:'TEST-PAIR',expiresAt:1900000000}),
  revokeTerminal:async id=>lifecycle.push(`revoke-${id}`),
  removeProject:async id=>q.deleteProject(id),
  terminal:async id=>({window:`p-${id}`}),
};
const driver = createCodexDriver(service);

test('Codex driver keeps incompatible state visible and routes only its own lifecycle',async()=> {
  const state = driver.state();
  assert.equal(state.provider,'codex');
  assert.equal(state.cliVersion,'0.162.1');
  assert.equal(state.server.state,'incompatible');
  assert.equal(state.details.server.detail,'changed schema');
  await driver.boot();
  await driver.request('server.restart',{});
  assert.deepEqual(await driver.request('login.start',{}),{state:'pending'});
  assert.deepEqual(await driver.request('remote.pair',{}),{manualPairingCode:'TEST-PAIR',expiresAt:1900000000});
  await assert.rejects(driver.request('claude.login',{}),/no admitida/);
  assert.deepEqual(lifecycle,['boot','restart']);
  process.env.RC_CODEX_INTEGRITY_ERROR = '1';
  try { await assert.rejects(driver.boot(),/integridad/); }
  finally { delete process.env.RC_CODEX_INTEGRITY_ERROR; }
  assert.deepEqual(lifecycle,['boot','restart']);
});

test('Codex driver validates provider bindings and returns IDs and its private terminal socket',async()=> {
  const dir = path.join(projects,'same-folder');
  fs.mkdirSync(dir);
  const record = await driver.request('projects.add',{name:'Nombre humano',path:dir,trust:true});
  assert.equal(record.name,'Nombre humano');
  assert.equal(record.trust,true);
  const terminal = await driver.request('terminal.open',{id:String(record.id)});
  assert.deepEqual(terminal,{window:`p-${record.id}`,tmuxSocket:'agent-rc-codex-test',tmuxSession:'agent-rc-codex'});
  await driver.request('projects.update',{id:record.id,trust:false});
  assert(lifecycle.includes(`revoke-${record.id}`));
  await assert.rejects(driver.request('projects.update',{id:record.id,trust:'yes'}),/booleano/);
  await assert.rejects(driver.request('projects.add',{name:'escape',path:root}),/autorizadas/);
  await driver.request('projects.remove',{id:record.id});
  await assert.rejects(driver.request('terminal.open',{id:record.id}),/no encontrado/);
});

test.after(async()=>{ await driver.shutdown(); db.close(); fs.rmSync(root,{recursive:true,force:true}); });
