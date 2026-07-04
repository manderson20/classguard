// ClassPulse "Import from Google Slides" — reads the requesting TEACHER's own
// deck via domain-wide delegation (subject = teacher email; scopes
// presentations.readonly + drive.readonly, see google.js's setup header) and
// converts each slide to a PNG stored on the screenshots volume. Slides
// become image content-pages; teachers interleave question pages in the
// builder. Same approach Formative uses — the deck stays the creative
// source of truth in Google Slides.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
const { getImpersonatedAuth } = require('./google');
const { withTransaction } = require('../db');

const SLIDES_SCOPES = ['https://www.googleapis.com/auth/presentations.readonly'];
const DRIVE_SCOPES  = ['https://www.googleapis.com/auth/drive.readonly'];

// Rides the existing screenshots volume so images survive container
// rebuilds without a compose change. Node-local, like screenshots — an HA
// standby won't have these files until a shared-storage story exists.
const SLIDE_IMAGE_DIR = path.join(
  process.env.SCREENSHOT_DIR || path.join(__dirname, '../../screenshots'),
  'classpulse-slides'
);
fs.mkdirSync(SLIDE_IMAGE_DIR, { recursive: true });

// Matches Formative's own cap; keeps a single import bounded (one thumbnail
// API call + one image download per slide).
const MAX_SLIDES = 75;

// List the teacher's own Slides decks, newest-modified first.
async function listPresentations(teacherEmail, search = '') {
  const auth  = await getImpersonatedAuth(DRIVE_SCOPES, teacherEmail);
  const drive = google.drive({ version: 'v3', auth });

  let q = "mimeType='application/vnd.google-apps.presentation' and trashed=false";
  if (search) {
    // Drive's q syntax: backslashes escape first, then single quotes — the
    // reverse order (or quotes alone) lets a term ending in \ break out.
    const term = String(search).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    q += ` and name contains '${term}'`;
  }
  const res = await drive.files.list({
    q,
    orderBy: 'modifiedTime desc',
    pageSize: 20,
    fields: 'files(id, name, modifiedTime, thumbnailLink)',
  });
  return res.data.files || [];
}

// Import a deck into a lesson: one image content-page per slide, appended
// after the lesson's existing pages (so a re-import or second deck never
// clobbers question pages the teacher already built).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PNG magic bytes — the only file type the Slides thumbnail API produces.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function importPresentation(teacherEmail, presentationId, lessonId) {
  // lessonId comes from a request param — it has already passed an ownership
  // check against the DB, but validate the shape explicitly before it ever
  // touches a filesystem path.
  if (!UUID_RE.test(String(lessonId))) throw new Error('Invalid lesson id');

  const auth   = await getImpersonatedAuth(SLIDES_SCOPES, teacherEmail);
  const slides = google.slides({ version: 'v1', auth });

  const pres = await slides.presentations.get({
    presentationId,
    fields: 'title,slides(objectId)',
  });
  const slideIds = (pres.data.slides || []).map(s => s.objectId);
  if (!slideIds.length) throw new Error('That presentation has no slides');
  if (slideIds.length > MAX_SLIDES) {
    throw new Error(`Presentation has ${slideIds.length} slides — the import limit is ${MAX_SLIDES}. Split the deck and import in parts.`);
  }

  const lessonDir = path.join(SLIDE_IMAGE_DIR, lessonId);
  fs.mkdirSync(lessonDir, { recursive: true });

  // Download every slide's PNG before touching the DB — a mid-deck Google
  // failure aborts cleanly instead of leaving a half-imported lesson.
  const files = [];
  for (const objectId of slideIds) {
    const thumb = await slides.presentations.pages.getThumbnail({
      presentationId,
      pageObjectId: objectId,
      'thumbnailProperties.thumbnailSize': 'LARGE', // 1600px wide
    });
    const resp = await fetch(thumb.data.contentUrl);
    if (!resp.ok) throw new Error(`Slide image download failed (HTTP ${resp.status})`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('Slide image unexpectedly large — aborting import');
    if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new Error('Slide image response was not a PNG — aborting import');
    }
    const fileName = `${crypto.randomUUID()}.png`;
    fs.writeFileSync(path.join(lessonDir, fileName), buf);
    files.push(path.join('classpulse-slides', lessonId, fileName));
  }

  const pages = await withTransaction(async (client) => {
    const { rows: [{ max }] } = await client.query(
      `SELECT COALESCE(MAX(position), 0) AS max FROM classpulse_pages WHERE lesson_id = $1`,
      [lessonId]
    );
    const created = [];
    for (let i = 0; i < files.length; i++) {
      const { rows: [page] } = await client.query(
        `INSERT INTO classpulse_pages (lesson_id, position, content_type, title, image_url)
         VALUES ($1, $2, 'content', $3, $4)
         RETURNING *`,
        [lessonId, Number(max) + i + 1, `Slide ${i + 1}`, files[i]]
      );
      created.push(page);
    }
    await client.query(
      `UPDATE classpulse_lessons SET google_presentation_id = $2, updated_at = now() WHERE id = $1`,
      [lessonId, presentationId]
    );
    return created;
  });

  return { title: pres.data.title, imported: pages.length, pages };
}

// Absolute path for serving a stored slide image; null if the stored value
// escapes the slides dir (defense-in-depth — values are server-generated).
function resolveSlideImagePath(relPath) {
  const base = path.dirname(SLIDE_IMAGE_DIR); // the screenshots volume root
  const abs  = path.resolve(base, relPath);
  if (!abs.startsWith(SLIDE_IMAGE_DIR + path.sep)) return null;
  return abs;
}

// Save an uploaded image buffer for a lesson (direct graphics/diagram upload
// on content pages — same storage + serving path as imported slides).
function saveLessonImage(lessonId, buffer, ext) {
  if (!UUID_RE.test(String(lessonId))) throw new Error('Invalid lesson id');
  if (!['png', 'jpg'].includes(ext)) throw new Error('Unsupported image type');
  const lessonDir = path.join(SLIDE_IMAGE_DIR, lessonId);
  fs.mkdirSync(lessonDir, { recursive: true });
  const fileName = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(lessonDir, fileName), buffer);
  return path.join('classpulse-slides', lessonId, fileName);
}

function deleteLessonImage(relPath) {
  const abs = resolveSlideImagePath(relPath);
  if (abs && fs.existsSync(abs)) fs.unlinkSync(abs);
}

module.exports = { listPresentations, importPresentation, resolveSlideImagePath, saveLessonImage, deleteLessonImage };
