/**
 * Renders a visual IP subnet map.
 * Each cell represents one IP in the subnet. Color indicates status:
 *   - green: static/documented
 *   - blue:  DHCP reservation
 *   - amber: live DHCP lease (not reserved)
 *   - red:   conflict
 *   - gray:  free
 */

const STATUS_COLORS = {
  static:      'bg-green-400 hover:bg-green-500',
  reservation: 'bg-blue-400 hover:bg-blue-500',
  lease:       'bg-amber-300 hover:bg-amber-400',
  conflict:    'bg-red-500 hover:bg-red-600 ring-2 ring-red-700',
  free:        'bg-slate-100 hover:bg-slate-200',
};

const STATUS_LABELS = {
  static:      'Static',
  reservation: 'DHCP Reservation',
  lease:       'Active Lease',
  conflict:    'Conflict',
  free:        'Free',
};

export default function SubnetMap({ entries = [], onCellClick }) {
  if (entries.length === 0) {
    return (
      <div className="py-10 text-center text-slate-400 text-sm">
        No IP data available for this subnet
      </div>
    );
  }

  return (
    <div>
      {/* Legend */}
      <div className="flex flex-wrap gap-4 mb-4">
        {Object.entries(STATUS_LABELS).map(([k, label]) => (
          <div key={k} className="flex items-center gap-1.5 text-xs text-slate-600">
            <div className={`w-3 h-3 rounded-sm ${STATUS_COLORS[k]}`} />
            {label}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="flex flex-wrap gap-1">
        {entries.map(entry => {
          const status = entry.status || 'free';
          return (
            <button
              key={entry.ip}
              title={buildTitle(entry)}
              onClick={() => onCellClick?.(entry)}
              className={`w-8 h-8 rounded text-[9px] font-mono transition-colors
                ${STATUS_COLORS[status] || STATUS_COLORS.free}
                ${status === 'free' ? 'cursor-default' : 'cursor-pointer'}`}
            >
              {lastOctet(entry.ip)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function lastOctet(ip) {
  return ip ? ip.split('.').pop() : '?';
}

function buildTitle(entry) {
  const parts = [entry.ip];
  if (entry.hostname)    parts.push(`Host: ${entry.hostname}`);
  if (entry.mac_address) parts.push(`MAC: ${entry.mac_address}`);
  if (entry.owner)       parts.push(`Owner: ${entry.owner}`);
  if (entry.status)      parts.push(`Status: ${STATUS_LABELS[entry.status] || entry.status}`);
  return parts.join('\n');
}
