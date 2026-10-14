import {mkdir,readFile,writeFile,access,constants,open,rename,unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';

async function writeDaemonSettings(file,value) {
  const directory = '/data/codex/app-server-daemon';
  const temporary = `${directory}/.settings-${process.pid}-${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary,'wx',0o600);
    await handle.writeFile(`${JSON.stringify(value,null,2)}\n`,'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary,file);
    // Flush the directory entry as well as the contents before launching workers.
    const parent = await open(directory,'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    if (handle) await handle.close();
    try { await unlink(temporary); } catch(error) { if (error.code !== 'ENOENT') throw error; }
  }
}

let claudeFailure = false;
let codexFailure = false;
// HOME is deliberately different for the two providers. Do not move or inspect
// auth files when preparing either provider's directories.
try {
  for (const dir of ['/data/home','/data/claude']) await mkdir(dir,{recursive:true,mode:0o700});
} catch { claudeFailure = true; }
try {
  const home = '/data/codex';
  for (const dir of ['/data/codex-home',home,'/data/codex-rc',`${home}/app-server-daemon`]) {
    await mkdir(dir,{recursive:true,mode:0o700});
  }
  try {
    await writeFile(`${home}/config.toml`,[
      'check_for_update_on_startup = false',
      'cli_auth_credentials_store = "file"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"','',
    ].join('\n'),{flag:'wx',mode:0o600});
  } catch(error) { if (error.code !== 'EEXIST') throw error; }
  const settingsPath = `${home}/app-server-daemon/settings.json`;
  let settings = {};
  try {
    settings = JSON.parse(await readFile(settingsPath,'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings');
  } catch(error) { if (error.code !== 'ENOENT') throw error; }
  settings.updater = {...(settings.updater && typeof settings.updater === 'object' ? settings.updater : {}),autoUpdateEnabled:false};
  await writeDaemonSettings(settingsPath,settings);
} catch { codexFailure = true; }

async function verify(binary,versionFile,digestFile,label) {
  const version = (await readFile(versionFile,'utf8')).trim();
  const expected = label === 'codex' ? `codex-cli ${version}` : `${version} (Claude Code)`;
  if (execFileSync(binary,['--version'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:10000}).trim() !== expected) throw new Error('Version mismatch');
  const digest = createHash('sha256').update(await readFile(binary)).digest('hex');
  if (digest !== (await readFile(digestFile,'utf8')).trim()) throw new Error('Checksum mismatch');
  try { await access(binary,constants.W_OK); } catch { return; }
  throw new Error('Writable binary');
}
// Image build assertions are strict. Runtime errors remain confined to the
// affected worker so the panel and other provider can still start.
try { await verify('/opt/codex/codex','/app/CODEX_VERSION','/opt/codex/codex.sha256','codex'); } catch { codexFailure = true; }
try { await verify('/opt/claude/claude','/app/CLAUDE_VERSION','/opt/claude/claude.sha256','claude'); } catch { claudeFailure = true; }

// Only these constant statements enter eval in entrypoint.sh. Nothing read from
// disk, a child process, IPC or a remote service is interpolated into stdout.
process.stdout.write(claudeFailure ? "export RC_CLAUDE_INTEGRITY_ERROR='1'\n" : 'unset RC_CLAUDE_INTEGRITY_ERROR\n');
process.stdout.write(codexFailure ? "export RC_CODEX_INTEGRITY_ERROR='1'\n" : 'unset RC_CODEX_INTEGRITY_ERROR\n');
console.error(`Agent RC integrity: Claude ${claudeFailure?'failed':'verified'}; Codex ${codexFailure?'failed':'verified'}; updaters disabled for verified providers`);
