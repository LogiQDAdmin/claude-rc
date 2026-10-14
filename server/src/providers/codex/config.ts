import path from 'node:path'
import fs from 'node:fs'

const env = process.env
const dataDir = path.resolve(env.DATA_DIR ?? '/data')
const versionFile = env.CODEX_VERSION_FILE ?? '/app/CODEX_VERSION'
const codexVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '0.162.1'
if (!/^\d+\.\d+\.\d+$/.test(codexVersion)) throw new Error('CODEX_VERSION no válido')

export const config = {
  port: Number(env.PORT ?? 8080),
  dataDir,
  codexHome: env.CODEX_HOME ?? path.join(dataDir, 'codex'),
  home: env.CODEX_USER_HOME ?? path.join(dataDir, 'codex-home'),
  codexBinary: env.CODEX_BINARY ?? '/opt/codex/codex',
  codexSocket: env.CODEX_SOCKET_PATH ?? path.join(dataDir, 'codex-rc', 'app-server.sock'),
  codexVersion,
  projectRoots: (env.PROJECT_ROOTS ?? '/projects,/data/proyectos').split(',').map(p => p.trim()).filter(Boolean),
  panelPassword: env.PANEL_PASSWORD ?? '',
  webDir: path.resolve(env.WEB_DIR ?? path.resolve(import.meta.dirname, '../../web/dist')),
  // Un servidor tmux propio, distinto de cualquier app de referencia.
  tmuxSocket: env.CODEX_TMUX_SOCKET ?? 'agent-rc-codex',
  tmuxSession: 'agent-rc-codex',
  version: env.APP_VERSION ?? '0.2.0-local',
  loginTimeoutMs: 15 * 60_000,
}

export const dbPath = path.join(dataDir, 'codex-rc.db')
