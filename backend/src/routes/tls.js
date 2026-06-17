const express  = require('express');
const router   = express.Router();
const { authenticate }   = require('../middleware/auth');
const { requireMinRole } = require('../middleware/roles');
const acmeTls = require('../services/acmeTls');

const auth      = [authenticate, requireMinRole('admin')];
const superauth = [authenticate, requireMinRole('superadmin')];

function redact(cfg) {
  if (!cfg) return cfg;
  const {
    account_key_pem, privkey_pem, cert_pem,
    cloudflare_api_token, route53_secret_access_key,
    manual_challenge, ...safe
  } = cfg;
  return {
    ...safe,
    cloudflare_api_token_set:      !!cloudflare_api_token,
    route53_secret_access_key_set: !!route53_secret_access_key,
    cert_pem_set:                  !!cert_pem,
    // Never expose the in-flight private key/CSR — only what the admin needs
    // to publish the DNS record.
    manual_challenge: manual_challenge
      ? { recordName: manual_challenge.recordName, recordValue: manual_challenge.recordValue }
      : null,
  };
}

// GET /api/v1/tls — current config + cert status (secrets redacted)
router.get('/', ...auth, async (req, res) => {
  try {
    res.json(redact(await acmeTls.getConfig()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/v1/tls — save domain / provider / credentials
router.put('/', ...superauth, async (req, res) => {
  try {
    res.json(redact(await acmeTls.saveConfig(req.body)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/tls/issue — Cloudflare/Route53: issue (or renew) in one call
router.post('/issue', ...superauth, async (req, res) => {
  try {
    res.json(redact(await acmeTls.issueAutomatic()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/tls/manual/start — returns the TXT record to add
router.post('/manual/start', ...superauth, async (req, res) => {
  try {
    res.json(await acmeTls.startManualChallenge());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/v1/tls/manual/confirm — admin added the record, validate + issue
router.post('/manual/confirm', ...superauth, async (req, res) => {
  try {
    res.json(redact(await acmeTls.completeManualChallenge()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
