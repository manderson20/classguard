import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const INPUT  = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';
const SELECT = INPUT + ' bg-white';
const MONO   = 'font-mono text-xs';

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      <span>{label}{hint && <span className="font-normal text-slate-400 ml-1">— {hint}</span>}</span>
      {children}
    </label>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
        </div>
        <div className="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

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

// ---------------------------------------------------------------------------
// VPN Profiles — each carries its own subnet restriction and is assignable
// to a user or group. The connecting cert's CN is matched against a real
// ClassGuard user by email (every platform panel above already sets the
// cert's identity to the user's email), so assignment reuses the same
// Groups feature already used for RADIUS/content policies elsewhere.
// ---------------------------------------------------------------------------

function ProfileModal({ initial, onSave, onCancel, isPending }) {
  const [name, setName] = useState(initial?.name || '');
  const [subnetsText, setSubnetsText] = useState((initial?.restrict_to_subnets || []).join(', '));

  return (
    <div className="flex flex-col gap-3">
      <Field label="Name">
        <input className={INPUT} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. IT Team" />
      </Field>
      <Field label="Restrict access to subnets" hint="comma-separated CIDRs — leave empty for full network access">
        <input className={INPUT} value={subnetsText} onChange={e => setSubnetsText(e.target.value)}
          placeholder="172.16.1.0/24, 10.0.5.0/24" />
      </Field>
      <div className="flex justify-end gap-2 mt-2">
        <button onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
        <button
          onClick={() => onSave({
            name,
            restrict_to_subnets: subnetsText.split(',').map(s => s.trim()).filter(Boolean),
          })}
          disabled={isPending || !name.trim()}
          className="btn-primary text-sm"
        >
          {isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function AssignmentsModal({ profile, onClose }) {
  const qc = useQueryClient();
  const [target, setTarget] = useState('user');
  const [userSearch, setUserSearch] = useState('');
  const [userId, setUserId] = useState('');
  const [groupId, setGroupId] = useState('');

  const { data: assignments = [] } = useQuery({
    queryKey: ['vpn-profile-assignments', profile.id],
    queryFn:  () => api.get(`/vpn/profiles/${profile.id}/assignments`),
  });
  const { data: users = [] } = useQuery({
    queryKey: ['vpn-assignment-user-search', userSearch],
    queryFn:  () => api.get(`/users?search=${encodeURIComponent(userSearch)}&limit=20`).then(r => r.users),
    enabled:  target === 'user' && userSearch.length > 1,
  });
  const { data: groups = [] } = useQuery({
    queryKey: ['groups'],
    queryFn:  () => api.get('/groups'),
    enabled:  target === 'group',
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['vpn-profile-assignments', profile.id] });
    qc.invalidateQueries({ queryKey: ['vpn-profiles'] }); // assignment_count badge lives there
  };

  const add = useMutation({
    mutationFn: () => api.post(`/vpn/profiles/${profile.id}/assignments`, {
      user_id:  target === 'user'  ? userId  || null : null,
      group_id: target === 'group' ? groupId || null : null,
    }),
    onSuccess: () => { invalidate(); setUserId(''); setGroupId(''); setUserSearch(''); },
  });
  const remove = useMutation({
    mutationFn: id => api.delete(`/vpn/assignments/${id}`),
    onSuccess:  invalidate,
  });

  return (
    <Modal title={`Assignments — ${profile.name}`} onClose={onClose}>
      <p className="text-xs text-slate-500 mb-3">
        Anyone connecting whose certificate identity (email) matches a user assigned here, directly or via
        a group, gets this profile. Everyone else falls back to the default profile.
      </p>

      <div className="bg-slate-50 rounded-lg p-3 mb-4">
        <div className="flex gap-2 mb-2">
          <select className={SELECT + ' w-32'} value={target} onChange={e => setTarget(e.target.value)}>
            <option value="user">User</option>
            <option value="group">Group</option>
          </select>
          {target === 'user' ? (
            <input className={INPUT} value={userSearch} onChange={e => setUserSearch(e.target.value)} placeholder="Search by name or email…" />
          ) : (
            <select className={SELECT} value={groupId} onChange={e => setGroupId(e.target.value)}>
              <option value="">Select a group…</option>
              {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
        </div>
        {target === 'user' && users.length > 0 && (
          <select className={SELECT + ' mb-2'} value={userId} onChange={e => setUserId(e.target.value)}>
            <option value="">Select a user…</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>)}
          </select>
        )}
        <div className="flex justify-end">
          <button
            onClick={() => add.mutate()}
            disabled={add.isPending || (target === 'user' ? !userId : !groupId)}
            className="btn-primary text-xs"
          >
            {add.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>

      <div className="divide-y divide-slate-100">
        {assignments.map(a => (
          <div key={a.id} className="flex items-center justify-between py-2 text-sm">
            <span className="text-slate-700">
              {a.user_id ? `${a.user_name} (${a.user_email})` : `Group: ${a.group_name}`}
            </span>
            <button onClick={() => remove.mutate(a.id)} className="text-xs text-red-600 hover:underline">Remove</button>
          </div>
        ))}
        {!assignments.length && <p className="text-sm text-slate-400 py-4 text-center">No one assigned yet — this profile is unused.</p>}
      </div>
    </Modal>
  );
}

function ProfilesSection() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null); // { mode: 'create'|'edit', profile? } | null
  const [assignProfile, setAssignProfile] = useState(null);

  const { data: profiles = [] } = useQuery({
    queryKey: ['vpn-profiles'],
    queryFn:  () => api.get('/vpn/profiles'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['vpn-profiles'] });

  const create = useMutation({
    mutationFn: form => api.post('/vpn/profiles', form),
    onSuccess:  () => { invalidate(); setModal(null); },
  });
  const update = useMutation({
    mutationFn: ({ id, ...form }) => api.put(`/vpn/profiles/${id}`, form),
    onSuccess:  () => { invalidate(); setModal(null); },
  });
  const makeDefault = useMutation({
    mutationFn: id => api.post(`/vpn/profiles/${id}/make-default`),
    onSuccess:  invalidate,
  });
  const remove = useMutation({
    mutationFn: id => api.delete(`/vpn/profiles/${id}`),
    onSuccess:  invalidate,
    onError:    err => alert(err?.response?.data?.error || 'Failed to delete profile'),
  });

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden mb-4">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <div>
          <h3 className="font-semibold text-slate-900">VPN Profiles</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Different subnet access for different people — e.g. a broader "IT Team" profile alongside a
            more restricted default for everyone else. Resolved from the connecting cert's email identity.
          </p>
        </div>
        <button onClick={() => setModal({ mode: 'create' })} className="btn-primary text-xs flex-shrink-0">+ New Profile</button>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
          <tr>
            {['Name', 'Restricted Subnets', 'Assigned', '', ''].map(h => (
              <th key={h} className="px-4 py-2 text-left">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {profiles.map(p => (
            <tr key={p.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 text-slate-800 font-medium">
                {p.name}
                {p.is_default && <span className="ml-2 px-2 py-0.5 rounded-full text-xs font-medium bg-primary-100 text-primary-700">Default</span>}
              </td>
              <td className={`px-4 py-3 ${MONO} text-slate-600`}>
                {p.restrict_to_subnets?.length ? p.restrict_to_subnets.join(', ') : <span className="text-slate-400">Full network access</span>}
              </td>
              <td className="px-4 py-3 text-slate-600">
                {p.is_default ? <span className="text-slate-400">Everyone else</span> : `${p.assignment_count} ${p.assignment_count === '1' ? 'assignment' : 'assignments'}`}
              </td>
              <td className="px-4 py-3 text-right whitespace-nowrap">
                {!p.is_default && (
                  <button onClick={() => setAssignProfile(p)} className="text-xs text-primary-600 hover:underline mr-3">Assignments</button>
                )}
                <button onClick={() => setModal({ mode: 'edit', profile: p })} className="text-xs text-slate-600 hover:underline mr-3">Edit</button>
                {!p.is_default && (
                  <button onClick={() => makeDefault.mutate(p.id)} className="text-xs text-slate-600 hover:underline mr-3">Make Default</button>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                {!p.is_default && (
                  <button
                    onClick={() => { if (confirm(`Delete "${p.name}"? Anyone assigned to it falls back to the default profile.`)) remove.mutate(p.id); }}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {modal && (
        <Modal title={modal.mode === 'create' ? 'New VPN Profile' : `Edit ${modal.profile.name}`} onClose={() => setModal(null)}>
          <ProfileModal
            initial={modal.profile}
            isPending={create.isPending || update.isPending}
            onCancel={() => setModal(null)}
            onSave={form => modal.mode === 'create' ? create.mutate(form) : update.mutate({ id: modal.profile.id, ...form })}
          />
        </Modal>
      )}
      {assignProfile && <AssignmentsModal profile={assignProfile} onClose={() => setAssignProfile(null)} />}
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
          only to the optional subnet restriction set by their assigned profile below.
        </p>
      </div>

      <CaSection cfg={cfg} />
      <ProfilesSection />
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
              {['Identity', 'Profile', 'IP', 'Status', 'Connected', 'Bytes In/Out'].map(h => (
                <th key={h} className="px-4 py-2 text-left">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sessions.map(s => (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className={`px-4 py-3 ${MONO} text-slate-800`}>{s.cert_cn}</td>
                <td className="px-4 py-3 text-slate-600">{s.profile_name || '—'}</td>
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
              <tr><td colSpan={6} className="text-center text-slate-400 py-8 text-sm">No sessions yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
