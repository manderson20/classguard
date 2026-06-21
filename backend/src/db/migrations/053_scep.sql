-- Mosyle's SCEP profile turned out not to hand out a certificate at all -
-- it's Apple's standard SCEP payload, which only configures a URL pointing
-- at a SCEP server plus a static Challenge secret. mosyle_ca_pem (migration
-- 052) was built on the wrong assumption and was never actually populated
-- (confirmed NULL in production) - dropping it cleanly rather than leaving
-- a dead column around.
--
-- ClassGuard now generates and owns its own CA (services/ca.js) - the SCEP
-- server (infrastructure/scep/) issues certs from it on enrollment, and the
-- VPN server (infrastructure/vpn/) trusts the same CA directly. No export/
-- import step with Mosyle at all.
ALTER TABLE vpn_config DROP COLUMN IF EXISTS mosyle_ca_pem;
ALTER TABLE vpn_config ADD COLUMN ca_cert_pem        TEXT;
ALTER TABLE vpn_config ADD COLUMN ca_private_key_pem TEXT;
ALTER TABLE vpn_config ADD COLUMN scep_challenge     TEXT;
ALTER TABLE vpn_config ADD COLUMN scep_enabled       BOOLEAN NOT NULL DEFAULT false;
