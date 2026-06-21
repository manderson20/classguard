import { useState, useEffect, useRef } from 'react';
import { useSocket } from '../contexts/SocketContext';
import api from '../lib/api';

const FRAME_INTERVAL_MS = 4000;
const STALE_AFTER_MS    = 15_000;

export default function LiveViewModal({ student, onClose }) {
  const { socket } = useSocket();
  const [frame, setFrame]   = useState(null);
  const [error, setError]   = useState(null);
  const [waiting, setWaiting] = useState(true);
  const intervalRef = useRef(null);

  useEffect(() => {
    let stopped = false;
    socket?.emit('join:liveview', student.id);

    const handler = (data) => {
      if (stopped) return;
      setFrame(data);
      setWaiting(false);
    };
    socket?.on('liveview:frame', handler);

    const requestFrame = () => api.post(`/live-view/${student.id}/frame`).catch(() => {});

    api.post(`/live-view/${student.id}/start`)
      .then(() => {
        if (stopped) return;
        requestFrame();
        intervalRef.current = setInterval(requestFrame, FRAME_INTERVAL_MS);
      })
      .catch(err => setError(err.message || 'Failed to start live view session'));

    return () => {
      stopped = true;
      clearInterval(intervalRef.current);
      socket?.off('liveview:frame', handler);
      socket?.emit('leave:liveview', student.id);
      api.post(`/live-view/${student.id}/stop`).catch(() => {});
    };
  }, [student.id, socket]);

  const isStale = frame && Date.now() - new Date(frame.capturedAt).getTime() > STALE_AFTER_MS;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl overflow-hidden">
        <div className="bg-amber-50 border-b border-amber-200 px-5 py-2.5 flex items-center justify-between">
          <p className="text-xs text-amber-800">
            <strong>Live View</strong> — viewing {student.full_name || student.email}'s browser. This session is
            logged with your identity and cannot be deleted.
          </p>
          <button onClick={onClose} className="text-amber-700 hover:text-amber-900 text-sm font-medium ml-4 flex-shrink-0">
            Close
          </button>
        </div>

        <div className="p-5">
          {error ? (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-4">{error}</div>
          ) : waiting ? (
            <div className="aspect-video bg-slate-100 rounded-lg flex items-center justify-center text-slate-400 text-sm">
              Waiting for the device to respond…
            </div>
          ) : (
            <>
              <div className="bg-slate-900 rounded-lg overflow-hidden">
                <img src={frame.dataUrl} alt="" className="w-full h-auto block" />
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
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
      </div>
    </div>
  );
}
