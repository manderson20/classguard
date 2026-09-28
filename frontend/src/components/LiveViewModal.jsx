import { useState } from 'react';
import useLiveFrames, { frameAgeMs } from '../lib/useLiveFrames';

// ~1 frame every 1.5s — Chrome caps captureVisibleTab at 2 calls/second per
// extension, and the class thumbnail grid may be asking the same device for
// a frame at the same time.
const FRAME_INTERVAL_MS = 1500;
const STALE_AFTER_MS    = 10_000;

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return url || ''; }
}

// Every control prop is optional: the admin device-view page passes none and
// gets a view-only window; the teacher's class view passes them all.
export default function LiveViewModal({
  student, onClose,
  onLock, onUnlock, onOpenUrl, onCloseTab, onMessage,
  history = null,
}) {
  const { frames, errors, now } = useLiveFrames([student.id], { intervalMs: FRAME_INTERVAL_MS });
  const frame = frames[student.id];
  const error = errors[student.id];
  const isStale = frame && frameAgeMs(frame, now) > STALE_AFTER_MS;
  const [urlInput, setUrlInput] = useState('');

  const hasControls = onLock || onUnlock || onOpenUrl || onCloseTab || onMessage;
  const tabs = frame?.tabs;

  const submitUrl = () => {
    if (!urlInput.trim()) return;
    onOpenUrl(urlInput.trim());
    setUrlInput('');
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-7xl max-h-[95vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="bg-amber-50 border-b border-amber-200 px-5 py-2.5 flex items-center justify-between flex-shrink-0">
          <p className="text-xs text-amber-800">
            <strong>Live View</strong> — viewing {student.full_name || student.email}'s browser. This session is
            logged with your identity and cannot be deleted.
          </p>
          <button onClick={onClose} className="text-amber-700 hover:text-amber-900 text-sm font-medium ml-4 flex-shrink-0">
            Close
          </button>
        </div>

        <div className="flex flex-col lg:flex-row gap-4 p-4 overflow-y-auto min-h-0">
          <div className="flex-1 min-w-0">
            {error ? (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-4">{error}</div>
            ) : !frame ? (
              <div className="aspect-video bg-slate-100 rounded-lg flex items-center justify-center text-slate-400 text-sm">
                Waiting for the device to respond…
              </div>
            ) : (
              <>
                <div className="bg-slate-900 rounded-lg overflow-hidden">
                  <img src={frame.dataUrl} alt="" className="w-full h-auto block" />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                  <div className="truncate">
                    <span className="font-medium text-slate-700">{frame.title || 'Untitled'}</span>
                    {frame.url && <span className="font-mono text-slate-400 ml-2">{frame.url}</span>}
                  </div>
                  <span className={isStale ? 'text-amber-600 flex-shrink-0 ml-3' : 'text-slate-400 flex-shrink-0 ml-3'}>
                    {isStale ? 'No recent response — device may be offline' : `Updated ${new Date(frame.capturedAt).toLocaleTimeString()}`}
                  </span>
                </div>
              </>
            )}
          </div>

          <div className="lg:w-80 flex-shrink-0 space-y-4">
            {hasControls && (
              <section>
                <div className="flex flex-wrap gap-1.5">
                  {onLock && (
                    <button onClick={onLock} className="text-xs px-2 py-1 rounded-md border text-slate-600 border-slate-300 hover:bg-slate-50">Lock</button>
                  )}
                  {onUnlock && (
                    <button onClick={onUnlock} className="text-xs px-2 py-1 rounded-md border text-slate-600 border-slate-300 hover:bg-slate-50">Unlock</button>
                  )}
                  {onCloseTab && (
                    <button onClick={() => onCloseTab(null)} className="text-xs px-2 py-1 rounded-md border text-slate-600 border-slate-300 hover:bg-slate-50">Close Current Tab</button>
                  )}
                  {onMessage && (
                    <button onClick={onMessage} className="text-xs px-2 py-1 rounded-md border text-slate-600 border-slate-300 hover:bg-slate-50">Message</button>
                  )}
                </div>
                {onOpenUrl && (
                  <div className="flex gap-1.5 mt-2">
                    <input value={urlInput} onChange={e => setUrlInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && submitUrl()}
                      placeholder="Open URL: https://…" className="flex-1 min-w-0 text-xs border border-slate-300 rounded-md px-2 py-1" />
                    <button onClick={submitUrl} className="text-xs px-2 py-1 rounded-md bg-blue-600 text-white">Go</button>
                  </div>
                )}
              </section>
            )}

            <section>
              <h3 className="text-xs font-semibold text-slate-700 mb-1.5">
                Open Tabs{tabs ? ` (${tabs.length})` : ''}
              </h3>
              {!frame ? (
                <div className="text-xs text-slate-400">Waiting…</div>
              ) : !tabs ? (
                <div className="text-xs text-slate-400">The tab list appears once this device's extension updates.</div>
              ) : (
                <ul className="space-y-1 max-h-56 overflow-y-auto">
                  {tabs.map(t => (
                    <li key={t.id} className={`flex items-center gap-2 text-xs rounded px-1.5 py-1 ${t.active ? 'bg-blue-50' : ''}`}>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-slate-700">{t.title || hostnameOf(t.url) || 'Untitled'}</div>
                        <div className="truncate font-mono text-[10px] text-slate-400">{hostnameOf(t.url)}</div>
                      </div>
                      {t.active && <span className="text-[10px] text-blue-600 flex-shrink-0">viewing</span>}
                      {onCloseTab && (
                        <button onClick={() => onCloseTab(t)} title="Close this tab"
                          className="text-slate-400 hover:text-red-600 flex-shrink-0 px-1">✕</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {history && (
              <section>
                <h3 className="text-xs font-semibold text-slate-700 mb-1.5">History this class</h3>
                {history}
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
