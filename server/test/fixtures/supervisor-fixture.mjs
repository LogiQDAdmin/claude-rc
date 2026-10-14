import {runProviderWorker} from '../../dist/worker-protocol.js'

export async function runFixture(provider) {
  const mode = process.env[`AGENT_FIXTURE_${provider.toUpperCase()}_MODE`]??'normal'
  const state = {provider,cliVersion:provider==='claude'?'2.1.294':'0.162.1',account:{loggedIn:false},
    server:{state:'disponible',detail:'Synthetic provider available',restarts:0},login:{state:'idle'}}
  await runProviderWorker({
    boot:async()=>{ if (mode==='boot-hang') await new Promise(()=>{}) },
    state:()=>mode==='bad-state'?{...state,login:{state:'pending',verificationUrl:42}}:state,
    request:async(action)=> {
      if (action==='identity') return {provider,pid:process.pid}
      if (action==='crash') { setTimeout(()=>process.exit(17),10);return {accepted:true} }
      if (action==='stall') { setTimeout(()=>{ while (true) {} },10);return {accepted:true} }
      if (action==='hang-request') await new Promise(()=>{})
      if (action==='bad-state') { process.send({type:'state',state:{provider,unexpected:'changed-format'}});return {accepted:true} }
      if (action==='throw-private') throw new Error('synthetic-private-token-never-publish')
      if (action==='pending-login') { state.login={state:'pending',verificationUrl:'https://fixture.invalid/device',userCode:'TEST-ONLY'};return state.login }
      return {ok:true}
    },
    shutdown:async()=> {
      if (mode==='slow-stop') await new Promise(resolve=>setTimeout(resolve,150))
      state.server.state='detenido'
    },
  })
}
