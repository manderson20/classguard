import { useQuery } from '@tanstack/react-query';
import api from '../lib/api';

function Field({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-slate-500 flex-shrink-0">{label}</span>
      <span className="text-right text-slate-800 break-all">{value ?? '—'}</span>
    </div>
  );
}

/**
 * Informational popover for a VLAN number: shows the matching network(s) as
 * configured on the controller (name, subnet, DHCP). Fetched live so it
 * always reflects the controller's current config.
 *
 * Props: vlan (number), controllerId, onClose
 */
export default function VlanInfoModal({ vlan, controllerId, onClose }) {
  const { data: networks, isLoading, error } = useQuery({
    queryKey: ['controller-networks', controllerId],
    queryFn:  () => api.get(`/network/controllers/${controllerId}/networks`),
    staleTime: 60_000,
  });

  const matches = (networks || []).filter(n => n.vlan === Number(vlan));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-800">VLAN {vlan}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none">&times;</button>
        </div>

        {isLoading && <div className="text-sm text-slate-400 py-4 text-center">Loading network config…</div>}
        {error && <div className="text-sm text-red-600 py-2">{error.message}</div>}

        {!isLoading && !error && !matches.length && (
          <div className="text-sm text-slate-500 py-2">
            No network with VLAN {vlan} is defined on this controller — it may be tagged on upstream equipment only.
          </div>
        )}

        <div className="space-y-4">
          {matches.map(n => (
            <div key={n.id} className="border border-slate-200 rounded-lg p-3 space-y-1.5">
              <Field label="Name"    value={n.name} />
              {n.native && <div className="text-xs text-slate-400">Untagged default LAN — native VLAN 1</div>}
              <Field label="Purpose" value={n.purpose} />
              <Field label="Subnet"  value={n.subnet} />
              {n.domain_name && <Field label="Domain" value={n.domain_name} />}
              <Field
                label="DHCP"
                value={n.dhcp_enabled
                  ? `${n.dhcp_start || '?'} – ${n.dhcp_stop || '?'}`
                  : 'Disabled'}
              />
              {n.dhcp_dns?.length > 0 && <Field label="DHCP DNS" value={n.dhcp_dns.join(', ')} />}
              {!n.enabled && <div className="text-xs text-amber-600">Network is disabled on the controller</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
