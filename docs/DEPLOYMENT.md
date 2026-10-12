# Despliegue genérico con Compose y Caddy

Usar Node 24/npm 11 para los helpers y Docker Engine/Compose v2 en el servidor. Configurar DNS A/AAAA del dominio y permitir 80/443 hacia Caddy; no publicar API ni PostgreSQL. Copiar `.env.example` a `.env`, elegir `DOMAIN` y las identidades iniciales. El dominio de ejemplo es un placeholder, no un servidor operativo.

```sh
npm run secrets:init
docker compose --profile tools config --quiet
docker compose --profile tools build api web bootstrap
docker compose up -d postgres storage-init
docker compose --profile tools run --rm bootstrap
docker compose up -d api web
docker compose ps
```

Antes del bootstrap, el operador debe crear los archivos privados `.secrets/admin_pin` (4 dígitos) y `.secrets/guest_setup_secret` (código de invitación). Compose exige también `.secrets/vapid_private_key`: puede ser un archivo vacío si no se configura push. Con push, usar `node scripts/generate-vapid.mjs` y configurar la clave pública y el asunto. Las dos contraseñas iniciales se solicitan con entrada oculta; para automatización se pueden montar archivos y pasar sus rutas como `ADMIN_PASSWORD_FILE` y `MEMBER_PASSWORD_FILE` al servicio de bootstrap, sin valores secretos en argumentos. Los helpers actuales no constituyen un instalador sin interacción.

El seed crea exactamente dos cuentas, una conversación y recibos de lectura; aplica Sharp únicamente a avatares opcionales. Cambiar `.env` después no renombra ni cambia contraseñas o avatares de las cuentas existentes. Las cuentas editan sus perfiles desde la web. No hay recuperación administrativa de PIN implementada mediante CLI.

El API usa el rol limitado `private_chat_app`; migración, seed y grants usan `private_chat_owner`. Cookies HttpOnly/Secure/SameSite, CSRF y Origin exacto se conservan. Caddy sirve frontend, `/api` y `/socket.io` bajo un único origen HTTPS. Si el servidor comparte puertos con otro proxy, preparar su integración de forma explícita; no reemplazarlo ni detenerlo automáticamente.

## Backup y recuperación

Configurar `.secrets/backup_repository`, `.secrets/backup-ssh/id_ed25519` y `known_hosts`; conservar `backup_password` fuera del servidor. El repositorio inicial de secrets:init es sólo un placeholder.

```sh
docker compose --profile ops build backup
docker compose --profile ops run --rm --no-deps backup init
npm run backup
docker compose --profile ops run --rm --no-deps backup check
```

El helper detiene brevemente un API que estaba activo, respalda PostgreSQL, avatares y journal coherentes mediante restic, y lo vuelve a iniciar. Fotos/videos de mensajes están en PostgreSQL. Programar copias y probar una recuperación en el entorno de destino antes de confiar en ellas. No usar `docker compose down -v` para actualizar o desinstalar software.

Restaurar un ID explícito en `.data/restore`, vacío, y después en la base aislada de `compose.restore.yaml`:

```sh
docker compose --profile ops run --rm --no-deps backup restore-files ID_DEL_SNAPSHOT
docker compose -f compose.restore.yaml up -d restore-postgres
docker compose -f compose.restore.yaml run --rm restore-loader
docker compose -f compose.restore.yaml run --rm restore-reconcile
```

La reconciliación exige el journal vivo externo read-only, `RECOVERY_MODE=true`, e invalida las sesiones restauradas. Verificar mensajes borrados, perfiles, permisos, migraciones y avatares antes de una promoción manual explícita. No sobrescribe producción ni promueve automáticamente. La pérdida simultánea del servidor y del journal actualizado puede permitir resurrecciones; esta distribución no implementa replicación continua del journal.

Para actualizar: backup, parada controlada, build revisado, migraciones/grants con owner, arranque y readiness, y prueba de ambos roles. No restaurar una DB vieja para hacer rollback de código. Un cambio mayor de PostgreSQL requiere un procedimiento específico, no sólo cambiar la imagen.

Este documento describe los archivos disponibles; no certifica su ejecución con Docker ni un despliegue remoto.
