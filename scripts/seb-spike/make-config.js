#!/usr/bin/env node
// Phase 0 spike helper — generates the test Safe Exam Browser configs used in
// docs/lockdown-seb-spike.md (macOS: §5, Windows: §8.5). Not used by
// ClassGuard at runtime.
//
// Output per variant, in the directory given by --out (default ./seb-spike-out):
//   <variant>.seb      plain XML plist. Both platforms accept an unencrypted
//                      "<?xm" file (seb-mac SEBConfigFileManager.m L256-262;
//                      seb-win XmlParser). Double-click it on the test machine,
//                      or host it and open sebs://host/path.
//   <variant>.link.txt a sebs://application/seb;base64,<config> link, which
//                      seb-mac rewrites to a data: URL (NSURL+SEBURL.m
//                      L97-127), so the whole config rides in the link.
//                      MACOS ONLY: SEB for Windows fetches sebs:// as https://
//                      at launch and can't load this form
//                      (seb-win-refactoring NetworkResourceLoader.cs
//                      L133-146 at 397f8e12).
//   <variant>.hosted-link.txt  with --host-base: sebs://<host-base>/<variant>.seb,
//                      for the .seb files once they are served from there.
//                      Works on both platforms; Windows needs this form.
//   0-probe.hosted-link-token.txt  with --host-base and --origin: the probe's
//                      hosted link plus "??token=spike123" (test 8.5 3f).
//
// Usage:
//   node scripts/seb-spike/make-config.js --form <Google Form viewform URL> \
//     [--quit-password <pw>] [--quit-url <url>] [--origin <https://classguard...>] \
//     [--host-base <https://host/dir/>] [--platform mac|win|both] [--allow-vm true] \
//     [--win-ua <user agent>] [--deactivate-prohibited a.exe,b.exe[:OriginalName.exe]] \
//     [--out <dir>]
//
// --platform (default both) picks which platform-specific variants are
// written. The Windows keys are in every config regardless: SEB for macOS
// ignores them, and the Config Key covers whatever the file contains.
//
// No dependencies; Node 18+.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const SPIKE_TOKEN = 'spike123';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

// hashedQuitPassword: lowercase hex SHA-256 of the UTF-8 password. seb-mac
// NFC-normalizes first (SEBKeychainManager.m L209-227); seb-win doesn't, so
// main() only accepts ASCII passwords, where both give the same hash.
function hashQuitPassword(pw) {
  return crypto.createHash('sha256').update(pw.normalize('NFC'), 'utf8').digest('hex');
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal plist writer for the types these configs use. Integers only — no
// <real>, whose Config Key serialization is fragile (seb-mac SEBCryptor.m
// L420-443), and no <date>/<data> or empty dicts, which would also make the
// Mac and Windows Config Keys harder to keep identical.
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
    if (Object.keys(v).length === 0) throw new Error('empty dict: not allowed (Config Key parity)');
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

// SEB for Windows 3.10.3+ rejects a config with `",` in any string (doc §8.1.2).
function assertNoQuoteComma(v, where = 'config') {
  if (typeof v === 'string' && v.includes('",')) throw new Error(`${where} contains '",', which SEB for Windows 3.10.3+ rejects`);
  if (Array.isArray(v)) v.forEach((x, i) => assertNoQuoteComma(x, `${where}[${i}]`));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => assertNoQuoteComma(x, `${where}.${k}`));
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

// prohibitedProcesses entries that switch OFF a default entry: SEB for Windows
// removes the default whose executable AND originalName match, and adds the
// entry only if it is active (ApplicationDataMapper.cs L32-77 at 397f8e12).
// Defaults use the executable name as originalName, e.g. Teams.exe/Teams.exe.
function deactivatedProcesses(spec) {
  if (!spec) return null;
  return spec.split(',').map(s => s.trim()).filter(Boolean).map((item) => {
    const [executable, originalName = executable] = item.split(':');
    return { active: false, executable, originalName, os: 1, description: 'district agent (spike)' };
  });
}

function baseConfig({ startURL, quitURL, quitPassword, allowVM, prohibited }) {
  const cfg = {
    sebConfigPurpose: 0,                  // 0 = starting an exam (Constants.h L419-425)
    startURL,
    // --- macOS (ignored by SEB for Windows) ---
    lockdownModePolicy: 2,                // 2 = enforce AAC (Constants.h L288-323)
    browserWindowWebView: 3,              // 3 = force modern WKWebView (Constants.h L101-104)
    detectAccessibilityApps: false,       // default true prompts students for Full Disk Access (RELNOTES 3.7)
    allowOpenAndSavePanel: false,
    // --- Windows, SEB 3.10.x (ignored by SEB for macOS; doc §8.3) ---
    createNewDesktop: true,               // kiosk mode (SecurityDataMapper.cs L131-150)
    killExplorerShell: false,             // the other kiosk mode; needed for screen readers / touch keyboard (§8.2 #11)
    sebServiceIgnore: false,              // default true = service not used, Ctrl+Alt+Del stays open (DataValues.cs L292)
    sebServicePolicy: 1,                  // 1 = warn if the service is missing (ServiceDataMapper.cs L183-192)
    allowVirtualMachine: allowVM,         // 3.10.1/3.10.2 flag real laptops as VMs (GH#1517)
    allowDownloads: false,                // Windows default true (DataValues.cs L173)
    allowUploads: false,                  // Forms file-upload questions would need true
    enableChromeNotifications: true,      // don't let the service rewrite Chrome's notification policy
    // --- both ---
    sendBrowserExamKey: false,            // Mac: CK/BEK headers only exist in the deprecated classic WebView
    examSessionClearCookiesOnStart: true,
    examSessionClearCookiesOnEnd: true,
    allowBrowsingBackForward: false,
    browserWindowAllowReload: true,       // test 4 checks whether reload re-submits anything
    allowQuit: true,
    quitURL,
    quitURLConfirm: false,                // quit link exits immediately, bypassing the password (defaults differ: Mac true, Windows false)
    hashedQuitPassword: quitPassword ? hashQuitPassword(quitPassword) : '',
  };
  if (prohibited) cfg.prohibitedProcesses = prohibited;
  return cfg;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.form) {
    console.error('--form <Google Form viewform URL> is required');
    process.exit(2);
  }
  const platform = args.platform || 'both';
  if (!['mac', 'win', 'both'].includes(platform)) {
    console.error('--platform must be mac, win or both');
    process.exit(2);
  }
  const quitPassword = args['quit-password'] || '';
  if (!/^[\x20-\x7e]*$/.test(quitPassword)) {
    console.error('--quit-password must be printable ASCII (SEB for Windows hashes it without Unicode normalization)');
    process.exit(2);
  }
  const form     = new URL(args.form).toString();
  const origin   = args.origin || null;
  const quitURL  = args['quit-url'] || (origin ? `${origin.replace(/\/$/, '')}/seb-quit` : 'https://seb-quit.invalid/');
  const outDir   = args.out || 'seb-spike-out';
  const hostBase = args['host-base'] ? new URL(args['host-base']) : null;
  if (hostBase && hostBase.protocol !== 'https:') {
    console.error('--host-base must be an https:// URL (sebs:// is fetched as https://)');
    process.exit(2);
  }
  const common = {
    quitURL,
    quitPassword,
    allowVM:    args['allow-vm'] === 'true',
    prohibited: deactivatedProcesses(args['deactivate-prohibited']),
  };
  const safariUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15';
  // Reduced Chrome UA at the Chromium major SEB 3.10.2's CEF ships (147).
  const winUA = args['win-ua'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
  const mac = platform !== 'win';
  const win = platform !== 'mac';

  const variants = {
    // Test 1a: sign-in only — no URL filter, so a failure is Google's, not ours.
    '1a-signin-nofilter': { ...baseConfig({ startURL: form, ...common }), URLFilterEnable: false },
  };
  // Test 1c (diagnostic only): same, with a custom base user agent. SEB still
  // appends its own SEB/x.y tokens (seb-mac SEBBrowserController.m L378-409),
  // and Google forbids UA spoofing, so this never ships.
  if (mac) {
    variants['1c-signin-safari-ua'] = {
      ...baseConfig({ startURL: form, ...common }),
      URLFilterEnable: false,
      browserUserAgentMac: 1,
      browserUserAgentMacCustom: safariUA,
    };
  }
  if (win) {
    variants['1c-signin-custom-ua-win'] = {
      ...baseConfig({ startURL: form, ...common }),
      URLFilterEnable: false,
      browserUserAgentWinDesktopMode: 1,
      browserUserAgentWinDesktopModeCustom: winUA,
    };
  }
  // Tests 1b/2/3/4: the realistic locked config — AAC on Mac, kiosk mode on
  // Windows, plus the allowlist.
  variants['2-direct-aac-filtered'] = {
    ...baseConfig({ startURL: form, ...common }),
    URLFilterEnable: true,
    // Content filter (sub-resources) stays off for the spike: the docs say it
    // forces the classic WebView, the current code says otherwise (see doc §1.5).
    URLFilterEnableContentFilter: false,
    URLFilterRules: googleFormAllowRules(origin),
  };

  if (origin) {
    const o = origin.replace(/\/$/, '');
    const q = encodeURIComponent;
    // Test 0: the probe page (SafeExamBrowser JS API + UA), then on to the
    // Form. startURLAppendQueryParameter makes SEB pass a "??token=" from the
    // link on to the start URL (test 8.5 3f).
    variants['0-probe'] = {
      ...baseConfig({ startURL: `${o}/seb-spike/probe.html?form=${q(form)}`, ...common }),
      URLFilterEnable: false,
      startURLAppendQueryParameter: true,
    };
    // Test 5: wrapper layout — ClassGuard page with the Form in an iframe.
    // Its Finish link always goes to <origin>/seb-quit (wrapper.html never
    // takes a URL from the query string), so this variant's quitURL is that,
    // whatever --quit-url says.
    variants['5-wrapper'] = {
      ...baseConfig({ startURL: `${o}/seb-spike/wrapper.html?form=${q(form)}`, ...common, quitURL: `${o}/seb-quit` }),
      URLFilterEnable: false,
    };
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, cfg] of Object.entries(variants)) {
    assertNoQuoteComma(cfg, name);
    const xml = toPlist(cfg);
    fs.writeFileSync(path.join(outDir, `${name}.seb`), xml);
    const notes = [];
    if (mac) {
      const link = `sebs://application/seb;base64,${Buffer.from(xml, 'utf8').toString('base64')}`;
      fs.writeFileSync(path.join(outDir, `${name}.link.txt`), link + '\n');
      notes.push(`base64 link ${link.length} chars, Mac only`);
    }
    if (hostBase) {
      const dir = `${hostBase.host}${hostBase.pathname.replace(/\/?$/, '/')}`;
      const hosted = `sebs://${dir}${name}.seb`;
      fs.writeFileSync(path.join(outDir, `${name}.hosted-link.txt`), hosted + '\n');
      if (name === '0-probe') {
        fs.writeFileSync(path.join(outDir, `${name}.hosted-link-token.txt`), `${hosted}??token=${SPIKE_TOKEN}\n`);
      }
      notes.push('hosted link');
    }
    console.log(`${name}: ${path.join(outDir, name)}.seb  (${notes.join(', ') || 'no links'})`);
  }
  console.log(`quitURL: ${quitURL}${quitPassword ? '  (quit password set)' : '  (no quit password)'}`);
  if (hostBase) console.log(`serve the .seb files at ${hostBase.href} (not as text/html; a missing file must be a 404, not an HTML page)`);
  if (win && !hostBase) console.log('note: no --host-base, so no links SEB for Windows can open; double-click the .seb files, or rerun with --host-base');
  if (win && !common.allowVM) console.log('note: allowVirtualMachine=false; if SEB 3.10.1/3.10.2 refuses to start on a real laptop, rerun with --allow-vm true');
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
