import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

function cidrToCount(cidr) {
  const prefix = parseInt(cidr?.split('/')[1], 10);
  if (isNaN(prefix)) return null;
  return Math.pow(2, 32 - prefix) - 2;
}

function pct(used, total) {
  if (!total) return 0;
  return Math.round((used / total) * 100);
}

export default function IpamPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '', cidr: '', gateway: '', vlan_id: '', location: '', description: '', dhcp_enabled: false, ipam_enabled: true,
  });

  const { data: subnets = [], isLoading } = useQuery({
    queryKey: ['subnets'],
    queryFn:  () => api.get('/ipam/subnets'),
  });

  const { data: leases = [] } = useQuery({
    queryKey: ['leases'],
    queryFn:  () => api.get('/ipam/leases').catch(() => []),
  });

  const create = useMutation({
    mutationFn: () => api.post('/ipam/subnets', {
      ...form,
      vlan_id: form.vlan_id ? parseInt(form.vlan_id) : null,
    }),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['subnets'] }); setCreating(false); setForm({ name: '', cidr: '', gateway: '', vlan_id: '', location: '', description: '', dhcp_enabled: false, ipam_enabled: true }); },
  });

  const del = useMutation({
    mutationFn: id => api.delete(`/ipam/subnets/${id}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['subnets'] }),
  });

  const totalUsed  = leases.length;
  const totalHosts = subnets.reduce((acc, s) => acc + (cidrToCount(s.cidr) || 0), 0);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">IPAM</h1>
          <p className="text-slate-500 text-sm mt-0.5">IP Address Management · integrated with ISC Kea DHCP</p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>+ Add Subnet</button>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card p-4 bg-blue-50">
          <div className="text-2xl font-bold text-blue-700">{subnets.length}</div>
          <div className="text-xs font-semibold text-slate-500 mt-0.5">Subnets</div>
        </div>
        <div className="card p-4 bg-green-50">
          <div className="text-2xl font-bold text-green-700">{totalHosts.toLocaleString()}</div>
          <div className="text-xs font-semibold text-slate-500 mt-0.5">Total Hosts</div>
        </div>
        <div className="card p-4 bg-amber-50">
          <div className="text-2xl font-bold text-amber-700">{totalUsed.toLocaleString()}</div>
          <div className="text-xs font-semibold text-slate-500 mt-0.5">Active Leases</div>
        </div>
      </div>

      {isLoading ? (
        <div className="text-slate-400 text-sm">Loading…</div>
      ) : (
        <div className="space-y-3">
          {subnets.map(s => {
            const hosts = cidrToCount(s.cidr) || 0;
            const used  = leases.filter(l => l.subnet_id === s.id).length;
            const utilPct = pct(used, hosts);

            return (
              <div key={s.id} className="card p-5">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <span className="font-semibold text-slate-900">{s.name}</span>
                      <span className="font-mono text-sm text-slate-600">{s.cidr}</span>
                      {s.vlan_id && <span className="badge-slate text-xs">VLAN {s.vlan_id}</span>}
                      {s.dhcp_enabled && <span className="badge-blue text-xs">DHCP</span>}
                      {s.ipam_enabled && <span className="badge-green text-xs">IPAM</span>}
                    </div>
                    {s.location && <div className="text-sm text-slate-500">{s.location}</div>}
                    {s.description && <div className="text-xs text-slate-400">{s.description}</div>}
                    {s.gateway && <div className="text-xs text-slate-400 font-mono">GW: {s.gateway}</div>}

                    {/* Utilization bar */}
                    <div className="mt-3 max-w-xs">
                      <div className="flex justify-between text-xs text-slate-500 mb-1">
                        <span>{used} used</span>
                        <span>{hosts} hosts · {utilPct}%</span>
                      </div>
                      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${utilPct > 85 ? 'bg-red-500' : utilPct > 60 ? 'bg-amber-400' : 'bg-green-500'}`}
                          style={{ width: `${Math.min(utilPct, 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Link to={`/admin/ipam/subnets/${s.id}`} className="btn-primary btn-sm">
                      Map →
                    </Link>
                    <button
                      className="text-xs text-slate-400 hover:text-red-500 px-2 py-1.5"
                      onClick={() => { if (confirm(`Delete subnet "${s.name}"?`)) del.mutate(s.id); }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {subnets.length === 0 && (
            <div className="card p-10 text-center text-slate-400 text-sm">
              No subnets configured. Add your first subnet to start documenting IPs.
            </div>
          )}
        </div>
      )}

      {/* Create subnet modal */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
            <h2 className="font-semibold text-slate-900 mb-4">Add Subnet</h2>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Name</label>
                  <input className="input" placeholder="Main Building"
                    value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
                </div>
                <div>
                  <label className="label">CIDR</label>
                  <input className="input font-mono" placeholder="192.168.1.0/24"
                    value={form.cidr} onChange={e => setForm(f => ({ ...f, cidr: e.target.value }))} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Gateway</label>
                  <input className="input font-mono" placeholder="192.168.1.1"
                    value={form.gateway} onChange={e => setForm(f => ({ ...f, gateway: e.target.value }))} />
                </div>
                <div>
                  <label className="label">VLAN ID</label>
                  <input type="number" className="input" placeholder="10"
                    value={form.vlan_id} onChange={e => setForm(f => ({ ...f, vlan_id: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="label">Location</label>
                <input className="input" placeholder="Main Building, Floor 1"
                  value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
              </div>
              <div>
                <label className="label">Description</label>
                <input className="input" placeholder="Optional"
                  value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              </div>
              <div className="flex gap-6">
                <Checkbox id="dhcp_en" label="DHCP Enabled" checked={form.dhcp_enabled}
                  onChange={v => setForm(f => ({ ...f, dhcp_enabled: v }))} />
                <Checkbox id="ipam_en" label="IPAM Enabled" checked={form.ipam_enabled}
                  onChange={v => setForm(f => ({ ...f, ipam_enabled: v }))} />
              </div>
            </div>
            <div className="flex gap-3 justify-end mt-5">
              <button className="btn-secondary" onClick={() => setCreating(false)}>Cancel</button>
              <button
                className="btn-primary"
                disabled={!form.name || !form.cidr || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? 'Creating…' : 'Add Subnet'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Checkbox({ id, label, checked, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <input type="checkbox" id={id} className="w-4 h-4 rounded text-primary-600"
        checked={checked} onChange={e => onChange(e.target.checked)} />
      <label htmlFor={id} className="text-sm text-slate-600 cursor-pointer">{label}</label>
    </div>
  );
}
