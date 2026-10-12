-- Esquema inicial del chat privado.
-- Los CHECK hacen cumplir a nivel de base de datos: dos slots con roles
-- asociados, una única conversación y unicidad de nombre insensible a
-- mayúsculas (el username se guarda normalizado a minúsculas).

CREATE SCHEMA IF NOT EXISTS "chat";

CREATE TABLE IF NOT EXISTS "chat"."users" (
  "id" text PRIMARY KEY,
  "slot" smallint NOT NULL UNIQUE CHECK ("slot" IN (1, 2)),
  "username" text NOT NULL UNIQUE CHECK ("username" ~ '^[a-z0-9_.-]{3,32}$'),
  "display_name" text NOT NULL CHECK (char_length("display_name") BETWEEN 1 AND 60),
  "role" text NOT NULL CHECK ("role" IN ('admin', 'member')),
  "password_hash" text NOT NULL,
  "avatar_path" text,
  "avatar_version" integer NOT NULL DEFAULT 0,
  "must_change_password" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "users_slot_role_ck"
    CHECK (("slot" = 1 AND "role" = 'admin') OR ("slot" = 2 AND "role" = 'member'))
);

CREATE TABLE IF NOT EXISTS "chat"."sessions" (
  "id" text PRIMARY KEY,
  "token_hash" text NOT NULL UNIQUE,
  "user_id" text NOT NULL REFERENCES "chat"."users"("id") ON DELETE CASCADE,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "expires_at" timestamptz(6) NOT NULL,
  "revoked_at" timestamptz(6),
  "last_seen_at" timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "chat"."sessions"("user_id");

CREATE TABLE IF NOT EXISTS "chat"."conversation" (
  "id" smallint PRIMARY KEY CHECK ("id" = 1),
  "version" integer NOT NULL DEFAULT 1,
  "last_sequence" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "chat"."messages" (
  "id" text PRIMARY KEY,
  "conversation_id" smallint NOT NULL REFERENCES "chat"."conversation"("id"),
  "sender_id" text NOT NULL REFERENCES "chat"."users"("id"),
  "client_message_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "body" text NOT NULL CHECK (char_length("body") BETWEEN 1 AND 4000),
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "messages_sender_key_uq" UNIQUE ("sender_id", "client_message_id"),
  CONSTRAINT "messages_conversation_seq_uq" UNIQUE ("conversation_id", "sequence")
);
CREATE INDEX IF NOT EXISTS "messages_conversation_sequence_idx"
  ON "chat"."messages"("conversation_id", "sequence");

CREATE TABLE IF NOT EXISTS "chat"."read_receipts" (
  "user_id" text PRIMARY KEY REFERENCES "chat"."users"("id") ON DELETE CASCADE,
  "last_read_sequence" integer NOT NULL DEFAULT 0,
  "read_at" timestamptz(6),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "chat"."deletion_audit" (
  "id" text PRIMARY KEY,
  "actor_id" text NOT NULL REFERENCES "chat"."users"("id"),
  "action" text NOT NULL CHECK ("action" IN ('message_deleted', 'conversation_cleared')),
  "message_id" text,
  "conversation_version" integer NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "deletion_audit_actor_idx" ON "chat"."deletion_audit"("actor_id");

-- Tombstones sin texto: impiden que un reintento o una restauración
-- recree mensajes borrados. Jamás guardan el body.
CREATE TABLE IF NOT EXISTS "chat"."message_tombstones" (
  "message_id" text PRIMARY KEY,
  "sender_id" text NOT NULL,
  "client_message_id" text NOT NULL,
  "conversation_version" integer NOT NULL,
  "deleted_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "tombstones_sender_key_uq" UNIQUE ("sender_id", "client_message_id")
);
