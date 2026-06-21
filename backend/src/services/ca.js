/**
 * ClassGuard's own private CA, for issuing client certs to staff devices via
 * SCEP (infrastructure/scep/) and validating them at the VPN server
 * (infrastructure/vpn/). Mosyle's SCEP profile turned out to be a pointer at
 * a SCEP server, not a certificate source itself — see migration 053 — so
 * this CA exists because nobody else was going to provide one.
 *
 * Generated once via generateCa() (admin clicks "Generate CA" on the VPN
 * page), stored in Postgres (vpn_config.ca_cert_pem/ca_private_key_pem) as
 * the source of truth — same plaintext-column-protected-by-DB-access
 * pattern acmeTls.js already uses for the Let's Encrypt account key
 * (tls_config.account_key_pem). The SCEP and VPN containers are passive
 * readers of these columns, not generators.
 */
const forge  = require('node-forge');
const crypto = require('crypto');
const { pki } = forge;

const CA_VALIDITY_YEARS = 10;

function generateCa() {
  const keys = pki.rsa.generateKeyPair(4096);
  const cert = pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(16).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + CA_VALIDITY_YEARS);

  const attrs = [{ name: 'commonName', value: 'ClassGuard VPN CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed — issuer == subject

  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    ca_cert_pem:        pki.certificateToPem(cert),
    ca_private_key_pem: pki.privateKeyToPem(keys.privateKey),
  };
}

function generateChallenge() {
  return crypto.randomBytes(24).toString('hex');
}

// SHA-256 fingerprint of the cert, for display on the VPN page — not a
// substitute for Mosyle's own "Create from Certificate..." fingerprint
// computation (that's what the device profile actually pins), just a
// human-checkable value so an admin can confirm they uploaded the right file.
function fingerprint(certPem) {
  const der = pki.pemToDer(certPem).getBytes();
  return forge.md.sha256.create().update(der).digest().toHex().toUpperCase().replace(/(..)(?=.)/g, '$1:');
}

function certInfo(certPem) {
  const cert = pki.certificateFromPem(certPem);
  return {
    subject:     cert.subject.getField('CN')?.value,
    notBefore:   cert.validity.notBefore,
    notAfter:    cert.validity.notAfter,
    fingerprint: fingerprint(certPem),
  };
}

module.exports = { generateCa, generateChallenge, certInfo };
