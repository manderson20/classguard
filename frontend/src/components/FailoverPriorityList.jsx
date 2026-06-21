import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

// Every node in the cluster runs VRRP as BACKUP and advertises its own
// priority — whichever live node has the highest number becomes MASTER
// (see backend/src/services/keepalived.js). This replaces the old fixed
// "primary priority" / "secondary priority" pair so the failover order
// scales to however many nodes are actually in the cluster.
export default function FailoverPriorityList() {
  const qc = useQueryClient();
  const { data: nodes = [] } = useQuery({
    queryKey: ['ha-nodes'],
    queryFn:  () => api.get('/ha/nodes'),
  });

  const setPriority = useMutation({
    mutationFn: ({ nodeId, failover_priority }) => api.put(`/ha/nodes/${nodeId}/priority`, { failover_priority }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['ha-nodes'] }),
  });

  const active = nodes.filter(n => n.is_active);
  const sorted = [...active].sort((a, b) => (b.failover_priority ?? 100) - (a.failover_priority ?? 100));

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-medium text-slate-600">Failover order</label>
        <span className="text-xs text-slate-400">Highest priority wins the VIP while it's alive — ties broken by VRRP itself</span>
      </div>
      <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
        {sorted.length === 0 && (
          <div className="px-3 py-3 text-xs text-slate-400">No active nodes yet</div>
        )}
        {sorted.map((n, i) => (
          <div key={n.node_id} className="flex items-center gap-3 px-3 py-2">
            <span className="text-xs font-mono text-slate-400 w-6 flex-shrink-0">#{i + 1}</span>
            <span className="text-sm text-slate-800 flex-1 truncate">{n.hostname || n.node_id}</span>
            <input
              type="number"
              className="border border-slate-300 rounded-lg px-2 py-1 text-xs w-20 text-right focus:outline-none focus:ring-1 focus:ring-primary-500"
              defaultValue={n.failover_priority ?? 100}
              min={1}
              max={255}
              onBlur={e => {
                const v = parseInt(e.target.value, 10);
                if (Number.isInteger(v) && v !== n.failover_priority) {
                  setPriority.mutate({ nodeId: n.node_id, failover_priority: v });
                }
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
