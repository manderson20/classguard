-- Migration 009: Integrations — Zammad, Google Admin, Mosyle MDM, Snipe-IT

-- -------------------------------------------------------------------------
-- Devices synced from external systems (Google Admin, Mosyle, Snipe-IT)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_devices (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  source         VARCHAR(50)  NOT NULL,  -- google_admin | mosyle | snipeit
  external_id    VARCHAR(255) NOT NULL,
  serial_number  VARCHAR(255),
  mac_addresses  TEXT[]       DEFAULT '{}',
  device_name    VARCHAR(255),
  device_model   VARCHAR(255),
  os_type        VARCHAR(100),
  os_version     VARCHAR(100),
  assigned_user  VARCHAR(255),
  assigned_email VARCHAR(255),
  ip_addresses   TEXT[]       DEFAULT '{}',
  location       VARCHAR(255),
  status         VARCHAR(100),
  enrollment_date TIMESTAMPTZ,
  last_seen      TIMESTAMPTZ,
  raw_data       JSONB,
  synced_at      TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_intdev_source  ON integration_devices(source);
CREATE INDEX IF NOT EXISTS idx_intdev_serial  ON integration_devices(serial_number);
CREATE INDEX IF NOT EXISTS idx_intdev_email   ON integration_devices(assigned_email);

-- -------------------------------------------------------------------------
-- Zammad tickets (cached locally for search/linking)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zammad_tickets (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  zammad_id      INT          NOT NULL UNIQUE,
  number         VARCHAR(50),
  title          TEXT,
  state          VARCHAR(100),
  priority       VARCHAR(100),
  customer_email VARCHAR(255),
  assignee       VARCHAR(255),
  group_name     VARCHAR(255),
  tags           TEXT[]       DEFAULT '{}',
  related_device_id UUID      REFERENCES integration_devices(id) ON DELETE SET NULL,
  related_ip     INET,
  created_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ,
  synced_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zammad_state  ON zammad_tickets(state);
CREATE INDEX IF NOT EXISTS idx_zammad_email  ON zammad_tickets(customer_email);
