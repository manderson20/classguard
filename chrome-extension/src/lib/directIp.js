// Detects navigation straight to a literal IP address — the one case
// dns-engine structurally can never see, since no DNS query happens when
// the browser is handed an IP literal instead of a hostname.
//
// Private/loopback/link-local ranges are deliberately excluded: traffic to
// the school's own LAN (printers, internal apps, the ClassGuard box itself)
// is not a filtering-bypass attempt and must never be logged or blocked as
// one. Chrome's DNR regex engine (RE2) has no lookaround, so the same
// exclusion logic needs to exist as plain JS here too, not just in the DNR
// allow-rule rules.js builds — this is what decides what we *log/report*,
// rules.js's regexes are what DNR uses to actually *block*.

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/; // hostname with brackets already stripped by URL parsing

function isPrivateIpv4(octets) {
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function isPrivateIpv6(hostname) {
  const lower = hostname.toLowerCase();
  if (lower === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;       // fc00::/7 (ULA)
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;       // fe80::/10 (link-local)
  return false;
}

/**
 * Returns 'ipv4' | 'ipv6' | null — null means "not a literal IP at all" or
 * "a literal IP, but in a private/loopback/link-local range we don't care
 * about." Only a non-null result is a public IP-literal navigation worth
 * reporting.
 */
export function classifyPublicIpLiteral(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }

  const v4 = hostname.match(IPV4_RE);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    if (octets.some(o => o > 255)) return null; // not actually a valid IPv4 literal
    return isPrivateIpv4(octets) ? null : 'ipv4';
  }

  // Unlike IPv4, new URL().hostname keeps the brackets for an IPv6-literal
  // authority (e.g. "https://[2001:db8::1]/" -> hostname === "[2001:db8::1]"),
  // so strip them before testing. A real hostname never legally contains a
  // ':', so this check alone safely distinguishes an IPv6 literal from any
  // domain name.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const stripped = hostname.slice(1, -1);
    if (IPV6_RE.test(stripped)) {
      return isPrivateIpv6(stripped) ? null : 'ipv6';
    }
  }

  return null;
}
