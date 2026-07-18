-- Track which software version last changed each help article, so the wiki
-- and the in-app Help Center can show a "last reviewed" stamp and we can tell
-- at a glance which pages have drifted behind the current release.
--
-- Set on every create/update by routes/knowledgeBase.js (= the app version at
-- edit time). Existing rows are backfilled to the doc-tracking baseline
-- release rather than the current one, so they aren't falsely stamped as
-- "touched" by the release that merely added this column.

ALTER TABLE kb_articles
  ADD COLUMN IF NOT EXISTS content_version TEXT;

UPDATE kb_articles
  SET content_version = '0.13.1'
  WHERE content_version IS NULL;
