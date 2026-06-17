/**
 * TLS certificate automation — ACME DNS-01 (Let's Encrypt).
 *
 * Why DNS-01 instead of HTTP-01: HTTP-01 requires Let's Encrypt to reach
 * port 80 on the requesting node directly, which means port-forwarding a
 * public IP per node. DNS-01 instead proves domain ownership via a TXT
 * record, so the ClassGuard server can stay on a private IP behind the VRRP
 * VIP — only the public DNS zone needs to be reachable.
 *
 * The issued cert/key live in Postgres (tls_config), the same shared store
 * every HA node already reads — so any node can write the cert to its local
 * volume without a separate file-sync mechanism.
 */

const acme   = require('acme-client');
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const {
  Route53Client,
  ChangeResourceRecordSetsCommand,
  ListHostedZonesByNameCommand,
} = require('@aws-sdk/client-route-53');
const { pool } = require('../db');

const CERT_DIR = process.env.TLS_CERT_DIR || '/app/certs';

async function getConfig() {
  const { rows } = await pool.query('SELECT * FROM tls_config LIMIT 1');
  return rows[0] || {};
}

const SAVABLE_FIELDS = [
  'enabled', 'domain', 'acme_email', 'provider',
  'cloudflare_api_token', 'cloudflare_zone_id',
  'route53_access_key_id', 'route53_secret_access_key', 'route53_hosted_zone_id',
];

async function saveConfig(fields) {
  const entries = Object.entries(fields).filter(([k]) => SAVABLE_FIELDS.includes(k));
  if (!entries.length) return getConfig();
  const sets = entries.map(([k], i) => `${k} = $${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `UPDATE tls_config SET ${sets}, updated_at = NOW() RETURNING *`,
    entries.map(([, v]) => v)
  );
  return rows[0];
}

async function persist(fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `UPDATE tls_config SET ${sets}, updated_at = NOW() RETURNING *`,
    keys.map(k => fields[k])
  );
  return rows[0];
}

function writeCertToDisk(certPem, keyPem) {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(path.join(CERT_DIR, 'fullchain.pem'), certPem, { mode: 0o644 });
  fs.writeFileSync(path.join(CERT_DIR, 'privkey.pem'), keyPem, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Cloudflare DNS-01 record management
// ---------------------------------------------------------------------------
async function cloudflareFindZoneId(cfg, domain) {
  if (cfg.cloudflare_zone_id) return cfg.cloudflare_zone_id;
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    const { data } = await axios.get('https://api.cloudflare.com/client/v4/zones', {
      params:  { name: candidate },
      headers: { Authorization: `Bearer ${cfg.cloudflare_api_token}` },
    });
    if (data.result?.length) return data.result[0].id;
  }
  throw new Error(`Could not find a Cloudflare zone for ${domain}`);
}

async function cloudflareCreateTxt(cfg, recordName, recordValue) {
  const zoneId = await cloudflareFindZoneId(cfg, cfg.domain);
  const { data } = await axios.post(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
    { type: 'TXT', name: recordName, content: recordValue, ttl: 60 },
    { headers: { Authorization: `Bearer ${cfg.cloudflare_api_token}`, 'Content-Type': 'application/json' } }
  );
  return { zoneId, recordId: data.result.id };
}

async function cloudflareDeleteTxt(cfg, zoneId, recordId) {
  await axios.delete(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, {
    headers: { Authorization: `Bearer ${cfg.cloudflare_api_token}` },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Route53 DNS-01 record management
// ---------------------------------------------------------------------------
function route53Client(cfg) {
  return new Route53Client({
    region: 'us-east-1',
    credentials: {
      accessKeyId:     cfg.route53_access_key_id,
      secretAccessKey: cfg.route53_secret_access_key,
    },
  });
}

async function route53FindZoneId(cfg, domain) {
  if (cfg.route53_hosted_zone_id) return cfg.route53_hosted_zone_id;
  const client = route53Client(cfg);
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.') + '.';
    const res = await client.send(new ListHostedZonesByNameCommand({ DNSName: candidate, MaxItems: '1' }));
    if (res.HostedZones?.[0]?.Name === candidate) return res.HostedZones[0].Id;
  }
  throw new Error(`Could not find a Route53 hosted zone for ${domain}`);
}

async function route53UpsertTxt(cfg, zoneId, recordName, recordValue) {
  const client = route53Client(cfg);
  await client.send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: zoneId,
    ChangeBatch: {
      Changes: [{
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: recordName, Type: 'TXT', TTL: 60,
          ResourceRecords: [{ Value: `"${recordValue}"` }],
        },
      }],
    },
  }));
}

async function route53DeleteTxt(cfg, zoneId, recordName, recordValue) {
  const client = route53Client(cfg);
  await client.send(new ChangeResourceRecordSetsCommand({
    HostedZoneId: zoneId,
    ChangeBatch: {
      Changes: [{
        Action: 'DELETE',
        ResourceRecordSet: {
          Name: recordName, Type: 'TXT', TTL: 60,
          ResourceRecords: [{ Value: `"${recordValue}"` }],
        },
      }],
    },
  })).catch(() => {});
}

// ---------------------------------------------------------------------------
// ACME client bootstrap (shared account key, persisted in tls_config)
// ---------------------------------------------------------------------------
async function getClient(cfg) {
  let accountKey = cfg.account_key_pem;
  if (!accountKey) {
    accountKey = (await acme.crypto.createPrivateKey()).toString();
    await persist({ account_key_pem: accountKey });
  }
  return new acme.Client({
    directoryUrl: acme.directory.letsencrypt.production,
    accountKey,
  });
}

async function finishIssuance(certPem, keyPem) {
  const info = acme.crypto.readCertificateInfo(certPem);
  writeCertToDisk(certPem, keyPem);
  return persist({
    cert_pem:         certPem.toString(),
    privkey_pem:      keyPem.toString(),
    cert_issued_at:   new Date(),
    cert_expires_at:  info.notAfter,
    last_error:       null,
    last_attempt_at:  new Date(),
    manual_challenge: null,
  });
}

// ---------------------------------------------------------------------------
// Automatic providers (Cloudflare / Route53) — single round-trip issuance
// ---------------------------------------------------------------------------
async function issueAutomatic() {
  const cfg = await getConfig();
  if (!cfg.domain) throw new Error('Set a domain before issuing a certificate');

  const client = await getClient(cfg);
  const [certKey, csr] = await acme.crypto.createCsr({ commonName: cfg.domain });

  let pendingZone = null;

  try {
    const certPem = await client.auto({
      csr,
      email: cfg.acme_email || undefined,
      termsOfServiceAgreed: true,
      challengePriority: ['dns-01'],
      challengeCreateFn: async (authz, challenge) => {
        const recordName  = `_acme-challenge.${authz.identifier.value}`;
        const recordValue = await client.getChallengeKeyAuthorization(challenge);
        if (cfg.provider === 'cloudflare') {
          pendingZone = await cloudflareCreateTxt(cfg, recordName, recordValue);
        } else if (cfg.provider === 'route53') {
          const zoneId = await route53FindZoneId(cfg, cfg.domain);
          await route53UpsertTxt(cfg, zoneId, recordName, recordValue);
          pendingZone = { zoneId, recordName, recordValue };
        } else {
          throw new Error(`issueAutomatic() does not support provider "${cfg.provider}"`);
        }
      },
      challengeRemoveFn: async () => {
        if (!pendingZone) return;
        if (cfg.provider === 'cloudflare') {
          await cloudflareDeleteTxt(cfg, pendingZone.zoneId, pendingZone.recordId);
        } else if (cfg.provider === 'route53') {
          await route53DeleteTxt(cfg, pendingZone.zoneId, pendingZone.recordName, pendingZone.recordValue);
        }
      },
    });

    return await finishIssuance(certPem, certKey);
  } catch (err) {
    await persist({ last_error: err.message, last_attempt_at: new Date() });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Manual provider — two-phase flow since a human has to add the DNS record
// between "start" and "confirm"
// ---------------------------------------------------------------------------
async function startManualChallenge() {
  const cfg = await getConfig();
  if (!cfg.domain) throw new Error('Set a domain before issuing a certificate');

  const client = await getClient(cfg);
  const [certKey, csr] = await acme.crypto.createCsr({ commonName: cfg.domain });

  const order = await client.createOrder({ identifiers: [{ type: 'dns', value: cfg.domain }] });
  const [authz] = await client.getAuthorizations(order);
  const challenge = authz.challenges.find(c => c.type === 'dns-01');
  if (!challenge) throw new Error('Let\'s Encrypt did not offer a dns-01 challenge for this domain');

  const recordValue = await client.getChallengeKeyAuthorization(challenge);
  const recordName  = `_acme-challenge.${cfg.domain}`;

  await persist({
    manual_challenge: { order, authz, challenge, recordName, recordValue,
      certKey: certKey.toString('base64'), csr: csr.toString('base64') },
    last_attempt_at: new Date(),
    last_error: null,
  });

  return { recordName, recordValue };
}

async function completeManualChallenge() {
  const cfg = await getConfig();
  const pending = cfg.manual_challenge;
  if (!pending) throw new Error('No pending challenge — click "Start" first');

  const client    = await getClient(cfg);
  const certKey   = Buffer.from(pending.certKey, 'base64');
  const csr       = Buffer.from(pending.csr, 'base64');

  try {
    await client.verifyChallenge(pending.authz, pending.challenge);
    await client.completeChallenge(pending.challenge);
    await client.waitForValidStatus(pending.challenge);

    const finalized = await client.finalizeOrder(pending.order, csr);
    const certPem   = await client.getCertificate(finalized);

    return await finishIssuance(certPem, certKey);
  } catch (err) {
    await persist({ last_error: err.message, last_attempt_at: new Date() });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Renewal check — call from a daily cron. Only auto-renews Cloudflare/Route53;
// manual-provider certs need an admin to repeat the DNS step, so we just flag it.
// ---------------------------------------------------------------------------
async function renewIfNeeded() {
  const cfg = await getConfig();
  if (!cfg.enabled || !cfg.cert_expires_at) return { renewed: false };

  const daysLeft = (new Date(cfg.cert_expires_at) - Date.now()) / 86_400_000;
  if (daysLeft > 30) return { renewed: false, daysLeft };

  if (cfg.provider === 'manual') {
    await persist({ last_error: `Certificate expires in ${Math.round(daysLeft)} days — manual DNS-01 renewal required (Settings → TLS).` });
    return { renewed: false, daysLeft, needsManualAction: true };
  }

  await issueAutomatic();
  return { renewed: true };
}

module.exports = {
  getConfig, saveConfig,
  issueAutomatic, startManualChallenge, completeManualChallenge,
  renewIfNeeded, CERT_DIR,
};
