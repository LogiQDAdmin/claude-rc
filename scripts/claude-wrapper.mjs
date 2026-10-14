#!/usr/bin/env node
import {spawn} from 'node:child_process';

const args = process.argv.slice(2);
if (['update','install'].includes(args[0])) {
  console.error('Agent RC fixes Claude Code in its image. Replace the app image to change versions.');
  process.exit(64);
}
// Preserve legacy HOME for bridge-spawn, independently of the Codex provider.
const env = {...process.env,HOME:'/data/home',CLAUDE_CONFIG_DIR:'/data/claude',DISABLE_UPDATES:'1',DISABLE_AUTOUPDATER:'1'};
const child = spawn('/opt/claude/claude',args,{stdio:'inherit',env});
child.on('error',()=>{console.error('Could not start the pinned Claude binary');process.exit(1)});
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) process.on(signal,()=>child.kill(signal));
child.on('exit',(code,signal)=>process.exit(signal ? 128+({SIGINT:2,SIGTERM:15,SIGHUP:1}[signal]??1) : code??1));
