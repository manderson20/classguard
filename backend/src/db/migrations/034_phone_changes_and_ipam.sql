-- Migration 034: Phone change workflow, directory exclusion flag, IPAM link

-- -------------------------------------------------------------------------
-- Directory exclusion (speakers/paging-only devices shouldn't be listed)
-- and IPAM link (so phones show up as real IPAM-tracked devices).
-- -------------------------------------------------------------------------
ALTER TABLE phones
  ADD COLUMN IF NOT EXISTS include_in_directory BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS ipam_address_id       UUID REFERENCES ip_addresses(id) ON DELETE SET NULL;

-- -------------------------------------------------------------------------
-- Change periods — one per move window (e.g. "Summer 2026"). Changes can
-- only realistically happen when staff aren't using their phones, so these
-- map to a school's actual move windows, not arbitrary dates.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS phone_change_periods (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,             -- "Summer 2026"
  start_date  DATE,
  end_date    DATE,
  status      VARCHAR(20)  NOT NULL DEFAULT 'planning', -- planning | active | closed
  notes       TEXT,
  created_by  UUID         REFERENCES users(id),
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- Reusable checklist templates (e.g. "Standard Teacher Move") so the same
-- set of steps doesn't have to be retyped for every change.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS phone_change_task_templates (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  is_default  BOOLEAN      DEFAULT false,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phone_change_task_template_items (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  UUID         NOT NULL REFERENCES phone_change_task_templates(id) ON DELETE CASCADE,
  label        VARCHAR(255) NOT NULL,
  sort_order   INT          DEFAULT 0
);

-- -------------------------------------------------------------------------
-- One change = one phone/room move within a period.
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS phone_changes (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id          UUID         NOT NULL REFERENCES phone_change_periods(id) ON DELETE CASCADE,
  phone_id           UUID         REFERENCES phones(id) ON DELETE SET NULL,
  extension          VARCHAR(20),
  building           VARCHAR(100),
  room_number        VARCHAR(50),
  previous_occupant  VARCHAR(255),
  new_occupant       VARCHAR(255),
  status             VARCHAR(20)  NOT NULL DEFAULT 'pending', -- pending | in_progress | completed | cancelled
  notes              TEXT,
  created_by         UUID         REFERENCES users(id),
  created_at         TIMESTAMPTZ  DEFAULT NOW(),
  completed_at       TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_changes_period ON phone_changes(period_id);
CREATE INDEX IF NOT EXISTS idx_phone_changes_status ON phone_changes(status);
CREATE INDEX IF NOT EXISTS idx_phone_changes_phone  ON phone_changes(phone_id);

-- Per-change checklist instance — copied from a template at creation time
-- (or built ad-hoc), then checked off independently per change.
CREATE TABLE IF NOT EXISTS phone_change_tasks (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id   UUID         NOT NULL REFERENCES phone_changes(id) ON DELETE CASCADE,
  label       VARCHAR(255) NOT NULL,
  sort_order  INT          DEFAULT 0,
  is_done     BOOLEAN      DEFAULT false,
  done_by     UUID         REFERENCES users(id),
  done_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_phone_change_tasks_change ON phone_change_tasks(change_id);

-- Seed a sensible default template so the feature isn't empty on first use.
INSERT INTO phone_change_task_templates (name, is_default)
SELECT 'Standard Teacher Move', true
WHERE NOT EXISTS (SELECT 1 FROM phone_change_task_templates WHERE name = 'Standard Teacher Move');

INSERT INTO phone_change_task_template_items (template_id, label, sort_order)
SELECT t.id, item.label, item.sort_order
FROM phone_change_task_templates t,
     (VALUES
       ('Update display name / caller ID', 1),
       ('Update room number / building', 2),
       ('Reset voicemail box and greeting', 3),
       ('Update voicemail-to-email address', 4),
       ('Update phone system user account login', 5),
       ('Verify extension rings to correct room', 6)
     ) AS item(label, sort_order)
WHERE t.name = 'Standard Teacher Move'
  AND NOT EXISTS (SELECT 1 FROM phone_change_task_template_items WHERE template_id = t.id);
