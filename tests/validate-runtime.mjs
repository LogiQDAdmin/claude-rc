#!/usr/bin/env node
// Run only inside the new, isolated Agent RC validation container. This helper
// reports booleans and binary metadata, never auth contents, device codes,
// account responses, process command lines or environment values.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';

const phase = process.argv[2] || 'runtime';
const checks = [];
const versions = {};
const hashes = {};
function check(name,condition) { checks.push({check:name,ok:Boolean(condition)}); }
function fileText(file) { return fs.readFileSync(file,'utf8').trim(); }
function output(binary,args) {
  try { return execFileSync(binary,args,{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:15000,maxBuffer:8192}).trim(); }
  catch { return undefined; }
}
function guarded(binary,args) {
  const result = spawnSync(binary,args,{stdio:['ignore','ignore','ignore'],timeout:5000});
  return result.status === 64;
}
function immutable(binary) {
  const stat = fs.statSync(binary);
  let writable = false;
  try { fs.accessSync(binary,fs.constants.W_OK); writable = true; } catch {}
  return stat.uid === 0 && (stat.mode & 0o222) === 0 && !writable;
}
function digest(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

try {
  check('runtime UID is 1000',process.getuid?.() === 1000);
  check('parent HOME retains Claude bridge compatibility',process.env.HOME === '/data/home');
  check('Claude update policy is disabled',process.env.DISABLE_UPDATES === '1' && process.env.DISABLE_AUTOUPDATER === '1');
  check('Codex config and user HOME are separate',process.env.CODEX_HOME === '/data/codex' && process.env.CODEX_USER_HOME === '/data/codex-home');
  check('provider tmux sockets are distinct',process.env.CLAUDE_TMUX_SOCKET === 'agent-rc-claude' && process.env.CODEX_TMUX_SOCKET === 'agent-rc-codex');
  for (const provider of ['claude','codex']) {
    const version = fileText(`/app/${provider.toUpperCase()}_VERSION`);
    versions[provider] = version;
    const binary = `/opt/${provider}/${provider}`;
    const expected = provider === 'claude' ? `${version} (Claude Code)` : `codex-cli ${version}`;
    check(`${provider} native version equals its version file`,output(binary,['--version']) === expected);
    check(`${provider} PATH wrapper preserves the pinned version`,output(`/usr/local/bin/${provider}`,['--version']) === expected);
    hashes[provider] = digest(binary);
    check(`${provider} native hash equals the image checksum`,hashes[provider] === fileText(`/opt/${provider}/${provider}.sha256`));
    check(`${provider} native is root-owned and not writable by runtime`,immutable(binary));
  }
  check('Claude version remains 2.1.294',versions.claude === '2.1.294');
  check('Codex version remains 0.162.1',versions.codex === '0.162.1');
  const settings = JSON.parse(fileText('/data/codex/app-server-daemon/settings.json'));
  check('Codex managed auto-update preference is false',settings.updater?.autoUpdateEnabled === false);
  check('fresh Codex credential file is absent',!fs.existsSync('/data/codex/auth.json'));
  check('fresh Claude credential files are absent',!fs.existsSync('/data/claude/.credentials.json') && !fs.existsSync('/data/home/.claude/.credentials.json'));
  check('no managed Codex installation was created',!fs.existsSync('/data/codex/packages'));
  check('Codex startup updater cache was not created',!fs.existsSync('/data/codex/version.json'));
  check('Codex explicit update is blocked',guarded('/usr/local/bin/codex',['update']));
  check('Codex managed bootstrap is blocked',guarded('/usr/local/bin/codex',['app-server','daemon','bootstrap','--remote-control']));
  check('Codex managed remote-control launcher is blocked',guarded('/usr/local/bin/codex',['remote-control','pair']));
  check('Claude explicit update is blocked',guarded('/usr/local/bin/claude',['update']));
  check('Claude installer is blocked',guarded('/usr/local/bin/claude',['install']));

  const initArgs = fs.readFileSync('/proc/1/cmdline','utf8').split('\0').filter(Boolean);
  const ownContainer = initArgs[0] === '/usr/bin/tini';
  check('process inventory belongs to the validation container',ownContainer);
  if (ownContainer) {
    let updaterFound = false;
    let directServerFound = false;
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let args;
      try { args = fs.readFileSync(path.join('/proc',entry,'cmdline'),'utf8').split('\0').filter(Boolean); } catch { continue; }
      if (!args.length) continue;
      const codex = path.basename(args[0]) === 'codex' || args[0].startsWith('/data/codex/packages/');
      if (codex && (args.includes('pid-update-loop') || args.includes('bootstrap') || args.includes('update') || (args.includes('app-server') && args.includes('daemon')))) updaterFound = true;
      if (codex && args.includes('app-server') && args.includes('--remote-control') && !args.includes('daemon')) directServerFound = true;
    }
    check('no Codex managed daemon or updater process exists',!updaterFound);
    check('pinned direct Codex app-server is running',directServerFound);
  }
} catch {
  check('runtime inspection completed without an unexpected failure',false);
}
const ok = checks.every(row=>row.ok);
process.stdout.write(`${JSON.stringify({phase,ok,versions,hashes,checks})}\n`);
if (!ok) process.exitCode = 1;
