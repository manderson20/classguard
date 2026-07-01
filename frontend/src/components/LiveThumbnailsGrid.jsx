import { useState, useEffect, useRef } from 'react';
import { useSocket } from '../contexts/SocketContext';
import api from '../lib/api';
import Avatar from './Avatar';

// Reuses the teacher-scoped Live View endpoints (routes/liveView.js) as-is —
// no new backend routes needed. The single-student viewer (LiveViewModal)
// polls one student every 4s; this drives the SAME per-student
// start/frame/stop calls for every roster member at once, each round, on a
// slower cadence (20s, not 4s) since it's asking N devices simultaneously
// instead of one repeatedly.
const FRAME_INTERVAL_MS = 20_000;
const STALE_AFTER_MS    = 45_000;

export default function LiveThumbnailsGrid({ members, onClose }) {
  const { socket } = useSocket();
  const [frames, setFrames] = useState({}); // studentId -> {dataUrl, url, title, capturedAt}
  const intervalRef = useRef(null);

  useEffect(() => {
    let stopped = false;
    const studentIds = members.map(m => m.id);

    const requestFrames = () => {
      for (const id of studentIds) {
        api.post(`/live-view/${id}/frame`).catch(() => {});
      }
    };

    const handler = (data) => {
      if (stopped) return;
      setFrames(prev => ({ ...prev, [data.studentId]: data }));
    };
    socket?.on('liveview:frame', handler);

    (async () => {
      for (const id of studentIds) {
        socket?.emit('join:liveview', id);
        await api.post(`/live-view/${id}/start`).catch(() => {});
      }
      if (stopped) return;
      requestFrames();
      intervalRef.current = setInterval(requestFrames, FRAME_INTERVAL_MS);
    })();

    return () => {
      stopped = true;
      clearInterval(intervalRef.current);
      socket?.off('liveview:frame', handler);
      for (const id of studentIds) {
        socket?.emit('leave:liveview', id);
        api.post(`/live-view/${id}/stop`).catch(() => {});
      }
    };
    // members is a fresh array reference on every parent render (mapped from
    // roster data) -- keying on its content, not identity, avoids tearing
    // down and restarting every student's session on every unrelated
    // ActiveLesson re-render (e.g. an activity-log update elsewhere on the page).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.map(m => m.id).join(','), socket]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="bg-amber-50 border-b border-amber-200 px-5 py-2.5 flex items-center justify-between flex-shrink-0">
          <p className="text-xs text-amber-800">
            <strong>Live Thumbnails</strong> — refreshing every {FRAME_INTERVAL_MS / 1000}s. Each view is logged with your identity.
          </p>
          <button onClick={onClose} className="text-amber-700 hover:text-amber-900 text-sm font-medium ml-4 flex-shrink-0">
            Close
          </button>
        </div>

        <div className="p-4 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {members.length === 0 && (
            <div className="col-span-full text-center text-slate-400 text-sm py-8">No students in this class</div>
          )}
          {members.map(m => {
            const frame = frames[m.id];
            const isStale = frame && Date.now() - new Date(frame.capturedAt).getTime() > STALE_AFTER_MS;
            return (
              <div key={m.id} className="border border-slate-200 rounded-lg overflow-hidden">
                <div className="aspect-video bg-slate-100 flex items-center justify-center">
                  {frame ? (
                    <img src={frame.dataUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-slate-400 text-xs">Waiting…</span>
                  )}
                </div>
                <div className="px-2 py-1.5 flex items-center gap-1.5">
                  <Avatar photoUrl={m.photo_url} name={m.full_name} email={m.email} className="w-4 h-4 text-[9px]" />
                  <span className="text-xs text-slate-700 truncate flex-1">{m.full_name}</span>
                  {isStale && <span className="text-[10px] text-amber-600 flex-shrink-0">offline?</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
