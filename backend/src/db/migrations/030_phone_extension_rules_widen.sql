-- Migration 030: the "Phone Extension Rules" sheet mixes real short codes
-- ("21###") with longer footnote/explanation rows in the same column —
-- VARCHAR(50) was sized for the codes alone and overflowed on those.
ALTER TABLE phone_extension_rules ALTER COLUMN extension_code TYPE VARCHAR(255);
ALTER TABLE phone_extension_rules ALTER COLUMN parent_code TYPE VARCHAR(255);
