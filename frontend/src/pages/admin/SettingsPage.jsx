import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

function Section({ title, children }) {
  return (
    <div className="card p-6 mb-5">
      <h2 className="text-sm font-semibold text-slate-700 mb-4">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div className="flex items-start gap-4 py-3 border-b border-slate-50 last:border-0">
      <div className="flex-1">
        <div className="text-sm font-medium text-slate-800">{label}</div>
        {hint && <div className="text-xs text-slate-400 mt-0.5">{hint}</div>}
      </div>
      <div className="flex-shrink-0 w-64">{children}</div>
    </div>
  );
}

const PRESET_COLORS = [
  { label: 'Blue',    value: '#2563eb' },
  { label: 'Indigo',  value: '#4f46e5' },
  { label: 'Green',   value: '#16a34a' },
  { label: 'Red',     value: '#dc2626' },
  { label: 'Maroon',  value: '#9f1239' },
  { label: 'Purple',  value: '#7c3aed' },
  { label: 'Orange',  value: '#ea580c' },
  { label: 'Teal',    value: '#0d9488' },
];

const MAX_LOGO_BYTES = 300 * 1024; // 300 KB

function BlockPageBrandingSection({ appSettings, appLoading, saved, setSaved }) {
  const qc = useQueryClient();
  const [branding, setBranding] = useState({
    blockpage_school_name:   '',
    blockpage_message:       '',
    blockpage_contact_email: '',
    blockpage_primary_color: '#2563eb',
  });
  const [logoPreview, setLogoPreview] = useState(null);
  const [logoError,   setLogoError]   = useState('');

  useEffect(() => {
    if (appSettings && Object.keys(appSettings).length) {
      setBranding({
        blockpage_school_name:     appSettings.blockpage_school_name   || '',
        blockpage_message:         appSettings.blockpage_message       || '',
        blockpage_contact_email:   appSettings.blockpage_contact_email || '',
        blockpage_primary_color:   appSettings.blockpage_primary_color || '#2563eb',
        blockpage_unblock_who:     appSettings.unblock_requests_who    || 'all',
        blockpage_override_enabled: appSettings.override_codes_enabled !== 'false',
      });
      setLogoPreview(appSettings.blockpage_logo || null);
    }
  }, [appSettings]);

  const save = useMutation({
    mutationFn: () => api.put('/settings', {
      blockpage_school_name:   branding.blockpage_school_name,
      blockpage_message:       branding.blockpage_message,
      blockpage_contact_email: branding.blockpage_contact_email,
      blockpage_primary_color: branding.blockpage_primary_color,
      unblock_requests_who:    branding.blockpage_unblock_who || 'all',
      override_codes_enabled:  String(branding.blockpage_override_enabled !== false),
      ...(logoPreview !== appSettings?.blockpage_logo ? { blockpage_logo: logoPreview || '' } : {}),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      setSaved('branding');
      setTimeout(() => setSaved(''), 2500);
    },
  });

  function handleLogoFile(file) {
    setLogoError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) { setLogoError('Please select an image file (PNG, JPG, or SVG)'); return; }

    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target.result;
      const sizeBytes = Math.round((dataUrl.length * 3) / 4);
      if (sizeBytes > MAX_LOGO_BYTES) {
        setLogoError(`Image is too large (${Math.round(sizeBytes / 1024)} KB). Please use an image under 300 KB.`);
        return;
      }
      setLogoPreview(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  const color = branding.blockpage_primary_color || '#2563eb';
  const colorLight = color + '22';

  return (
    <Section title="Block Page Branding">
      <p className="text-xs text-slate-500 mb-5">
        Customize the page students see when a website is blocked — both in the Chrome extension and
        on non-extension devices (via DNS sinkhole). Changes take effect within 5 minutes.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Settings column */}
        <div className="space-y-4">
          {appLoading ? <div className="text-slate-400 text-sm">Loading…</div> : (
            <>
              {/* Logo upload */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">School Logo</label>
                <div
                  className="border-2 border-dashed border-slate-200 rounded-xl p-4 text-center cursor-pointer hover:border-primary-400 hover:bg-primary-50 transition-colors"
                  onClick={() => document.getElementById('logo-file-input').click()}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); handleLogoFile(e.dataTransfer.files[0]); }}
                >
                  {logoPreview ? (
                    <div className="flex flex-col items-center gap-2">
                      <img src={logoPreview} alt="School logo" className="max-h-16 max-w-[200px] object-contain" />
                      <span className="text-xs text-slate-400">Click or drag to replace</span>
                    </div>
                  ) : (
                    <div className="py-2">
                      <div className="text-2xl mb-1">🏫</div>
                      <div className="text-sm text-slate-500">Click or drag to upload your school logo</div>
                      <div className="text-xs text-slate-400 mt-1">PNG, JPG, or SVG · max 300 KB</div>
                    </div>
                  )}
                </div>
                <input id="logo-file-input" type="file" accept="image/*" className="hidden"
                  onChange={e => handleLogoFile(e.target.files[0])} />
                {logoError && <p className="text-red-600 text-xs mt-1">{logoError}</p>}
                {logoPreview && (
                  <button className="text-xs text-red-500 hover:underline mt-1"
                    onClick={() => setLogoPreview(null)}>Remove logo</button>
                )}
              </div>

              {/* School name */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">School / District Name</label>
                <input className="input text-sm" placeholder="e.g. Springfield Unified School District"
                  value={branding.blockpage_school_name}
                  onChange={e => setBranding(b => ({ ...b, blockpage_school_name: e.target.value }))} />
              </div>

              {/* Custom message */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Custom Message</label>
                <textarea className="input text-sm resize-none" rows={3}
                  placeholder="This website is not permitted on your school's network."
                  value={branding.blockpage_message}
                  onChange={e => setBranding(b => ({ ...b, blockpage_message: e.target.value }))} />
              </div>

              {/* Contact email */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">IT Contact Email <span className="text-slate-400 font-normal">(optional)</span></label>
                <input className="input text-sm" type="email" placeholder="helpdesk@school.org"
                  value={branding.blockpage_contact_email}
                  onChange={e => setBranding(b => ({ ...b, blockpage_contact_email: e.target.value }))} />
                <p className="text-xs text-slate-400 mt-1">Shown as a contact link students can click</p>
              </div>

              {/* Primary color */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Accent Color</label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {PRESET_COLORS.map(p => (
                    <button key={p.value} title={p.label}
                      className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 ${color === p.value ? 'border-slate-700 scale-110' : 'border-transparent'}`}
                      style={{ background: p.value }}
                      onClick={() => setBranding(b => ({ ...b, blockpage_primary_color: p.value }))}
                    />
                  ))}
                  <div className="relative w-7 h-7">
                    <input type="color" value={color}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      onChange={e => setBranding(b => ({ ...b, blockpage_primary_color: e.target.value }))} />
                    <div className="w-7 h-7 rounded-full border-2 border-dashed border-slate-300 flex items-center justify-center text-slate-400 text-xs">+</div>
                  </div>
                </div>
              </div>

              {/* Unblock request / override code toggles */}
              <div className="pt-2 border-t border-slate-100 space-y-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Unblock Requests</label>
                  <select className="input text-sm bg-white"
                    value={branding.blockpage_unblock_who || 'all'}
                    onChange={e => setBranding(b => ({ ...b, blockpage_unblock_who: e.target.value }))}>
                    <option value="all">All users (staff + students)</option>
                    <option value="staff">Staff only</option>
                    <option value="off">Disabled</option>
                  </select>
                  <p className="text-xs text-slate-400 mt-1">Who can submit "Request Access" from the block page</p>
                </div>
                <div className="flex items-center gap-3">
                  <input type="checkbox" id="override-toggle-chk" className="w-4 h-4 rounded"
                    checked={branding.blockpage_override_enabled !== false}
                    onChange={e => setBranding(b => ({ ...b, blockpage_override_enabled: e.target.checked }))} />
                  <label htmlFor="override-toggle-chk" className="text-sm font-medium text-slate-700 cursor-pointer">
                    Show "Enter override code" on block page
                  </label>
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save Block Page'}
                </button>
                {saved === 'branding' && <span className="text-green-600 text-sm font-medium">Saved!</span>}
                {save.error && <span className="text-red-500 text-sm">{save.error.message}</span>}
              </div>
            </>
          )}
        </div>

        {/* Live preview column */}
        <div className="hidden lg:block">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Live Preview</div>
          <div className="rounded-2xl border border-slate-200 overflow-hidden shadow-sm" style={{ background: '#f1f5f9' }}>
            <div className="p-5 flex flex-col items-center text-center" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>

              {/* Logo — school logo if set, ClassGuard logo as fallback */}
              <div className="mb-3 flex items-center justify-center" style={{ minHeight: 56 }}>
                <img
                  src={logoPreview || '/classguard-logo.png'}
                  alt=""
                  style={{ maxHeight: 56, maxWidth: 140, objectFit: 'contain' }}
                />
              </div>

              {branding.blockpage_school_name && (
                <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
                  {branding.blockpage_school_name}
                </div>
              )}

              <div style={{ display: 'inline-block', background: colorLight, color, borderRadius: 999, padding: '3px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 10 }}>
                Access Blocked
              </div>

              <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a', marginBottom: 10, lineHeight: 1.25 }}>
                This website has been blocked
              </div>

              <div style={{ display: 'inline-block', background: '#f8fafc', border: '1.5px solid #e2e8f0', borderRadius: 6, padding: '4px 10px', fontFamily: 'monospace', fontSize: 11, color: '#334155', marginBottom: 10 }}>
                🔒 example-site.com
              </div>

              <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.55, marginBottom: branding.blockpage_contact_email ? 8 : 0 }}>
                {branding.blockpage_message || "This website is not permitted on your school's network."}
              </div>

              {branding.blockpage_contact_email && (
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 6 }}>
                  Contact <span style={{ color }}>{branding.blockpage_contact_email}</span>
                </div>
              )}

              <div style={{ borderTop: '1px solid #e2e8f0', width: '100%', marginTop: 14, paddingTop: 10, fontSize: 10, color: '#94a3b8' }}>
                Protected by <strong style={{ color: '#64748b' }}>ClassGuard</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}

const TABS = ['Branding', 'DNS & Retention', 'Monitoring', 'About'];

export default function SettingsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('Branding');

  const { data: dnsSettings = {}, isLoading: dnsLoading } = useQuery({
    queryKey: ['dns-settings'],
    queryFn:  () => api.get('/dns/settings'),
  });

  const { data: appSettings = {}, isLoading: appLoading } = useQuery({
    queryKey: ['app-settings'],
    queryFn:  () => api.get('/settings').catch(() => ({})),
  });

  const { data: dnsZones = [] } = useQuery({
    queryKey: ['dns-zones'],
    queryFn:  () => api.get('/dns/zones'),
  });

  const [dns, setDns]     = useState({});
  const [zabbixToken,  setZabbixToken]  = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    if (appSettings && Object.keys(appSettings).length) {
      setZabbixToken(appSettings.zabbix_metrics_token || '');
    }
  }, [appSettings]);

  useEffect(() => {
    if (dnsSettings && Object.keys(dnsSettings).length) {
      setDns({
        upstream_primary:   dnsSettings.upstream_primary   || '8.8.8.8',
        upstream_secondary: dnsSettings.upstream_secondary || '8.8.4.4',
        upstream_ipv6:      dnsSettings.upstream_ipv6      || '',
        block_page_ip:      dnsSettings.block_page_ip      || '',
        block_page_ipv6:    dnsSettings.block_page_ipv6    || '',
        cache_ttl:          dnsSettings.cache_ttl          || '300',
        dhcp_auto_register:         dnsSettings.dhcp_auto_register         || 'false',
        dhcp_auto_register_zone_id: dnsSettings.dhcp_auto_register_zone_id || '',
      });
    }
  }, [dnsSettings]);

  const saveDns = useMutation({
    mutationFn: () => api.put('/dns/settings', dns),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['dns-settings'] });
      setSaved('dns');
      setTimeout(() => setSaved(''), 2000);
    },
  });

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
        <p className="text-slate-500 text-sm mt-0.5">System-wide configuration</p>
      </div>

      <div className="flex gap-1 border-b border-slate-200 mb-5">
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors
              ${tab === t
                ? 'bg-white border border-b-white border-slate-200 text-primary-700 -mb-px'
                : 'text-slate-500 hover:text-slate-700'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Branding' && (
        <BlockPageBrandingSection appSettings={appSettings} appLoading={appLoading} saved={saved} setSaved={setSaved} />
      )}

      {tab === 'DNS & Retention' && (
      <>
      {/* DNS Settings */}
      <Section title="DNS Engine">
        {dnsLoading ? (
          <div className="text-slate-400 text-sm">Loading…</div>
        ) : (
          <>
            <Field label="Primary Upstream DNS" hint="Default: 8.8.8.8 (Google)">
              <input
                className="input font-mono text-sm"
                value={dns.upstream_primary || ''}
                onChange={e => setDns(d => ({ ...d, upstream_primary: e.target.value }))}
              />
            </Field>
            <Field label="Secondary Upstream DNS" hint="Fallback resolver">
              <input
                className="input font-mono text-sm"
                value={dns.upstream_secondary || ''}
                onChange={e => setDns(d => ({ ...d, upstream_secondary: e.target.value }))}
              />
            </Field>
            <Field label="Upstream IPv6 (optional)" hint="Leave blank unless you specifically want AAAA queries sent to a different resolver than the ones above. Most public resolvers (Google, Cloudflare, Quad9, etc.) already answer AAAA fine over plain IPv4 transport — a resolver's address is just how you reach it, not which record types it can answer — but if yours doesn't, set one here that does.">
              <input
                className="input font-mono text-sm"
                placeholder="e.g. 2606:4700:4700::1111"
                value={dns.upstream_ipv6 || ''}
                onChange={e => setDns(d => ({ ...d, upstream_ipv6: e.target.value }))}
              />
            </Field>
            <Field label="Block Page IP" hint="IP to redirect blocked A queries to">
              <input
                className="input font-mono text-sm"
                placeholder="e.g. 192.168.1.100"
                value={dns.block_page_ip || ''}
                onChange={e => setDns(d => ({ ...d, block_page_ip: e.target.value }))}
              />
            </Field>
            <Field label="Block Page IPv6 (optional)" hint="IP to redirect blocked AAAA queries to — leave blank to return NXDOMAIN for blocked AAAA instead (clients fall back to the A block page either way)">
              <input
                className="input font-mono text-sm"
                placeholder="e.g. fd00::1"
                value={dns.block_page_ipv6 || ''}
                onChange={e => setDns(d => ({ ...d, block_page_ipv6: e.target.value }))}
              />
            </Field>
            <Field label="DNS Cache TTL" hint="Seconds to cache upstream responses">
              <input
                type="number"
                className="input text-sm"
                value={dns.cache_ttl || ''}
                onChange={e => setDns(d => ({ ...d, cache_ttl: e.target.value }))}
              />
            </Field>
            <div className="flex items-center gap-3 pt-4">
              <button
                className="btn-primary"
                onClick={() => saveDns.mutate()}
                disabled={saveDns.isPending}
              >
                {saveDns.isPending ? 'Saving…' : 'Save DNS Settings'}
              </button>
              {saved === 'dns' && <span className="text-green-600 text-sm font-medium">Saved!</span>}
            </div>
          </>
        )}
      </Section>

      {/* DHCP-lease DNS auto-registration */}
      <Section title="DHCP → DNS Auto-Registration">
        <p className="text-xs text-slate-500 mb-3">
          When a device gets a DHCP lease with a hostname, automatically create/update an A record for it
          in the zone below — the same thing Windows AD-integrated DNS does on lease, without needing
          Active Directory. Checked every 5 minutes; records this creates are cleaned up automatically once
          a lease expires or changes IP. Records you create by hand are never touched by this.
        </p>
        <Field label="Enable auto-registration">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={dns.dhcp_auto_register === 'true'}
              onChange={e => setDns(d => ({ ...d, dhcp_auto_register: e.target.checked ? 'true' : 'false' }))}
            />
            <span className="text-sm text-slate-600">Enabled</span>
          </label>
        </Field>
        <Field label="Target zone" hint="which zone auto-registered hostnames go into">
          <select
            className="input text-sm"
            value={dns.dhcp_auto_register_zone_id || ''}
            onChange={e => setDns(d => ({ ...d, dhcp_auto_register_zone_id: e.target.value }))}
          >
            <option value="">Select a zone…</option>
            {dnsZones.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </Field>
        <div className="flex items-center gap-3 pt-4">
          <button
            className="btn-primary"
            onClick={() => saveDns.mutate()}
            disabled={saveDns.isPending}
          >
            {saveDns.isPending ? 'Saving…' : 'Save DNS Settings'}
          </button>
          {saved === 'dns' && <span className="text-green-600 text-sm font-medium">Saved!</span>}
        </div>
      </Section>

      {/* Log retention */}
      <Section title="Data Retention">
        <Field label="DNS Log Retention" hint="Managed by TimescaleDB retention policy (set in migration 003)">
          <div className="input bg-slate-50 text-slate-500 cursor-not-allowed select-none text-sm">
            90 days (configured in DB)
          </div>
        </Field>
        <Field label="Log Chunk Interval" hint="TimescaleDB hypertable chunk size">
          <div className="input bg-slate-50 text-slate-500 cursor-not-allowed select-none text-sm">
            1 day
          </div>
        </Field>
        <Field label="Log Compression Threshold" hint="Chunks older than this are compressed">
          <div className="input bg-slate-50 text-slate-500 cursor-not-allowed select-none text-sm">
            2 days
          </div>
        </Field>
        <p className="text-xs text-slate-400 mt-3">
          To change retention, update the TimescaleDB policy via psql:
          <code className="ml-1 bg-slate-100 px-1.5 py-0.5 rounded font-mono text-xs">
            SELECT alter_data_retention_policy('dns_logs', INTERVAL '90 days');
          </code>
        </p>
      </Section>
      </>
      )}

      {tab === 'Monitoring' && (
      <>
      {/* Zabbix monitoring */}
      <Section title="Zabbix Monitoring">
        <p className="text-sm text-slate-600 mb-4">
          ClassGuard exposes a <code className="bg-slate-100 px-1 rounded font-mono text-xs">/metrics</code> endpoint
          that Zabbix polls via HTTP agent items. Add a metrics token to secure the endpoint,
          then download the host template to auto-create all Zabbix items.
        </p>
        <Field label="Metrics Token (X-Metrics-Token header)" hint="Leave blank to allow unauthenticated requests from localhost only">
          <input
            type="password"
            className="input"
            value={zabbixToken}
            onChange={e => setZabbixToken(e.target.value)}
            placeholder="Set a secret token for Zabbix to use"
          />
        </Field>
        <div className="mt-3 bg-slate-50 rounded-lg p-3 text-xs font-mono text-slate-600 space-y-1">
          <div><span className="text-slate-400">Endpoint URL:</span> {window.location.origin.replace(':5173','').replace(':5174','') || window.location.origin}:3001/metrics</div>
          <div><span className="text-slate-400">Zabbix item type:</span> HTTP agent</div>
          <div><span className="text-slate-400">Header:</span> X-Metrics-Token: &lt;your token&gt;</div>
          <div><span className="text-slate-400">Output format:</span> JSON</div>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button
            className="btn-primary"
            onClick={() => api.put('/settings', { zabbix_metrics_token: zabbixToken }).then(() => { setSaved('zabbix'); setTimeout(()=>setSaved(''),2000); })}
          >
            Save
          </button>
          <a
            href={`/metrics/zabbix-template?token=${zabbixToken}`}
            className="btn-secondary text-sm"
            target="_blank" rel="noreferrer"
          >
            Download Zabbix Template XML
          </a>
          {saved === 'zabbix' && <span className="text-green-600 text-sm font-medium">Saved!</span>}
        </div>
      </Section>
      </>
      )}

      {tab === 'About' && (
      <>
      {/* About */}
      <Section title="About">
        <Field label="Version" hint="ClassGuard open-source release">
          <div className="text-sm font-mono text-slate-700">{appSettings.version || '0.0.1'}</div>
        </Field>
        <Field label="License">
          <div className="text-sm text-slate-700">AGPLv3</div>
        </Field>
        <Field label="GitHub">
          <div className="text-sm font-mono text-primary-600">manderson20/classguard</div>
        </Field>
        <Field label="Support">
          <div className="text-sm text-slate-500">Open an issue on GitHub</div>
        </Field>
      </Section>
      </>
      )}
    </div>
  );
}
