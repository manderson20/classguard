-- Migration 036: track which ip_addresses rows are owned by the DHCP
-- lease->IPAM sync job (services/dhcpLeaseIpamSync.js) so that job can safely
-- create/revert/delete rows for transient dynamic leases without touching
-- anything an admin has documented by hand or that's backed by a fixed
-- reservation (address_status='reserved' is never lease_managed).

ALTER TABLE ip_addresses
  ADD COLUMN IF NOT EXISTS lease_managed BOOLEAN NOT NULL DEFAULT false;
