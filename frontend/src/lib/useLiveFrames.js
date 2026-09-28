import { useState, useEffect } from 'react';
import { useSocket } from '../contexts/SocketContext';
import api from './api';

// Socket.IO rooms belong to the socket, not to each listener: the thumbnail
// grid and the full-size viewer share one socket, so leaving a student's
// room when one view closes would silently cut off the other. Count joins
// per student and only leave when the last view is gone.
const roomRefs = new Map(); // studentId -> number of mounted views

function joinRoom(socket, id) {
  roomRefs.set(id, (roomRefs.get(id) || 0) + 1);
  socket?.emit('join:liveview', id);
}

function leaveRoom(socket, id) {
  const n = (roomRefs.get(id) || 1) - 1;
  if (n > 0) { roomRefs.set(id, n); return; }
  roomRefs.delete(id);
  socket?.emit('leave:liveview', id);
}

// Shared Live View frame loop (routes/liveView.js) for the full-size viewer
// and the class thumbnail grid: open an audited session per student, join
// each student's frame room, ask for a frame every intervalMs, and keep the
// latest frame per student. Sessions are stopped on unmount.
//
// size 'thumb' asks the extension for a downscaled frame; a 'full' viewer
// ignores thumbnail frames that arrive in the same room (both views can be
// watching one student at once), while a thumbnail happily shows either.
//
// A /frame call that 403s means this viewer's session was closed elsewhere
// (e.g. the other view of the same student was closed) — reopen it rather
// than going dark. `now` ticks so callers can age frames ("offline?") even
// when a device stops sending.
export default function useLiveFrames(studentIds, { intervalMs, size = 'full' }) {
  const { socket } = useSocket();
  const [frames, setFrames] = useState({}); // studentId -> frame
  const [errors, setErrors] = useState({}); // studentId -> message
  const [now, setNow]       = useState(() => Date.now());
  const idsKey = studentIds.join(',');

  useEffect(() => {
    const ids = idsKey ? idsKey.split(',') : [];
    if (ids.length === 0) return undefined;
    let stopped = false;
    let timer = null;

    const handler = (data) => {
      if (stopped || !ids.includes(data.studentId)) return;
      if (size === 'full' && data.size === 'thumb') return;
      setFrames(prev => ({ ...prev, [data.studentId]: data }));
    };
    socket?.on('liveview:frame', handler);
    // A reconnected socket has lost its rooms.
    const rejoin = () => ids.forEach(id => socket.emit('join:liveview', id));
    socket?.on('connect', rejoin);

    const start = (id) => api.post(`/live-view/${id}/start`)
      .then(() => setErrors(prev => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }))
      .catch(err => setErrors(prev => ({ ...prev, [id]: err.message || 'Failed to start live view session' })));

    const requestFrame = (id) => api.post(`/live-view/${id}/frame`, { size })
      .catch(err => { if (err.status === 403 && !stopped) start(id); });

    // Rooms are joined synchronously so cleanup always releases exactly
    // what this view took, even if it unmounts mid-way through the starts.
    ids.forEach(id => joinRoom(socket, id));
    (async () => {
      for (const id of ids) {
        if (stopped) return;
        await start(id);
      }
      if (stopped) return;
      ids.forEach(requestFrame);
      timer = setInterval(() => {
        ids.forEach(requestFrame);
        setNow(Date.now());
      }, intervalMs);
    })();

    return () => {
      stopped = true;
      clearInterval(timer);
      socket?.off('liveview:frame', handler);
      socket?.off('connect', rejoin);
      for (const id of ids) {
        leaveRoom(socket, id);
        api.post(`/live-view/${id}/stop`).catch(() => {});
      }
    };
  }, [idsKey, socket, intervalMs, size]);

  return { frames, errors, now };
}

export function frameAgeMs(frame, now) {
  return frame ? now - new Date(frame.capturedAt).getTime() : Infinity;
}
