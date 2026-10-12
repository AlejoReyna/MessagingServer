# Private Chat

Chat web privado para exactamente dos cuentas precreadas, roles admin/member y una conversación. Incluye texto, emojis, fotos, videos, respuestas citadas, perfiles editables, presencia y lectura. Ambos pueden borrar sus mensajes para ambos; sólo admin puede borrar mensajes ajenos o vaciar la conversación.

Repositorio: [MessagingServer](https://github.com/AlejoReyna/MessagingServer). La interfaz conserva el acceso a GitHub en móvil y escritorio.

Node 24 LTS, npm 11+, ESM y TypeScript estricto. API Fastify/Socket.IO, Prisma y PostgreSQL real; Sharp para imágenes, FFmpeg/FFprobe para videos; frontend React compilado servido mediante Caddy. HTTPS protege el transporte; el servidor puede leer los mensajes. No hay cifrado de extremo a extremo ni registro público.

## Desarrollo

```sh
npm ci
npm run check:foundation
npm run typecheck
npm run build
```

Para desarrollo con la base de Compose:

```sh
npm run secrets:init
docker compose -f compose.dev.yaml up -d
```

Antes de `npm run db:local`, suministrar `.secrets/admin_pin` (4 dígitos) y `.secrets/guest_setup_secret` (código de invitación). Las contraseñas iniciales se leen con entrada oculta en terminal, o mediante `ADMIN_PASSWORD_FILE` y `MEMBER_PASSWORD_FILE`. No poner sus valores en argumentos o archivos versionados. Los secretos y datos locales están ignorados por Git.

`ADMIN_USERNAME` y `PARTNER_USERNAME` eligen usernames; `ADMIN_DISPLAY_NAME` y `MEMBER_DISPLAY_NAME` eligen nombres visibles. Por defecto son admin/member y Administrador/Miembro. `ADMIN_AVATAR_FILE` y `MEMBER_AVATAR_FILE` permiten fotos iniciales opcionales suministradas por el operador, nunca incluidas en este repositorio. El seed conserva cuentas existentes.

```sh
npm run db:local
npm run dev:api
```

En otra terminal, `npm run dev:web`; abrir `http://127.0.0.1:5173`. El miembro crea su PIN mediante el código de invitación y el admin usa el PIN provisionado o sus credenciales. Cada cuenta debe cambiar su contraseña inicial. El código de invitación se compara sin distinguir mayúsculas; no es una recuperación de cuentas.

## Verificación

Con PostgreSQL nativo y FFmpeg/FFprobe en PATH:

```sh
npm run verify:local
npm run test:db:stop
```

El helper crea un cluster exclusivo en `.data/postgres-integration`, loopback 55432; `PRIVATE_CHAT_TEST_PORT` permite elegir otro puerto libre. No usar una base con datos reales para integración. `npm run verify` requiere `INTEGRATION_DATABASE_URL` de una base exclusiva y ejecuta tipos, pruebas, build e integración real. No se omiten pruebas por falta de PostgreSQL.

## Producción y publicación

Consultar [despliegue y recuperación](docs/DEPLOYMENT.md), [contrato v6](docs/CONTRACT.md), [perfiles](docs/PROFILE_PHOTOS.md) y [notificaciones](docs/IOS_PUSH.md). Esta copia no incluye un instalador nativo ni publica paquetes o releases automáticamente. Docker es una vía existente de despliegue, cuya ejecución debe comprobarse en el servidor de destino.

Licencia [MIT](LICENSE) para el código del proyecto y los recursos originales generados. Las dependencias y la fuente tienen sus propias licencias: [inventario](docs/ASSETS_AND_LICENSES.md). La distribución no incluye catálogos de stickers de terceros ni datos personales. Los marcadores históricos de esos catálogos se muestran como texto.

[Preparación y resultados de comprobación](docs/PUBLIC_PREPARATION.md) e [instrucciones para crear el repositorio nuevo](docs/PUBLISHING.md). No importar el historial Git, secretos, base de datos ni informes de un despliegue privado al crear el nuevo repositorio.
