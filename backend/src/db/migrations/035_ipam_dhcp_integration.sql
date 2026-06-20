-- Migration 035: wire IPAM and DHCP together.
--
-- dhcp_subnets (Kea-facing) and ipam_subnets (phpIPAM-style, what the actual
-- IPAM page reads) have always been two separate tables, linked only by an
-- FK on ipam_subnets that nothing ever populated — so a DHCP scope import
-- was invisible to IPAM. This adds the address-level status tracking needed
-- to show static vs. reserved vs. leased in IPAM; the subnet-level link
-- itself (ipam_subnets.dhcp_subnet_id) already existed, it just needed code
-- to actually set it (see services/dhcpIpamSync.js).

ALTER TABLE ip_addresses
  ADD COLUMN IF NOT EXISTS address_status VARCHAR(20) NOT NULL DEFAULT 'static'
    CHECK (address_status IN ('static', 'reserved', 'leased')),
  ADD COLUMN IF NOT EXISTS dhcp_reservation_id UUID REFERENCES dhcp_reservations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ip_addresses_status ON ip_addresses(address_status);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_reservation ON ip_addresses(dhcp_reservation_id);
