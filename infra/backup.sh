#!/usr/bin/env bash
set -euo pipefail
umask 077
task_action=${1:-backup}
task_repository=$(cat "${RESTIC_REPOSITORY_FILE:?}")
# Primera versión operativa: SFTP, identidad y known_hosts montados, sin passwords en URL.
if [[ ! "$task_repository" =~ ^sftp:[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:/[A-Za-z0-9_./-]+$ ]] || [[ "$task_repository" == *YOUR_BACKUP_HOST* ]]; then
  printf '%s\n' 'Configura un repositorio SFTP externo válido en backup_repository.' >&2
  exit 1
fi
test -s /root/.ssh/known_hosts
test -s /root/.ssh/id_ed25519
unset task_repository

case "$task_action" in
  init) exec restic init ;;
  snapshots) exec restic snapshots --tag private-chat ;;
  check) exec restic check ;;
  retention-preview) exec restic forget --tag private-chat --group-by host,paths,tags --keep-within 7d --dry-run ;;
  retention-apply) exec restic forget --tag private-chat --group-by host,paths,tags --keep-within 7d --prune ;;
  restore-files)
    task_snapshot=${2:?Selecciona un snapshot explícito}
    [[ "$task_snapshot" =~ ^[a-f0-9]{8,64}$ ]] || { printf '%s\n' 'Snapshot inválido.' >&2; exit 1; }
    test -d /restore
    # No sobrescribir una recuperación previa ni tocar los volúmenes activos.
    if [[ -n $(find /restore -mindepth 1 -maxdepth 1 -print -quit) ]]; then
      printf '%s\n' 'El directorio de recuperación debe estar vacío.' >&2
      exit 1
    fi
    exec restic restore "$task_snapshot" --target /restore
    ;;
  backup) ;;
  *) printf '%s\n' 'Acción desconocida.' >&2; exit 1 ;;
esac

mkdir -p /staging
task_db_password=$(cat /run/secrets/db_owner_password)
[[ "$task_db_password" =~ ^[a-f0-9]{64}$ ]] || exit 1
printf '%s:%s:%s:%s:%s\n' "$PGHOST" "$PGPORT" "$PGDATABASE" "$PGUSER" "$task_db_password" > /tmp/private-chat.pgpass
chmod 600 /tmp/private-chat.pgpass
unset task_db_password
export PGPASSFILE=/tmp/private-chat.pgpass
trap 'rm -f /tmp/private-chat.pgpass /staging/database.dump' EXIT

# La operación documentada detiene API antes de esto: DB, avatares y journal coherentes.
pg_dump --format=custom --no-owner --file=/staging/database.dump
restic backup --host private-chat --tag private-chat /staging/database.dump /source/uploads /source/journal
printf '%s\n' 'Respaldo cifrado externo completado. Retención: aplicar tras revisar retention-preview.'
