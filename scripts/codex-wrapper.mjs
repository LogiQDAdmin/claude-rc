#!/usr/bin/env node
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const blocked = args.some((arg, index) =>
  arg === 'remote-control' || arg === 'update' || arg === 'pid-update-loop' ||
  arg === '--managed-daemon' || arg.includes('check_for_update_on_startup') ||
  (arg === 'daemon' && args.slice(0, index).includes('app-server'))
);
if (blocked) {
  console.error('Codex RC fixes the CLI in its image. Managed daemon, remote-control launcher and update commands are disabled. Use the panel to pair or restart the direct app-server.');
  process.exit(64);
}
const env = { ...process.env, HOME: '/data/codex-home', CODEX_HOME: '/data/codex' };
for (const name of ['CODEX_MANAGED_PACKAGE_ROOT', 'CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_BY_BUN', 'CODEX_MANAGED_BY_PNPM', 'CODEX_MANAGED_BY_VITE_PLUS']) delete env[name];
const child = spawn('/opt/codex/codex', ['-c', 'check_for_update_on_startup=false', ...args], { stdio: 'inherit', env });
child.on('error', () => { console.error('Could not start the pinned Codex binary'); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal) process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] ?? 1));
  process.exit(code ?? 1);
});
