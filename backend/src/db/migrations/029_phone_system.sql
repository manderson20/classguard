-- Migration 029: Phone System — VoIP device inventory, caller ID/DID registry,
-- ring groups, paging groups, parking lots, and extension numbering rules.
-- Replaces the "Phone System.xlsx" spreadsheet that was the source of truth
-- before this.

CREATE TABLE IF NOT EXISTS phones (
  id                         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id                  VARCHAR(50)  UNIQUE NOT NULL,   -- e.g. "P-1", "PW-1"
  device_type                VARCHAR(100),                   -- e.g. "Polycom VVX 411"
  mac_address                MACADDR,
  ip_address                 INET,
  network_switch             VARCHAR(100),
  switch_interface           VARCHAR(50),
  building                   VARCHAR(100),
  room_number                VARCHAR(50),
  extension                  VARCHAR(20),
  display_name               VARCHAR(255),                   -- "Name/Caller ID"
  voicemail_email            VARCHAR(255),
  leave_voicemail_on_server  VARCHAR(10),                    -- Yes / No / N/a
  egress_outside_number      VARCHAR(50),
  outbound_egress_cid        VARCHAR(255),
  ingress_phone_number       VARCHAR(50),
  emergency_egress_cid       VARCHAR(255),
  paging_groups              JSONB        DEFAULT '[]',      -- page extensions this phone belongs to
  ring_groups                JSONB        DEFAULT '[]',      -- ring-group extensions this phone belongs to
  sidecar_needed             BOOLEAN      DEFAULT false,
  sidecar_serial             VARCHAR(100),
  sidecar_model              VARCHAR(100),
  headset_needed             BOOLEAN      DEFAULT false,
  headset_model              VARCHAR(100),
  wall_mount_needed          BOOLEAN      DEFAULT false,
  wall_mount_model           VARCHAR(100),
  handset_needed             BOOLEAN      DEFAULT false,
  handset_model              VARCHAR(100),
  notes                      TEXT,
  is_active                  BOOLEAN      DEFAULT true,
  created_by                 UUID         REFERENCES users(id),
  created_at                 TIMESTAMPTZ  DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phones_extension    ON phones(extension);
CREATE INDEX IF NOT EXISTS idx_phones_building     ON phones(building);
CREATE INDEX IF NOT EXISTS idx_phones_display_name ON phones(display_name);

-- Outbound caller-ID identities tied to a building/department's main line —
-- "BSD Transport. <660-258-5135>" style templates are derived at use time
-- from caller_id_name + phone_number rather than stored redundantly.
CREATE TABLE IF NOT EXISTS phone_caller_id_profiles (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id_name       VARCHAR(50)  UNIQUE NOT NULL,
  building_department  VARCHAR(255),
  address              VARCHAR(255),
  phone_number         VARCHAR(50),
  fax_number           VARCHAR(50),
  connection_type      VARCHAR(50),   -- VoIP / VoIP - Both / Analog
  e911_address         VARCHAR(255),
  created_at           TIMESTAMPTZ  DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  DEFAULT NOW()
);

-- DID / main line registry from the carrier
CREATE TABLE IF NOT EXISTS phone_did_numbers (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number    VARCHAR(50)  UNIQUE NOT NULL,
  description     VARCHAR(255),
  number_type     VARCHAR(20)  DEFAULT 'phone',  -- phone | fax
  connection_type VARCHAR(50),
  e911_address    VARCHAR(255),
  carrier         VARCHAR(100),
  created_at      TIMESTAMPTZ  DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phone_ring_groups (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  extension   VARCHAR(20)  UNIQUE NOT NULL,
  description VARCHAR(255),
  members     JSONB        DEFAULT '[]',  -- [{extension, description}]
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Phone-system side of a paging zone (the extension staff dial); the network
-- side (multicast address/port/vlan) lives in multicast_groups — linked here
-- rather than duplicated, since the same zone is genuinely both things.
CREATE TABLE IF NOT EXISTS phone_paging_groups (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  page_extension      VARCHAR(20)  UNIQUE NOT NULL,
  description         VARCHAR(255),
  polycom_group_label VARCHAR(50),
  multicast_group_id  UUID         REFERENCES multicast_groups(id) ON DELETE SET NULL,
  notes               TEXT,
  created_at          TIMESTAMPTZ  DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS phone_parking_lots (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  location_name VARCHAR(100) UNIQUE NOT NULL,
  extension     VARCHAR(20),
  lot_numbers   JSONB        DEFAULT '[]',
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- Reference table documenting the extension numbering convention — informational only
CREATE TABLE IF NOT EXISTS phone_extension_rules (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_code    VARCHAR(50),
  extension_code VARCHAR(50)  NOT NULL,
  meaning        VARCHAR(255),
  sort_order     INT          DEFAULT 0,
  created_at     TIMESTAMPTZ  DEFAULT NOW()
);
