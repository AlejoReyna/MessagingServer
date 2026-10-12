-- Additive: existing text, photo and reply rows remain unchanged.
ALTER TABLE "chat"."messages"
  ADD COLUMN "video_data" BYTEA,
  ADD COLUMN "video_hash" TEXT;

ALTER TABLE "chat"."messages"
  ADD CONSTRAINT "message_video_valid" CHECK (
    (video_data IS NULL AND video_hash IS NULL) OR
    (video_data IS NOT NULL AND video_hash IS NOT NULL
      AND octet_length(video_data) BETWEEN 1 AND 52428800
      AND video_hash ~ '^[0-9a-f]{64}$')
  ),
  ADD CONSTRAINT "message_single_attachment" CHECK (
    photo_data IS NULL OR video_data IS NULL
  );
