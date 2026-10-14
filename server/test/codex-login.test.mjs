import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {DeviceLogin,parseDeviceOutput} from '../dist/providers/codex/login.js'

const sample = 'Open this link in your browser:\n\x1b[34mhttps://auth.openai.com/codex/device\x1b[0m\nEnter this one-time code (expires in 15 minutes)\n\x1b[32mTEST-CODE\x1b[0m\n'
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms))
function fixture(overrides = {}) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  const calls = [], events = []
  let completed = 0
  const login = new DeviceLogin({binary:'/opt/codex/codex',env:{CODEX_HOME:'/fresh/codex'},timeoutMs:1000,outputTimeoutMs:1000,
    onComplete:()=>completed++,onEvent:message=>events.push(message),
    spawnProcess:(...args)=>{ calls.push(args); return child },...overrides})
  return {login,child,calls,events,completed:()=>completed}
}

test('device parser strips ANSI and emits only link plus code',()=> {
  assert.deepEqual(parseDeviceOutput(sample+'fake-token-do-not-return'),{verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-CODE'})
  assert.equal(parseDeviceOutput('https://example.test/codex/device\nEnter this one-time code\nTEST-CODE'),undefined)
  assert.equal(parseDeviceOutput('https://auth.openai.com/codex/device.evil.test\nEnter this one-time code\nTEST-CODE'),undefined)
  assert.equal(parseDeviceOutput('https://auth.openai.com/codex/device\nnew unknown prompt\nTEST-CODE'),undefined)
})

test('login uses exact native device arguments, keeps code in RAM, clears on success',()=> {
  const f = fixture()
  f.login.start()
  assert.equal(f.calls[0][0],'/opt/codex/codex')
  assert.deepEqual(f.calls[0][1],['login','--device-auth'])
  assert.equal(f.calls[0][2].detached,false)
  f.child.stderr.write(sample.slice(0,70))
  f.child.stderr.write(sample.slice(70))
  assert.equal(f.login.state.userCode,'TEST-CODE')
  f.child.exitCode = 0
  f.child.emit('exit',0)
  assert.equal(f.login.state.state,'success')
  assert.equal(f.login.state.userCode,undefined)
  assert.equal(f.completed(),1)
  assert(!f.events.join('\n').includes('TEST-CODE'))
  assert(!f.events.join('\n').includes('https://auth'))
})

test('login expiry clears code and cannot be overwritten by a late exit',async()=> {
  const f = fixture({timeoutMs:20})
  f.login.start()
  f.child.stdout.write(sample)
  await sleep(40)
  assert.equal(f.login.state.state,'expired')
  assert.equal(f.login.state.userCode,undefined)
  f.child.emit('exit',0)
  assert.equal(f.login.state.state,'expired')
  assert.equal(f.completed(),0)
})

test('unrecognized or excessive login output becomes a visible sanitized error',async()=> {
  const f = fixture({outputTimeoutMs:20})
  f.login.start()
  f.child.stderr.write('fake-token-not-a-diagnostic')
  await sleep(40)
  assert.equal(f.login.state.state,'error')
  assert(!JSON.stringify(f.login.state).includes('fake-token'))
  assert(!f.events.join('\n').includes('fake-token'))
  const g = fixture()
  g.login.start()
  g.child.stdout.write('x'.repeat(17000))
  assert.equal(g.login.state.state,'error')
})

test('cancel hides code and stale process completion does not start the server',()=> {
  const f = fixture()
  f.login.start()
  f.child.stdout.write(sample)
  f.login.cancel()
  f.child.emit('exit',0)
  assert.equal(f.login.state.state,'idle')
  assert.equal(f.login.state.userCode,undefined)
  assert.equal(f.completed(),0)
})
