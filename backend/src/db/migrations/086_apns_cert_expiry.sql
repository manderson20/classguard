-- Expiry date of the OLD APNS push certificate.
-- After this date, devices that haven't beaten since expiry are definitively
-- on the old cert (cannot receive MDM push) and can be auto-detected.
INSERT INTO settings (key, value, updated_at)
VALUES ('apns_old_cert_expires_on', NULL, NOW())
ON CONFLICT (key) DO NOTHING;
