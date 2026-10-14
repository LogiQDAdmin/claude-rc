# Remote Control — Claude y Codex

Una app y un contenedor para Claude Code y Codex. El panel conserva el gestor de proyectos, conversaciones y recuperación de Claude RC 0.1.1 y añade Codex como proveedor independiente. La integración de Codex es experimental. Versión 0.2.1: corrige el inicio de sesión de Claude y distingue la conexión al relay de Codex del emparejamiento de otro dispositivo. Publicar una imagen y actualizar una instalación existente son pasos separados.

La CLI de Claude 2.1.294 genera el enlace de login `https://claude.com/cai/oauth/authorize`. El panel reconoce esta dirección exacta y conserva los enlaces oficiales anteriores; no acepta dominios parecidos ni mezcla el flujo de Claude con el de Codex.

## Versiones y actualizaciones

`CLAUDE_VERSION` fija Claude Code en **2.1.294** y `CODEX_VERSION` fija Codex en **0.162.1**. La imagen multi-stage parte de Node 24; descarga los dos payloads nativos oficiales en etapas independientes. No hereda de una imagen de Claude RC. Los ejecutables de `/opt/claude/claude` y `/opt/codex/codex` pertenecen a root y no son escribibles por el usuario de la app (UID 1000).

Claude recibe `DISABLE_UPDATES=1` y `DISABLE_AUTOUPDATER=1` en el arranque, sus procesos y el wrapper de terminal. El wrapper rechaza `claude update`. Codex se invoca con `-c check_for_update_on_startup=false`. Su wrapper rechaza `update`, `remote-control`, `app-server daemon` y `pid-update-loop`, que podrían activar el arranque gestionado. El backend inicia directamente el app-server nativo sin el launcher gestionado.

**No basta con desactivar el aviso de actualización de Codex.** En esta versión el daemon gestionado activa por defecto su updater. Cada arranque de la app fuerza `updater.autoUpdateEnabled=false` en `/data/codex/app-server-daemon/settings.json`, aunque el archivo ya existiera con `true`. Desaparecen del entorno las variables de gestión de paquetes antes de ejecutar Codex. Las pruebas deben verificar el valor después de recrear el contenedor y que ningún proceso `pid-update-loop` o daemon gestionado aparece al abrir un terminal. Los checksums y versiones se comprueban de forma independiente: una integridad incorrecta deja visible el fallo de ese proveedor y el panel sigue arrancando.

Cambiar un archivo de versión exige construir y validar una nueva imagen. No hay actualización automática de los CLIs.

## Cuentas y proyectos

Cada proveedor tiene su propio bloque de cuenta y sus botones. Abrir el panel no inicia un login.

- **Claude:** el panel ejecuta el flujo oficial de Claude, muestra el enlace y permite introducir el código que entregue su web. Conserva Remote Control por proyecto, preguntas de confianza, terminales, conversaciones, modos de spawn y recuperación de conversaciones huérfanas con su identificador original.
- **Codex:** el panel ejecuta `codex login --device-auth`, muestra el enlace oficial y el código de dispositivo; el usuario completa el proceso en la web. El código vive sólo en memoria y se borra al cancelar, caducar, terminar o caer/detenerse su worker. El estado público evita duplicarlo en otros campos. No se pide la contraseña de OpenAI en el panel. El app-server ofrece estado de cuenta, estado remoto y emparejamiento experimental; cada proyecto tiene su terminal CLI.

**Codex: iniciar sesión no empareja otro escritorio.** «Relay conectado» confirma que el app-server está conectado al servicio remoto. El emparejamiento es un paso separado: se inicia desde el panel y se canjea en el cliente compatible. El panel consulta `remoteControl/pairing/status` para ese intento y sólo muestra «Emparejamiento confirmado» cuando el servidor devuelve `claimed=true`. Esta confirmación acredita el canje del código; no demuestra que el cliente pueda abrir proyectos o conversaciones. El código permanece sólo en memoria hasta cerrar el intento, caducar, confirmarse o parar/reiniciar su proveedor. Cerrar borra la copia local; el código emitido por OpenAI conserva su caducidad original, porque esta API no define una operación de revocación.

En la app de escritorio, la [guía oficial de conexiones remotas](https://learn.chatgpt.com/docs/remote-connections) sitúa la configuración en Ajustes → Conexiones → Controlar otros dispositivos; su disponibilidad depende del cliente y del despliegue. Utiliza el código manual únicamente si el cliente ofrece esa opción. La documentación oficial de acceso móvil describe hosts Mac/Windows con la app de escritorio, no una configuración desde Codex CLI. Este contenedor Linux usa APIs experimentales y su compatibilidad completa con esos clientes aún no está verificada. No se inventa una URL ni un QR a partir del código.

La operación nativa de emparejamiento admite hasta 30 segundos de espera HTTP. El adaptador reserva 40 segundos para `pairing/start` y `pairing/status`, conservando el límite corto en el resto de llamadas. Los fallos del intento generan un diagnóstico fijo y seguro en el registro, sin códigos, identificadores opacos ni mensajes crudos del servidor.

Al añadir un proyecto se elige Claude, Codex o ambos. También se puede añadir el otro proveedor a una carpeta existente. Los archivos del proyecto se conservan al quitar una asociación o eliminarla del catálogo. El permiso de confianza se concede por proveedor. Revocarlo cierra sus terminales; en Claude también detiene su proceso de proyecto.

**Dos agentes pueden editar los mismos archivos y competir por el índice Git.** No comparten un bloqueo de escritura fiable. Para una misma carpeta, trabaja por turnos; para trabajar en paralelo, crea worktrees Git separados y añádelos como proyectos distintos. El modo `worktree` de Claude afecta a sus nuevas conversaciones; Codex usa la carpeta que se le asignó. El panel muestra este aviso cuando se eligen ambos.

El estado manual Parar/Arrancar de Claude se conserva tras recrear, como en 0.1.1. Su campo legacy `autostart` se mantiene; el gestor antiguo seguía `desired` y no aplicaba ese campo como condición adicional. La migración conserva ese comportamiento.

## Datos y compatibilidad con 0.1.1

| Ruta | Propietario y finalidad |
|---|---|
| `/data/claude` | Configuración, credenciales y conversaciones de Claude; misma ruta que 0.1.1 |
| `/data/home` | HOME legado de Claude; se conserva `~/.claude`, incluido `bridge-spawn` |
| `/data/claude-rc.db` | Esquema, proyectos, conversaciones, eventos y metadatos originales de Claude |
| `/data/codex` | CODEX_HOME independiente, login nuevo y configuración del updater |
| `/data/codex-home` | HOME independiente de los procesos y terminales Codex |
| `/data/codex-rc.db` | Proyectos y eventos propios de Codex |
| `/data/agent-rc.db` | Catálogo común y asociaciones proveedor/proyecto; añadido en 0.2.0 |
| `/data/codex-rc` | Socket privado y archivos de supervisión del app-server |
| `/projects`, `/data/proyectos` | Raíces de carpetas autorizadas |

La importación del catálogo consulta sólo los campos públicos de proyectos de `claude-rc.db`, con SQLite en modo lectura. Es idempotente, conserva nombres y rutas aunque haya carpetas repetidas en datos antiguos, y no reescribe la base de datos legacy. El worker de Claude sigue usándola como antes: registra su actividad y aplica el mismo protocolo de parada y rescate. No se copian ni se leen credenciales de otras instalaciones para la migración o las pruebas.

Los proyectos de Codex **no entran en la tabla legacy de Claude**: volver a 0.1.1 no debe iniciar Claude sobre un proyecto exclusivo de Codex. Conserva una copia de seguridad del volumen antes de una actualización real, como para cualquier cambio de versión con datos persistentes. Esta rama no actualiza por sí sola ninguna instalación.

## Supervisión y partes experimentales

El HTTP común inicia dos procesos Node por IPC; cada uno tiene grupo de procesos y servidor tmux privado (`agent-rc-claude` / `agent-rc-codex`). Una caída, un bloqueo o un mensaje incompatible queda limitado al proveedor. Los CLIs y sus terminales se limpian sólo en ese grupo/socket. Una parada de proveedor persiste y no cambia las preferencias de proyectos del otro.

`GET /healthz` comprueba el panel y responde sin cuenta, incluso si ambos proveedores están detenidos. No exige login y permite usar `PANEL_PASSWORD` sin romper la sonda. El reinicio del contenedor afecta a ambos; el host, el volumen y el proceso HTTP siguen siendo recursos compartidos.

Estas dependencias no ofrecen un contrato estable para toda la integración:

- El app-server y Remote Control de Codex 0.162.1 usan WebSocket sobre socket Unix y JSON-RPC experimental. Se validan `initialize` (incluida la versión), `account/read`, `remoteControl/status/read`, `remoteControl/pairing/start` y `remoteControl/pairing/status`. El backend acepta una falta de cuenta y valida los campos requeridos, sus tipos y las enumeraciones de estas respuestas; los campos adicionales se ignoran. La interfaz muestra **Formato incompatible** o **Detenido inesperadamente**, con diagnóstico del proveedor y controles de reinicio.
- El modo de arranque gestionado, los nombres de opciones CLI, la ubicación `app-server-daemon/settings.json` y el formato del mensaje de `--device-auth` son específicos de esa versión. Se prueban con el binario fijado y con fixtures de formato incorrecto. Una versión nueva requiere revalidarlos.
- Claude Remote Control se integra a través de CLI, sesiones persistidas y salida de terminal; sus mensajes y formatos también pueden cambiar. El parser y la recuperación del gestor 0.1.1 tienen pruebas de regresión.

Una cuenta autenticada y una respuesta real desde el móvil requieren login humano. Las pruebas sin credenciales, los mocks y la aparición de un código no demuestran por sí solos que se haya completado una conversación remota.

Referencias oficiales: [Codex app-server](https://developers.openai.com/codex/app-server), [autenticación Codex](https://developers.openai.com/codex/auth), [fuente fijada de Codex](https://github.com/openai/codex/tree/rust-v0.162.1), [variables de Claude](https://code.claude.com/docs/en/env-vars).

## Construcción y pruebas locales

```sh
docker build --build-arg APP_VERSION=0.2.1 -t agent-rc:local .
# deploy/local/compose.yaml usa sólo volúmenes propios de esta prueba.
docker compose -f deploy/local/compose.yaml up -d
```

El compose de pruebas publica `127.0.0.1:3782`. `PANEL_PASSWORD` queda vacío por defecto. Si se configura voluntariamente, el usuario del panel es `admin`. Los flujos de login de proveedor siguen siendo independientes de esa protección HTTP. `PROJECT_ROOTS` limita las carpetas; se rechazan enlaces simbólicos que escapen de ellas.

Con Node 24:

```sh
cd server
npm ci
npm test
cd ../web
npm ci
npm test
npm run build
```

Las pruebas cubren los proveedores, el enlace actual de Claude, los estados y caducidad del emparejamiento de Codex, los parsers y errores de protocolo, confianza y terminales, paro manual, login separado, recuperación y campos legacy, importación idempotente, aislamiento de workers, CSRF y healthcheck. `tests/validate-runtime.mjs` comprueba dentro de un contenedor de prueba propio las versiones, hashes, permisos, configuración del updater y ausencia de arranque gestionado. Se debe repetir tras recrear y tras abrir un terminal Codex.

## Umbrel y publicación

La versión 0.2.0 mantiene el ID **`logiqd-claude-rc`**, el puerto **3781**, los montajes y los datos de la app instalada. Cambia el nombre visible a **Remote Control — Claude y Codex** y añade el proveedor. El puerto 3782 se usa para validación local independiente. No hace falta recrear Umbrel para el puerto de la app existente.

El tag `v0.2.1` ejecuta el workflow que publica `ghcr.io/logiqdadmin/claude-rc:0.2.1` para `linux/amd64`. La tienda debe apuntar a esa versión después de que el workflow termine correctamente y la imagen sea descargable sin credenciales. Publicar la actualización no la instala: el usuario la inicia desde la interfaz de Umbrel. Las imágenes publicadas 0.1.1 y 0.2.0 no se sobrescriben.
