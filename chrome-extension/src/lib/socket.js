// Socket.io client wrapper for the service worker.
// Uses websocket transport only (no XHR polling) since XHR is unavailable in
// service workers. The service worker may be suspended by Chrome at any time;
// the alarm-based policy sync is the reliable fallback when the socket is down.

/* global __BACKEND_URL__ */
import { io } from 'socket.io-client';

let _socket = null;

export function connectSocket({ jwt, onPolicyUpdated }) {
  if (_socket && _socket.connected) return;
  if (_socket) _socket.disconnect();

  _socket = io(__BACKEND_URL__, {
    transports: ['websocket'],
    auth: { token: jwt },
    reconnection:         true,
    reconnectionDelay:    10_000,
    reconnectionAttempts: 10,
  });

  _socket.on('connect',        () => console.log('[ClassGuard] socket connected'));
  _socket.on('disconnect',     (r) => console.log('[ClassGuard] socket disconnected:', r));
  _socket.on('connect_error',  (e) => console.warn('[ClassGuard] socket error:', e.message));
  _socket.on('policy:updated', onPolicyUpdated);
}

export function disconnectSocket() {
  if (_socket) {
    _socket.disconnect();
    _socket = null;
  }
}

export function isConnected() {
  return _socket?.connected ?? false;
}
