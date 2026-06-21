import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const INPUT = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';
const MONO  = 'font-mono text-xs';

function ListEditor({ label, hint, values, onChange, placeholder }) {
  const [text, setText] = useState((values || []).join(', '));
  return (
    <div>
      <label className="text-xs font-medium text-slate-600 block mb-1">{label}</label>
      {hint && <p className="text-xs text-slate-400 mb-1">{hint}</p>}
      <input
        className={INPUT}
        value={text}
        placeholder={placeholder}
        onChange={e => setText(e.target.value)}
        onBlur={() => onChange(text.split(',').map(s => s.trim()).filter(Boolean))}
      />
    </div>
  );
}

function CopyField({ label, value }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-slate-100 last:border-b-0">
      <div className="min-w-0">
        <div className="text-xs text-slate-500">{label}</div>
        <div className={`${MONO} text-slate-800 truncate`}>{value || '—'}</div>
      </div>
      <button
        className="btn-secondary text-xs flex-shrink-0"
        onClick={() => { navigator.clipboard.writeText(value || ''); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        disabled={!value}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// Exactly what to paste into Mosyle's VPN payload screen — Mosyle's own API
// has no way to push this profile (confirmed against its actual API spec),
// so this does as much of the work as possible short of that.
function MosyleProfilePanel() {
  const { data: vrrp } = useQuery({ queryKey: ['ha-vrrp'], queryFn: () => api.get('/ha/vrrp') });
  const server = vrrp?.vip_address || '(configure a VRRP VIP on the HA Cluster page first)';

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm mb-4">
      <h3 className="font-semibold text-slate-900 mb-1">Mosyle VPN Profile Values</h3>
      <p className="text-xs text-slate-500 mb-4">
        Mosyle's API has no endpoint to push a VPN profile — paste these values into
        Management → Profiles → VPN in Mosyle's own console.
      </p>
      <CopyField label="Connection Type" value="IKEv2" />
      <CopyField label="Server" value={server} />
      <CopyField label="Machine Authentication" value="Certificate" />
      <CopyField label="Identity Certificate" value="The cert issued via the SCEP profile below" />
    </div>
  );
}

// Mosyle's SCEP profile doesn't hand out a certificate — it's Apple's
// standard SCEP payload, just a pointer at a SCEP server plus a static
// challenge (confirmed from Mosyle's own profile screen). This panel is
// what makes that pointer resolve to ClassGuard's own CA below.
function ScepProfilePanel({ cfg }) {
  const url = `${window.location.origin}/scep/`;
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm mb-4">
      <h3 className="font-semibold text-slate-900 mb-1">Mosyle SCEP Profile Values</h3>
      <p className="text-xs text-slate-500 mb-4">
        Management → Profiles → SCEP in Mosyle. Create this <strong>before</strong> the VPN
        profile above — the VPN profile's Identity Certificate picker references this one.
      </p>
      <CopyField label="URL" value={url} />
      <CopyField label="Subject" value="CN=%Email%" />
      <CopyField label="Challenge" value={cfg.scep_challenge} />
      <CopyField label="Key Size (in bits)" value="2048 (Mosyle's own default of 1024 is weak — change it)" />
      <p className="text-xs text-slate-400 mt-3">
        Setting Subject to <span className={MONO}>CN=%Email%</span> means every issued cert's
        identity is the staff member's actual email, using Mosyle's own variable substitution —
        that's what shows up in the Sessions table below instead of an opaque device serial.
      </p>
    </div>
  );
}

function CaSection({ cfg }) {
  const qc = useQueryClient();
  const generate = useMutation({
    mutationFn: () => api.post('/vpn/generate-ca'),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['vpn-config'] }),
  });

  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([cfg.ca_cert_pem], { type: 'application/x-pem-file' }));
    a.download = 'classguard-vpn-ca.pem';
    a.click();
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm mb-4">
      <h3 className="font-semibold text-slate-900 mb-3">Certificate Authority</h3>
      {!cfg.ca_cert_pem ? (
        <div>
          <p className="text-xs text-slate-500 mb-3">
            ClassGuard generates and owns this CA itself — Mosyle never had one to export
            (its SCEP profile only points devices at a SCEP server; see the panel below).
            The SCEP server issues client certs from this CA, and the VPN server trusts it directly.
          </p>
          <button onClick={() => generate.mutate()} disabled={generate.isPending} className="btn-primary text-sm">
            {generate.isPending ? 'Generating…' : 'Generate CA'}
          </button>
        </div>
      ) : (
        <div>
          <div className="grid md:grid-cols-2 gap-4 text-sm mb-3">
            <div>
              <div className="text-xs text-slate-500">Expires</div>
              <div className="text-slate-800">{cfg.ca_info ? new Date(cfg.ca_info.notAfter).toLocaleDateString() : '—'}</div>
            </div>
            <div className="min-w-0">
              <div className="text-xs text-slate-500">Fingerprint (SHA-256)</div>
              <div className={`${MONO} text-slate-800 truncate`}>{cfg.ca_info?.fingerprint || '—'}</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={download} className="btn-secondary text-sm">Download CA Certificate</button>
            <button
              onClick={() => { if (confirm('Rotating invalidates every certificate already issued to staff devices. Continue?')) generate.mutate(); }}
              disabled={generate.isPending}
              className="btn-secondary text-sm text-red-600"
            >
              {generate.isPending ? 'Rotating…' : 'Rotate CA'}
            </button>
          </div>
          <p className="text-xs text-slate-400 mt-2">
            Download this and feed it into Mosyle's SCEP profile "Create from Certificate…" button
            (Fingerprint field) so devices can verify they're talking to the right server.
          </p>
        </div>
      )}
    </div>
  );
}

export default function VpnPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState(null);

  const { data: cfgData = {} } = useQuery({
    queryKey: ['vpn-config'],
    queryFn:  () => api.get('/vpn/config'),
  });

  const { data: sessions = [], isFetching } = useQuery({
    queryKey: ['vpn-sessions'],
    queryFn:  () => api.get('/vpn/sessions'),
    refetchInterval: 30_000,
  });

  const save = useMutation({
    mutationFn: () => api.put('/vpn/config', form || cfgData),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['vpn-config'] }); setForm(null); },
  });

  const cfg = form || cfgData;
  const set = (k, v) => setForm(p => ({ ...(p || cfgData), [k]: v }));

  const active = sessions.filter(s => !s.disconnected_at);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">VPN — Staff Remote Access</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Self-hosted IKEv2 over the VRRP floating IP. Apple's built-in VPN client connects directly —
          no app to install on staff Macs/iPads, just the MDM profiles below. Authentication trusts
          ClassGuard's own CA, issued to devices via a self-hosted SCEP server when Mosyle enrolls them —
          Mosyle itself never holds a certificate; its SCEP profile is just a pointer at that server.
          This is a traditional perimeter VPN, not ZTNA — a connected client is a network member, subject
          only to the optional subnet restriction below.
        </p>
      </div>

      <CaSection cfg={cfg} />
      <ScepProfilePanel cfg={cfg} />
      <MosyleProfilePanel />

      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm mb-4">
        <h3 className="font-semibold text-slate-900 mb-3">Configuration</h3>

        <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer mb-3">
          <input type="checkbox" className="w-4 h-4 rounded"
            checked={cfg.enabled === true}
            onChange={e => set('enabled', e.target.checked)} />
          Enable VPN server
        </label>

        <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer mb-4">
          <input type="checkbox" className="w-4 h-4 rounded"
            checked={cfg.scep_enabled === true}
            disabled={!cfg.ca_cert_pem}
            onChange={e => set('scep_enabled', e.target.checked)} />
          Enable SCEP server {!cfg.ca_cert_pem && <span className="text-xs text-slate-400">(generate a CA first)</span>}
        </label>

        <div className="grid md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-xs font-medium text-slate-600 block mb-1">Client IP pool (CIDR)</label>
            <p className="text-xs text-slate-400 mb-1">Carved out for VPN clients only — not served by Kea/DHCP.</p>
            <input className={INPUT} value={cfg.client_subnet || ''} placeholder="10.99.99.0/24"
              onChange={e => set('client_subnet', e.target.value)} />
          </div>
          <ListEditor
            label="DNS servers pushed to clients"
            hint="comma-separated — usually ClassGuard's own DNS engine address"
            values={cfg.dns_servers}
            placeholder="172.16.1.250"
            onChange={v => set('dns_servers', v)}
          />
        </div>

        <ListEditor
          label="Restrict access to subnets (optional)"
          hint="comma-separated CIDRs — leave empty for full network access. Set this to limit a connected client to specific internal subnets instead of the whole LAN, without building a full per-resource ZTNA layer."
          values={cfg.restrict_to_subnets}
          placeholder="172.16.1.0/24, 10.0.5.0/24"
          onChange={v => set('restrict_to_subnets', v)}
        />

        <div className="flex justify-end mt-4">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
            {save.isPending ? 'Saving…' : 'Save VPN Config'}
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900">Sessions</h3>
          <span className="text-xs text-slate-400">{isFetching ? 'Refreshing…' : `${active.length} active`}</span>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>
              {['Identity', 'IP', 'Status', 'Connected', 'Bytes In/Out'].map(h => (
                <th key={h} className="px-4 py-2 text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sessions.map(s => (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className={`px-4 py-3 ${MONO} text-slate-800`}>{s.cert_cn}</td>
                <td className={`px-4 py-3 ${MONO} text-slate-600`}>{s.assigned_ip || '—'} <span className="text-slate-400">({s.real_ip || '—'})</span></td>
                <td className="px-4 py-3">
                  {!s.disconnected_at
                    ? <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">Connected</span>
                    : <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-500">Disconnected</span>}
                </td>
                <td className="px-4 py-3 text-xs text-slate-400">{new Date(s.connected_at).toLocaleString()}</td>
                <td className={`px-4 py-3 ${MONO} text-slate-600`}>{s.bytes_in} / {s.bytes_out}</td>
              </tr>
            ))}
            {!sessions.length && (
              <tr><td colSpan={5} className="text-center text-slate-400 py-8 text-sm">No sessions yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
