import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../../lib/api';

// Creates a local-password account — the only way to add ANY user when
// Google Workspace sync isn't the source (a test account, a break-glass
// admin, or simply because Google SSO is the thing that's currently
// broken). Superadmin-only, mirrors POST /api/v1/users.
export default function AddUserModal({ onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ fullName: '', email: '', password: '', role: 'teacher' });
  const [error, setError] = useState(null);

  const create = useMutation({
    mutationFn: () => api.post('/users', form),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['users'] }); onClose(); },
    onError:    (err) => setError(err.message),
  });

  const f = (key, val) => { setError(null); setForm(prev => ({ ...prev, [key]: val })); };
  const canSave = form.fullName.trim() && form.email.trim() && form.password.length >= 10;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900 text-lg">Add Local User</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">✕</button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-xs text-slate-500">
            Creates an account with a local password, independent of Google sync — for test accounts,
            break-glass access, or a fallback while Google SSO is down.
          </p>
          <div>
            <label className="label">Full Name</label>
            <input className="input" value={form.fullName} onChange={e => f('fullName', e.target.value)} />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={form.email} onChange={e => f('email', e.target.value)} />
          </div>
          <div>
            <label className="label">Password</label>
            <input className="input" type="password" placeholder="10+ characters" value={form.password} onChange={e => f('password', e.target.value)} />
          </div>
          <div>
            <label className="label">Role</label>
            <select className="input" value={form.role} onChange={e => f('role', e.target.value)}>
              <option value="student">student</option>
              <option value="teacher">teacher</option>
              <option value="admin">admin</option>
              <option value="superadmin">superadmin</option>
            </select>
          </div>
          {error && <p className="text-sm text-red-600 font-medium">{error}</p>}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!canSave || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create User'}
          </button>
        </div>
      </div>
    </div>
  );
}
