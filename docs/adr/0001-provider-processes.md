# ADR 0001: dos proveedores en una app

Fecha: 2026-10-14. Estado: aceptado para validación local.

El gestor 0.1.1 ya conserva proyectos, conversaciones y recuperación de Claude. La integración previa de Codex es experimental y tiene su propio protocolo de app-server. Ambos deben poder convivir sin que un fallo del protocolo de Codex bloquee el panel o Claude.

El proceso HTTP común inicia dos workers Node mediante IPC. Cada worker tiene grupo de procesos, HOME, CLI, base de datos, sesiones y socket tmux propios. Los CLIs se construyen como payloads nativos fijos desde una imagen Node independiente. El supervisor valida los mensajes, detecta salida y falta de respuestas, y limpia únicamente el grupo y el socket de ese proveedor.

El catálogo común en agent-rc.db añade asociaciones. Importa sólo las columnas públicas de proyectos de claude-rc.db; no migra ni lee credenciales. Claude conserva su esquema y HOME antiguos. Los proyectos exclusivos de Codex quedan fuera de la tabla legacy para que un rollback no arranque Claude sobre ellos.

El healthcheck verifica HTTP. No requiere que los workers estén disponibles ni que haya cuentas. Una incompatibilidad aparece como error del proveedor. Reiniciar el contenedor afecta a ambos, y un fallo del host, del almacenamiento común o del proceso HTTP continúa siendo una frontera compartida.

Ambos agentes pueden apuntar a la misma carpeta, pero los CLIs no comparten un bloqueo de escritura fiable. La interfaz avisa y recomienda turnos o worktrees separados. El aislamiento de procesos no convierte la edición simultánea de un checkout en una operación segura.
