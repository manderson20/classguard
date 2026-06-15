import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

const DEVICE_TYPES = ['workstation', 'laptop', 'printer', 'server', 'switch', 'ap', 'camera', 'phone', 'tablet', 'other'];

export default function IpModal({ subnetId, entry, onClose }) {
  const qc = useQueryClient();
  const isNew = !entry?.id;

  const [form, setForm] = useState({
    ip:          '',
    hostname:    '',
    mac_address: '',
    device_type: 'workstation',
    owner:       '',
    tags:        '',
    is_gateway:  false,
    is_static:   true,
    notes:       '',
  });

  const [dnsForm, setDnsForm] = useState({ record_type: 'A', name: '', value: '', ttl: 300, zone: '' });
  const [tab, setTab] = useState('ip');

  useEffect(() => {
    if (entry) {
      setForm({
        ip:          entry.ip          || '',
        hostname:    entry.hostname    || '',
        mac_address: entry.mac_address || '',
        device_type: entry.device_type || 'workstation',
        owner:       entry.owner       || '',
        tags:        (entry.tags || []).join(', '),
        is_gateway:  entry.is_gateway  || false,
        is_static:   entry.is_static   ?? true,
        notes:       entry.notes       || '',
      });
    }
  }, [entry]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...form,
        subnet_id: subnetId,
        tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      };
      return isNew
        ? api.post('/ipam/addresses', payload)
        : api.patch(`/ipam/addresses/${entry.id}`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subnet-map', subnetId] });
      qc.invalidateQueries({ queryKey: ['ipam-addresses'] });
      onClose();
    },
  });

  const del = useMutation({
    mutationFn: () => api.delete(`/ipam/addresses/${entry.id}`),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['subnet-map', subnetId] });
      qc.invalidateQueries({ queryKey: ['ipam-addresses'] });
      onClose();
    },
  });

  const addDns = useMutation({
    mutationFn: () => api.post(`/ipam/addresses/${entry.id}/dns`, dnsForm),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['subnet-map', subnetId] }); setDnsForm({ record_type: 'A', name: '', value: '', ttl: 300, zone: '' }); },
  });

  const deleteDns = useMutation({
    mutationFn: dnsId => api.delete(`/ipam/addresses/${entry.id}/dns/${dnsId}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['subnet-map', subnetId] }),
  });

  const f = (key, val) => setForm(prev => ({ ...prev, [key]: val }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900 text-lg">
            {isNew ? 'Document IP Address' : `Edit ${entry.ip}`}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">✕</button>
        </div>

        {/* Tabs */}
        {!isNew && (
          <div className="flex border-b border-slate-100 px-6">
            {['ip', 'dns'].map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`py-2.5 px-4 text-sm font-medium border-b-2 transition-colors -mb-px
                  ${tab === t ? 'border-primary-600 text-primary-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
              >
                {t === 'ip' ? 'IP Details' : 'DNS Records'}
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tab === 'ip' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">IP Address</label>
                  <input className="input font-mono" placeholder="192.168.1.10"
                    value={form.ip} onChange={e => f('ip', e.target.value)} />
                </div>
                <div>
                  <label className="label">Hostname</label>
                  <input className="input" placeholder="printer-office-1"
                    value={form.hostname} onChange={e => f('hostname', e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">MAC Address</label>
                  <input className="input font-mono" placeholder="aa:bb:cc:dd:ee:ff"
                    value={form.mac_address} onChange={e => f('mac_address', e.target.value)} />
                </div>
                <div>
                  <label className="label">Device Type</label>
                  <select className="input" value={form.device_type} onChange={e => f('device_type', e.target.value)}>
                    {DEVICE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="label">Owner / Description</label>
                <input className="input" placeholder="Room 204 HP LaserJet"
                  value={form.owner} onChange={e => f('owner', e.target.value)} />
              </div>
              <div>
                <label className="label">Tags <span className="text-slate-400 font-normal">(comma-separated)</span></label>
                <input className="input" placeholder="printer, floor-2, managed"
                  value={form.tags} onChange={e => f('tags', e.target.value)} />
              </div>
              <div className="flex items-center gap-6">
                <Checkbox id="is_static" label="Static IP" checked={form.is_static}
                  onChange={v => f('is_static', v)} />
                <Checkbox id="is_gateway" label="Default Gateway" checked={form.is_gateway}
                  onChange={v => f('is_gateway', v)} />
              </div>
            </div>
          )}

          {tab === 'dns' && !isNew && (
            <div>
              {/* Add DNS record */}
              <div className="grid grid-cols-2 gap-3 mb-5 p-4 bg-slate-50 rounded-xl">
                <div>
                  <label className="label">Type</label>
                  <select className="input text-sm" value={dnsForm.record_type}
                    onChange={e => setDnsForm(d => ({ ...d, record_type: e.target.value }))}>
                    {['A','AAAA','CNAME','PTR','MX','TXT','SRV'].map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Name</label>
                  <input className="input text-sm font-mono" placeholder="printer.local"
                    value={dnsForm.name} onChange={e => setDnsForm(d => ({ ...d, name: e.target.value }))} />
                </div>
                <div>
                  <label className="label">Value</label>
                  <input className="input text-sm font-mono" placeholder="192.168.1.10"
                    value={dnsForm.value} onChange={e => setDnsForm(d => ({ ...d, value: e.target.value }))} />
                </div>
                <div>
                  <label className="label">TTL</label>
                  <input type="number" className="input text-sm" value={dnsForm.ttl}
                    onChange={e => setDnsForm(d => ({ ...d, ttl: parseInt(e.target.value) || 300 }))} />
                </div>
                <div className="col-span-2">
                  <label className="label">Zone</label>
                  <input className="input text-sm font-mono" placeholder="school.local"
                    value={dnsForm.zone} onChange={e => setDnsForm(d => ({ ...d, zone: e.target.value }))} />
                </div>
                <div className="col-span-2">
                  <button
                    className="btn-primary w-full"
                    disabled={!dnsForm.name || !dnsForm.value || addDns.isPending}
                    onClick={() => addDns.mutate()}
                  >
                    {addDns.isPending ? 'Adding…' : 'Add Record'}
                  </button>
                </div>
              </div>

              {/* Existing records */}
              {(entry?.dns_records || []).length === 0 ? (
                <div className="text-slate-400 text-sm text-center py-4">No DNS records attached</div>
              ) : (
                <div className="space-y-2">
                  {(entry?.dns_records || []).map(r => (
                    <div key={r.id} className="flex items-center gap-3 p-3 rounded-lg border border-slate-100">
                      <span className="w-12 text-center bg-slate-100 text-slate-700 text-xs font-mono rounded px-1.5 py-0.5">
                        {r.record_type}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-xs text-slate-700">{r.name}</div>
                        <div className="font-mono text-xs text-slate-400">{r.value}</div>
                      </div>
                      <span className="text-xs text-slate-400">TTL {r.ttl}</span>
                      <button
                        className="text-slate-300 hover:text-red-500 text-sm"
                        onClick={() => deleteDns.mutate(r.id)}
                      >✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between">
          <div>
            {!isNew && (
              <button
                className="text-sm text-red-500 hover:underline"
                onClick={() => { if (confirm(`Delete ${entry.ip}?`)) del.mutate(); }}
              >
                Delete IP
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button className="btn-secondary" onClick={onClose}>Cancel</button>
            {tab === 'ip' && (
              <button
                className="btn-primary"
                onClick={() => save.mutate()}
                disabled={!form.ip || save.isPending}
              >
                {save.isPending ? 'Saving…' : (isNew ? 'Document IP' : 'Save')}
              </button>
            )}
          </div>
        </div>
      </div>
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
