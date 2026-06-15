-- =============================================================================
-- ClassGuard Initial Schema
-- =============================================================================

-- Users (synced from Google Workspace)
CREATE TABLE IF NOT EXISTS users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id       VARCHAR(255) UNIQUE NOT NULL,
  email           VARCHAR(255) UNIQUE NOT NULL,
  full_name       VARCHAR(255),
  given_name      VARCHAR(255),
  photo_url       TEXT,
  role            VARCHAR(50) NOT NULL DEFAULT 'student', -- student | teacher | admin | superadmin
  google_ou       VARCHAR(500),
  is_active       BOOLEAN     DEFAULT true,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Groups (ClassGuard-native; may mirror Google Groups)
CREATE TABLE IF NOT EXISTS groups (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(255) NOT NULL,
  description         TEXT,
  google_group_email  VARCHAR(255),
  created_by          UUID        REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Group memberships
CREATE TABLE IF NOT EXISTS group_members (
  group_id  UUID REFERENCES groups(id) ON DELETE CASCADE,
  user_id   UUID REFERENCES users(id)  ON DELETE CASCADE,
  added_by  UUID REFERENCES users(id),
  added_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

-- Filtering policies
CREATE TABLE IF NOT EXISTS policies (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(255) NOT NULL,
  description         TEXT,
  mode                VARCHAR(50) NOT NULL DEFAULT 'standard', -- open | standard | lesson | penalty_box
  safe_search         BOOLEAN     DEFAULT true,
  youtube_restricted  VARCHAR(20) DEFAULT 'moderate',          -- off | moderate | strict
  schedule            JSONB,
  created_by          UUID        REFERENCES users(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Key/value settings store
CREATE TABLE IF NOT EXISTS settings (
  key         VARCHAR(255) PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Policy assignments (who gets which policy)
CREATE TABLE IF NOT EXISTS policy_assignments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id    UUID        REFERENCES policies(id) ON DELETE CASCADE,
  target_type  VARCHAR(20) NOT NULL,   -- student | group | ou | default
  target_id    UUID,                   -- user.id or group.id (null if ou or default)
  target_ou    VARCHAR(500),           -- Google OU path (if target_type = 'ou')
  priority     INT         DEFAULT 0,
  assigned_by  UUID        REFERENCES users(id),
  assigned_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Blocklist feed subscriptions
CREATE TABLE IF NOT EXISTS blocklist_sources (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(255) NOT NULL,
  url            TEXT        NOT NULL,
  format         VARCHAR(50) DEFAULT 'hosts',   -- hosts | domain_list | dnsmasq
  category       VARCHAR(100),
  is_active      BOOLEAN     DEFAULT false,
  sync_schedule  VARCHAR(50) DEFAULT 'daily',
  last_synced_at TIMESTAMPTZ,
  domain_count   INT         DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Which policies subscribe to which blocklists
CREATE TABLE IF NOT EXISTS policy_blocklists (
  policy_id  UUID REFERENCES policies(id)          ON DELETE CASCADE,
  source_id  UUID REFERENCES blocklist_sources(id) ON DELETE CASCADE,
  PRIMARY KEY (policy_id, source_id)
);

-- Per-policy custom domain allow/deny rules
CREATE TABLE IF NOT EXISTS policy_domain_rules (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id  UUID        REFERENCES policies(id) ON DELETE CASCADE,
  domain     VARCHAR(255) NOT NULL,
  rule_type  VARCHAR(10) NOT NULL,  -- allow | deny
  added_by   UUID        REFERENCES users(id),
  added_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Registered client devices
CREATE TABLE IF NOT EXISTS devices (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  device_identifier  VARCHAR(255) UNIQUE,   -- serial or extension-generated UUID
  device_type        VARCHAR(50),           -- chromebook | mac | ipad
  hostname           VARCHAR(255),
  current_user_id    UUID        REFERENCES users(id),
  last_ip            VARCHAR(45),
  last_seen_at       TIMESTAMPTZ,
  notes              TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- DNS query log (retention controlled by DNS_LOG_RETENTION_DAYS)
CREATE TABLE IF NOT EXISTS dns_logs (
  id            BIGSERIAL    PRIMARY KEY,
  device_id     UUID         REFERENCES devices(id),
  user_id       UUID         REFERENCES users(id),
  domain        VARCHAR(500) NOT NULL,
  action        VARCHAR(20)  NOT NULL,   -- allowed | blocked
  block_reason  VARCHAR(255),
  policy_id     UUID         REFERENCES policies(id),
  queried_at    TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dns_logs_user_time  ON dns_logs(user_id, queried_at DESC);
CREATE INDEX IF NOT EXISTS idx_dns_logs_queried_at ON dns_logs(queried_at DESC);

-- Penalty box records
CREATE TABLE IF NOT EXISTS penalty_box (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID        REFERENCES users(id) ON DELETE CASCADE,
  placed_by    UUID        REFERENCES users(id),
  reason       TEXT,
  expires_at   TIMESTAMPTZ,
  released_at  TIMESTAMPTZ,
  released_by  UUID        REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Classes (from Google Classroom or manually created)
CREATE TABLE IF NOT EXISTS classes (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 VARCHAR(255) NOT NULL,
  teacher_id           UUID        REFERENCES users(id),
  google_classroom_id  VARCHAR(255),
  is_active            BOOLEAN     DEFAULT true,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Class rosters
CREATE TABLE IF NOT EXISTS class_members (
  class_id    UUID REFERENCES classes(id) ON DELETE CASCADE,
  student_id  UUID REFERENCES users(id)  ON DELETE CASCADE,
  PRIMARY KEY (class_id, student_id)
);

-- Teacher lesson sessions (productivity filter override)
CREATE TABLE IF NOT EXISTS lesson_sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id         UUID        REFERENCES classes(id),
  teacher_id       UUID        REFERENCES users(id),
  allowed_domains  JSONB       NOT NULL DEFAULT '[]',
  is_active        BOOLEAN     DEFAULT true,
  started_at       TIMESTAMPTZ DEFAULT NOW(),
  ended_at         TIMESTAMPTZ
);

-- Admin audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL   PRIMARY KEY,
  actor_id     UUID        REFERENCES users(id),
  action       VARCHAR(100) NOT NULL,
  target_type  VARCHAR(50),
  target_id    UUID,
  details      JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- DHCP subnets managed via ISC Kea
CREATE TABLE IF NOT EXISTS dhcp_subnets (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  kea_subnet_id           INT         UNIQUE NOT NULL,
  subnet                  CIDR        NOT NULL,
  label                   VARCHAR(255),
  pool_start              INET        NOT NULL,
  pool_end                INET        NOT NULL,
  gateway                 INET,
  dns_servers             INET[]      DEFAULT ARRAY['127.0.0.1'::inet],
  domain_name             VARCHAR(255),
  lease_time_seconds      INT         DEFAULT 86400,
  valid_lifetime_seconds  INT         DEFAULT 86400,
  notes                   TEXT,
  is_active               BOOLEAN     DEFAULT true,
  created_by              UUID        REFERENCES users(id),
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- DHCP static reservations (MAC → IP)
CREATE TABLE IF NOT EXISTS dhcp_reservations (
  id           UUID     PRIMARY KEY DEFAULT gen_random_uuid(),
  subnet_id    UUID     REFERENCES dhcp_subnets(id) ON DELETE CASCADE,
  mac_address  MACADDR  NOT NULL,
  ip_address   INET     NOT NULL,
  hostname     VARCHAR(255),
  device_id    UUID     REFERENCES devices(id),
  notes        TEXT,
  created_by   UUID     REFERENCES users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (subnet_id, mac_address),
  UNIQUE (subnet_id, ip_address)
);
CREATE INDEX IF NOT EXISTS idx_dhcp_reservations_mac ON dhcp_reservations(mac_address);
CREATE INDEX IF NOT EXISTS idx_dhcp_reservations_ip  ON dhcp_reservations(ip_address);

-- HA node registry (each node heartbeats into this table)
CREATE TABLE IF NOT EXISTS nodes (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname        VARCHAR(255) NOT NULL,
  ip              VARCHAR(45) NOT NULL,
  role            VARCHAR(20) DEFAULT 'secondary',  -- primary | secondary
  last_heartbeat  TIMESTAMPTZ,
  is_active       BOOLEAN     DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Seed data
-- =============================================================================

-- Default blocklist sources (inactive; admin enables them in the UI)
INSERT INTO blocklist_sources (name, url, format, category, is_active) VALUES
  ('OISD Full',          'https://oisd.nl/downloads/dnsmasq2',                                                          'dnsmasq',     'ads_malware',  false),
  ('OISD NSFW',          'https://nsfw.oisd.nl/downloads/dnsmasq2',                                                     'dnsmasq',     'adult',        false),
  ('Hagezi Pro',         'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/dnsmasq/pro.txt',                'dnsmasq',     'ads_tracking', false),
  ('StevenBlack Unified','https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',                           'hosts',       'ads_malware',  false),
  ('Phishing Army',      'https://phishing.army/download/phishing_army_blocklist.txt',                                  'domain_list', 'phishing',     false)
ON CONFLICT DO NOTHING;
