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

function ExtensionDeploySection({ googleClientId }) {
  const [copied, setCopied] = useState('');
  const serverUrl = window.location.origin;

  const policy = JSON.stringify({
    serverUrl,
    googleClientId: googleClientId || '<paste-client-id-above>',
  }, null, 2);

  const copy = (key, text) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(''), 2000);
  };

  return (
    <Section title="Chrome Extension — Google Admin Deployment">
      <p className="text-xs text-slate-500 mb-4">
        ClassGuard uses a single generic extension that self-configures per school via Google Admin Console
        managed storage — no custom build required. Follow these steps to deploy it.
      </p>

      <div className="space-y-5">
        {/* Step 1 */}
        <div>
          <div className="text-sm font-semibold text-slate-700 mb-1">Step 1 — Publish or sideload the extension</div>
          <p className="text-xs text-slate-500">
            Either upload the built <code className="bg-slate-100 px-1 rounded font-mono">dist/</code> folder to the Chrome Web Store
            as an unlisted extension, or use Google Admin → Devices → Chrome → Apps &amp; Extensions → Force-install from CRX.
            Copy the extension ID once it's installed.
          </p>
        </div>

        {/* Step 2 */}
        <div>
          <div className="text-sm font-semibold text-slate-700 mb-2">Step 2 — Deploy this policy via Google Admin Console</div>
          <p className="text-xs text-slate-500 mb-2">
            Google Admin → Devices → Chrome → Apps &amp; Extensions → select your extension → Policy for extensions (JSON) → paste below.
          </p>
          <div className="relative">
            <pre className="bg-slate-800 text-green-300 text-xs rounded p-3 overflow-auto leading-5">{policy}</pre>
            <button
              onClick={() => copy('policy', policy)}
              className="absolute top-2 right-2 text-xs bg-slate-600 hover:bg-slate-500 text-white px-2 py-1 rounded"
            >
              {copied === 'policy' ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            <strong>serverUrl</strong> is pre-filled with this server's origin.{' '}
            <strong>googleClientId</strong> comes from the Google Workspace Login section above — save that first.
          </p>
        </div>

        {/* Step 3 */}
        <div>
          <div className="text-sm font-semibold text-slate-700 mb-1">Step 3 — Force-install the extension</div>
          <p className="text-xs text-slate-500">
            In the same Apps &amp; Extensions screen, set the install policy to <strong>Force install</strong> for your student OUs.
            The extension will auto-configure itself on next device sync (usually within 15 minutes).
          </p>
        </div>

        {/* What managed storage replaces */}
        <div className="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-700">
          <strong>How it works:</strong> The extension reads <code className="font-mono">chrome.storage.managed</code> at runtime to
          discover the ClassGuard server URL. This means one extension package works for every school district —
          each school's admin sets their own server URL via the Google Admin policy, exactly like GoGuardian's deployment model.
        </div>
      </div>
    </Section>
  );
}

export default function SettingsPage() {
  const qc = useQueryClient();

  const { data: dnsSettings = {}, isLoading: dnsLoading } = useQuery({
    queryKey: ['dns-settings'],
    queryFn:  () => api.get('/dns/settings'),
  });

  const { data: appSettings = {}, isLoading: appLoading } = useQuery({
    queryKey: ['app-settings'],
    queryFn:  () => api.get('/settings').catch(() => ({})),
  });

  const [dns, setDns]     = useState({});
  const [google, setGoogle] = useState({
    google_client_id: '', google_client_secret: '', google_redirect_uri: '', google_workspace_domain: '',
  });
  const [zabbixToken,  setZabbixToken]  = useState('');
  const [youtubeApiKey, setYoutubeApiKey] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    if (appSettings && Object.keys(appSettings).length) {
      setGoogle(g => ({
        google_client_id:        appSettings.google_client_id        || '',
        google_client_secret:    appSettings.google_client_secret    || '',
        google_redirect_uri:     appSettings.google_redirect_uri     || '',
        google_workspace_domain: appSettings.google_workspace_domain || '',
      }));
      setZabbixToken(appSettings.zabbix_metrics_token || '');
      setYoutubeApiKey(appSettings.youtube_api_key    || '');
    }
  }, [appSettings]);

  const saveGoogle = useMutation({
    mutationFn: () => api.put('/settings', google),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['app-settings'] });
      setSaved('google');
      setTimeout(() => setSaved(''), 2500);
    },
  });

  useEffect(() => {
    if (dnsSettings && Object.keys(dnsSettings).length) {
      setDns({
        upstream_primary:   dnsSettings.upstream_primary   || '8.8.8.8',
        upstream_secondary: dnsSettings.upstream_secondary || '8.8.4.4',
        block_page_ip:      dnsSettings.block_page_ip      || '',
        cache_ttl:          dnsSettings.cache_ttl          || '300',
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

      {/* Google OAuth */}
      <Section title="Google Workspace Login">
        <p className="text-xs text-slate-500 mb-4">
          Configure Google OAuth to let teachers and students sign in with their school Google accounts.
          <br />
          <strong>Setup steps:</strong>{' '}
          <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer"
            className="text-primary-600 underline">Google Cloud Console</a>
          {' '}→ APIs &amp; Services → Credentials → Create OAuth 2.0 Client ID (Web application).
          Add <code className="bg-slate-100 px-1 rounded font-mono text-xs">{window.location.origin}/auth/callback</code> as
          an Authorized redirect URI.
        </p>
        {appLoading ? <div className="text-slate-400 text-sm">Loading…</div> : (
          <>
            <Field label="Google Client ID" hint="Paste from Google Cloud Console">
              <input
                className="input text-sm font-mono"
                value={google.google_client_id}
                onChange={e => setGoogle(g => ({ ...g, google_client_id: e.target.value }))}
                placeholder="123456789-xxx.apps.googleusercontent.com"
              />
            </Field>
            <Field label="Google Client Secret" hint="Keep this secret">
              <input
                type="password"
                className="input text-sm font-mono"
                value={google.google_client_secret}
                onChange={e => setGoogle(g => ({ ...g, google_client_secret: e.target.value }))}
                placeholder="GOCSPX-…"
              />
            </Field>
            <Field label="Authorized Redirect URI" hint="Must match what you entered in Google Cloud Console">
              <input
                className="input text-sm font-mono"
                value={google.google_redirect_uri}
                onChange={e => setGoogle(g => ({ ...g, google_redirect_uri: e.target.value }))}
                placeholder={`${window.location.origin}/auth/callback`}
              />
            </Field>
            <Field label="Workspace Domain" hint="Restrict login to this domain (e.g. school.org). Leave blank to allow any Google account.">
              <input
                className="input text-sm font-mono"
                value={google.google_workspace_domain}
                onChange={e => setGoogle(g => ({ ...g, google_workspace_domain: e.target.value }))}
                placeholder="school.org"
              />
            </Field>
            <div className="flex items-center gap-3 pt-4">
              <button
                className="btn-primary"
                onClick={() => saveGoogle.mutate()}
                disabled={saveGoogle.isPending}
              >
                {saveGoogle.isPending ? 'Saving…' : 'Save Google Settings'}
              </button>
              {saved === 'google' && <span className="text-green-600 text-sm font-medium">Saved!</span>}
            </div>
          </>
        )}
      </Section>

      {/* YouTube Data API */}
      <Section title="YouTube Data API">
        <p className="text-xs text-slate-500 mb-4">
          Required for per-category and per-video YouTube filtering in policy rules.
          The API key is stored server-side and never sent to student devices.
          Video category lookups are cached 24 hours in Redis — 10,000 free quota units/day
          covers a large school with heavy YouTube use.
        </p>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700 mb-4">
          <strong>Setup:</strong>{' '}
          <a href="https://console.cloud.google.com" target="_blank" rel="noreferrer"
            className="underline">Google Cloud Console</a>
          {' '}→ APIs &amp; Services → Library → search <em>YouTube Data API v3</em> → Enable →
          Credentials → Create API Key. Restrict the key to YouTube Data API v3 only.
        </div>
        {appLoading ? <div className="text-slate-400 text-sm">Loading…</div> : (
          <>
            <Field label="YouTube Data API Key" hint="Restricted to YouTube Data API v3 — never exposed to students">
              <input
                type="password"
                className="input text-sm font-mono"
                value={youtubeApiKey}
                onChange={e => setYoutubeApiKey(e.target.value)}
                placeholder="AIzaSy…"
              />
            </Field>
            <div className="flex items-center gap-3 pt-4">
              <button
                className="btn-primary"
                onClick={() => {
                  api.put('/settings', { youtube_api_key: youtubeApiKey }).then(() => {
                    setSaved('youtube');
                    setTimeout(() => setSaved(''), 2500);
                  });
                }}
              >
                Save API Key
              </button>
              {saved === 'youtube' && <span className="text-green-600 text-sm font-medium">Saved!</span>}
            </div>
          </>
        )}
      </Section>

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
            <Field label="Block Page IP" hint="IP to redirect blocked A queries to">
              <input
                className="input font-mono text-sm"
                placeholder="e.g. 192.168.1.100"
                value={dns.block_page_ip || ''}
                onChange={e => setDns(d => ({ ...d, block_page_ip: e.target.value }))}
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

      {/* Chrome Extension Deployment */}
      <ExtensionDeploySection googleClientId={google.google_client_id} />

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
    </div>
  );
}
