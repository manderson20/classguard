import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Icon as MdiIcon } from '@mdi/react';
import {
  mdiAlertCircleOutline,
  mdiCheckCircleOutline,
  mdiMonitor,
  mdiShieldCheckOutline,
  mdiInformationOutline,
  mdiDeleteOutline,
  mdiRefresh,
} from '@mdi/js';
import api from '../../lib/api';

const STATUS_TABS = [
  { value: '',         label: 'All'                     },
  { value: 'expired',  label: 'Expired'                 },
  { value: 'expiring', label: 'Expiring Soon (<12 mo)'  },
  { value: 'ok',       label: 'Current'                 },
  { value: 'unknown',  label: 'Unknown'                 },
];

const GOOGLE_STATUS_TABS = [
  { value: '',              label: 'All Statuses'   },
  { value: 'ACTIVE',        label: 'Active'         },
  { value: 'DISABLED',      label: 'Disabled'       },
  { value: 'DEPROVISIONED', label: 'Deprovisioned'  },
];

const DEPROVISION_REASONS = [
  { value: 'retiring_device',             label: 'Retiring device (end of life)'   },
  { value: 'different_model_replacement', label: 'Replacing with different model'  },
  { value: 'upgrade_transfer',            label: 'Upgrade or transfer'             },
  { value: 'other',                       label: 'Other'                           },
];

function AupBadge({ status }) {
  const map = {
    expired:  { cls: 'bg-red-100 text-red-700',    label: 'Expired'       },
    expiring: { cls: 'bg-amber-100 text-amber-700', label: 'Expiring Soon' },
    ok:       { cls: 'bg-green-100 text-green-700', label: 'Current'       },
    unknown:  { cls: 'bg-slate-100 text-slate-500', label: 'Unknown'       },
  };
  const { cls, label } = map[status] || map.unknown;
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cls}`}>
      {label}
    </span>
  );
}

function AupSourceChip({ source }) {
  if (!source) return null;
  if (source === 'google_admin') {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs bg-slate-100 text-slate-500 ml-1.5"
        title="Date pulled directly from Google Admin API for this device"
      >
        <MdiIcon path={mdiShieldCheckOutline} size="0.75em" />
        Live from Google
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-slate-100 text-slate-500 ml-1.5"
      title="Estimated from model reference table — run a Google Admin sync for per-device accuracy"
    >
      Model estimate
    </span>
  );
}

function LicenseWarningChip() {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-700 ml-1"
      title="This model is marked * on Google's AUP page — the date shown assumes a Chrome Education/Enterprise Upgrade license is active and extended support has been opted into in Google Admin. Without it, this device's support may have already ended."
    >
      ⚠ License required
    </span>
  );
}

function GoogleStatusBadge({ status }) {
  if (!status || status === 'ACTIVE') return null;
  const map = {
    DISABLED:      { cls: 'bg-slate-200 text-slate-600',  label: 'Disabled'      },
    DEPROVISIONED: { cls: 'bg-red-100 text-red-600',       label: 'Deprovisioned' },
  };
  const { cls, label } = map[status] || { cls: 'bg-slate-100 text-slate-500', label: status };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cls}`}>
      {label}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// Modal for disable / reenable / deprovision actions.
function ActionModal({ action, count, onConfirm, onCancel, loading, result }) {
  const [deprovisionReason, setDeprovisionReason] = useState(DEPROVISION_REASONS[0].value);

  const cfg = {
    disable: {
      title:      `Disable ${count} Chromebook${count !== 1 ? 's' : ''}?`,
      icon:       mdiAlertCircleOutline,
      iconCls:    'text-red-500',
      btnCls:     'bg-red-600 hover:bg-red-700',
      resultKey:  'disabled',
      resultVerb: 'Disabled',
      actionVerb: 'Disabling',
      btnLabel:   (n) => `Disable ${n} device${n !== 1 ? 's' : ''}`,
    },
    reenable: {
      title:      `Re-enable ${count} Chromebook${count !== 1 ? 's' : ''}?`,
      icon:       mdiRefresh,
      iconCls:    'text-green-600',
      btnCls:     'bg-green-600 hover:bg-green-700',
      resultKey:  'reenabled',
      resultVerb: 'Re-enabled',
      actionVerb: 'Re-enabling',
      btnLabel:   (n) => `Re-enable ${n} device${n !== 1 ? 's' : ''}`,
    },
    deprovision: {
      title:      `Deprovision ${count} Chromebook${count !== 1 ? 's' : ''}?`,
      icon:       mdiDeleteOutline,
      iconCls:    'text-slate-700',
      btnCls:     'bg-slate-800 hover:bg-slate-900',
      resultKey:  'deprovisioned',
      resultVerb: 'Deprovisioned',
      actionVerb: 'Deprovisioning',
      btnLabel:   (n) => `Deprovision ${n} device${n !== 1 ? 's' : ''}`,
    },
  }[action] || {};

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h2 className="font-bold text-slate-900 flex items-center gap-2">
            <MdiIcon path={cfg.icon} size="1em" className={cfg.iconCls} />
            {cfg.title}
          </h2>
          <button onClick={onCancel} className="text-slate-400 hover:text-slate-700 text-xl">×</button>
        </div>
        <div className="px-6 py-4">
          {result ? (
            <div>
              <p className="text-sm text-green-700 font-medium mb-2">
                {cfg.resultVerb}: {result[cfg.resultKey]}
              </p>
              {result.errors?.length > 0 && (
                <div className="text-sm text-red-600">
                  <p className="font-medium mb-1">Errors:</p>
                  <ul className="list-disc list-inside space-y-1 text-xs">
                    {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
              <button className="btn btn-primary mt-4 w-full" onClick={onCancel}>Close</button>
            </div>
          ) : (
            <>
              {action === 'disable' && (
                <p className="text-sm text-slate-600 mb-4">
                  Students will not be able to sign in to {count === 1 ? 'this device' : 'these devices'} in Google Admin.
                  The device stays enrolled and licensed — you can re-enable it at any time from the Disabled view.
                </p>
              )}
              {action === 'reenable' && (
                <p className="text-sm text-slate-600 mb-4">
                  {count === 1 ? 'This device' : 'These devices'} will be re-activated in Google Admin.
                  Students will be able to sign in again immediately.
                </p>
              )}
              {action === 'deprovision' && (
                <>
                  <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
                    <p className="font-semibold mb-1">This action is irreversible.</p>
                    <p>
                      {count === 1 ? 'This device' : 'These devices'} will be removed from Google MDM and
                      {count === 1 ? ' its' : ' their'} Chrome Education Upgrade license will be freed.
                      Re-provisioning requires a physical wipe and re-enrollment — it cannot be undone from ClassGuard.
                    </p>
                  </div>
                  <label className="block mb-4">
                    <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide block mb-1">
                      Deprovision Reason
                    </span>
                    <select
                      className="input w-full"
                      value={deprovisionReason}
                      onChange={e => setDeprovisionReason(e.target.value)}
                    >
                      {DEPROVISION_REASONS.map(r => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <div className="flex gap-3">
                <button className="btn btn-secondary flex-1" onClick={onCancel} disabled={loading}>
                  Cancel
                </button>
                <button
                  className={`btn flex-1 text-white ${cfg.btnCls}`}
                  onClick={() => onConfirm(action === 'deprovision' ? deprovisionReason : null)}
                  disabled={loading}
                >
                  {loading ? `${cfg.actionVerb}…` : cfg.btnLabel(count)}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function FleetChromebooks() {
  const [statusFilter,       setStatusFilter]       = useState('');
  const [googleStatusFilter, setGoogleStatusFilter] = useState('');
  const [showLicenseOnly,    setShowLicenseOnly]    = useState(false);
  const [selected,           setSelected]           = useState(new Set());
  const [pendingAction,      setPendingAction]      = useState(null); // 'disable' | 'reenable' | 'deprovision' | null
  const [actionResult,       setActionResult]       = useState(null);
  const [bannerDismissed,    setBannerDismissed]    = useState(false);
  const qc = useQueryClient();

  const { data: allDevices = [], isLoading } = useQuery({
    queryKey: ['fleet-chromebooks'],
    queryFn:  () => api.get('/fleet/chromebooks'),
    staleTime: 30_000,
  });

  const stats = useMemo(() => ({
    total:    allDevices.length,
    expired:  allDevices.filter(d => d.aupStatus === 'expired').length,
    expiring: allDevices.filter(d => d.aupStatus === 'expiring').length,
    license:  allDevices.filter(d => d.requiresLicense).length,
  }), [allDevices]);

  const displayedDevices = useMemo(() =>
    allDevices
      .filter(d => !statusFilter       || d.aupStatus    === statusFilter)
      .filter(d => !googleStatusFilter || d.googleStatus === googleStatusFilter)
      .filter(d => !showLicenseOnly    || d.requiresLicense),
    [allDevices, statusFilter, googleStatusFilter, showLicenseOnly]
  );

  const expiredDevices = useMemo(
    () => allDevices.filter(d => d.aupStatus === 'expired' && d.googleDeviceId),
    [allDevices]
  );

  const disableMutation = useMutation({
    mutationFn: (deviceIds) => api.post('/fleet/chromebooks/disable', { deviceIds }),
    onSuccess: (result) => {
      setActionResult(result);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['fleet-chromebooks'] });
      qc.invalidateQueries({ queryKey: ['fleet-summary'] });
    },
  });

  const deprovisionMutation = useMutation({
    mutationFn: ({ deviceIds, reason }) =>
      api.post('/fleet/chromebooks/deprovision', { deviceIds, reason }),
    onSuccess: (result) => {
      setActionResult(result);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['fleet-chromebooks'] });
      qc.invalidateQueries({ queryKey: ['fleet-summary'] });
    },
  });

  const reenableMutation = useMutation({
    mutationFn: (deviceIds) => api.post('/fleet/chromebooks/reenable', { deviceIds }),
    onSuccess: (result) => {
      setActionResult(result);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['fleet-chromebooks'] });
      qc.invalidateQueries({ queryKey: ['fleet-summary'] });
    },
  });

  // Which devices can be checked depends on the Google status filter:
  // Active view → only ACTIVE; Disabled view → only DISABLED; Deprovisioned → none.
  const isSelectable = (d) => {
    if (!d.googleDeviceId) return false;
    if (googleStatusFilter === 'DISABLED')      return d.googleStatus === 'DISABLED';
    if (googleStatusFilter === 'DEPROVISIONED') return false;
    return d.googleStatus === 'ACTIVE' || !d.googleStatus;
  };

  const toggleAll = () => {
    const selectable = displayedDevices.filter(isSelectable).map(d => d.googleDeviceId);
    if (selected.size === selectable.length && selectable.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable));
    }
  };

  const toggleOne = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const selectAllExpired = () => {
    setSelected(new Set(expiredDevices.filter(isSelectable).map(d => d.googleDeviceId)));
  };

  const handleConfirm = (deprovisionReason) => {
    const ids = [...selected];
    if (pendingAction === 'deprovision') {
      deprovisionMutation.mutate({ deviceIds: ids, reason: deprovisionReason });
    } else if (pendingAction === 'reenable') {
      reenableMutation.mutate(ids);
    } else {
      disableMutation.mutate(ids);
    }
  };

  const handleCloseModal = () => {
    setPendingAction(null);
    setActionResult(null);
  };

  const isMutationPending = disableMutation.isPending || deprovisionMutation.isPending || reenableMutation.isPending;

  return (
    <div className="p-6">
      {/* Page header */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <MdiIcon path={mdiMonitor} size="1.2em" className="text-primary-600" />
            Chromebooks
          </h1>
          <p className="text-slate-500 text-sm mt-0.5">
            {allDevices.length > 0
              ? `${allDevices.length.toLocaleString()} device${allDevices.length !== 1 ? 's' : ''}`
              : 'AUP status for all Chromebooks'}
          </p>
        </div>
        {selected.size > 0 && (
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
            {googleStatusFilter === 'DISABLED' ? (
              <>
                <button
                  className="btn flex items-center gap-1.5 bg-green-600 hover:bg-green-700 text-white"
                  onClick={() => setPendingAction('reenable')}
                >
                  <MdiIcon path={mdiRefresh} size="1em" />
                  Re-enable Selected ({selected.size})
                </button>
                <button
                  className="btn flex items-center gap-1.5 bg-slate-800 hover:bg-slate-900 text-white"
                  onClick={() => setPendingAction('deprovision')}
                >
                  <MdiIcon path={mdiDeleteOutline} size="1em" />
                  Deprovision Selected ({selected.size})
                </button>
              </>
            ) : (
              <button
                className="btn flex items-center gap-1.5 bg-red-600 hover:bg-red-700 text-white"
                onClick={() => setPendingAction('disable')}
              >
                <MdiIcon path={mdiAlertCircleOutline} size="1em" />
                Disable Selected ({selected.size})
              </button>
            )}
          </div>
        )}
      </div>

      {/* Summary stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="card p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold">Total Chromebooks</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{stats.total.toLocaleString()}</p>
        </div>
        <div className="card p-4 border-l-4 border-red-400">
          <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold">Expired AUP</p>
          <p className="text-2xl font-bold text-red-600 mt-1">{stats.expired.toLocaleString()}</p>
        </div>
        <div className="card p-4 border-l-4 border-amber-400">
          <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold">Expiring Soon</p>
          <p className="text-2xl font-bold text-amber-600 mt-1">{stats.expiring.toLocaleString()}</p>
        </div>
        <div className="card p-4 border-l-4 border-orange-400">
          <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold">Needs License Verification</p>
          <p className="text-2xl font-bold text-orange-600 mt-1">{stats.license.toLocaleString()}</p>
        </div>
      </div>

      {/* Source accuracy note */}
      <p className="text-xs text-slate-400 flex items-center gap-1 mb-4">
        <MdiIcon path={mdiInformationOutline} size="0.9em" className="flex-shrink-0" />
        AUP dates marked "Live from Google" are pulled directly from each device's record in Google Admin.
        "Model estimate" dates are approximations — run a Google Admin sync (Fleet &gt; Cross-Sync) for per-device accuracy.
      </p>

      {/* License callout banner */}
      {!bannerDismissed && stats.license > 0 && (
        <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
          <MdiIcon path={mdiAlertCircleOutline} size="1.2em" className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 text-sm">
            <p className="font-semibold text-amber-900">Extended Support License Check Required</p>
            <p className="text-amber-800 mt-0.5">
              {stats.license} device{stats.license !== 1 ? 's' : ''} show AUP dates that assume a Chrome Education/Enterprise
              Upgrade license is active and extended support has been opted in via Google Admin Console. Without both, those
              devices may already be unsupported.{' '}
              <a
                href="https://support.google.com/chrome/a/answer/6220366"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-amber-900"
              >
                Learn more ↗
              </a>
            </p>
          </div>
          <button
            onClick={() => setBannerDismissed(true)}
            className="text-amber-500 hover:text-amber-700 text-lg leading-none flex-shrink-0"
          >
            ×
          </button>
        </div>
      )}

      {/* AUP filter bar */}
      <div className="flex flex-wrap gap-1 mb-4 items-center">
        {STATUS_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => { setStatusFilter(tab.value); setShowLicenseOnly(false); setSelected(new Set()); }}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              statusFilter === tab.value && !showLicenseOnly
                ? 'bg-primary-600 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
        <span className="w-px h-5 bg-slate-200 mx-1" />
        <button
          onClick={() => { setShowLicenseOnly(v => !v); setStatusFilter(''); setSelected(new Set()); }}
          className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1 ${
            showLicenseOnly
              ? 'bg-orange-500 text-white'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          ⚠ Needs License Verification
          {stats.license > 0 && (
            <span className={`ml-1 px-1.5 py-0.5 rounded-full text-xs font-bold ${
              showLicenseOnly ? 'bg-white/30 text-white' : 'bg-orange-100 text-orange-700'
            }`}>
              {stats.license}
            </span>
          )}
        </button>
      </div>

      {/* Google Admin Status filter */}
      <div className="flex gap-1 mb-4 items-center flex-wrap">
        <span className="text-xs text-slate-500 mr-1">Google Admin:</span>
        {GOOGLE_STATUS_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => { setGoogleStatusFilter(tab.value); setShowLicenseOnly(false); setSelected(new Set()); }}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              googleStatusFilter === tab.value
                ? 'bg-slate-700 text-white'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Deprovisioned info callout */}
      {googleStatusFilter === 'DEPROVISIONED' && (
        <div className="mb-4 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 flex items-start gap-3">
          <MdiIcon path={mdiInformationOutline} size="1.1em" className="text-slate-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-slate-600">
            <span className="font-semibold">Deprovisioned devices cannot be re-provisioned remotely.</span>{' '}
            Deprovisioning removes the device from Google MDM entirely. To bring a device back into management,
            it must be physically wiped and re-enrolled. Once re-enrolled, it will appear here as Active after the next Google Admin sync.
          </p>
        </div>
      )}

      {/* Disabled view workflow hint */}
      {googleStatusFilter === 'DISABLED' && displayedDevices.length > 0 && (
        <div className="mb-4 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 flex items-start gap-3">
          <MdiIcon path={mdiInformationOutline} size="1.1em" className="text-blue-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-blue-800">
            Select disabled devices to <span className="font-semibold">Re-enable</span> them (reverses the disable),
            or <span className="font-semibold">Deprovision</span> them to permanently free the Chrome Education Upgrade license.
          </p>
        </div>
      )}

      {/* Expired AUP action bar */}
      {statusFilter === 'expired' && expiredDevices.length > 0 && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap">
          <MdiIcon path={mdiAlertCircleOutline} size="1.1em" className="text-red-600 flex-shrink-0" />
          <p className="text-sm text-red-800 flex-1">
            <span className="font-semibold">{expiredDevices.length} device{expiredDevices.length !== 1 ? 's' : ''}</span>{' '}
            have expired AUP — select devices above to disable or deprovision.
          </p>
          <button
            className="btn btn-sm bg-red-100 hover:bg-red-200 text-red-800 flex-shrink-0"
            onClick={selectAllExpired}
          >
            Select All Expired
          </button>
        </div>
      )}

      {/* Table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 space-y-3">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="animate-pulse h-8 bg-slate-100 rounded" />
            ))}
          </div>
        ) : displayedDevices.length === 0 ? (
          <div className="p-12 text-center text-slate-400 text-sm">
            <MdiIcon path={mdiCheckCircleOutline} size="2em" className="mx-auto mb-2 opacity-30" />
            No Chromebooks in this category.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
                  <th className="px-4 py-2 text-left w-8">
                    <input
                      type="checkbox"
                      checked={(() => {
                        const s = displayedDevices.filter(isSelectable);
                        return s.length > 0 && selected.size === s.length;
                      })()}
                      onChange={toggleAll}
                      className="rounded"
                    />
                  </th>
                  <th className="px-4 py-2 text-left">Device</th>
                  <th className="px-4 py-2 text-left">Serial</th>
                  <th className="px-4 py-2 text-left">Model</th>
                  <th className="px-4 py-2 text-left">Admin Status</th>
                  <th className="px-4 py-2 text-left">AUP Status</th>
                  <th className="px-4 py-2 text-left">OS Version</th>
                  <th className="px-4 py-2 text-left">Assigned</th>
                  <th className="px-4 py-2 text-left">Asset Tag</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {displayedDevices.map(d => {
                  const active = d.googleStatus === 'ACTIVE' || !d.googleStatus;
                  return (
                    <tr
                      key={d.serialNumber}
                      className={`transition-colors ${
                        active ? 'hover:bg-slate-50' : 'opacity-60 bg-slate-50/60'
                      }`}
                    >
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(d.googleDeviceId)}
                          onChange={() => isSelectable(d) && toggleOne(d.googleDeviceId)}
                          disabled={!isSelectable(d)}
                          title={!active ? `Cannot select — device is ${d.googleStatus?.toLowerCase()} in Google Admin` : undefined}
                          className="rounded"
                        />
                      </td>
                      <td className="px-4 py-2 font-medium text-slate-900">{d.deviceName || '—'}</td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-600">{d.serialNumber}</td>
                      <td className="px-4 py-2 text-slate-600">{d.deviceModel || '—'}</td>
                      <td className="px-4 py-2">
                        {active
                          ? <span className="text-xs text-green-700 font-medium">Active</span>
                          : <GoogleStatusBadge status={d.googleStatus} />
                        }
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap items-center gap-y-1">
                          <AupBadge status={d.aupStatus} />
                          {d.aupDate && (
                            <span className="text-slate-600 ml-1.5 text-xs">{fmtDate(d.aupDate)}</span>
                          )}
                          <AupSourceChip source={d.aupSource} />
                          {d.requiresLicense && <LicenseWarningChip />}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-slate-600">{d.osVersion || '—'}</td>
                      <td className="px-4 py-2 text-xs text-slate-600">{d.assignedEmail || '—'}</td>
                      <td className="px-4 py-2 text-xs text-slate-600">{d.assetTag || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pendingAction && (
        <ActionModal
          action={pendingAction}
          count={selected.size}
          onConfirm={handleConfirm}
          onCancel={handleCloseModal}
          loading={isMutationPending}
          result={actionResult}
        />
      )}
    </div>
  );
}
