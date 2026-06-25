INSERT INTO kb_articles (slug, title, category, content, page_paths) VALUES (
  'network-tools', 'Network Tools', 'DNS & Network',
  $kb$Ping, traceroute, and outbound public IP — run directly from whichever node is actually serving your request, not from your own browser.

- **Public IP Address (per node)** — what each ClassGuard node's own outbound traffic shows up as on the public internet. Two nodes behind different upstream NAT can legitimately show different addresses; this is also useful for confirming what to allowlist on a vendor's side, or that an HA failover didn't silently change the apparent source IP.
- **Ping / Traceroute** — run against any hostname or IP, with output exactly as the real `ping`/`traceroute` binaries produce it (not a simplified summary). Limited to 10 pings and 20 traceroute hops per run.

Both tools run with `execFile` against a strict hostname/IP allowlist — arbitrary shell input is rejected outright, not merely escaped.$kb$,
  ARRAY['/admin/network-tools']
) ON CONFLICT (slug) DO NOTHING;
