# Wiki generation & maintenance

The GitHub wiki is **generated**, not hand-edited. Its content comes from two
sources:

1. **Help articles** — the in-app Help Center (the `kb_articles` table, edited
   under **Help** in the app). This is the canonical source for every
   feature/admin page.
2. **Operations pages** — `scripts/wiki/pages/*.md` in this repo (Architecture
   Overview, Deployment & Updates, Monitoring & Wallboard, Roadmap). Edit these
   as normal files.

Each generated page carries a **freshness stamp** — the date it was last
reviewed and the ClassGuard version that last touched it. `content_version` on
each article is bumped automatically whenever the article is edited in the app
(see `backend/src/routes/knowledgeBase.js`). The generated **Doc Status** page
lists every page's version and flags any that have drifted behind the current
release.

## Updating the wiki after a release

> Short version: **"update the wiki accordingly"** = review the changelog,
> edit the affected articles/pages, regenerate, and push.

1. **Review what changed.** Read `CHANGELOG.md` since the last wiki sync. For
   each entry, decide which page(s) it affects:
   - A feature/admin-page change → edit that **Help article** in the app
     (Help ▸ the article ▸ Edit). Editing stamps it with the current version.
   - An architecture/ops/monitoring/deploy change → edit the matching file in
     `scripts/wiki/pages/`.
   - A new page needed → add a Help article (in-app) or a `pages/*.md` file.

2. **Export the articles** (run where the DB is reachable — the API container):

   ```sh
   docker exec classguard-api node -e "$(cat scripts/wiki/export-kb.js)" \
     > scripts/wiki/kb-export.json
   ```

3. **Clone the wiki and generate:**

   ```sh
   git clone https://github.com/manderson20/classguard.wiki.git /tmp/cg-wiki
   node scripts/wiki/generate.mjs scripts/wiki/kb-export.json /tmp/cg-wiki
   ```

4. **Review, then publish:**

   ```sh
   cd /tmp/cg-wiki && git add -A && git commit -m "Sync wiki for vX.Y.Z" && git push
   ```

5. **Sanity check** the generated **Doc Status** page — anything still flagged
   ⚠️ is a page whose content predates a couple of releases and likely needs a
   real content review, not just a re-stamp.

## Privacy

The wiki is **public**. Never include district-identifying information —
real domains, SSIDs, private IPs, hostnames, or building names. Keep everything
generic. The generator does not add any of this, but hand-edited `pages/*.md`
and Help articles must stay clean too.

## Files

| File | Purpose |
|---|---|
| `generate.mjs` | Pure generator: KB JSON + `VERSION` + `pages/` → wiki markdown |
| `export-kb.js` | Dumps `kb_articles` to JSON (run in the API container) |
| `pages/*.md` | Source for the operations pages (hand-edited) |
| `kb-export.json` | Transient export (git-ignored); regenerate as needed |
