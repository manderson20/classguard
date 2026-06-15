import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function Badge({ label, color = 'slate' }) {
  const colors = {
    slate:  'bg-slate-100 text-slate-600',
    blue:   'bg-blue-100 text-blue-700',
    green:  'bg-green-100 text-green-700',
    red:    'bg-red-100 text-red-700',
    yellow: 'bg-yellow-100 text-yellow-700',
    purple: 'bg-purple-100 text-purple-700',
    orange: 'bg-orange-100 text-orange-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[color] ?? colors.slate}`}>
      {label}
    </span>
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

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}
      {children}
    </label>
  );
}

const INPUT = 'border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary-500';

// ---------------------------------------------------------------------------
// Subnets tab (IPAM subnets — IPv4 + IPv6)
// ---------------------------------------------------------------------------
const EMPTY_SUBNET = { subnet:'', ip_version:4, name:'', description:'', gateway:'', notes:'' };

function SubnetsTab({ sections, vrfs, vlans }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(EMPTY_SUBNET);
  const [ipvFilter, setIpv] = useState('');

  const { data: subnets = [] } = useQuery({
    queryKey: ['ipam-subnets', ipvFilter],
    queryFn:  () => api.get(`/ipam/ipam-subnets${ipvFilter ? `?ip_version=${ipvFilter}` : ''}`),
  });

  const save = useMutation({
    mutationFn: () => modal === 'add'
      ? api.post('/ipam/ipam-subnets', { ...form, ip_version: parseInt(form.ip_version, 10) })
      : api.put(`/ipam/ipam-subnets/${modal.id}`, form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ipam-subnets'] }); setModal(null); },
  });

  const del = useMutation({
    mutationFn: id => api.delete(`/ipam/ipam-subnets/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ipam-subnets'] }),
  });

  const ipvColor = v => v === 6 ? 'purple' : 'blue';

  return (
    <>
      <div className="flex items-center gap-3 mb-3">
        <select value={ipvFilter} onChange={e => setIpv(e.target.value)} className={INPUT}>
          <option value="">All versions</option>
          <option value="4">IPv4 only</option>
          <option value="6">IPv6 only</option>
        </select>
        <button className="btn-primary text-sm ml-auto" onClick={() => { setForm(EMPTY_SUBNET); setModal('add'); }}>
          + Add Subnet
        </button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Subnet','Ver','Name','Section','VRF','VLAN','Gateway','IPs',''].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {subnets.map(s => (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono font-semibold text-slate-800">{s.subnet}</td>
                <td className="px-3 py-2"><Badge label={`IPv${s.ip_version}`} color={ipvColor(s.ip_version)} /></td>
                <td className="px-3 py-2 text-slate-700">{s.name || '—'}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{s.section_name || '—'}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{s.vrf_name || '—'}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{s.vlan_name ? `${s.vlan_id} ${s.vlan_name}` : '—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{s.gateway || '—'}</td>
                <td className="px-3 py-2 text-slate-500">{s.ip_count || 0}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <button onClick={() => { setForm(s); setModal(s); }} className="text-xs text-primary-600 hover:underline mr-2">Edit</button>
                  <button onClick={() => del.mutate(s.id)} className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!subnets.length && <tr><td colSpan={9} className="text-center text-slate-400 py-8">No subnets yet</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <Modal title={modal === 'add' ? 'Add Subnet' : 'Edit Subnet'} onClose={() => setModal(null)}>
          <div className="grid grid-cols-2 gap-3">
            {[['Subnet CIDR','subnet'],['Name','name'],['Gateway','gateway'],['Description','description'],['Notes','notes']].map(([l,k]) => (
              <Field key={k} label={l}><input className={INPUT} value={form[k]||''} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))}/></Field>
            ))}
            <Field label="IP Version">
              <select className={INPUT} value={form.ip_version} onChange={e=>setForm(f=>({...f,ip_version:e.target.value}))}>
                <option value={4}>IPv4</option><option value={6}>IPv6</option>
              </select>
            </Field>
            <Field label="Section">
              <select className={INPUT} value={form.section_id||''} onChange={e=>setForm(f=>({...f,section_id:e.target.value||null}))}>
                <option value="">None</option>
                {sections.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="VRF">
              <select className={INPUT} value={form.vrf_id||''} onChange={e=>setForm(f=>({...f,vrf_id:e.target.value||null}))}>
                <option value="">None</option>
                {vrfs.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </Field>
            <Field label="VLAN">
              <select className={INPUT} value={form.vlan_id||''} onChange={e=>setForm(f=>({...f,vlan_id:e.target.value||null}))}>
                <option value="">None</option>
                {vlans.map(v=><option key={v.id} value={v.id}>{v.vlan_id} — {v.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
          {save.isError && <p className="text-red-500 text-xs mt-2">{save.error.message}</p>}
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// VLANs tab
// ---------------------------------------------------------------------------
function VlansTab({ sections }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState({ vlan_id:'', name:'', description:'' });

  const { data: vlans = [] } = useQuery({ queryKey:['vlans'], queryFn:()=>api.get('/ipam/vlans') });
  const save = useMutation({
    mutationFn: () => modal==='add' ? api.post('/ipam/vlans',{...form,vlan_id:parseInt(form.vlan_id,10)}) : api.put(`/ipam/vlans/${modal.id}`,form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['vlans']}); setModal(null); },
  });
  const del = useMutation({ mutationFn: id=>api.delete(`/ipam/vlans/${id}`), onSuccess:()=>qc.invalidateQueries({queryKey:['vlans']}) });

  return (
    <>
      <div className="flex justify-end mb-3"><button className="btn-primary text-sm" onClick={()=>{setForm({vlan_id:'',name:'',description:''});setModal('add')}}>+ Add VLAN</button></div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['VLAN ID','Name','Description','Section',''].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {vlans.map(v=>(
              <tr key={v.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-bold text-slate-800">{v.vlan_id}</td>
                <td className="px-3 py-2 text-slate-700">{v.name||'—'}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{v.description||'—'}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{v.section_name||'—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <button onClick={()=>{setForm(v);setModal(v);}} className="text-xs text-primary-600 hover:underline mr-2">Edit</button>
                  <button onClick={()=>del.mutate(v.id)} className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!vlans.length && <tr><td colSpan={5} className="text-center text-slate-400 py-8">No VLANs yet</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <Modal title={modal==='add'?'Add VLAN':'Edit VLAN'} onClose={()=>setModal(null)}>
          <div className="flex flex-col gap-3">
            {[['VLAN ID (1–4094)','vlan_id'],['Name','name'],['Description','description']].map(([l,k])=>(
              <Field key={k} label={l}><input className={INPUT} value={form[k]||''} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))}/></Field>
            ))}
            <Field label="Section">
              <select className={INPUT} value={form.section_id||''} onChange={e=>setForm(f=>({...f,section_id:e.target.value||null}))}>
                <option value="">None</option>
                {sections.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={()=>save.mutate()} disabled={save.isPending} className="btn-primary text-sm">{save.isPending?'Saving…':'Save'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// VRFs tab
// ---------------------------------------------------------------------------
function VrfsTab() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState({ name:'', rd:'', description:'' });

  const { data: vrfs = [] } = useQuery({ queryKey:['vrfs'], queryFn:()=>api.get('/ipam/vrfs') });
  const save = useMutation({
    mutationFn: () => modal==='add' ? api.post('/ipam/vrfs',form) : api.put(`/ipam/vrfs/${modal.id}`,form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['vrfs']}); setModal(null); },
  });
  const del = useMutation({ mutationFn: id=>api.delete(`/ipam/vrfs/${id}`), onSuccess:()=>qc.invalidateQueries({queryKey:['vrfs']}) });

  return (
    <>
      <div className="flex justify-end mb-3"><button className="btn-primary text-sm" onClick={()=>{setForm({name:'',rd:'',description:''});setModal('add')}}>+ Add VRF</button></div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Name','Route Distinguisher','Description',''].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {vrfs.map(v=>(
              <tr key={v.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-semibold text-slate-800">{v.name}</td>
                <td className="px-3 py-2 font-mono text-slate-600">{v.rd||'—'}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{v.description||'—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <button onClick={()=>{setForm(v);setModal(v);}} className="text-xs text-primary-600 hover:underline mr-2">Edit</button>
                  <button onClick={()=>del.mutate(v.id)} className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!vrfs.length && <tr><td colSpan={4} className="text-center text-slate-400 py-8">No VRFs yet</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <Modal title={modal==='add'?'Add VRF':'Edit VRF'} onClose={()=>setModal(null)}>
          <div className="flex flex-col gap-3">
            {[['Name','name'],['Route Distinguisher (e.g. 65000:100)','rd'],['Description','description']].map(([l,k])=>(
              <Field key={k} label={l}><input className={INPUT} value={form[k]||''} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))}/></Field>
            ))}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={()=>save.mutate()} disabled={save.isPending} className="btn-primary text-sm">{save.isPending?'Saving…':'Save'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// BGP tab
// ---------------------------------------------------------------------------
const BGP_STATUS_COLOR = { active:'green', inactive:'slate', withdrawn:'red' };
const EMPTY_BGP = { prefix:'', ip_version:4, asn:'', peer_asn:'', peer_ip:'', next_hop:'', origin:'IGP', status:'active', description:'' };

function BgpTab({ vrfs }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(EMPTY_BGP);
  const [filter, setFilter] = useState('');

  const { data: prefixes = [] } = useQuery({
    queryKey:['bgp-prefixes'],
    queryFn: ()=>api.get('/ipam/bgp'),
  });

  const filtered = filter ? prefixes.filter(p => p.prefix.includes(filter) || String(p.asn).includes(filter)) : prefixes;

  const save = useMutation({
    mutationFn: () => modal==='add'
      ? api.post('/ipam/bgp', {...form, asn:parseInt(form.asn)||null, peer_asn:parseInt(form.peer_asn)||null, ip_version:parseInt(form.ip_version,10)})
      : api.put(`/ipam/bgp/${modal.id}`, form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['bgp-prefixes']}); setModal(null); },
  });
  const del = useMutation({ mutationFn:id=>api.delete(`/ipam/bgp/${id}`), onSuccess:()=>qc.invalidateQueries({queryKey:['bgp-prefixes']}) });

  return (
    <>
      <div className="flex items-center gap-3 mb-3">
        <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Filter by prefix or ASN…" className={`${INPUT} flex-1`}/>
        <button className="btn-primary text-sm" onClick={()=>{setForm(EMPTY_BGP);setModal('add')}}>+ Add Prefix</button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Prefix','Ver','ASN','Peer ASN','Peer IP','Next Hop','Origin','Status','VRF',''].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map(p=>(
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-mono font-semibold text-slate-800">{p.prefix}</td>
                <td className="px-3 py-2"><Badge label={`IPv${p.ip_version}`} color={p.ip_version===6?'purple':'blue'}/></td>
                <td className="px-3 py-2 text-slate-600">{p.asn||'—'}</td>
                <td className="px-3 py-2 text-slate-600">{p.peer_asn||'—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{p.peer_ip||'—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{p.next_hop||'—'}</td>
                <td className="px-3 py-2"><Badge label={p.origin||'—'} color="slate"/></td>
                <td className="px-3 py-2"><Badge label={p.status} color={BGP_STATUS_COLOR[p.status]||'slate'}/></td>
                <td className="px-3 py-2 text-xs text-slate-500">{p.vrf_name||'—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <button onClick={()=>{setForm(p);setModal(p)}} className="text-xs text-primary-600 hover:underline mr-2">Edit</button>
                  <button onClick={()=>del.mutate(p.id)} className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan={10} className="text-center text-slate-400 py-8">No BGP prefixes</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <Modal title={modal==='add'?'Add BGP Prefix':'Edit BGP Prefix'} onClose={()=>setModal(null)}>
          <div className="grid grid-cols-2 gap-3">
            {[['Prefix (CIDR)','prefix'],['Origin ASN','asn'],['Peer ASN','peer_asn'],['Peer IP','peer_ip'],['Next Hop','next_hop'],['Description','description']].map(([l,k])=>(
              <Field key={k} label={l}><input className={INPUT} value={form[k]||''} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))}/></Field>
            ))}
            <Field label="IP Version">
              <select className={INPUT} value={form.ip_version} onChange={e=>setForm(f=>({...f,ip_version:e.target.value}))}>
                <option value={4}>IPv4</option><option value={6}>IPv6</option>
              </select>
            </Field>
            <Field label="Origin">
              <select className={INPUT} value={form.origin||'IGP'} onChange={e=>setForm(f=>({...f,origin:e.target.value}))}>
                {['IGP','EGP','INCOMPLETE'].map(o=><option key={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select className={INPUT} value={form.status||'active'} onChange={e=>setForm(f=>({...f,status:e.target.value}))}>
                {['active','inactive','withdrawn'].map(s=><option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="VRF">
              <select className={INPUT} value={form.vrf_id||''} onChange={e=>setForm(f=>({...f,vrf_id:e.target.value||null}))}>
                <option value="">None</option>
                {vrfs.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={()=>save.mutate()} disabled={save.isPending} className="btn-primary text-sm">{save.isPending?'Saving…':'Save'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// NAT Rules tab
// ---------------------------------------------------------------------------
const NAT_TYPES = ['source','destination','masquerade','static','pat'];
const EMPTY_NAT = { name:'', nat_type:'source', src_prefix:'', dst_prefix:'', translated_src:'', translated_dst:'', protocol:'any', description:'' };

function NatTab() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(EMPTY_NAT);

  const { data: rules = [] } = useQuery({ queryKey:['nat-rules'], queryFn:()=>api.get('/ipam/nat') });
  const save = useMutation({
    mutationFn: () => modal==='add' ? api.post('/ipam/nat',form) : api.put(`/ipam/nat/${modal.id}`,form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['nat-rules']}); setModal(null); },
  });
  const del = useMutation({ mutationFn:id=>api.delete(`/ipam/nat/${id}`), onSuccess:()=>qc.invalidateQueries({queryKey:['nat-rules']}) });

  return (
    <>
      <div className="flex justify-end mb-3"><button className="btn-primary text-sm" onClick={()=>{setForm(EMPTY_NAT);setModal('add')}}>+ Add NAT Rule</button></div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase">
            <tr>{['Name','Type','Source','Destination','Translated Src','Translated Dst','Proto','Active',''].map(h=><th key={h} className="px-3 py-2 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rules.map(r=>(
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-3 py-2 font-semibold text-slate-800">{r.name}</td>
                <td className="px-3 py-2"><Badge label={r.nat_type} color="blue"/></td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.src_prefix||'any'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.dst_prefix||'any'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.translated_src||'—'}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.translated_dst||'—'}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{r.protocol}</td>
                <td className="px-3 py-2">
                  <span className={`w-2 h-2 rounded-full inline-block ${r.is_active?'bg-green-400':'bg-slate-300'}`}/>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <button onClick={()=>{setForm(r);setModal(r)}} className="text-xs text-primary-600 hover:underline mr-2">Edit</button>
                  <button onClick={()=>del.mutate(r.id)} className="text-xs text-red-500 hover:underline">Del</button>
                </td>
              </tr>
            ))}
            {!rules.length && <tr><td colSpan={9} className="text-center text-slate-400 py-8">No NAT rules</td></tr>}
          </tbody>
        </table>
      </div>
      {modal && (
        <Modal title={modal==='add'?'Add NAT Rule':'Edit NAT Rule'} onClose={()=>setModal(null)}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name (span 2)">
              <input className={INPUT} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/>
            </Field>
            <Field label="NAT Type">
              <select className={INPUT} value={form.nat_type} onChange={e=>setForm(f=>({...f,nat_type:e.target.value}))}>
                {NAT_TYPES.map(t=><option key={t}>{t}</option>)}
              </select>
            </Field>
            {[['Source Prefix','src_prefix'],['Destination Prefix','dst_prefix'],
              ['Translated Source','translated_src'],['Translated Dest','translated_dst'],
              ['Src Port','src_port'],['Dst Port','dst_port'],
              ['Translated Port','translated_port'],['Interface','interface'],['Description','description']].map(([l,k])=>(
              <Field key={k} label={l}><input className={INPUT} value={form[k]||''} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))}/></Field>
            ))}
            <Field label="Protocol">
              <select className={INPUT} value={form.protocol||'any'} onChange={e=>setForm(f=>({...f,protocol:e.target.value}))}>
                {['any','tcp','udp','icmp'].map(p=><option key={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Active">
              <input type="checkbox" checked={form.is_active!==false} onChange={e=>setForm(f=>({...f,is_active:e.target.checked}))} className="mt-1"/>
            </Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={()=>save.mutate()} disabled={save.isPending} className="btn-primary text-sm">{save.isPending?'Saving…':'Save'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sections tab
// ---------------------------------------------------------------------------
function SectionsTab() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState({ name:'', description:'', color:'#3b82f6' });
  const { data: sections=[] } = useQuery({ queryKey:['ipam-sections'], queryFn:()=>api.get('/ipam/sections') });
  const save = useMutation({
    mutationFn: () => modal==='add' ? api.post('/ipam/sections',form) : api.put(`/ipam/sections/${modal.id}`,form),
    onSuccess: () => { qc.invalidateQueries({queryKey:['ipam-sections']}); setModal(null); },
  });
  const del = useMutation({ mutationFn:id=>api.delete(`/ipam/sections/${id}`), onSuccess:()=>qc.invalidateQueries({queryKey:['ipam-sections']}) });

  return (
    <>
      <div className="flex justify-end mb-3"><button className="btn-primary text-sm" onClick={()=>{setForm({name:'',description:'',color:'#3b82f6'});setModal('add')}}>+ Add Section</button></div>
      <div className="grid gap-3">
        {sections.map(s=>(
          <div key={s.id} className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg bg-white">
            <div className="w-4 h-4 rounded-full flex-shrink-0" style={{background:s.color||'#3b82f6'}}/>
            <div className="flex-1">
              <div className="font-medium text-slate-800 text-sm">{s.name}</div>
              <div className="text-xs text-slate-500">{s.description||'No description'}</div>
            </div>
            <button onClick={()=>{setForm(s);setModal(s)}} className="text-xs text-primary-600 hover:underline mr-2">Edit</button>
            <button onClick={()=>del.mutate(s.id)} className="text-xs text-red-500 hover:underline">Delete</button>
          </div>
        ))}
        {!sections.length && <p className="text-center text-slate-400 py-8 text-sm">No sections yet</p>}
      </div>
      {modal && (
        <Modal title={modal==='add'?'Add Section':'Edit Section'} onClose={()=>setModal(null)}>
          <div className="flex flex-col gap-3">
            {[['Name','name'],['Description','description']].map(([l,k])=>(
              <Field key={k} label={l}><input className={INPUT} value={form[k]||''} onChange={e=>setForm(f=>({...f,[k]:e.target.value}))}/></Field>
            ))}
            <Field label="Color"><input type="color" value={form.color||'#3b82f6'} onChange={e=>setForm(f=>({...f,color:e.target.value}))} className="h-8 w-16 rounded cursor-pointer border border-slate-300"/></Field>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={()=>setModal(null)} className="btn-secondary text-sm">Cancel</button>
            <button onClick={()=>save.mutate()} disabled={save.isPending} className="btn-primary text-sm">{save.isPending?'Saving…':'Save'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
const TABS = ['Subnets','VLANs','VRFs','Sections','BGP','NAT'];

export default function IpamFullPage() {
  const [tab, setTab] = useState('Subnets');

  const { data: sections=[] } = useQuery({ queryKey:['ipam-sections'], queryFn:()=>api.get('/ipam/sections') });
  const { data: vrfs=[] }     = useQuery({ queryKey:['vrfs'],          queryFn:()=>api.get('/ipam/vrfs') });
  const { data: vlans=[] }    = useQuery({ queryKey:['vlans'],         queryFn:()=>api.get('/ipam/vlans') });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-slate-900">IPAM</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          IP Address Management — IPv4, IPv6, VLANs, VRFs, BGP, NAT
          {' · '}<Link to="/admin/ipam/subnets" className="text-primary-600 hover:underline">Classic subnet view →</Link>
        </p>
      </div>

      <div className="flex gap-1 border-b border-slate-200 mb-5">
        {TABS.map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors
              ${tab===t ? 'bg-white border border-b-white border-slate-200 text-primary-700 -mb-px' : 'text-slate-500 hover:text-slate-700'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab==='Subnets'  && <SubnetsTab sections={sections} vrfs={vrfs} vlans={vlans}/>}
      {tab==='VLANs'    && <VlansTab sections={sections}/>}
      {tab==='VRFs'     && <VrfsTab/>}
      {tab==='Sections' && <SectionsTab/>}
      {tab==='BGP'      && <BgpTab vrfs={vrfs}/>}
      {tab==='NAT'      && <NatTab/>}
    </div>
  );
}
