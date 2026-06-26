-- Per-device APNS certificate status flag, maintained by the Mosyle sync.
-- NULL = unknown (no cert date configured yet), TRUE = on new cert, FALSE = needs re-enrollment.
ALTER TABLE integration_devices
  ADD COLUMN IF NOT EXISTS apns_cert_ok BOOLEAN DEFAULT NULL;

-- Backfill from current cert replacement date if already set.
DO $$
DECLARE
  cert_date TEXT;
BEGIN
  SELECT value INTO cert_date FROM settings WHERE key = 'apns_cert_replaced_on';
  IF cert_date IS NOT NULL AND cert_date <> '' THEN
    UPDATE integration_devices
    SET apns_cert_ok = (enrolled_at >= cert_date::timestamptz)
    WHERE source = 'mosyle' AND enrolled_at IS NOT NULL;

    UPDATE integration_devices
    SET apns_cert_ok = FALSE
    WHERE source = 'mosyle' AND enrolled_at IS NULL AND apns_cert_ok IS NULL;
  END IF;
END $$;
