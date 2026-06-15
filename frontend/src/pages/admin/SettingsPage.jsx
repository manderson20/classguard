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

  const [dns, setDns] = useState({});
  const [saved, setSaved] = useState('');

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
