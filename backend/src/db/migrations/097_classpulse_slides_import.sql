-- Import-from-Google-Slides for ClassPulse lessons: imported decks become
-- image content-pages (Formative-style — slides render as images, questions
-- interleave as separate pages), so teachers keep full creative control of
-- the deck in Google Slides.
ALTER TABLE classpulse_pages
  ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Remembers which deck a lesson was imported from so a future "refresh from
-- Slides" can re-pull without re-picking the deck.
ALTER TABLE classpulse_lessons
  ADD COLUMN IF NOT EXISTS google_presentation_id TEXT;
