-- Add missing columns and constraints discovered during Phase 4 implementation

-- lesson_sessions: add name and updated_at
ALTER TABLE lesson_sessions
  ADD COLUMN IF NOT EXISTS name       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- penalty_box: rename created_at → placed_at for domain clarity
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'penalty_box' AND column_name = 'created_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'penalty_box' AND column_name = 'placed_at'
  ) THEN
    ALTER TABLE penalty_box RENAME COLUMN created_at TO placed_at;
  END IF;
END $$;

-- Partial unique index so a student can only be in the penalty box once (active entry)
CREATE UNIQUE INDEX IF NOT EXISTS penalty_box_active_student
  ON penalty_box (student_id)
  WHERE released_at IS NULL;

-- Unique constraint for policy_assignments (student and group target types)
-- OU assignments are keyed on (policy_id, target_type, target_ou) instead.
CREATE UNIQUE INDEX IF NOT EXISTS policy_assignments_student_group_unique
  ON policy_assignments (policy_id, target_type, target_id)
  WHERE target_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS policy_assignments_ou_unique
  ON policy_assignments (policy_id, target_type, target_ou)
  WHERE target_ou IS NOT NULL;

-- groups / group_members updated_at
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
