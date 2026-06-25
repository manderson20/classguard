-- Mark a subnet as public IP space so its addresses appear in the private-IP
-- NAT pairing picker. No data change needed -- existing subnets default false.
ALTER TABLE ipam_subnets ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

-- Link a private ip_addresses row to the NAT rule that translates it.
-- ON DELETE SET NULL so deleting a NAT rule orphans the IP row cleanly rather
-- than blocking the delete.
ALTER TABLE ip_addresses ADD COLUMN IF NOT EXISTS nat_rule_id UUID REFERENCES nat_rules(id) ON DELETE SET NULL;
