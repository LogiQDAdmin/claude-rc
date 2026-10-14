import path from 'node:path'

const env = process.env

export const config = {
  port: Number(env.PORT ?? 8080),
  dataDir: env.DATA_DIR ?? '/data',
  // Claude guarda aquí credenciales, ajustes, conversaciones y el registro de sesiones.
  claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? '/data/claude',
  // Carpetas donde puede haber proyectos. La primera suele ser la elegida por el usuario
  // (montaje de Umbrel o del host); la última, una carpeta propia de la app.
  projectRoots: (env.PROJECT_ROOTS ?? '/projects,/data/proyectos')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
  // Prefijo de los nombres que se ven en claude.ai/code: "<prefijo>-<proyecto>".
  namePrefix: env.RC_NAME_PREFIX ?? 'rc',
  // Si se define, el panel pide usuario "admin" y esta contraseña (para Ubuntu sin proxy).
  panelPassword: env.PANEL_PASSWORD ?? '',
  webDir: env.WEB_DIR ?? path.resolve(import.meta.dirname, '../../web/dist'),
  tmuxSocket: 'rc',
  tmuxSession: 'rc',
  version: env.APP_VERSION ?? 'dev',
}

export const dbPath = path.join(config.dataDir, 'claude-rc.db')
