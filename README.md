# Remote Control (claude-rc)

Panel web para tener **Claude Code siempre disponible desde el móvil** en un servidor propio
(Ubuntu o Umbrel). Mantiene un `claude remote-control` por proyecto y, si el servidor se apaga
de golpe, rescata las conversaciones que estaban abiertas.

## Qué hace

- **Cuenta**: inicio de sesión oficial de claude.ai desde el panel (enlace + código). Remote
  Control no funciona con `claude setup-token` ni con claves de API.
- **Proyectos**: cada carpeta es un servidor `claude remote-control --name <prefijo>-<proyecto> --spawn …`.
  En el móvil o en claude.ai/code aparece con ese nombre y desde ahí se abren conversaciones.
- **Supervisión**: relanza los servidores que se caen (el modo servidor se cierra tras ~10 min
  sin red) con espera creciente; respeta la parada manual también tras reiniciar; contesta el
  «Trust» de las carpetas que el usuario marcó de confianza y muestra cualquier otra pregunta en
  el panel con botones Sí/No.
- **Recuperación**: al parar el contenedor manda Ctrl+C a cada servidor (parada limpia: todo
  vuelve solo). Si no hubo parada limpia (apagón, `docker kill`), las conversaciones abiertas
  quedan huérfanas: el gestor las rescata una a una con `claude remote-control --session-id`,
  las cierra y después el servidor del proyecto vuelve a atenderlas.
- **Terminal**: la consola real de cada servidor (tmux), para lo que no tenga botón.

## Cómo funciona por dentro

| Pieza | |
|---|---|
| `server/` | Gestor en Node.js 24 + TypeScript. SQLite integrado (`node:sqlite`), tmux para los procesos de Claude, `node-pty` + WebSocket para la terminal |
| `web/` | Panel en React + Vite |
| `/data` (volumen) | `claude/` (`CLAUDE_CONFIG_DIR`: credenciales, conversaciones), `home/` (`~/.claude`, incluye `bridge-spawn`), `claude-rc.db`, `proyectos/` |
| `/projects` | Carpeta de proyectos elegida por el usuario (montaje del host o de Umbrel) |

Para saber qué conversación es cada una, el gestor lee el registro de procesos de Claude Code
(`<config>/sessions/<pid>.json`: id local, carpeta, `bridgeSessionId` y estado) y guarda una copia en
SQLite cada pocos segundos. Es un formato interno de Claude Code: si cambia, el panel deja de ver
las conversaciones, pero los servidores siguen funcionando.

### Variables

| Variable | Por defecto | |
|---|---|---|
| `RC_NAME_PREFIX` | `rc` | Prefijo de los nombres en claude.ai/code |
| `PROJECT_ROOTS` | `/projects,/data/proyectos` | Carpetas donde se pueden crear proyectos |
| `PANEL_PASSWORD` | (vacío) | Si se define, el panel pide usuario `admin` y esta contraseña |

## Desplegar

**Ubuntu**: `deploy/ubuntu/compose.yaml` (panel en `127.0.0.1:7681`, se entra por túnel SSH).

**Umbrel**: tienda de apps `https://github.com/LogiQDAdmin/umbrel-app-store` → app «Remote Control».
En los ajustes de la app se elige la carpeta de proyectos.

**Versión nueva**: cambiar `CLAUDE_VERSION` si toca, `git tag vX.Y.Z && git push --tags`. La
acción de GitHub publica `ghcr.io/logiqdadmin/claude-rc:X.Y.Z`; después, subir el número en la tienda.

## Límites conocidos

- Recuperar una conversación por `--session-id` funciona durante unas 4 horas tras la parada
  (según la documentación de Remote Control); pasado ese tiempo puede volver como entrada nueva.
- Las conversaciones de un mismo proyecto comparten carpeta (modo `same-dir`) y la memoria
  automática del proyecto. No hay aislamiento entre proyectos dentro del contenedor.
- La versión de Claude Code va fijada en la imagen (`DISABLE_UPDATES=1`).
