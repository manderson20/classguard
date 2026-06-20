import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const ROLE_COLOR = { primary: 'blue', standby: 'green', replica: 'slate' };
const ROLE_LABEL = { primary: 'Primary', standby: 'Standby', replica: 'Read Replica' };

const INPUT = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500 w-full';

function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      <span>{label}{hint && <span className="font-normal text-slate-400 ml-1">— {hint}</span>}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Database Replication section
// ---------------------------------------------------------------------------
function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function DbReplicationSection() {
  const { data, isLoading } = useQuery({
    queryKey: ['ha-db-replication'],
    queryFn:  () => api.get('/ha/db-replication'),
    refetchInterval: 20_000,
  });

  const role     = data?.role;
  const replicas = data?.replicas || [];

  return (
    <div className="mb-8">
      <h2 className="font-semibold text-slate-800 mb-3">Database Replication</h2>

      {isLoading && <p className="text-sm text-slate-400">Checking replication status…</p>}

      {!isLoading && role === 'standby' && data.standby && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 bg-blue-400 rounded-full" />
            <span className="font-medium text-slate-800 text-sm">This node is a streaming replica</span>
          </div>
          <div className="text-xs text-slate-500">
            Replay lag: {data.standby.replay_lag_seconds != null ? `${Math.round(data.standby.replay_lag_seconds)}s` : '—'} ·
            {' '}Last replayed transaction: {data.standby.last_replay_at ? new Date(data.standby.last_replay_at).toLocaleTimeString() : '—'}
          </div>
        </div>
      )}

      {!isLoading && role === 'primary' && replicas.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
          <h3 className="font-semibold text-amber-900 mb-1.5">No streaming replicas detected — single point of failure</h3>
          <p className="text-sm text-amber-800 mb-3">
            This PostgreSQL instance has no replicas connected. If it goes down, the DNS engine keeps filtering using
            its locally cached Redis policy snapshot — students won't suddenly lose filtering — but no admin changes
            (new policies, blocklist syncs, user/group edits) can be made until the database is back.
          </p>
          <div className="text-xs text-amber-800 bg-amber-100/60 rounded-lg p-3">
            <div className="font-semibold mb-1">To eliminate this SPOF:</div>
            <ol className="list-decimal list-inside space-y-1">
              <li>Set up PostgreSQL streaming replication to a second server — <code className="bg-amber-200/50 px-1 rounded">pg_auto_failover</code> is the simplest option for automatic primary promotion (Patroni + etcd if you want more control).</li>
              <li>Point the replica's <code className="bg-amber-200/50 px-1 rounded">DATABASE_URL</code> at the same Postgres cluster as a hot standby.</li>
              <li>This panel will automatically pick up the replica once it connects — no ClassGuard config needed.</li>
            </ol>
          </div>
        </div>
      )}

      {!isLoading && role === 'primary' && replicas.length > 0 && (
        <div className="flex flex-col gap-2">
          {replicas.map(r => {
            const lagBytes = r.replay_lag_bytes || 0;
            const healthy  = lagBytes < 8 * 1024 * 1024; // < 8MB behind
            return (
              <div key={r.application_name} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${healthy ? 'bg-green-400' : 'bg-amber-400'}`} />
                    <span className="font-medium text-slate-800 text-sm">{r.application_name || r.client_addr}</span>
                    <span className="text-xs text-slate-400">{r.client_addr}</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    State: {r.state} · Sync: {r.sync_state} · Replay lag: {formatBytes(lagBytes)}
                    {r.replay_lag && ` (${r.replay_lag})`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TLS Certificate (Let's Encrypt) section
// ---------------------------------------------------------------------------
function TlsSection() {
  const qc = useQueryClient();
  const [form, setForm]   = useState(null);
  const [manualRecord, setManualRecord] = useState(null);
  const [actionError, setActionError]   = useState('');

  const { data: tls = {} } = useQuery({
    queryKey: ['tls-config'],
    queryFn:  () => api.get('/tls'),
    refetchInterval: 30_000,
  });

  const cfg = form || tls;
  const set = (k, v) => setForm(p => ({ ...(p || tls), [k]: v }));

  const save = useMutation({
    mutationFn: () => api.put('/tls', form || tls),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['tls-config'] }),
  });

  const issue = useMutation({
    mutationFn: () => api.post('/tls/issue'),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['tls-config'] }),
    onError:    err => setActionError(err.message),
  });

  const manualStart = useMutation({
    mutationFn: () => api.post('/tls/manual/start'),
    onSuccess:  (data) => { setManualRecord(data); qc.invalidateQueries({ queryKey: ['tls-config'] }); },
    onError:    err => setActionError(err.message),
  });

  const manualConfirm = useMutation({
    mutationFn: () => api.post('/tls/manual/confirm'),
    onSuccess:  () => { setManualRecord(null); qc.invalidateQueries({ queryKey: ['tls-config'] }); },
    onError:    err => setActionError(err.message),
  });

  const pendingManual = manualRecord || (tls.manual_challenge?.recordValue ? tls.manual_challenge : null);
  const daysLeft = tls.cert_expires_at ? Math.round((new Date(tls.cert_expires_at) - Date.now()) / 86_400_000) : null;

  return (
    <div className="mb-8">
      <h2 className="font-semibold text-slate-800 mb-3">TLS Certificate (Let's Encrypt)</h2>

      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm mb-4">
        <p className="text-xs text-slate-500 mb-4">
          Issued via the DNS-01 challenge — Let's Encrypt verifies ownership through a DNS TXT record instead of an
          inbound HTTP request, so no port forwarding or public IP is required. The cert is issued for the VIP's
          hostname above and stored centrally, so every node in the cluster can serve it.
        </p>

        {tls.cert_pem_set && (
          <div className={`mb-4 text-sm px-3 py-2 rounded-lg border ${daysLeft != null && daysLeft < 14 ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-green-50 border-green-200 text-green-800'}`}>
            Certificate active — expires {tls.cert_expires_at ? new Date(tls.cert_expires_at).toLocaleDateString() : '—'}
            {daysLeft != null && ` (${daysLeft} days)`}
          </div>
        )}
        {tls.last_error && (
          <div className="mb-4 text-sm px-3 py-2 rounded-lg border bg-red-50 border-red-200 text-red-800">{tls.last_error}</div>
        )}

        <div className="grid md:grid-cols-2 gap-4 mb-4">
          <Field label="Domain" hint="public DNS name pointing at the VIP above">
            <input className={INPUT} value={cfg.domain || ''} onChange={e => set('domain', e.target.value)} placeholder="classguard.district.org" />
          </Field>
          <Field label="ACME contact email" hint="Let's Encrypt expiry notices">
            <input className={INPUT} value={cfg.acme_email || ''} onChange={e => set('acme_email', e.target.value)} placeholder="it@district.org" />
          </Field>
          <Field label="Validation method">
            <select className={INPUT + ' bg-white'} value={cfg.provider || 'manual'} onChange={e => set('provider', e.target.value)}>
              <option value="manual">Manual DNS — I'll add the TXT record myself</option>
              <option value="cloudflare">Cloudflare DNS</option>
              <option value="route53">AWS Route 53 DNS</option>
              <option value="http01">Port 80/443 — no DNS provider needed</option>
            </select>
          </Field>
          <Field label="Enable TLS">
            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer mt-1.5">
              <input type="checkbox" className="w-4 h-4 rounded" checked={cfg.enabled === true} onChange={e => set('enabled', e.target.checked)} />
              Serve HTTPS using this certificate once issued
            </label>
          </Field>
        </div>

        {cfg.provider === 'cloudflare' && (
          <div className="grid md:grid-cols-2 gap-4 mb-4 pt-4 border-t border-slate-100">
            <Field label="Cloudflare API token" hint={tls.cloudflare_api_token_set ? 'set — leave blank to keep' : 'Zone:DNS:Edit permission'}>
              <input type="password" className={INPUT} value={cfg.cloudflare_api_token || ''} onChange={e => set('cloudflare_api_token', e.target.value)} placeholder={tls.cloudflare_api_token_set ? '••••••••' : ''} />
            </Field>
            <Field label="Zone ID" hint="optional — auto-detected from domain">
              <input className={INPUT} value={cfg.cloudflare_zone_id || ''} onChange={e => set('cloudflare_zone_id', e.target.value)} />
            </Field>
          </div>
        )}

        {cfg.provider === 'route53' && (
          <div className="grid md:grid-cols-2 gap-4 mb-4 pt-4 border-t border-slate-100">
            <Field label="Access Key ID">
              <input className={INPUT} value={cfg.route53_access_key_id || ''} onChange={e => set('route53_access_key_id', e.target.value)} />
            </Field>
            <Field label="Secret Access Key" hint={tls.route53_secret_access_key_set ? 'set — leave blank to keep' : undefined}>
              <input type="password" className={INPUT} value={cfg.route53_secret_access_key || ''} onChange={e => set('route53_secret_access_key', e.target.value)} placeholder={tls.route53_secret_access_key_set ? '••••••••' : ''} />
            </Field>
            <Field label="Hosted Zone ID" hint="optional — auto-detected from domain">
              <input className={INPUT} value={cfg.route53_hosted_zone_id || ''} onChange={e => set('route53_hosted_zone_id', e.target.value)} />
            </Field>
          </div>
        )}

        {cfg.provider === 'http01' && (
          <div className="mb-4 pt-4 border-t border-slate-100">
            <p className="text-xs text-slate-500">
              Let's Encrypt connects to <strong>this server on port 80</strong> directly to verify domain ownership —
              no DNS provider credentials needed. Your router/firewall must forward ports 80 and 443 from the
              internet to this server's IP, and the domain above must already resolve to that public address.
              Renews automatically, same as Cloudflare/Route 53.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-100">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-secondary text-sm">
            {save.isPending ? 'Saving…' : 'Save Settings'}
          </button>

          {(cfg.provider === 'cloudflare' || cfg.provider === 'route53' || cfg.provider === 'http01') && (
            <button onClick={() => issue.mutate()} disabled={issue.isPending || !cfg.domain} className="btn-primary text-sm">
              {issue.isPending ? 'Issuing…' : tls.cert_pem_set ? 'Renew Certificate' : 'Issue Certificate'}
            </button>
          )}
        </div>

        {cfg.provider === 'manual' && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            {!pendingManual ? (
              <div className="flex justify-end">
                <button onClick={() => manualStart.mutate()} disabled={manualStart.isPending || !cfg.domain} className="btn-primary text-sm">
                  {manualStart.isPending ? 'Requesting…' : 'Start — Get DNS Record'}
                </button>
              </div>
            ) : (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-sm text-blue-900 font-medium mb-2">Add this TXT record to your DNS zone:</p>
                <div className="bg-white border border-blue-200 rounded p-3 font-mono text-xs space-y-1 mb-3">
                  <div><span className="text-slate-400">Name:</span> {pendingManual.recordName}</div>
                  <div className="break-all"><span className="text-slate-400">Value:</span> {pendingManual.recordValue}</div>
                </div>
                <div className="flex justify-end">
                  <button onClick={() => manualConfirm.mutate()} disabled={manualConfirm.isPending} className="btn-primary text-sm">
                    {manualConfirm.isPending ? 'Verifying…' : "I've added the record — Verify & Issue"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {actionError && <p className="text-red-600 text-sm mt-3">{actionError}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VRRP / Virtual IP section
// ---------------------------------------------------------------------------
function VrrpSection() {
  const qc = useQueryClient();
  const [form, setForm] = useState(null);
  const [bundle, setBundle] = useState(null);
  const [loadingBundle, setLoadingBundle] = useState(false);
  const [activeFile, setActiveFile] = useState(null);

  const { data: vrrp = {} } = useQuery({
    queryKey: ['ha-vrrp'],
    queryFn:  () => api.get('/ha/vrrp'),
  });

  const save = useMutation({
    mutationFn: () => api.put('/ha/vrrp', form || vrrp),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['ha-vrrp'] }),
  });

  const cfg = form || vrrp;
  const set = (k, v) => setForm(p => ({ ...(p || vrrp), [k]: v }));

  const loadBundle = async () => {
    setLoadingBundle(true);
    try {
      const b = await api.get('/ha/vrrp/bundle');
      setBundle(b);
      setActiveFile(Object.keys(b)[0]);
    } finally {
      setLoadingBundle(false);
    }
  };

  const downloadFile = (name, content) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
    a.download = name;
    a.click();
  };

  return (
    <div className="mb-8">
      <h2 className="font-semibold text-slate-800 mb-3">Virtual IP (VRRP) — Failover Without a Shared Disk</h2>

      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm mb-4">
        <p className="text-xs text-slate-500 mb-4">
          A virtual IP floats between nodes using <strong>keepalived</strong> — clients, switches, and TLS
          certificates only ever talk to one address, regardless of which physical node is currently active.
          Install keepalived directly on the host (not in Docker) on each node and deploy the matching config below.
        </p>
        <div className="grid md:grid-cols-3 gap-4">
          <Field label="Virtual IP Address (VIP)" hint="shared between nodes">
            <input className={INPUT} value={cfg.vip_address || ''} onChange={e => set('vip_address', e.target.value)} placeholder="172.16.1.249" />
          </Field>
          <Field label="Subnet prefix length">
            <input type="number" className={INPUT} value={cfg.vip_prefix_len || 24} onChange={e => set('vip_prefix_len', parseInt(e.target.value))} min={1} max={32} />
          </Field>
          <Field label="Network interface" hint="on both nodes">
            <input className={INPUT} value={cfg.vip_interface || 'eth0'} onChange={e => set('vip_interface', e.target.value)} />
          </Field>
          <Field label="VRRP instance name">
            <input className={INPUT} value={cfg.vrrp_instance_name || 'CLASSGUARD_APPS'} onChange={e => set('vrrp_instance_name', e.target.value)} />
          </Field>
          <Field label="Virtual Router ID" hint="1–255, unique per VIP on this LAN">
            <input type="number" className={INPUT} value={cfg.vrrp_virtual_router_id || 51} onChange={e => set('vrrp_virtual_router_id', parseInt(e.target.value))} min={1} max={255} />
          </Field>
          <Field label="VRRP auth password">
            <input type="password" className={INPUT} value={cfg.vrrp_auth_password || ''} onChange={e => set('vrrp_auth_password', e.target.value)} />
          </Field>
          <Field label="Primary priority" hint="default 150">
            <input type="number" className={INPUT} value={cfg.priority_primary || 150} onChange={e => set('priority_primary', parseInt(e.target.value))} />
          </Field>
          <Field label="Secondary priority" hint="default 100">
            <input type="number" className={INPUT} value={cfg.priority_secondary || 100} onChange={e => set('priority_secondary', parseInt(e.target.value))} />
          </Field>
        </div>
        <div className="flex items-center gap-5 mt-4 pt-4 border-t border-slate-100">
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 rounded"
              checked={cfg.track_classguard_api !== false}
              onChange={e => set('track_classguard_api', e.target.checked)} />
            Fail over if the ClassGuard API stops responding
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
            <input type="checkbox" className="w-4 h-4 rounded"
              checked={cfg.track_freeradius === true}
              onChange={e => set('track_freeradius', e.target.checked)} />
            Fail over if FreeRADIUS stops responding <span className="text-slate-400">(only if you use RADIUS / NAC)</span>
          </label>
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
            {save.isPending ? 'Saving…' : 'Save VIP Config'}
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-slate-900">Keepalived Config Files</h3>
            <p className="text-xs text-slate-500 mt-0.5">Generated from the VIP settings above. Deploy to each node's host (outside Docker).</p>
          </div>
          <button onClick={loadBundle} disabled={loadingBundle} className="btn-primary text-sm">
            {loadingBundle ? 'Generating…' : 'Generate Configs'}
          </button>
        </div>

        {bundle && (
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <div className="flex border-b border-slate-200 overflow-x-auto">
              {Object.keys(bundle).map(name => (
                <button key={name} onClick={() => setActiveFile(name)}
                  className={`px-3 py-2 text-xs font-mono whitespace-nowrap border-r border-slate-200 transition-colors
                    ${activeFile === name ? 'bg-primary-600 text-white' : 'hover:bg-slate-50 text-slate-600'}`}>
                  {name}
                </button>
              ))}
            </div>
            {activeFile && (
              <div className="relative">
                <div className="absolute top-2 right-2 flex gap-2">
                  <button onClick={() => navigator.clipboard.writeText(bundle[activeFile])}
                    className="bg-white border border-slate-200 rounded px-2 py-1 text-xs hover:bg-slate-50">Copy</button>
                  <button onClick={() => downloadFile(activeFile, bundle[activeFile])}
                    className="bg-white border border-slate-200 rounded px-2 py-1 text-xs hover:bg-slate-50">Download</button>
                </div>
                <pre className="p-4 text-xs font-mono bg-slate-900 text-slate-100 overflow-x-auto max-h-96 overflow-y-auto whitespace-pre">
                  {bundle[activeFile]}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RoleBadge({ role }) {
  const color = ROLE_COLOR[role] || 'slate';
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-semibold bg-${color}-100 text-${color}-700`}>
      {ROLE_LABEL[role] || role}
    </span>
  );
}

function StatusDot({ healthy, secondsSinceSeen }) {
  if (healthy)
    return <span className="text-xs font-medium text-green-600 flex items-center gap-1"><span className="w-2 h-2 bg-green-400 rounded-full" />Online</span>;
  if (secondsSinceSeen != null && secondsSinceSeen < 90)
    return <span className="text-xs font-medium text-yellow-600 flex items-center gap-1"><span className="w-2 h-2 bg-yellow-400 rounded-full" />Slow</span>;
  return <span className="text-xs font-medium text-red-500 flex items-center gap-1"><span className="w-2 h-2 bg-red-400 rounded-full" />Offline</span>;
}

// ---------------------------------------------------------------------------
// Add Server Modal
// ---------------------------------------------------------------------------
function AddServerModal({ onClose, qc }) {
  const [label, setLabel]   = useState('');
  const [role, setRole]     = useState('standby');
  const [invite, setInvite] = useState(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: () => api.post('/ha/invites', { label: label.trim() || null, ha_role: role, expires_hours: 168 }),
    onSuccess: (data) => {
      setInvite(data);
      qc.invalidateQueries({ queryKey: ['ha-invites'] });
    },
  });

  const primaryUrl = window.location.origin;
  const joinCmd = invite
    ? `NODE_ID=classguard-new NODE_ROLE=${invite.ha_role} CG_JOIN_TOKEN=${invite.token} APP_URL=http://<THIS_SERVER_IP> CG_PRIMARY_URL=${primaryUrl} docker compose up -d`
    : '';

  function copyCmd() {
    navigator.clipboard.writeText(joinCmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6">
        <h3 className="font-bold text-slate-900 text-lg mb-4">Add a Server to the Cluster</h3>

        {!invite ? (
          <>
            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Label <span className="text-slate-400 font-normal">(optional)</span></label>
                <input
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                  placeholder="e.g. Secondary — Building B"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Role for new server</label>
                <div className="flex flex-col gap-2">
                  {['standby', 'primary', 'replica'].map(r => (
                    <label key={r} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="radio" name="new_role" value={r} checked={role === r} onChange={() => setRole(r)} />
                      <RoleBadge role={r} />
                      <span className="text-slate-500">
                        {r === 'standby' && '— receives synced policy, can serve DNS'}
                        {r === 'primary' && '— full read/write (use only if splitting primaries)'}
                        {r === 'replica' && '— read-only database replica'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
              <button
                onClick={() => create.mutate()}
                disabled={create.isPending}
                className="btn-primary text-sm"
              >
                {create.isPending ? 'Generating…' : 'Generate Invite Token'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 mb-4 text-sm text-green-800">
              Invite token generated — valid for <strong>7 days</strong>, single-use.
            </div>

            <p className="text-sm text-slate-600 mb-2">
              Run this command on the new server (replace <code className="bg-slate-100 px-1 rounded">{'<THIS_SERVER_IP>'}</code> with its IP):
            </p>

            <div className="relative">
              <pre className="bg-slate-900 text-green-300 text-xs rounded-lg p-4 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
                {joinCmd}
              </pre>
              <button
                onClick={copyCmd}
                className="absolute top-2 right-2 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-1 rounded"
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>

            <p className="text-xs text-slate-500 mt-3">
              The new server will call back to this node using the token and appear in the cluster list automatically.
              You can also revoke the token from the Pending Invites section if unused.
            </p>

            <div className="flex justify-end mt-4">
              <button onClick={onClose} className="btn-primary text-sm">Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Change Role Modal
// ---------------------------------------------------------------------------
function ChangeRoleModal({ node, onClose, qc }) {
  const [newRole, setNewRole] = useState(node.ha_role);

  const updateRole = useMutation({
    mutationFn: ha_role => api.put(`/ha/nodes/${node.node_id}/role`, { ha_role }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ha-nodes'] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h3 className="font-bold text-slate-900 mb-4">Change Role — {node.hostname}</h3>
        <div className="flex flex-col gap-2 mb-4">
          {['primary', 'standby', 'replica'].map(r => (
            <label key={r} className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" name="ha_role" value={r} checked={newRole === r} onChange={() => setNewRole(r)} />
              <RoleBadge role={r} />
            </label>
          ))}
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Changing to <strong>primary</strong> does not demote other primaries automatically — coordinate to avoid split-brain.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button
            onClick={() => updateRole.mutate(newRole)}
            disabled={updateRole.isPending}
            className="btn-primary text-sm"
          >
            {updateRole.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------
export default function HaPage() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd]       = useState(false);
  const [roleModal, setRoleModal]   = useState(null);

  const { data: nodes = [], isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['ha-nodes'],
    queryFn:  () => api.get('/ha/nodes'),
    refetchInterval: 15_000,
  });

  const { data: summary = [] } = useQuery({
    queryKey: ['ha-summary'],
    queryFn:  () => api.get('/ha/summary'),
    refetchInterval: 30_000,
  });

  const { data: invites = [] } = useQuery({
    queryKey: ['ha-invites'],
    queryFn:  () => api.get('/ha/invites'),
    refetchInterval: 30_000,
  });

  const removeNode = useMutation({
    mutationFn: nodeId => api.delete(`/ha/nodes/${nodeId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ha-nodes'] }),
  });

  const revokeInvite = useMutation({
    mutationFn: id => api.delete(`/ha/invites/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ha-invites'] }),
  });

  const onlineCount  = nodes.filter(n => n.healthy).length;
  const primaryCount = summary.find(s => s.ha_role === 'primary')?.count || 0;
  const standbyCount = summary.find(s => s.ha_role === 'standby')?.count || 0;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">High Availability</h1>
          <p className="text-slate-500 text-sm mt-0.5">Multi-server cluster management and health monitoring</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary text-sm">
          + Add Server
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total Nodes',   value: nodes.length,  color: 'slate' },
          { label: 'Online',        value: onlineCount,   color: 'green' },
          { label: 'Primary',       value: primaryCount,  color: 'blue'  },
          { label: 'Standby',       value: standbyCount,  color: 'green' },
        ].map(c => (
          <div key={c.label} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm text-center">
            <div className={`text-3xl font-bold text-${c.color}-600`}>{c.value}</div>
            <div className="text-xs text-slate-500 mt-1">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Cluster nodes */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-800">Cluster Nodes</h2>
        <span className="text-xs text-slate-400">
          Last probed: {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : '—'} · auto-refreshes every 15s
        </span>
      </div>

      {isLoading && <p className="text-sm text-slate-400">Loading nodes…</p>}

      <div className="flex flex-col gap-3 mb-8">
        {nodes.map(n => (
          <div key={n.id}
            className={`bg-white border rounded-xl p-5 shadow-sm ${n.healthy ? 'border-slate-200' : 'border-red-200 bg-red-50/30'}`}>
            <div className="flex items-start gap-4">
              <div className="text-2xl">{n.ha_role === 'primary' ? '🖥️' : '🔄'}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-900">{n.hostname}</span>
                  <RoleBadge role={n.ha_role} />
                  <StatusDot healthy={n.healthy} secondsSinceSeen={n.seconds_since_seen} />
                  {n.probe?.version && <span className="text-xs text-slate-400">v{n.probe.version}</span>}
                </div>
                <div className="mt-1 text-xs text-slate-500 font-mono">{n.api_url || <span className="text-amber-500">No API URL — health probing disabled</span>}</div>
                <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-slate-500">
                  <div><span className="font-medium">Node ID:</span> {n.node_id || n.id.slice(0, 8)}</div>
                  <div><span className="font-medium">Role:</span> {n.role || '—'}</div>
                  <div><span className="font-medium">Last seen:</span> {n.seconds_since_seen == null ? 'Never' : n.seconds_since_seen < 60 ? 'Just now' : `${Math.round(n.seconds_since_seen / 60)}m ago`}</div>
                  <div><span className="font-medium">DB lag:</span> {n.db_lag_bytes != null ? `${n.db_lag_bytes}B` : '—'}</div>
                </div>
                {n.healthy && n.probe && (
                  <div className="mt-2 inline-flex items-center gap-1 text-xs text-green-600 bg-green-50 rounded px-2 py-0.5">
                    /health: {n.probe.status}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1 items-end flex-shrink-0">
                <button
                  onClick={() => setRoleModal(n)}
                  className="text-xs text-primary-600 hover:underline"
                >
                  Change Role
                </button>
                <button
                  onClick={() => { if (confirm(`Remove node "${n.hostname}" from the cluster?`)) removeNode.mutate(n.node_id || n.id); }}
                  className="text-xs text-red-500 hover:underline"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ))}

        {!isLoading && nodes.length === 0 && (
          <div className="text-center py-12 text-slate-400 text-sm border border-dashed border-slate-200 rounded-xl">
            No nodes registered yet.{' '}
            <button onClick={() => setShowAdd(true)} className="text-primary-600 hover:underline">Add the first server →</button>
          </div>
        )}
      </div>

      {/* Pending invites */}
      {invites.length > 0 && (
        <div className="mb-8">
          <h2 className="font-semibold text-slate-800 mb-3">Pending Invites</h2>
          <div className="flex flex-col gap-2">
            {invites.map(inv => (
              <div key={inv.id} className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-slate-800 text-sm">{inv.label || 'Unnamed invite'}</span>
                    <RoleBadge role={inv.ha_role} />
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 font-mono truncate">
                    Token: {inv.token.slice(0, 16)}…
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    Created by {inv.created_by_name || 'admin'} · expires {new Date(inv.expires_at).toLocaleDateString()}
                  </div>
                </div>
                <button
                  onClick={() => { if (confirm('Revoke this invite token?')) revokeInvite.mutate(inv.id); }}
                  className="text-xs text-red-500 hover:underline flex-shrink-0"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <DbReplicationSection />

      <VrrpSection />

      <TlsSection />

      {/* Setup guide */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-5">
        <h3 className="font-semibold text-blue-900 mb-2">How to add a server</h3>
        <ol className="text-sm text-blue-800 space-y-1.5 list-decimal list-inside">
          <li>Click <strong>+ Add Server</strong> above and choose a role for the new node.</li>
          <li>Copy the generated <code className="bg-blue-100 px-1 rounded">docker compose</code> command and run it on the new server.</li>
          <li>The new server connects to the <strong>same PostgreSQL database</strong> and self-registers using the invite token.</li>
          <li>It appears here within 30 seconds — token is consumed and cannot be reused.</li>
          <li>For DNS failover: point clients to both server IPs, or use a VRRP virtual IP (keepalived).</li>
        </ol>
      </div>

      {showAdd  && <AddServerModal onClose={() => setShowAdd(false)} qc={qc} />}
      {roleModal && <ChangeRoleModal node={roleModal} onClose={() => setRoleModal(null)} qc={qc} />}
    </div>
  );
}
