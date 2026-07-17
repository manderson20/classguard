import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import api from '../../lib/api';
import VlanInfoModal from '../../components/VlanInfoModal';

const ACTION_COLORS = {
  allowed: 'text-green-600',
  blocked: 'text-red-600',
};

function Row({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-slate-500 flex-shrink-0">{label}</span>
      <span className="text-right text-slate-800 break-all">{value ?? '—'}</span>
    </div>
  );
}

export default function NetworkDeviceDetail() {
  const { mac } = useParams();
  const [showVlanInfo, setShowVlanInfo] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['network-device', mac],
    queryFn:  () => api.get(`/network/clients/lookup/${mac}`),
  });

  if (isLoading) {
    return <div className="p-6 text-slate-400 text-sm">Loading…</div>;
  }

  const network = data?.network || null;
  const dhcp    = data?.dhcp    || null;
  const device  = data?.device  || null;
  const dns     = data?.recent_dns || [];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-2 mb-5 text-sm text-slate-400">
        <Link to="/admin/network" className="hover:text-primary-600">Network Infrastructure</Link>
        <span>›</span>
        <span className="text-slate-700 font-mono">{mac}</span>
      </div>

      {!network && !dhcp && !device ? (
        <div className="card p-12 text-center text-slate-400">
          <div className="text-3xl mb-3">📡</div>
          <div className="font-medium">No data found for this MAC address</div>
          <div className="text-xs mt-1">It may have aged out of the network controller's client list.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Network activity */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Network Activity</h2>
            {network ? (
              <div className="space-y-2 text-sm">
                <Row label="IP Address"      value={network.ip_address} />
                <Row label="Hostname"        value={network.hostname} />
                <Row label="Connection"      value={network.connection_type} />
                <Row label="Status"          value={network.status} />
                {network.connection_type === 'wireless' && (
                  <>
                    <Row label="Access Point" value={network.ap_name} />
                    <Row label="SSID"         value={network.ssid} />
                    <Row label="RSSI"         value={network.rssi != null ? `${network.rssi} dBm` : null} />
                    <Row label="Channel"      value={network.channel} />
                    <Row label="Radio"        value={network.radio_type} />
                  </>
                )}
                {network.connection_type === 'wired' && (
                  <>
                    <Row label="Switch"      value={network.switch_name} />
                    <Row label="Port"        value={network.switch_port} />
                  </>
                )}
                <Row label="VLAN" value={network.vlan
                  ? <button onClick={()=>setShowVlanInfo(true)} className="text-primary-600 hover:underline">{network.vlan}</button>
                  : null} />
                {showVlanInfo && (
                  <VlanInfoModal vlan={network.vlan} controllerId={network.controller_id} onClose={()=>setShowVlanInfo(false)} />
                )}
                <Row label="OS"              value={network.os_type} />
                <Row label="Vendor (OUI)"    value={network.vendor_oui} />
                <Row label="Controller"      value={network.controller_name} />
                <Row label="First seen"      value={network.first_seen ? new Date(network.first_seen).toLocaleString() : null} />
                <Row label="Last seen"       value={network.last_seen ? new Date(network.last_seen).toLocaleString() : null} />
              </div>
            ) : (
              <div className="text-slate-400 text-sm">Not currently seen by any network controller</div>
            )}
          </div>

          {/* Assigned device (MDM/inventory) */}
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Assigned Device</h2>
            {device ? (
              <div className="space-y-2 text-sm">
                <Row label="Name"      value={device.device_name} />
                <Row label="Model"     value={device.device_model} />
                <Row label="OS"        value={device.os_type ? `${device.os_type} ${device.os_version || ''}`.trim() : null} />
                <Row label="Assigned to" value={device.assigned_user || device.assigned_email} />
                <Row label="Source"    value={device.source} />
                <Row label="Serial"    value={device.serial_number} />
                <Row label="Status"    value={device.status} />
                <Row label="Last seen" value={device.last_seen ? new Date(device.last_seen).toLocaleString() : null} />
              </div>
            ) : (
              <div className="text-slate-400 text-sm">No matching device in Mosyle/Snipe-IT/Google Admin</div>
            )}

            <h2 className="text-sm font-semibold text-slate-700 mb-3 mt-5 pt-4 border-t border-slate-100">DHCP Reservation</h2>
            {dhcp ? (
              <div className="space-y-2 text-sm">
                <Row label="Reserved IP" value={dhcp.ip_address} />
                <Row label="Subnet"      value={dhcp.subnet_name ? `${dhcp.subnet_name} (${dhcp.subnet})` : dhcp.subnet} />
                <Row label="Hostname"    value={dhcp.hostname} />
              </div>
            ) : (
              <div className="text-slate-400 text-sm">No DHCP reservation for this MAC</div>
            )}
          </div>

          {/* Recent DNS activity */}
          <div className="card p-5 lg:col-span-2">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Recent DNS Activity (last hour)</h2>
            {dns.length === 0 ? (
              <div className="text-slate-400 text-sm py-2 text-center">
                No DNS activity in the last hour for this device's current IP
              </div>
            ) : (
              <div className="overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="pb-2 text-slate-500 font-semibold">Time</th>
                      <th className="pb-2 text-slate-500 font-semibold">Domain</th>
                      <th className="pb-2 text-slate-500 font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {dns.map((row, i) => (
                      <tr key={i} className="hover:bg-slate-50">
                        <td className="py-1.5 pr-3 font-mono text-slate-400 whitespace-nowrap">
                          {new Date(row.queried_at).toLocaleTimeString()}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-slate-700">{row.domain}</td>
                        <td className={`py-1.5 font-semibold ${ACTION_COLORS[row.action] || 'text-slate-400'}`}>
                          {row.action}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
