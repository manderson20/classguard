import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const ROLE_COLOR = { primary: 'blue', standby: 'green', replica: 'slate' };
const ROLE_LABEL = { primary: 'Primary', standby: 'Standby', replica: 'Read Replica' };

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
