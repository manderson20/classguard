import { useState, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import MdiIcon from '@mdi/react';
import { mdiMagnify, mdiChevronLeft, mdiLaptop, mdiAlertCircle } from '@mdi/js';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../lib/api';

function useDebounced(value, delay = 350) {
  const [d, setD] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setD(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return d;
}

export default function TicketNew() {
  const { user } = useAuth();
  const navigate  = useNavigate();

  const isStudentTech = user?.role === 'student_technician';

  // All hooks declared before any early return
  const [step, setStep]               = useState(1);
  const [searchQ, setSearchQ]         = useState('');
  const debouncedQ                    = useDebounced(searchQ);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [form, setForm]               = useState({ title: '', initial_condition: '', priority: 'normal' });
  const [error, setError]             = useState('');

  const { data: searchResults = [], isFetching } = useQuery({
    queryKey: ['techlab-device-search', debouncedQ],
    queryFn:  () => api.get(`/tech-lab/device-search?q=${encodeURIComponent(debouncedQ)}`),
    enabled:  isStudentTech && debouncedQ.length >= 2,
    staleTime: 10_000,
  });

  const createMutation = useMutation({
    mutationFn: (body) => api.post('/tech-lab/tickets', body),
    onSuccess:  (data) => navigate(`/techlab/tickets/${data.id}`),
    onError:    (err)  => setError(err.message || 'Failed to create ticket'),
  });

  // Only student techs can create tickets; redirect everyone else
  if (!isStudentTech) return <Navigate to="/techlab" replace />;

  const handleSelectDevice = (device) => {
    setSelectedDevice(device);
    setStep(2);
  };

  const handleSubmit = () => {
    if (!form.title.trim()) { setError('Title is required'); return; }
    setError('');
    createMutation.mutate({
      title:             form.title.trim(),
      initial_condition: form.initial_condition,
      priority:          form.priority,
      device_serial:     selectedDevice?.serial_number || null,
      device_name:       selectedDevice?.device_name   || null,
      device_model:      selectedDevice?.device_model  || null,
      snipeit_asset_tag: selectedDevice?.asset_tag     || null,
    });
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      {/* Back button */}
      <button
        className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4"
        onClick={() => step === 1 ? navigate('/techlab') : setStep(1)}
      >
        <MdiIcon path={mdiChevronLeft} size="1em" />
        {step === 1 ? 'Back to Tech Lab' : 'Back to device search'}
      </button>

      <h1 className="text-2xl font-bold text-slate-900 mb-1">New Repair Ticket</h1>
      <p className="text-slate-500 text-sm mb-6">
        Step {step} of 2 — {step === 1 ? 'Find the device' : 'Describe the issue'}
      </p>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-6">
        {[1, 2].map(s => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                step >= s ? 'bg-primary-600 text-white' : 'bg-slate-200 text-slate-400'
              }`}
            >
              {s}
            </div>
            {s === 1 && (
              <div className={`h-0.5 w-12 ${step >= 2 ? 'bg-primary-600' : 'bg-slate-200'}`} />
            )}
          </div>
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Step 1: device search                                               */}
      {/* ------------------------------------------------------------------ */}
      {step === 1 && (
        <div className="card p-6">
          <h2 className="font-semibold text-slate-800 mb-1">Find Device</h2>
          <p className="text-sm text-slate-500 mb-4">
            Search by serial number, device name, or asset tag.
          </p>

          <div className="relative mb-4">
            <MdiIcon
              path={mdiMagnify}
              size="1em"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
            />
            <input
              type="text"
              className="input pl-9"
              placeholder="Search devices…"
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              autoFocus
            />
          </div>

          {isFetching && (
            <p className="text-xs text-slate-400 mb-2">Searching…</p>
          )}

          {searchResults.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-slate-100">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="text-left py-2 px-3 text-xs font-semibold text-slate-500">Serial</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-slate-500">Name</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-slate-500">Model</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-slate-500">Asset Tag</th>
                    <th className="text-left py-2 px-3 text-xs font-semibold text-slate-500">Assigned To</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {searchResults.map((device) => (
                    <tr
                      key={device.serial_number}
                      className="hover:bg-primary-50 cursor-pointer transition-colors"
                      onClick={() => handleSelectDevice(device)}
                    >
                      <td className="py-2.5 px-3 font-mono text-xs text-slate-700">{device.serial_number}</td>
                      <td className="py-2.5 px-3 text-slate-700">{device.device_name || '—'}</td>
                      <td className="py-2.5 px-3 text-slate-500">{device.device_model || '—'}</td>
                      <td className="py-2.5 px-3 text-slate-500">{device.asset_tag || '—'}</td>
                      <td className="py-2.5 px-3 text-slate-400 text-xs">{device.assigned_email || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {debouncedQ.length >= 2 && !isFetching && searchResults.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-6">
              No devices found for "{debouncedQ}".
            </p>
          )}

          <div className="mt-5 pt-4 border-t border-slate-100">
            <button
              className="btn btn-secondary text-sm"
              onClick={() => { setSelectedDevice(null); setStep(2); }}
            >
              Skip — device not in system
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Step 2: ticket form                                                 */}
      {/* ------------------------------------------------------------------ */}
      {step === 2 && (
        <div className="card p-6 space-y-5">
          {/* Selected device summary */}
          {selectedDevice ? (
            <div className="bg-slate-50 rounded-lg p-3 flex items-center gap-3">
              <MdiIcon path={mdiLaptop} size="1.2em" className="text-slate-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-800 text-sm truncate">
                  {selectedDevice.device_name || selectedDevice.serial_number}
                </div>
                <div className="text-xs text-slate-500">
                  {selectedDevice.device_model && `${selectedDevice.device_model} · `}
                  <span className="font-mono">{selectedDevice.serial_number}</span>
                </div>
              </div>
              <button
                className="text-xs text-slate-400 hover:text-slate-600 flex-shrink-0"
                onClick={() => setStep(1)}
              >
                Change
              </button>
            </div>
          ) : (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700">
              No device selected — you can add device details later from the ticket page.
            </div>
          )}

          {/* Error banner */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2 text-sm text-red-700">
              <MdiIcon path={mdiAlertCircle} size="1em" className="flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Title */}
          <div>
            <label className="label">
              Title <span className="text-red-500 normal-case font-normal">*</span>
            </label>
            <input
              type="text"
              className="input"
              placeholder="e.g. Screen cracked, won't boot, keyboard stuck"
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              autoFocus
            />
          </div>

          {/* Initial condition */}
          <div>
            <label className="label">Initial Condition</label>
            <textarea
              className="input h-28 resize-none"
              placeholder="Describe the device's condition when you received it…"
              value={form.initial_condition}
              onChange={e => setForm(f => ({ ...f, initial_condition: e.target.value }))}
            />
          </div>

          {/* Priority */}
          <div>
            <label className="label">Priority</label>
            <select
              className="input"
              value={form.priority}
              onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? 'Creating…' : 'Create Ticket'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setStep(1)}
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
