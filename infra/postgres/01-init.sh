#!/usr/bin/env bash
set -euo pipefail
# Sólo para el primer arranque del volumen. No imprime ni pasa passwords por argv.
task_db_password=$(cat /run/secrets/db_app_password)
if [[ ! "$task_db_password" =~ ^[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'Formato inválido de db_app_password; usa secrets:init.' >&2
  exit 1
fi
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
REVOKE ALL ON DATABASE private_chat FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS chat AUTHORIZATION private_chat_owner;
CREATE ROLE private_chat_app LOGIN PASSWORD '$task_db_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE private_chat TO private_chat_app;
GRANT USAGE ON SCHEMA chat TO private_chat_app;
SQL
unset task_db_password
