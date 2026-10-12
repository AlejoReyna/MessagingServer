#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$PGHOST" == restore-postgres && "$PGDATABASE" == private_chat_restore ]] || { printf '%s\n' 'Destino de recuperación inválido.' >&2; exit 1; }
test -f /recovery/database.dump
task_db_password=$(cat /run/secrets/db_owner_password)
[[ "$task_db_password" =~ ^[a-f0-9]{64}$ ]] || exit 1
printf '%s:%s:%s:%s:%s\n' "$PGHOST" "$PGPORT" "$PGDATABASE" "$PGUSER" "$task_db_password" > /tmp/recovery.pgpass
chmod 600 /tmp/recovery.pgpass
unset task_db_password
export PGPASSFILE=/tmp/recovery.pgpass
trap 'rm -f /tmp/recovery.pgpass' EXIT
task_table_count=$(psql --no-psqlrc --tuples-only --no-align --command="SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');")
[[ "$task_table_count" == 0 ]] || { printf '%s\n' 'La base de recuperación debe estar vacía. No se sobrescribirá.' >&2; exit 1; }
pg_restore --exit-on-error --single-transaction --no-owner --no-privileges --dbname="$PGDATABASE" /recovery/database.dump
printf '%s\n' 'Snapshot cargado en base aislada. Reconciliar journal antes de habilitar cualquier API.'
