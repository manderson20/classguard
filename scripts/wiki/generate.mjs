#!/usr/bin/env node
// Generate the ClassGuard wiki from the knowledge-base articles.
//
//   node scripts/wiki/generate.mjs <kb-export.json> <wiki-checkout-dir>
//
// Produces, in the wiki checkout dir:
//   - one page per KB article, with a "last reviewed" freshness stamp
//     (article updated_at + the software version that last touched it)
//   - the static operations pages copied from scripts/wiki/pages/
//   - Home (indexed, with an in-app path -> wiki page reference table)
//   - _Sidebar, _Footer
//   - Doc-Status (a freshness index: every page, its version, and whether
//     it has drifted behind the current release)
//
// The generator is pure: it reads the KB from a JSON file (produced by
// export-kb.js), the current release from VERSION, and the static pages from
// ./pages. It never touches the database or the network. See README.md.

import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const STALE_MINOR_THRESHOLD = 2; // flag a page behind by >= this many minors

const [, , kbPath, wikiDir] = process.argv;
if (!kbPath || !wikiDir) {
  console.error('usage: node generate.mjs <kb-export.json> <wiki-checkout-dir>');
  process.exit(1);
}

const articles = JSON.parse(readFileSync(kbPath, 'utf8'));
const VERSION = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8').trim();

const CATEGORY_ORDER = ['Overview', 'Classroom', 'Policies & Safety', 'DNS & Network', 'System'];
const CATEGORY_ICON = {
  'Overview': '📊', 'Classroom': '🎓', 'Policies & Safety': '🛡️',
  'DNS & Network': '🌐', 'System': '⚙️',
};
const ACRONYMS = { dns: 'DNS', radius: 'RADIUS', nac: 'NAC', ha: 'HA', ntp: 'NTP',
  vpn: 'VPN', ipam: 'IPAM', ipv6: 'IPv6', ai: 'AI', nas: 'NAS' };

const pageName = t => t.replace(/\//g, ' ').replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
const wlink = t => (pageName(t) === t ? `[[${t}]]` : `[[${t}|${pageName(t)}]]`);
const humanPath = p => p.replace(/^\/|\/$/g, '').split('/').filter(Boolean)
  .map(w => ACRONYMS[w] || w[0].toUpperCase() + w.slice(1)).join(' ▸ ');
const ymd = d => new Date(d).toISOString().slice(0, 10);

function firstSentence(text) {
  let t = text.trim().replace(/\n/g, ' ').replace(/[#*`>]/g, '').replace(/\s+/g, ' ');
  const prot = t.replace(/e\.g\./g, 'e\0g\0').replace(/i\.e\./g, 'i\0e\0');
  const first = prot.split(/(?<=[.!?])\s/)[0].replace(/\0/g, '.');
  return first.length > 120 ? first.slice(0, 117) + '…' : first;
}

// semver "behind by N minors" (major bump counts as very stale)
function minorsBehind(pageVer) {
  if (!pageVer) return Infinity;
  const [pMaj, pMin] = pageVer.split('.').map(Number);
  const [cMaj, cMin] = VERSION.split('.').map(Number);
  if (cMaj !== pMaj) return (cMaj - pMaj) * 1000; // major drift = very stale
  return cMin - pMin;
}

const freshness = (updatedAt, ver) =>
  `> _Last reviewed **${ymd(updatedAt)}** · ClassGuard **v${ver || '—'}**_`;

const navFooter = cat => {
  const anchor = cat.toLowerCase().replace(/ & /g, '--').replace(/\s+/g, '-');
  return `---\n_[[Home]] · [[${CATEGORY_ICON[cat] || ''} ${cat}|Home#${anchor}]] · ClassGuard Help Center_`;
};

// group
const byCat = {};
for (const a of articles) (byCat[a.category] ||= []).push(a);
for (const c of Object.keys(byCat)) byCat[c].sort((x, y) => x.title.localeCompare(y.title));

// clear old generated .md (keep .git and the static pages we re-copy below)
for (const f of readdirSync(wikiDir)) {
  if (f.endsWith('.md')) rmSync(join(wikiDir, f));
}

// --- KB article pages ---
for (const a of articles) {
  const paths = a.page_paths || [];
  const inapp = paths.length
    ? paths.map(p => `**${humanPath(p)}** (\`${p}\`)`).join(' · ') : '—';
  const md = `# ${a.title}\n\n`
    + `> **Category:** ${a.category}  \n`
    + `> **In-app location:** ${inapp}\n\n`
    + `${freshness(a.updated_at, a.content_version)}\n\n`
    + `${a.content.trim()}\n\n`
    + `${navFooter(a.category)}\n`;
  writeFileSync(join(wikiDir, `${pageName(a.title)}.md`), md);
}

// --- static operations pages (source of truth in scripts/wiki/pages) ---
const staticDir = join(HERE, 'pages');
const staticPages = [];
for (const f of readdirSync(staticDir).filter(f => f.endsWith('.md'))) {
  let body = readFileSync(join(staticDir, f), 'utf8').trimEnd();
  // stamp: static pages are maintained in-repo and re-published each release
  const stamp = `\n\n> _Maintained in the repository (\`scripts/wiki/pages\`) · published with ClassGuard **v${VERSION}**_\n`;
  // insert the stamp before a trailing footer line if present, else append
  body = body.replace(/\n(_\[\[Home\]\][^\n]*)\s*$/, `${stamp}\n---\n$1`);
  if (!body.includes('Maintained in the repository')) body += stamp;
  writeFileSync(join(wikiDir, f), body + '\n');
  staticPages.push(basename(f, '.md'));
}

// --- _Sidebar ---
const side = ['### 🛡️ ClassGuard Wiki\n', '**[[Home]]**\n'];
for (const cat of CATEGORY_ORDER) {
  if (!byCat[cat]) continue;
  side.push(`**${CATEGORY_ICON[cat] || ''} ${cat}**`);
  for (const a of byCat[cat]) side.push(`- ${wlink(a.title)}`);
  side.push('');
}
side.push('---', '**Operations**',
  '- [[Deployment & Updates]]', '- [[Monitoring & Wallboard]]',
  '- [[Architecture Overview]]', '- [[Roadmap]]', '- [[Doc Status]]');
writeFileSync(join(wikiDir, '_Sidebar.md'), side.join('\n') + '\n');

// --- _Footer ---
writeFileSync(join(wikiDir, '_Footer.md'),
  '_ClassGuard — open-source school internet safety & classroom management. '
  + 'This wiki mirrors the in-app Help Center (**Help** in the app sidebar). '
  + 'See [[Doc Status]] for page freshness._\n');

// --- Home ---
const home = [
  '# ClassGuard Help Center\n',
  'Welcome to the ClassGuard wiki — the documentation home for administrators, '
  + 'teachers, and contributors. These guides mirror the in-app **Help Center**; '
  + 'each page notes the in-app location it documents and when it was last reviewed.\n',
  '> New here? Start with **[[Dashboard]]**, then browse by area. Operations and '
  + 'contributor docs are in the sidebar under **Operations**; page freshness is on **[[Doc Status]]**.\n',
];
for (const cat of CATEGORY_ORDER) {
  if (!byCat[cat]) continue;
  home.push(`\n## ${CATEGORY_ICON[cat] || ''} ${cat}\n`);
  for (const a of byCat[cat]) home.push(`- **${wlink(a.title)}** — ${firstSentence(a.content)}`);
}
home.push('\n## 🔗 In-app page reference\n',
  'Every admin page links to its help article. This table maps the in-app path to its wiki page.\n',
  '| In-app location | Path | Wiki page |', '|---|---|---|');
const rows = [];
for (const a of articles) for (const p of (a.page_paths || [])) rows.push([humanPath(p), p, a.title]);
rows.sort((x, y) => x[1].localeCompare(y[1]));
for (const [label, path, title] of rows) home.push(`| ${label} | \`${path}\` | ${wlink(title)} |`);
writeFileSync(join(wikiDir, 'Home.md'), home.join('\n') + '\n');

// --- Doc Status (the freshness index) ---
const ds = [
  '# Doc Status\n',
  `Generated for **ClassGuard v${VERSION}**. Each help page records the software `
  + 'version that last changed it (bumped automatically whenever the article is '
  + 'edited in the in-app Help Center). A page flagged ⚠️ has drifted '
  + `${STALE_MINOR_THRESHOLD}+ minor releases behind current and is worth a review.\n`,
  '> To refresh this wiki after a release, see `scripts/wiki/README.md` in the repository.\n',
  '| Page | Category | Last reviewed | Version | Status |',
  '|---|---|---|---|---|',
];
const staleList = [];
for (const cat of CATEGORY_ORDER) {
  for (const a of (byCat[cat] || [])) {
    const behind = minorsBehind(a.content_version);
    const stale = behind >= STALE_MINOR_THRESHOLD;
    if (stale) staleList.push(a.title);
    const status = stale ? `⚠️ ${behind >= 1000 ? 'major behind' : behind + ' minors behind'}` : '✅ current';
    ds.push(`| ${wlink(a.title)} | ${a.category} | ${ymd(a.updated_at)} | v${a.content_version || '—'} | ${status} |`);
  }
}
ds.push('\n## Operations pages\n',
  'Maintained in the repository (`scripts/wiki/pages`) and re-published each release.\n');
for (const p of staticPages.sort()) ds.push(`- ${wlink(p)}`);
ds.push(`\n---\n_${staleList.length ? `⚠️ ${staleList.length} page(s) need review: ${staleList.join(', ')}` : '✅ All pages current.'}_`);
writeFileSync(join(wikiDir, 'Doc Status.md'), ds.join('\n') + '\n');

const staleCount = articles.filter(a => minorsBehind(a.content_version) >= STALE_MINOR_THRESHOLD).length;
console.log(`generated ${articles.length} article pages + ${staticPages.length} ops pages + Home/_Sidebar/_Footer/Doc Status`);
console.log(`current version v${VERSION}; ${staleCount} page(s) flagged stale`);
