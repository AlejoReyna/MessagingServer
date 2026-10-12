-- Acceso con PIN v2 (contrato v2): hash del código de 4 dígitos por cuenta,
-- contador de intentos fallidos y bloqueo temporal. Sin texto ni secretos.
ALTER TABLE "chat"."users"
  ADD COLUMN IF NOT EXISTS "pin_hash" text,
  ADD COLUMN IF NOT EXISTS "pin_failed_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "pin_locked_until" timestamptz(6);
