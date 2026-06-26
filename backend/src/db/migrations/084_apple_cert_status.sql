-- Track when each Apple device last enrolled (extracted from Mosyle date_enroll Unix timestamp).
-- Used to determine which devices are on the new vs old APNS push certificate after a replace.
ALTER TABLE integration_devices
  ADD COLUMN IF NOT EXISTS enrolled_at TIMESTAMPTZ;

-- Backfill existing Mosyle records from raw_data.
UPDATE integration_devices
SET enrolled_at = to_timestamp((raw_data->>'date_enroll')::bigint)
WHERE source = 'mosyle'
  AND raw_data->>'date_enroll' IS NOT NULL
  AND (raw_data->>'date_enroll')::bigint > 0
  AND enrolled_at IS NULL;

-- Admin-settable cert replacement date (overrides auto-detection).
INSERT INTO settings (key, value, updated_at)
VALUES ('apns_cert_replaced_on', NULL, NOW())
ON CONFLICT (key) DO NOTHING;
