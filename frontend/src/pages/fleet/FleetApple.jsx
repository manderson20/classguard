import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import {
  mdiTablet, mdiPencil, mdiCertificateOutline, mdiCheckCircle,
  mdiAlertCircle, mdiDownload, mdiCalendar, mdiAutorenew, mdiSync,
} from '@mdi/js';
import api from '../../lib/api';

const OS_TABS = [
  { value: '',        label: 'All'     },
  { value: 'macOS',   label: 'macOS'   },
  { value: 'iOS',     label: 'iOS'     },
  { value: 'iPadOS',  label: 'iPadOS'  },
];

const VIEW_TABS = [
  { value: 'devices', label: 'All Devices'            },
  { value: 'cert',    label: 'Push Certificate Status' },
];

function UpdateBadge({ status }) {
  const map = {
    upToDate: { cls: 'bg-green-100 text-green-700',   label: 'Up to Date'       },
    behind:   { cls: 'bg-amber-100 text-amber-700',   label: 'Update Available' },
    unknown:  { cls: 'bg-slate-100 text-slate-500',   label: 'Unknown'          },
  };
  const { cls, label } = map[status] || map.unknown;
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cls}`}>
      {label}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

function OsRefModal({ onClose }) {
  const qc = useQueryClient();
  const { data: refs = [], isLoading } = useQuery({
    queryKey: ['fleet-apple-os-ref'],
    queryFn:  () => api.get('/fleet/apple/os-reference'),
    staleTime: 60_000,
  });

  const [edits, setEdits] = useState({});

  const updateMutation = useMutation({
    mutationFn: ({ family, latest_version, min_supported_version }) =>
      api.put(`/fleet/apple/os-reference/${encodeURIComponent(family)}`, { latest_version, min_supported_version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fleet-apple-os-ref'] });
      qc.invalidateQueries({ queryKey: ['fleet-apple'] });
    },
  });

  const getEdit = (family, field, fallback) =>
    edits[family]?.[field] !== undefined ? edits[family][field] : fallback;

  const setEdit = (family, field, value) =>
    setEdits(prev => ({ ...prev, [family]: { ...prev[family], [field]: value } }));

  const handleSave = (ref) => {
    const latest = getEdit(ref.os_family, 'latest_version',       ref.latest_version);
    const minSup = getEdit(ref.os_family, 'min_supported_version', ref.min_supported_version);
    updateMutation.mutate({ family: ref.os_family, latest_version: latest, min_supported_version: minSup });
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900">Override OS Reference Versions</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>
        <div className="px-6 py-4 space-y-4">
          {isLoading && (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => <div key={i} className="animate-pulse h-16 bg-slate-100 rounded" />)}
            </div>
          )}
          {!isLoading && refs.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-4">No OS reference data available.</p>
          )}
          {refs.map(ref => (
            <div key={ref.os_family} className="border border-slate-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="font-semibold text-slate-900">{ref.os_family}</span>
                {ref.notes && <span className="text-xs text-slate-400">{ref.notes}</span>}
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-slate-500">Latest Version</span>
                  <input
                    type="text"
                    className="input w-full"
                    value={getEdit(ref.os_family, 'latest_version', ref.latest_version || '')}
                    onChange={e => setEdit(ref.os_family, 'latest_version', e.target.value)}
                    placeholder="e.g. 14.5"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-slate-500">Min Supported Version</span>
                  <input
                    type="text"
                    className="input w-full"
                    value={getEdit(ref.os_family, 'min_supported_version', ref.min_supported_version || '')}
                    onChange={e => setEdit(ref.os_family, 'min_supported_version', e.target.value)}
                    placeholder="e.g. 12.0"
                  />
                </label>
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => handleSave(ref)}
                disabled={updateMutation.isPending}
              >
                {updateMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          ))}
        </div>
        <div className="px-6 py-4 border-t border-slate-100">
          <button className="btn btn-secondary w-full" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, color = 'slate' }) {
  const colors = {
    green:  'bg-green-50 border-green-200 text-green-700',
    amber:  'bg-amber-50 border-amber-200 text-amber-700',
    slate:  'bg-slate-50 border-slate-200 text-slate-700',
    blue:   'bg-blue-50 border-blue-200 text-blue-700',
  };
  return (
    <div className={`rounded-lg border px-4 py-3 ${colors[color]}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm font-medium mt-0.5">{label}</div>
      {sub && <div className="text-xs mt-0.5 opacity-70">{sub}</div>}
    </div>
  );
}

function exportCsv(devices, certDate) {
  const headers = ['Serial Number', 'Device Name', 'Model', 'OS Type', 'Assigned To', 'Asset Tag', 'Enrolled Date', 'Last Sync'];
  const rows = devices.map(d => [
    d.serialNumber || '',
    d.deviceName   || '',
    d.deviceModel  || '',
    d.osType       || '',
    d.assignedEmail || '',
    d.assetTag     || '',
    d.enrolledAt   ? new Date(d.enrolledAt).toLocaleDateString() : '',
    d.lastSync     ? new Date(d.lastSync).toLocaleDateString()   : '',
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `old-cert-devices-before-${certDate}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function CertStatusView() {
  const qc = useQueryClient();
  const [dateInput,    setDateInput]    = useState('');
  const [appleIdInput, setAppleIdInput] = useState('');
  const [osFilter,     setOsFilter]     = useState('');
  const [search,       setSearch]       = useState('');
  const [showHelp,     setShowHelp]     = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importing,    setImporting]    = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['fleet-apple-cert'],
    queryFn:  () => api.get('/fleet/apple/cert-status'),
    staleTime: 30_000,
  });

  const saveMutation = useMutation({
    mutationFn: ({ certDate, appleId }) => api.put('/fleet/apple/cert-status/threshold', { certDate, appleId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fleet-apple-cert'] });
      setDateInput('');
      setAppleIdInput('');
    },
  });

  const handleCsvImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImporting(true);
    setImportResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await api.post('/fleet/apple/cert-status/import-csv', form);
      setImportResult({ ok: true, ...result });
      qc.invalidateQueries({ queryKey: ['fleet-apple-cert'] });
    } catch (err) {
      setImportResult({ ok: false, error: err.message || 'Upload failed' });
    } finally {
      setImporting(false);
    }
  };

  const certDate     = data?.certDate     || null;
  const autoDetected = data?.autoDetected || false;
  const appleId      = data?.appleId      || null;
  const summary      = data?.summary      || null;
  const allOld       = data?.oldCertDevices || [];

  const filtered = allOld.filter(d => {
    if (osFilter && d.osType !== osFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        d.deviceName?.toLowerCase().includes(q)    ||
        d.serialNumber?.toLowerCase().includes(q)  ||
        d.assignedEmail?.toLowerCase().includes(q) ||
        d.assetTag?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const handleSave = () => {
    saveMutation.mutate({
      certDate: dateInput || certDate || null,
      appleId:  appleIdInput !== '' ? appleIdInput : appleId,
    });
  };

  return (
    <div className="space-y-5">

      {/* Renew vs Replace explainer */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <button
          className="w-full flex items-start justify-between gap-3 text-left"
          onClick={() => setShowHelp(h => !h)}
        >
          <div className="flex items-start gap-2">
            <MdiIcon path={mdiCertificateOutline} size="1.1em" className="text-blue-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-blue-900 text-sm">Renewed vs. Replaced — not the same thing</p>
              <p className="text-blue-700 text-xs mt-0.5">
                Only a certificate <span className="font-semibold">replacement</span> requires wiping all devices. Click for details.
              </p>
            </div>
          </div>
          <span className="text-blue-600 text-lg flex-shrink-0">{showHelp ? '▲' : '▼'}</span>
        </button>

        {showHelp && (
          <div className="mt-3 pt-3 border-t border-blue-200 grid sm:grid-cols-2 gap-4 text-sm">
            <div className="bg-white/70 rounded-lg p-3">
              <p className="font-semibold text-green-700 mb-1">✓ Renewed (same push topic)</p>
              <p className="text-slate-600 text-xs">
                You clicked <strong>Renew</strong> on an existing certificate in the Apple Push Certificates Portal.
                The push topic stays the same — all enrolled devices continue to receive MDM commands normally.
                No device action required.
              </p>
            </div>
            <div className="bg-white/70 rounded-lg p-3">
              <p className="font-semibold text-red-700 mb-1">⚠ Replaced (new push topic)</p>
              <p className="text-slate-600 text-xs">
                You created a <strong>new</strong> certificate (different Apple ID, or the old one expired/was revoked and you
                couldn't renew it). The push topic changes — Mosyle can no longer send MDM commands to any
                previously-enrolled device. Every device must be wiped and re-enrolled.
              </p>
            </div>
            <div className="sm:col-span-2 bg-white/70 rounded-lg p-3">
              <p className="font-semibold text-slate-700 mb-1">Where to find the date and Apple ID</p>
              <p className="text-slate-600 text-xs">
                Go to <strong>Mosyle Manager → Settings → MDM Settings</strong> and look for the Push Certificate section —
                it shows the Apple ID and creation/expiry dates. You can also check the
                <strong> Apple Push Certificates Portal</strong> (identity.apple.com/pushcert) — the certificate history
                shows exactly when each cert was created and under which Apple ID. Use the <strong>Created</strong> date
                of your current certificate as the replacement date below.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Cert date + Apple ID setting */}
      <div className="card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
          <div>
            <h3 className="font-semibold text-slate-900 flex items-center gap-2">
              Certificate Details
            </h3>
            <p className="text-sm text-slate-500 mt-0.5">
              Enter the date your current APNS certificate was <em>created</em> (not renewed) and the Apple ID used.
            </p>
          </div>
          {certDate && (
            <div className={`text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1 flex-shrink-0 ${
              autoDetected ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
            }`}>
              <MdiIcon path={autoDetected ? mdiAlertCircle : mdiCheckCircle} size="0.8em" />
              {autoDetected ? 'Estimated — verify this date' : 'Manually set'}
            </div>
          )}
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
              Certificate Created On
            </span>
            <div className="flex items-center gap-2">
              <MdiIcon path={mdiCalendar} size="1em" className="text-slate-400 flex-shrink-0" />
              <input
                type="date"
                className="input flex-1"
                value={dateInput || certDate || ''}
                onChange={e => setDateInput(e.target.value)}
              />
            </div>
            {autoDetected && certDate && !dateInput && (
              <p className="text-xs text-amber-600">
                Estimated from enrollment spike — may not be accurate. Verify against your cert portal.
              </p>
            )}
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
              Apple ID Used to Create Cert
            </span>
            <input
              type="email"
              className="input"
              placeholder="e.g. mdm-admin@district.org"
              value={appleIdInput || appleId || ''}
              onChange={e => setAppleIdInput(e.target.value)}
            />
            <p className="text-xs text-slate-400">
              The Apple ID shown in Mosyle MDM Settings or the Push Certificates Portal.
            </p>
          </label>
        </div>

        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <button
            className="btn btn-primary btn-sm"
            disabled={(!dateInput && !appleIdInput) || saveMutation.isPending}
            onClick={handleSave}
          >
            {saveMutation.isPending ? 'Saving…' : 'Save'}
          </button>
          {certDate && (
            <button
              className="btn btn-secondary btn-sm"
              disabled={saveMutation.isPending}
              onClick={() => {
                setDateInput('');
                setAppleIdInput('');
                saveMutation.mutate({ certDate: null, appleId: null });
              }}
            >
              Clear
            </button>
          )}
        </div>

        {/* Current saved values summary */}
        {certDate && !dateInput && (
          <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap gap-4 text-sm">
            <div>
              <span className="text-xs text-slate-400 uppercase tracking-wide">Cert created</span>
              <p className="font-semibold text-slate-800 mt-0.5">{new Date(certDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
            </div>
            {appleId && (
              <div>
                <span className="text-xs text-slate-400 uppercase tracking-wide">Apple ID</span>
                <p className="font-semibold text-slate-800 mt-0.5">{appleId}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Mosyle CSV import */}
      <div className="card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="font-semibold text-slate-900">Reconcile from Mosyle Export</h3>
            <p className="text-sm text-slate-500 mt-0.5">
              Export the <strong>converted devices</strong> list from Mosyle and upload it here.
              ClassGuard will mark those devices as on the new certificate and all others as needing re-enrollment.
            </p>
            <p className="text-xs text-slate-400 mt-1">
              In Mosyle: <span className="font-mono bg-slate-100 px-1 rounded">Devices → Filter by push cert status → Export CSV</span>
            </p>
          </div>
          <label className={`btn flex items-center gap-2 flex-shrink-0 cursor-pointer ${importing ? 'opacity-60 pointer-events-none' : 'btn-secondary'}`}>
            <MdiIcon path={mdiDownload} size="0.9em" className="rotate-180" />
            {importing ? 'Importing…' : 'Upload Converted List'}
            <input type="file" accept=".csv,.txt" className="hidden" onChange={handleCsvImport} disabled={importing} />
          </label>
        </div>
        {importResult && (
          <div className={`mt-3 rounded-lg px-4 py-3 text-sm ${importResult.ok ? 'bg-green-50 border border-green-200 text-green-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
            {importResult.ok ? (
              <>
                <span className="font-semibold">Import complete.</span>{' '}
                Matched {importResult.matchedInDb} of {importResult.convertedInFile} UDIDs from file.
                Now showing <span className="font-semibold">{importResult.newCert} on new cert</span> / {importResult.oldCert} needing re-enrollment.
              </>
            ) : (
              <><span className="font-semibold">Import failed:</span> {importResult.error}</>
            )}
          </div>
        )}
      </div>

      {/* Summary stats */}
      {summary && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard
              label="On New Certificate"
              value={summary.newCert.total.toLocaleString()}
              sub={[
                summary.newCert.iOS    && `${summary.newCert.iOS} iPhone`,
                summary.newCert.iPadOS && `${summary.newCert.iPadOS} iPad`,
                summary.newCert.macOS  && `${summary.newCert.macOS} Mac`,
                summary.newCert.tvOS   && `${summary.newCert.tvOS} Apple TV`,
              ].filter(Boolean).join(' · ') || 'No breakdown'}
              color="green"
            />
            <StatCard
              label="Needs Re-enrollment"
              value={summary.oldCert.total.toLocaleString()}
              sub={[
                summary.oldCert.iOS    && `${summary.oldCert.iOS} iPhone`,
                summary.oldCert.iPadOS && `${summary.oldCert.iPadOS} iPad`,
                summary.oldCert.macOS  && `${summary.oldCert.macOS} Mac`,
                summary.oldCert.tvOS   && `${summary.oldCert.tvOS} Apple TV`,
              ].filter(Boolean).join(' · ') || 'No breakdown'}
              color={summary.oldCert.total > 0 ? 'amber' : 'green'}
            />
            <StatCard
              label="Total Apple Devices"
              value={(summary.newCert.total + summary.oldCert.total).toLocaleString()}
              color="slate"
            />
            <StatCard
              label="Re-enrollment Progress"
              value={`${Math.round((summary.newCert.total / (summary.newCert.total + summary.oldCert.total)) * 100)}%`}
              sub={`${summary.newCert.total} of ${summary.newCert.total + summary.oldCert.total} completed`}
              color="blue"
            />
          </div>

          {summary.oldCert.total > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-start gap-3">
              <MdiIcon path={mdiAlertCircle} size="1.1em" className="text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-amber-800">
                <span className="font-semibold">{summary.oldCert.total} device{summary.oldCert.total !== 1 ? 's' : ''} cannot receive MDM push commands.</span>
                {' '}These devices are enrolled under the old APNS certificate. Commands sent from Mosyle (lock, wipe, profile install) will silently fail until the device is wiped and re-enrolled.
              </div>
            </div>
          )}
        </>
      )}

      {/* Old cert device table */}
      {summary && summary.oldCert.total > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3 flex-wrap">
            <h3 className="font-semibold text-slate-900">
              Devices Needing Re-enrollment
              <span className="ml-2 text-sm font-normal text-slate-500">({allOld.length})</span>
            </h3>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                className="input text-sm py-1 w-48"
                placeholder="Search name, serial, email…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {['', 'iOS', 'iPadOS', 'macOS', 'tvOS'].map(os => (
                <button
                  key={os}
                  onClick={() => setOsFilter(os)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    osFilter === os ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {os || 'All'}
                </button>
              ))}
              <button
                className="btn btn-secondary btn-sm flex items-center gap-1.5"
                onClick={() => exportCsv(allOld, certDate)}
              >
                <MdiIcon path={mdiDownload} size="0.85em" />
                Export CSV
              </button>
            </div>
          </div>

          {isLoading ? (
            <div className="p-8 space-y-3">
              {[...Array(6)].map((_, i) => <div key={i} className="animate-pulse h-8 bg-slate-100 rounded" />)}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
                    <th className="px-4 py-2 text-left">Device</th>
                    <th className="px-4 py-2 text-left">Serial</th>
                    <th className="px-4 py-2 text-left">Type</th>
                    <th className="px-4 py-2 text-left">Assigned To</th>
                    <th className="px-4 py-2 text-left">Asset Tag</th>
                    <th className="px-4 py-2 text-left">Last Enrolled</th>
                    <th className="px-4 py-2 text-left">Last Seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400 text-sm">No devices match your filters.</td></tr>
                  ) : filtered.map(d => (
                    <tr key={d.serialNumber || d.deviceName} className="hover:bg-amber-50/40 transition-colors">
                      <td className="px-4 py-2 font-medium text-slate-900">{d.deviceName || '—'}</td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-600">{d.serialNumber || '—'}</td>
                      <td className="px-4 py-2">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          d.osType === 'macOS'  ? 'bg-slate-100 text-slate-700' :
                          d.osType === 'iPadOS' ? 'bg-blue-100 text-blue-700'   :
                                                  'bg-purple-100 text-purple-700'
                        }`}>{d.osType || '—'}</span>
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-600">{d.assignedEmail || '—'}</td>
                      <td className="px-4 py-2 text-xs text-slate-600">{d.assetTag || '—'}</td>
                      <td className="px-4 py-2 text-xs text-amber-700 font-medium">{fmtDate(d.enrolledAt)}</td>
                      <td className="px-4 py-2 text-xs text-slate-400">{fmtDate(d.lastSync)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {summary && summary.oldCert.total === 0 && (
        <div className="card p-12 text-center">
          <MdiIcon path={mdiCheckCircle} size="2.5em" className="text-green-500 mx-auto mb-3" />
          <p className="text-green-700 font-semibold text-lg">All devices are on the new certificate!</p>
          <p className="text-slate-500 text-sm mt-1">Every Apple device in Mosyle has been re-enrolled after the cert replacement.</p>
        </div>
      )}
    </div>
  );
}

export default function FleetApple() {
  const [activeView,    setActiveView]    = useState('devices');
  const [osFilter,      setOsFilter]      = useState('');
  const [updateFilter,  setUpdateFilter]  = useState('');
  const [showRefModal,  setShowRefModal]  = useState(false);
  const [syncResult,    setSyncResult]    = useState(null);
  const qc = useQueryClient();

  const params = new URLSearchParams();
  if (osFilter)     params.set('os',           osFilter);
  if (updateFilter) params.set('updateStatus', updateFilter);

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['fleet-apple', osFilter, updateFilter],
    queryFn:  () => api.get(`/fleet/apple?${params.toString()}`),
    staleTime: 30_000,
    enabled: activeView === 'devices',
  });

  const syncMutation = useMutation({
    mutationFn: () => api.post('/fleet/apple/os-reference/sync'),
    onSuccess: (result) => {
      setSyncResult(result);
      qc.invalidateQueries({ queryKey: ['fleet-apple'] });
      qc.invalidateQueries({ queryKey: ['fleet-apple-os-ref'] });
      setTimeout(() => setSyncResult(null), 8000);
    },
  });

  return (
    <div className="p-6">
      <div className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <MdiIcon path={mdiTablet} size="1.2em" className="text-primary-600" />
            Apple Devices
          </h1>
          <p className="text-slate-500 text-sm mt-0.5">
            macOS, iOS, and iPadOS devices from Mosyle
          </p>
        </div>
        {activeView === 'devices' && (
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
            <button
              className="btn btn-secondary flex items-center gap-1.5"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              title="Fetch latest iOS/iPadOS/macOS versions from the SOFA feed (Mac Admins community)"
            >
              <MdiIcon path={mdiSync} size="0.9em" className={syncMutation.isPending ? 'animate-spin' : ''} />
              {syncMutation.isPending ? 'Syncing…' : 'Sync from Apple'}
            </button>
            <button
              className="btn btn-secondary flex items-center gap-1.5"
              onClick={() => setShowRefModal(true)}
            >
              <MdiIcon path={mdiPencil} size="0.9em" />
              Override Versions
            </button>
          </div>
        )}
      </div>

      {/* Sync success banner */}
      {syncResult && (
        <div className="mb-4 bg-green-50 border border-green-200 rounded-lg px-4 py-3 flex items-center justify-between gap-3">
          <p className="text-sm text-green-800">
            <span className="font-semibold">SOFA feed synced.</span>{' '}
            {[
              syncResult.ios   && `iOS/iPadOS: ${syncResult.ios}`,
              syncResult.macos && `macOS: ${syncResult.macos}`,
            ].filter(Boolean).join(' · ') || 'No versions returned from feed.'}
          </p>
          <button onClick={() => setSyncResult(null)} className="text-green-500 hover:text-green-700 text-lg leading-none flex-shrink-0">×</button>
        </div>
      )}

      {syncMutation.isError && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
          Sync failed: {syncMutation.error?.message || 'Unknown error'}
        </div>
      )}

      {/* View tabs */}
      <div className="flex gap-1 mb-5 border-b border-slate-200">
        {VIEW_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => setActiveView(tab.value)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeView === tab.value
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeView === 'cert' && <CertStatusView />}

      {activeView === 'devices' && (
        <>
          {/* OS tabs */}
          <div className="flex gap-1 mb-3 flex-wrap">
            {OS_TABS.map(tab => (
              <button
                key={tab.value}
                onClick={() => setOsFilter(tab.value)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  osFilter === tab.value
                    ? 'bg-primary-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Update status filter */}
          <div className="flex gap-2 mb-4 items-center">
            <span className="text-xs text-slate-500">Update status:</span>
            {[{ value: '', label: 'All' }, { value: 'upToDate', label: 'Up to Date' }, { value: 'behind', label: 'Behind' }, { value: 'unknown', label: 'Unknown' }].map(opt => (
              <button
                key={opt.value}
                onClick={() => setUpdateFilter(opt.value)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  updateFilter === opt.value
                    ? 'bg-slate-700 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="card overflow-hidden">
            {isLoading ? (
              <div className="p-8 space-y-3">
                {[...Array(8)].map((_, i) => (
                  <div key={i} className="animate-pulse h-8 bg-slate-100 rounded" />
                ))}
              </div>
            ) : devices.length === 0 ? (
              <div className="p-12 text-center text-slate-400 text-sm">No Apple devices match your filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
                      <th className="px-4 py-2 text-left">Device</th>
                      <th className="px-4 py-2 text-left">Serial</th>
                      <th className="px-4 py-2 text-left">Model</th>
                      <th className="px-4 py-2 text-left">OS</th>
                      <th className="px-4 py-2 text-left">Current Ver.</th>
                      <th className="px-4 py-2 text-left">Latest Ver.</th>
                      <th className="px-4 py-2 text-left">Status</th>
                      <th className="px-4 py-2 text-left">Assigned</th>
                      <th className="px-4 py-2 text-left">Asset Tag</th>
                      <th className="px-4 py-2 text-left">Last Sync</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {devices.map(d => (
                      <tr key={d.serialNumber} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-2 font-medium text-slate-900">{d.deviceName || '—'}</td>
                        <td className="px-4 py-2 font-mono text-xs text-slate-600">{d.serialNumber}</td>
                        <td className="px-4 py-2 text-slate-600">{d.deviceModel || '—'}</td>
                        <td className="px-4 py-2 text-slate-600">{d.osType || '—'}</td>
                        <td className="px-4 py-2 font-mono text-xs text-slate-600">{d.osVersion || '—'}</td>
                        <td className="px-4 py-2 font-mono text-xs text-slate-600">{d.latestVersion || '—'}</td>
                        <td className="px-4 py-2"><UpdateBadge status={d.updateStatus} /></td>
                        <td className="px-4 py-2 text-xs text-slate-600">{d.assignedEmail || '—'}</td>
                        <td className="px-4 py-2 text-xs text-slate-600">{d.assetTag || '—'}</td>
                        <td className="px-4 py-2 text-xs text-slate-500">{fmtDate(d.lastSync)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {showRefModal && <OsRefModal onClose={() => setShowRefModal(false)} />}
    </div>
  );
}
