ALTER TABLE "chat"."messages" ADD COLUMN "photo_data" BYTEA, ADD COLUMN "photo_hash" TEXT;
ALTER TABLE "chat"."messages" ADD CONSTRAINT "message_photo_valid" CHECK ((photo_data IS NULL AND photo_hash IS NULL) OR (photo_data IS NOT NULL AND photo_hash IS NOT NULL AND octet_length(photo_data) BETWEEN 1 AND 5242880 AND photo_hash ~ '^[0-9a-f]{64}$'));
