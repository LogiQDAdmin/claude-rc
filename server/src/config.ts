import path from 'node:path'

const env = process.env
export const config = {
  port: Number(env.PORT ?? 8080),
  dataDir: env.DATA_DIR ?? '/data',
  projectRoots: (env.PROJECT_ROOTS ?? '/projects,/data/proyectos').split(',').map(v => v.trim()).filter(Boolean),
  panelPassword: env.PANEL_PASSWORD ?? '',
  webDir: env.WEB_DIR ?? path.resolve(import.meta.dirname, '../../web/dist'),
  version: env.APP_VERSION ?? '0.2.0-dev',
  workers: {
    claude: env.CLAUDE_WORKER_FILE ?? path.resolve(import.meta.dirname, 'providers/claude-worker.js'),
    codex: env.CODEX_WORKER_FILE ?? path.resolve(import.meta.dirname, 'providers/codex-worker.js'),
  },
}
