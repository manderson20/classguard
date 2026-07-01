-- Migration 093: file distribution via chat attachments
--
-- body becomes nullable -- a file-only message (no caption text) is valid,
-- but a message must have SOME content (text or an attachment), enforced
-- by the check constraint below.

ALTER TABLE chat_messages ALTER COLUMN body DROP NOT NULL;

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment_path TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment_name TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment_mime TEXT;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment_size INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_has_content'
  ) THEN
    ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_has_content
      CHECK (body IS NOT NULL OR attachment_path IS NOT NULL);
  END IF;
END$$;
