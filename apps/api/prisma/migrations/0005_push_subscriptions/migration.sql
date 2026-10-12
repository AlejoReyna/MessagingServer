-- Suscripciones Web Push (contrato v5): aviso genérico sin texto.
-- id = SHA-256 hex del endpoint; endpoint único global para no duplicar
-- el mismo navegador en dos cuentas.
CREATE TABLE IF NOT EXISTS "chat"."push_subscriptions" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "chat"."users"("id") ON DELETE CASCADE,
  "endpoint" text NOT NULL UNIQUE,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_id_idx" ON "chat"."push_subscriptions"("user_id");
