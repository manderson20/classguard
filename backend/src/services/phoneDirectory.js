// Generates a printable phone directory (.docx) from the `phones` and
// `phone_paging_groups` tables — same look as the old hand-maintained
// "Phone Directory.docx": Letter page, 3 columns, bold 9pt entries as
// "EXTENSION  NAME", alphabetical, with a paging-codes section at the end.
//
// Source data comes straight from the database now rather than a curated
// spreadsheet, so wording may differ slightly from old manually-edited
// directories — entries print exactly what's in `phones.display_name` /
// `phone_paging_groups.description`, which admins can edit via the UI.

const {
  Document, Packer, Paragraph, TextRun, Header, SectionType,
} = require('docx');
const { pool } = require('../db');

const ENTRY_RUN_OPTS = { bold: true, size: 18 }; // 18 half-points = 9pt, matches the original
const DEFAULT_MIDDLE_TITLE = '{year} Phone Directory';

async function getMiddleTitle() {
  const { rows } = await pool.query(
    `SELECT value FROM settings WHERE key = 'phone.directory_middle_title'`
  );
  return rows[0]?.value ?? DEFAULT_MIDDLE_TITLE;
}

async function setMiddleTitle(value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('phone.directory_middle_title', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [value]
  );
}

function entryParagraph(code, label) {
  return new Paragraph({
    children: [new TextRun({ text: `${code} ${label}`, ...ENTRY_RUN_OPTS })],
  });
}

function headingParagraph(text) {
  return new Paragraph({
    spacing: { before: 200 },
    children: [new TextRun({ text, ...ENTRY_RUN_OPTS })],
  });
}

async function generate({ districtName = 'ClassGuard', schoolYear } = {}) {
  const { rows: phones } = await pool.query(
    `SELECT extension, display_name FROM phones
     WHERE is_active = true AND include_in_directory = true
       AND extension IS NOT NULL AND display_name IS NOT NULL
     ORDER BY display_name`
  );
  // Dedupe phones sharing the same display_name (e.g. two handsets for one
  // person) down to one directory line, using the lowest extension.
  const byName = new Map();
  for (const p of phones) {
    const key = p.display_name.trim().toUpperCase();
    const existing = byName.get(key);
    if (!existing || String(p.extension).localeCompare(String(existing.extension), undefined, { numeric: true }) < 0) {
      byName.set(key, p);
    }
  }
  const nameEntries = [...byName.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));

  const { rows: paging } = await pool.query(
    `SELECT page_extension, description FROM phone_paging_groups
     WHERE description IS NOT NULL
     ORDER BY page_extension::int`
  );

  const year = schoolYear || (() => {
    const now = new Date();
    const y = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1; // school year starts ~July
    return `${y}-${y + 1}`;
  })();
  const revDate = new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });

  const middleTitleRaw = (await getMiddleTitle()).replace(/\{year\}/g, year);
  const middleTitleLines = middleTitleRaw.split('\n').map(l => l.trim()).filter(Boolean);

  const children = [
    ...nameEntries.map(p => entryParagraph(p.extension, p.display_name.toUpperCase())),
    headingParagraph('PAGING CODES'),
    ...paging.map(p => entryParagraph(p.page_extension, p.description.toUpperCase())),
  ];

  const doc = new Document({
    sections: [{
      properties: {
        type: SectionType.CONTINUOUS,
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1080, right: 1440, bottom: 1440, left: 1440, header: 360, footer: 720 },
        },
        column: { count: 3, space: 720 },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              tabStops: [{ type: 'right', position: 9360 }],
              children: [new TextRun(`${districtName}\tRev: ${revDate}`)],
            }),
            ...middleTitleLines.map(line => new Paragraph({
              alignment: 'center',
              children: [new TextRun({ text: line, bold: true })],
            })),
          ],
        }),
      },
      children,
    }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { generate, getMiddleTitle, setMiddleTitle };
