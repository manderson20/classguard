-- One module for every help guide in the app. page_paths links an article
-- back to the specific admin/teacher route(s) it documents, so the
-- floating help button on each page can resolve straight to the right
-- article without per-page wiring.
CREATE TABLE kb_articles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  category   TEXT NOT NULL,
  content    TEXT NOT NULL,
  page_paths TEXT[] NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kb_articles_category ON kb_articles(category);
