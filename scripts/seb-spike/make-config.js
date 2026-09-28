#!/usr/bin/env node
// Phase 0 spike helper — generates the test Safe Exam Browser configs used in
// docs/lockdown-seb-spike.md. Not used by ClassGuard at runtime.
//
// Output per variant, in the directory given by --out (default ./seb-spike-out):
//   <variant>.seb      plain XML plist (SEB accepts an unencrypted "<?xm" file —
//                      seb-mac SEBConfigFileManager.m L256-262); double-click it
//                      on the test Mac, or host it and open sebs://host/path
//   <variant>.link.txt a sebs://application/seb;base64,<config> link, which
//                      seb-mac rewrites to a data: URL (NSURL+SEBURL.m
//                      L97-127) — the whole config rides in the link, so the
//                      Chrome-launch test needs no hosting at all
//
// Usage:
//   node scripts/seb-spike/make-config.js --form <Google Form viewform URL> \
//     [--quit-password <pw>] [--quit-url <url>] [--origin <https://classguard...>] [--out <dir>]
//
// No dependencies; Node 18+.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

// hashedQuitPassword: lowercase hex SHA-256 of the NFC-normalized UTF-8
// password (seb-mac SEBKeychainManager.m L209-227).
function hashQuitPassword(pw) {
  return crypto.createHash('sha256').update(pw.normalize('NFC'), 'utf8').digest('hex');
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal plist writer for the types these configs use. Integers only — no
// <real>, whose Config Key serialization is fragile (seb-mac SEBCryptor.m
// L420-443).
function plistValue(v, indent) {
  const pad = '\t'.repeat(indent);
  if (typeof v === 'boolean') return `${pad}<${v}/>`;
  if (Number.isInteger(v))    return `${pad}<integer>${v}</integer>`;
  if (typeof v === 'string')  return `${pad}<string>${xmlEscape(v)}</string>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `${pad}<array/>`;
    return `${pad}<array>\n${v.map(x => plistValue(x, indent + 1)).join('\n')}\n${pad}</array>`;
  }
  if (v && typeof v === 'object') {
    const body = Object.entries(v)
      .map(([k, x]) => `${pad}\t<key>${xmlEscape(k)}</key>\n${plistValue(x, indent + 1)}`)
      .join('\n');
    return `${pad}<dict>\n${body}\n${pad}</dict>`;
  }
  throw new Error(`unsupported plist value: ${v}`);
}

function toPlist(obj) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' + plistValue(obj, 0) + '\n</plist>\n';
}

// URLFilterRules entry: action 1 = allow, 0 = block; non-regex expressions
// use * wildcards (seb-mac SEBSettings.m L1229-1234, Constants.h L513-516).
const allow = (expression) => ({ active: true, regex: false, expression, action: 1 });

// Starting allowlist for a sign-in-required Google Form. Deliberately a
// first guess — test 1b's job is to find what this is missing (SEB's log
// records every URL the filter blocks).
function googleFormAllowRules(origin) {
  const rules = [
    allow('docs.google.com/forms/*'),
    allow('accounts.google.com'),
    allow('accounts.youtube.com'),
    allow('ssl.gstatic.com'),
    allow('www.gstatic.com'),
    allow('fonts.gstatic.com'),
    allow('fonts.googleapis.com'),
    allow('apis.google.com'),
    allow('*.googleusercontent.com'),
    allow('www.google.com/recaptcha/*'),
  ];
  if (origin) rules.push(allow(`${new URL(origin).host}`));
  return rules;
}

function baseConfig({ startURL, quitURL, quitPassword }) {
  return {
    sebConfigPurpose: 0,                  // 0 = starting an exam (Constants.h L419-425)
    startURL,
    lockdownModePolicy: 2,                // 2 = enforce AAC (Constants.h L288-323)
    browserWindowWebView: 3,              // 3 = force modern WKWebView (Constants.h L101-104)
    sendBrowserExamKey: false,            // CK/BEK headers only exist in the deprecated classic WebView
    examSessionClearCookiesOnStart: true,
    examSessionClearCookiesOnEnd: true,
    allowBrowsingBackForward: false,
    browserWindowAllowReload: true,       // test 4 checks whether reload re-submits anything
    allowQuit: true,
    quitURL,
    quitURLConfirm: false,                // quit link exits immediately, bypassing the password
    hashedQuitPassword: quitPassword ? hashQuitPassword(quitPassword) : '',
    detectAccessibilityApps: false,       // default true prompts students for Full Disk Access (RELNOTES 3.7)
    allowOpenAndSavePanel: false,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.form) {
    console.error('--form <Google Form viewform URL> is required');
    process.exit(2);
  }
  const form     = new URL(args.form).toString();
  const origin   = args.origin || null;
  const quitURL  = args['quit-url'] || (origin ? `${origin.replace(/\/$/, '')}/seb-quit` : 'https://seb-quit.invalid/');
  const quitPassword = args['quit-password'] || '';
  const outDir   = args.out || 'seb-spike-out';
  const safariUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15';

  const variants = {
    // Test 1a: sign-in only — no URL filter, so a failure is Google's, not ours.
    '1a-signin-nofilter': { ...baseConfig({ startURL: form, quitURL, quitPassword }), URLFilterEnable: false },
    // Test 1c: same, with a custom Safari base user agent (SEB still appends
    // its own SEB/x.y tokens — SEBBrowserController.m L378-409).
    '1c-signin-safari-ua': {
      ...baseConfig({ startURL: form, quitURL, quitPassword }),
      URLFilterEnable: false,
      browserUserAgentMac: 1,
      browserUserAgentMacCustom: safariUA,
    },
    // Tests 1b/2/3/4: the realistic locked config — AAC + allowlist.
    '2-direct-aac-filtered': {
      ...baseConfig({ startURL: form, quitURL, quitPassword }),
      URLFilterEnable: true,
      // Content filter (sub-resources) stays off for the spike: the docs say it
      // forces the classic WebView, the current code says otherwise (see doc §4).
      URLFilterEnableContentFilter: false,
      URLFilterRules: googleFormAllowRules(origin),
    },
  };

  if (origin) {
    const o = origin.replace(/\/$/, '');
    const q = encodeURIComponent;
    // Test 0: the probe page (SafeExamBrowser JS API + UA), then on to the Form.
    variants['0-probe'] = {
      ...baseConfig({ startURL: `${o}/seb-spike/probe.html?form=${q(form)}`, quitURL, quitPassword }),
      URLFilterEnable: false,
    };
    // Test 5: wrapper layout — ClassGuard page with the Form in an iframe.
    variants['5-wrapper'] = {
      ...baseConfig({ startURL: `${o}/seb-spike/wrapper.html?form=${q(form)}&quit=${q(quitURL)}`, quitURL, quitPassword }),
      URLFilterEnable: false,
    };
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, cfg] of Object.entries(variants)) {
    const xml = toPlist(cfg);
    fs.writeFileSync(path.join(outDir, `${name}.seb`), xml);
    const link = `sebs://application/seb;base64,${Buffer.from(xml, 'utf8').toString('base64')}`;
    fs.writeFileSync(path.join(outDir, `${name}.link.txt`), link + '\n');
    console.log(`${name}: ${path.join(outDir, name)}.seb  (link ${link.length} chars)`);
  }
  console.log(`quitURL: ${quitURL}${quitPassword ? '  (quit password set)' : '  (no quit password)'}`);
}

main();
