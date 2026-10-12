ALTER TABLE "chat"."messages" ADD COLUMN "reply_to_message_id" TEXT;
CREATE INDEX "messages_reply_to_message_id_idx" ON "chat"."messages"("reply_to_message_id");
