import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const ROLE_COLOR = { primary:'blue', standby:'green', replica:'slate' };
const ROLE_LABEL = { primary:'Primary', standby:'Standby', replica:'Read Replica' };

function RoleBadge({ role }) {
  const color = ROLE_COLOR[role] || 'slate';
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-semibold bg-${color}-100 text-${color}-700`}>
      {ROLE_LABEL[role] || role}
    </span>
  );
}

function StatusBadge({ healthy, secondsSinceSeen }) {
  if (healthy) return <span className="text-xs font-medium text-green-600 flex items-center gap-1"><span className="w-2 h-2 bg-green-400 rounded-full inline-block"/>Online</span>;
  if (secondsSinceSeen < 90) return <span className="text-xs font-medium text-yellow-600 flex items-center gap-1"><span className="w-2 h-2 bg-yellow-400 rounded-full inline-block"/>Slow</span>;
  return <span className="text-xs font-medium text-red-500 flex items-center gap-1"><span className="w-2 h-2 bg-red-400 rounded-full inline-block"/>Offline</span>;
}

export default function HaPage() {
  const qc = useQueryClient();
  const [roleModal, setRoleModal] = useState(null);
  const [newRole, setNewRole]     = useState('standby');

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

  const updateRole = useMutation({
    mutationFn: ({ nodeId, ha_role }) => api.put(`/ha/nodes/${nodeId}/role`, { ha_role }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ha-nodes'] }); setRoleModal(null); },
  });

  const removeNode = useMutation({
    mutationFn: nodeId => api.delete(`/ha/nodes/${nodeId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ha-nodes'] }),
  });

  const primaryCount  = summary.find(s=>s.ha_role==='primary')?.count  || 0;
  const standbyCount  = summary.find(s=>s.ha_role==='standby')?.count  || 0;
  const onlineCount   = nodes.filter(n=>n.healthy).length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">High Availability</h1>
        <p className="text-slate-500 text-sm mt-0.5">Multi-server cluster management and health monitoring</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {[
          { label:'Total Nodes',    value: nodes.length,  color:'slate' },
          { label:'Online',         value: onlineCount,   color:'green' },
          { label:'Primary Nodes',  value: primaryCount,  color:'blue'  },
          { label:'Standby Nodes',  value: standbyCount,  color:'green' },
        ].map(c=>(
          <div key={c.label} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm text-center">
            <div className={`text-3xl font-bold text-${c.color}-600`}>{c.value}</div>
            <div className="text-xs text-slate-500 mt-1">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Last probed */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-slate-800">Cluster Nodes</h2>
        <span className="text-xs text-slate-400">
          Last probed: {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : '—'} · auto-refreshes every 15s
        </span>
      </div>

      {isLoading && <p className="text-sm text-slate-400">Loading nodes…</p>}

      <div className="flex flex-col gap-3">
        {nodes.map(n => (
          <div key={n.node_id}
            className={`bg-white border rounded-xl p-5 shadow-sm
              ${n.healthy ? 'border-slate-200' : 'border-red-200 bg-red-50/30'}`}>
            <div className="flex items-start gap-4">
              <div className="text-2xl">{n.ha_role==='primary' ? '🖥️' : '🔄'}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-slate-900">{n.hostname}</span>
                  <RoleBadge role={n.ha_role}/>
                  <StatusBadge healthy={n.healthy} secondsSinceSeen={n.seconds_since_seen}/>
                  {n.probe?.version && <span className="text-xs text-slate-400">v{n.probe.version}</span>}
                </div>
                <div className="mt-1 text-xs text-slate-500 font-mono">{n.api_url || 'No API URL set'}</div>
                <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-slate-500">
                  <div><span className="font-medium">Node ID:</span> {n.node_id}</div>
                  <div><span className="font-medium">Role:</span> {n.role || '—'}</div>
                  <div><span className="font-medium">Last seen:</span> {n.seconds_since_seen < 60 ? 'Just now' : `${Math.round(n.seconds_since_seen/60)}m ago`}</div>
                  <div><span className="font-medium">DB lag:</span> {n.db_lag_bytes != null ? `${n.db_lag_bytes}B` : '—'}</div>
                </div>
                {n.healthy && n.probe && (
                  <div className="mt-2 inline-flex items-center gap-1 text-xs text-green-600 bg-green-50 rounded px-2 py-0.5">
                    /health: {n.probe.status}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-1 items-end flex-shrink-0">
                <button onClick={()=>{setNewRole(n.ha_role);setRoleModal(n);}}
                  className="text-xs text-primary-600 hover:underline">Change Role</button>
                <button onClick={()=>{if(confirm(`Remove node ${n.hostname}?`)) removeNode.mutate(n.node_id);}}
                  className="text-xs text-red-500 hover:underline">Remove</button>
              </div>
            </div>
          </div>
        ))}
        {!isLoading && !nodes.length && (
          <p className="text-center text-slate-400 py-12 text-sm">
            No nodes registered. Nodes self-register on startup.
          </p>
        )}
      </div>

      {/* Role change modal */}
      {roleModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <h3 className="font-bold text-slate-900 mb-4">Change Role — {roleModal.hostname}</h3>
            <div className="flex flex-col gap-2 mb-4">
              {['primary','standby','replica'].map(r=>(
                <label key={r} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="ha_role" value={r} checked={newRole===r} onChange={()=>setNewRole(r)}/>
                  <RoleBadge role={r}/>
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-500 mb-4">
              Changing a node to <strong>primary</strong> does not automatically demote other primaries.
              Ensure you coordinate role changes to avoid split-brain.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={()=>setRoleModal(null)} className="btn-secondary text-sm">Cancel</button>
              <button onClick={()=>updateRole.mutate({nodeId:roleModal.node_id, ha_role:newRole})}
                disabled={updateRole.isPending} className="btn-primary text-sm">
                {updateRole.isPending ? 'Saving…' : 'Save Role'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* HA setup guide */}
      <div className="mt-8 bg-blue-50 border border-blue-200 rounded-xl p-5">
        <h3 className="font-semibold text-blue-900 mb-2">Adding a new ClassGuard server to the cluster</h3>
        <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
          <li>Deploy ClassGuard on the new server and configure it to connect to the <strong>same PostgreSQL database</strong>.</li>
          <li>Set <code className="bg-blue-100 px-1 rounded">NODE_ROLE=standby</code> in the new server's <code>.env</code>.</li>
          <li>Set <code className="bg-blue-100 px-1 rounded">APP_URL=http://&lt;new-server-ip&gt;</code> so this node can be probed.</li>
          <li>Start ClassGuard — it will self-register and appear in this table within 30 seconds.</li>
          <li>For DNS HA: point clients to both servers or use a virtual IP (keepalived/VRRP).</li>
        </ol>
      </div>
    </div>
  );
}
