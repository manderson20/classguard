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

function downloadText(filename, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  a.download = filename;
  a.click();
}

// macOS/iOS via Mosyle — the only platform actually in use here, so this is
// the one with a real walkthrough rather than just a values reference.
// ClassGuard can't push either profile itself (confirmed against Mosyle's
// actual API spec — no profile/payload endpoint exists at all), so this
// does as much of the work as possible short of that: every value an admin
// needs, in the order they're needed.
function MosylePanel({ cfg }) {
  const { data: vrrp } = useQuery({ queryKey: ['ha-vrrp'], queryFn: () => api.get('/ha/vrrp') });
  const server = vrrp?.vip_address || '(configure a VRRP VIP on the HA Cluster page first)';
  const scepUrl = `${window.location.origin}/scep/`;

  return (
    <div>
      <h4 className="font-semibold text-slate-800 text-sm mb-2">1. Create the SCEP profile first</h4>
      <p className="text-xs text-slate-500 mb-2">Mosyle: Management → Profiles → SCEP → Add New Profile.</p>
      <div className="bg-slate-50 rounded-lg p-3 mb-3">
        <CopyField label="URL" value={scepUrl} />
        <CopyField label="Subject" value="CN=%Email%" />
        <CopyField label="Challenge" value={cfg.scep_challenge} />
        <CopyField label="Key Size (in bits)" value="2048 — Mosyle's own default of 1024 is weak, change it" />
      </div>
      <p className="text-xs text-slate-400 mb-4">
        Subject = <span className={MONO}>CN=%Email%</span> (Mosyle's own variable substitution) means every
        issued cert's identity is the staff member's actual email — that's what shows up in the Sessions
        table below instead of an opaque device serial. Assign this profile to specific users (1:1), not
        just devices, or <span className={MONO}>%Email%</span> has nothing to resolve to.
      </p>

      <h4 className="font-semibold text-slate-800 text-sm mb-2">2. Feed it ClassGuard's CA</h4>
      <p className="text-xs text-slate-500 mb-4">
        Download the CA certificate from the section above, then back in that same SCEP profile, use the
        "Create from Certificate…" button next to Fingerprint and upload it.
      </p>

      <h4 className="font-semibold text-slate-800 text-sm mb-2">3. Create the VPN profile</h4>
      <p className="text-xs text-slate-500 mb-2">Management → Profiles → VPN → Add New Profile.</p>
      <div className="bg-slate-50 rounded-lg p-3 mb-3">
        <CopyField label="Connection Type" value="IKEv2" />
        <CopyField label="Server" value={server} />
        <CopyField label="Machine Authentication" value="Certificate" />
        <CopyField label="Identity Certificate" value="Choose authentication certificate → the SCEP profile from step 1" />
      </div>

      <h4 className="font-semibold text-slate-800 text-sm mb-2">4. Assign both profiles to one test device first</h4>
      <p className="text-xs text-slate-500">
        Confirm it actually enrolls and connects (Sessions table below) before assigning more broadly.
      </p>
    </div>
  );
}

// ChromeOS — genuinely more involved than the Mac flow, not just a
// different console: a Chromebook doesn't talk to an arbitrary SCEP URL
// directly. Worth saying plainly rather than presenting this as equivalent
// effort to the Mosyle path.
function ChromeOsPanel({ cfg }) {
  const { data: vrrp } = useQuery({ queryKey: ['ha-vrrp'], queryFn: () => api.get('/ha/vrrp') });
  const server = vrrp?.vip_address || '(configure a VRRP VIP on the HA Cluster page first)';
  const scepUrl = `${window.location.origin}/scep/`;

  return (
    <div>
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 text-xs text-amber-800">
        Chromebooks don't enroll against a SCEP URL directly the way Macs/iPads do. Google requires
        installing its own <strong>Cloud Certificate Connector</strong> — a small Windows service, running
        somewhere on your network — that bridges Google's cloud to this SCEP server. Google is also
        migrating ChromeOS certificate provisioning to a newer Certificate Provisioning API through 2026,
        so verify the exact console steps against Google's current docs when you set this up.
      </div>

      <h4 className="font-semibold text-slate-800 text-sm mb-2">1. Install the Cloud Certificate Connector</h4>
      <p className="text-xs text-slate-500 mb-4">
        On a Windows host that can stay running and reach this SCEP server. Configure it with the SCEP
        values below (Google Admin console → Devices → Networks → Certificates).
      </p>
      <div className="bg-slate-50 rounded-lg p-3 mb-4">
        <CopyField label="SCEP URL" value={scepUrl} />
        <CopyField label="Challenge" value={cfg.scep_challenge} />
      </div>

      <h4 className="font-semibold text-slate-800 text-sm mb-2">2. Add the VPN network</h4>
      <p className="text-xs text-slate-500 mb-2">Google Admin console → Devices → Networks → add a Network → VPN.</p>
      <div className="bg-slate-50 rounded-lg p-3 mb-3">
        <CopyField label="Connection Type" value="IKEv2" />
        <CopyField label="Server" value={server} />
        <CopyField label="Authentication" value="User/Server certificate (reference the cert provisioned in step 1)" />
      </div>

      <h4 className="font-semibold text-slate-800 text-sm mb-2">3. Apply to an OU with one test device first</h4>
      <p className="text-xs text-slate-500">Confirm enrollment and connection before applying org-wide.</p>
    </div>
  );
}

// Windows — two real paths depending on whether the district has any MDM
// for staff Windows laptops at all, which varies a lot more district to
// district than it does for Mac/iPad.
function WindowsPanel({ cfg }) {
  const { data: vrrp } = useQuery({ queryKey: ['ha-vrrp'], queryFn: () => api.get('/ha/vrrp') });
  const server = vrrp?.vip_address || '(configure a VRRP VIP on the HA Cluster page first)';
  const scepUrl = `${window.location.origin}/scep/`;
  const [mode, setMode] = useState('intune');

  const script = `# ClassGuard VPN setup — no MDM required. Run as Administrator.
# Downloads nothing itself — get scepclient.exe first from the SAME
# open-source project this server is built from (same supply-chain
# reasoning as ClassGuard's own server-side build):
#   https://github.com/micromdm/scep/releases/download/v2.3.0/scepclient-windows-amd64-v2.3.0.zip
# Extract scepclient.exe into this same folder before running this script.
# Also download the CA certificate from this VPN page first and save it
# next to this script as classguard-ca.pem.

$ServerUrl  = "${scepUrl}"
$Challenge  = "${cfg.scep_challenge || '<paste the Challenge value from above>'}"
$CaFingerprint = "${cfg.ca_info?.fingerprint || '<paste the CA fingerprint shown above>'}"
$VpnServer  = "${server}"
$Cn         = "$env:USERNAME@$env:USERDNSDOMAIN"   # identity for this device's cert

# 1. Enroll for a certificate against ClassGuard's SCEP server
.\\scepclient.exe -server-url $ServerUrl -challenge $Challenge -ca-fingerprint $CaFingerprint \`
  -cn $Cn -private-key .\\classguard-vpn.key -certificate .\\classguard-vpn.pem

# 2. Trust ClassGuard's CA, then import the issued cert
Import-Certificate -FilePath .\\classguard-ca.pem -CertStoreLocation Cert:\\LocalMachine\\Root
certutil -importPFX -p "" .\\classguard-vpn.pem  # adjust if scepclient wrote a PFX instead of separate cert/key

# 3. Create the VPN connection
Add-VpnConnection -Name "ClassGuard" -ServerAddress $VpnServer -TunnelType Ikev2 \`
  -AuthenticationMethod MachineCertificate -RememberCredential -Force

Write-Host "Done. Connect via Settings -> Network & internet -> VPN -> ClassGuard."
`;

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => setMode('intune')} className={`text-xs px-3 py-1.5 rounded-full font-medium ${mode === 'intune' ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-600'}`}>Has Intune (or similar MDM)</button>
        <button onClick={() => setMode('manual')} className={`text-xs px-3 py-1.5 rounded-full font-medium ${mode === 'manual' ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-600'}`}>No MDM</button>
      </div>

      {mode === 'intune' ? (
        <div>
          <h4 className="font-semibold text-slate-800 text-sm mb-2">1. SCEP certificate profile</h4>
          <p className="text-xs text-slate-500 mb-2">Intune: Devices → Configuration → Create → SCEP certificate profile.</p>
          <div className="bg-slate-50 rounded-lg p-3 mb-4">
            <CopyField label="SCEP Server URL" value={scepUrl} />
            <CopyField label="Subject name format" value="CN={{UserPrincipalName}}" />
            <CopyField label="Challenge" value={cfg.scep_challenge} />
            <CopyField label="Key size" value="2048" />
          </div>
          <h4 className="font-semibold text-slate-800 text-sm mb-2">2. VPN profile</h4>
          <p className="text-xs text-slate-500 mb-2">Devices → Configuration → Create → VPN, Windows 10 and later.</p>
          <div className="bg-slate-50 rounded-lg p-3 mb-3">
            <CopyField label="Connection type" value="IKEv2" />
            <CopyField label="Server address" value={server} />
            <CopyField label="Authentication method" value="Machine certificates — select the SCEP profile from step 1" />
          </div>
          <p className="text-xs text-slate-500">Assign both to one test device's group before wider rollout.</p>
        </div>
      ) : (
        <div>
          <p className="text-xs text-slate-500 mb-3">
            For districts without device management on staff Windows laptops — a script using
            scepclient, the same project ClassGuard's SCEP server is built from, rather than anything
            requiring a management policy server.
          </p>
          <button onClick={() => downloadText('classguard-vpn-setup.ps1', script)} className="btn-secondary text-sm mb-3">
            Download Setup Script
          </button>
          <p className="text-xs text-slate-400">
            Review it before running — it needs scepclient.exe (linked in the script's own comments) and
            the CA certificate downloaded from the section above, both placed next to the script first.
          </p>
        </div>
      )}
    </div>
  );
}

function DeploymentInstructions({ cfg }) {
  const [platform, setPlatform] = useState('mac');
  const TABS = [
    { id: 'mac', label: 'macOS / iOS (Mosyle)' },
    { id: 'chromeos', label: 'ChromeOS' },
    { id: 'windows', label: 'Windows' },
  ];
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm mb-4">
      <h3 className="font-semibold text-slate-900 mb-1">Device Setup Instructions</h3>
      <p className="text-xs text-slate-500 mb-4">
        ClassGuard's SCEP server speaks a standard protocol any platform can enroll against — these are
        the platform-specific ways to actually point a device at it.
      </p>
      <div className="flex gap-2 mb-4 border-b border-slate-100 pb-3">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setPlatform(t.id)}
            className={`text-xs px-3 py-1.5 rounded-full font-medium ${platform === t.id ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {platform === 'mac' && <MosylePanel cfg={cfg} />}
      {platform === 'chromeos' && <ChromeOsPanel cfg={cfg} />}
      {platform === 'windows' && <WindowsPanel cfg={cfg} />}
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
          Self-hosted IKEv2 over the VRRP floating IP. Authentication trusts ClassGuard's own CA, issued
          to devices via a self-hosted SCEP server on enrollment — no MDM vendor ever holds a certificate
          itself, each one's "SCEP profile" is just a pointer at this server, so any platform that speaks
          SCEP can enroll (deployment instructions below cover macOS/iOS via Mosyle, ChromeOS, and Windows).
          This is a traditional perimeter VPN, not ZTNA — a connected client is a network member, subject
          only to the optional subnet restriction below.
        </p>
      </div>

      <CaSection cfg={cfg} />
      <DeploymentInstructions cfg={cfg} />

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
