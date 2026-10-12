# Preparación de la copia pública

La copia se preparó a partir de archivos versionados, sin copiar `.git`, secretos, cachés, builds anteriores, bases, journal, mensajes, fotos ni archivos locales. El repositorio privado original no se modificó. La URL de GitHub elegida por el operador se conserva intencionalmente en los controles de la interfaz.

Cambios:

- Nombres y fixtures personales sustituidos por identidades genéricas; nombres visibles configurables durante seed.
- Avatares incluidos eliminados; rutas iniciales opcionales con validación Sharp e idempotencia.
- Pregunta personal sustituida por código de invitación, manteniendo el DTO y la comparación existentes.
- Catálogo de stickers, sus imágenes, componentes y pruebas específicas eliminados; marcadores históricos mostrados como texto, sin migración destructiva.
- Iconos personalizados y sonido anterior sustituidos por recursos originales reproducibles.
- Enlaces de GitHub actualizados al repositorio elegido, manteniendo los iconos.
- Overlay, dominio y workflow de despliegue privado excluidos. CI genérica conservada; documentos operativos e informes históricos sustituidos por documentación genérica.
- Licencia MIT y metadata de workspaces añadidas; licencia de la fuente conservada e inventario npm incluido.

No se cambia el contrato HTTP v6, los endpoints, las columnas o los permisos de los dos roles. El PIN del admin sigue aprovisionándose con el seed; el del miembro se crea desde la web. No se incluye un instalador nativo ni recuperación administrativa de PIN por CLI.

## Comprobaciones ejecutadas

Entorno: macOS ARM64, Node 24.21.0, PostgreSQL nativo 16.15 y FFmpeg/FFprobe 9.0.2. El cluster exclusivo de esta copia usó loopback 55433 para evitar reutilizar instalaciones existentes, y se detuvo al terminar.

| Comando | Resultado |
| --- | --- |
| `npm ci --cache /tmp/private-chat-public-npm-cache --no-audit --no-fund` | 387 paquetes instalados; lockfile compatible |
| `npm run assets:generate` | Iconos genéricos y tono original generados |
| `PRIVATE_CHAT_TEST_PORT=55433 npm run verify:local` con Node 24 en PATH | Tipos/build y 185 pruebas correctas, cero omitidas |
| `npm run typecheck` y `npm run build` finales con Node 24 | Correctos tras los últimos cambios |
| `npm run check:public` | Auditoría estructural correcta |
| `node scripts/check-public.mjs --deny-file /tmp/private-chat-public-identifiers.txt` | Sin coincidencias de 11 identificadores privados, exceptuando deliberadamente la URL elegida |
| `PRIVATE_CHAT_TEST_PORT=55433 npm run test:db:stop` | Cluster de pruebas detenido |
| `git status --porcelain` en el proyecto privado original | Vacío; original intacto |

Desglose: 8 contratos, 6 infraestructura/helpers, 31 unitarias API, 80 frontend, 57 integración API y 3 integración de ejecución. Se verificaron ambos roles con PostgreSQL, permisos SQL y borrado, CSRF/sesiones/Origin, sockets, PIN, fotos, videos, citas y reconciliación de borrados. Las pruebas añadidas cubren el icono/enlace de GitHub, texto de marcadores antiguos, compositor sin catálogo, avatares opcionales y conservación del perfil, IDs y hashes al repetir seed.

Los primeros intentos detectaron una referencia residual del selector y dos expectativas de prueba que requerían ajuste; se corrigieron antes de la ejecución completa satisfactoria. Persisten avisos de deprecación de logging en Fastify y un log de teardown del transporte push asíncrono sobre un pool cerrado. Sus pruebas pasan; no se presentan como prueba de recepción push real.

No se verificaron Docker, PostgreSQL 18, Linux, macOS Intel, recepción en iPhone ni despliegue remoto en esta preparación. Este informe cubre la preparación local; la publicación de la fuente en GitHub no constituye un release ni un despliegue remoto. El paquete entregado contiene sólo fuente, documentos y recursos permitidos; excluye dependencias instaladas, builds y estado de pruebas.

## Archivos principales cambiados

`apps/api/src/cli/seed.ts`, `apps/web/src/components/{GateScreen,Composer,MessageBubble,ChatPanel,Sidebar,PushSettings}.tsx`, helpers y pruebas de sonido/citas/perfiles, `scripts/{local-env,test-db}.mjs`, `scripts/integration/{avatar,pin-gate}.test.mjs`, manifiesto/worker/HTML e iconos, `infra/api.Dockerfile`, `compose.yaml`, ejemplos de configuración, manifiestos npm y lockfile. Se añadieron generador de recursos, auditoría pública, regresiones, MIT, inventario de licencias y documentación genérica. Los componentes y assets del catálogo y los archivos del despliegue particular se excluyeron de la copia.
