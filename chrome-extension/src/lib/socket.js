// Socket.io client wrapper for the service worker.
// Uses websocket transport only (no XHR polling) since XHR is unavailable in
// service workers. The service worker may be suspended by Chrome at any time;
// the alarm-based policy sync is the reliable fallback when the socket is down.

import { io } from 'socket.io-client';
import { getServerUrl } from './api.js';

let _socket = null;

export async function connectSocket({
  jwt, onPolicyUpdated, onScreenshotRequest,
  onLockRequest, onUnlockRequest, onOpenTabRequest, onCloseTabRequest,
  onChatMessage, onLiveViewRequest,
}) {
  if (_socket && _socket.connected) return;
  if (_socket) _socket.disconnect();

  const url = await getServerUrl();

  _socket = io(url, {
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

  // Teacher-initiated screenshot request from backend
  _socket.on('screenshot:request', () => {
    if (typeof onScreenshotRequest === 'function') onScreenshotRequest('teacher_request');
  });

  // Admin Live View — same capture mechanism as a screenshot request, but
  // never persisted server-side (see /extension/liveview-frame)
  _socket.on('liveview:request', () => {
    if (typeof onLiveViewRequest === 'function') onLiveViewRequest();
  });

  // Teacher-initiated remote device commands
  _socket.on('lock:engage', (data) => {
    if (typeof onLockRequest === 'function') onLockRequest(data);
  });
  _socket.on('lock:release', () => {
    if (typeof onUnlockRequest === 'function') onUnlockRequest();
  });
  _socket.on('tab:open', (data) => {
    if (typeof onOpenTabRequest === 'function') onOpenTabRequest(data);
  });
  _socket.on('tab:close', () => {
    if (typeof onCloseTabRequest === 'function') onCloseTabRequest();
  });

  // New chat message addressed to this user (teacher or student)
  _socket.on('chat:message', (data) => {
    if (typeof onChatMessage === 'function') onChatMessage(data);
  });
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
