-- Tech instructor flag on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_tech_instructor BOOLEAN NOT NULL DEFAULT false;

-- Which classes are designated as Tech Lab classes (drives auto role assignment)
CREATE TABLE IF NOT EXISTS tech_lab_classes (
  id             SERIAL PRIMARY KEY,
  class_id       UUID REFERENCES classes(id) ON DELETE CASCADE,
  oneroster_course_code TEXT,       -- match on sync when class_id is unknown
  display_name   TEXT,
  instructor_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  auto_assign    BOOLEAN NOT NULL DEFAULT true,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Repair tickets
CREATE TABLE IF NOT EXISTS repair_tickets (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  device_serial   VARCHAR(255),
  device_name     TEXT,
  device_model    TEXT,
  snipeit_asset_id TEXT,
  snipeit_asset_tag TEXT,
  tech_class_id   INTEGER REFERENCES tech_lab_classes(id) ON DELETE SET NULL,
  assigned_to     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  status          VARCHAR(30) NOT NULL DEFAULT 'open',
  -- open | in_progress | pending_approval | approved | rejected | closed
  priority        VARCHAR(20) NOT NULL DEFAULT 'normal',
  -- low | normal | high
  initial_condition TEXT,
  resolution      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repair_tickets_assigned ON repair_tickets(assigned_to);
CREATE INDEX IF NOT EXISTS idx_repair_tickets_status   ON repair_tickets(status);
CREATE INDEX IF NOT EXISTS idx_repair_tickets_class    ON repair_tickets(tech_class_id);

-- Timestamped work-log notes
CREATE TABLE IF NOT EXISTS repair_notes (
  id          SERIAL PRIMARY KEY,
  ticket_id   INTEGER NOT NULL REFERENCES repair_tickets(id) ON DELETE CASCADE,
  author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  note_type   VARCHAR(30) NOT NULL DEFAULT 'note',
  -- note | diagnostic | parts_harvested | parts_installed | status_change | approval_note
  content     TEXT NOT NULL,
  is_private  BOOLEAN NOT NULL DEFAULT false, -- true = instructor-only
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repair_notes_ticket ON repair_notes(ticket_id);

-- Pending inventory changes awaiting instructor approval
CREATE TABLE IF NOT EXISTS repair_pending_changes (
  id                SERIAL PRIMARY KEY,
  ticket_id         INTEGER NOT NULL REFERENCES repair_tickets(id) ON DELETE CASCADE,
  change_type       VARCHAR(50) NOT NULL,
  -- archive_device | update_status | parts_transfer | update_notes
  target_serial     VARCHAR(255),  -- device the change applies to (may differ from ticket)
  target_snipeit_id TEXT,
  target_asset_tag  TEXT,
  change_data       JSONB NOT NULL, -- proposed change payload
  student_notes     TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- pending | approved | rejected
  submitted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  review_note       TEXT,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_repair_changes_ticket ON repair_pending_changes(ticket_id);
CREATE INDEX IF NOT EXISTS idx_repair_changes_status ON repair_pending_changes(status);
