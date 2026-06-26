-- Add asset_tag column to integration_devices for Snipe-IT asset tag numbers
ALTER TABLE integration_devices ADD COLUMN IF NOT EXISTS asset_tag VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_intdev_asset_tag ON integration_devices(asset_tag) WHERE asset_tag IS NOT NULL;
