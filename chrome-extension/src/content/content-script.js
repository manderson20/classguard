// ClassGuard content script — injected into every http/https page.
// Scans page text for flagged keywords and reports violations to the service worker.

(function () {
  if (window.__classguardInjected) return;
  window.__classguardInjected = true;

  // ---------------------------------------------------------------------------
  // Identity bridge — lets ClassGuard's OWN pages (e.g. the DNS-level block
  // page, frontend/public/blocked-dns.html) ask "who's signed in?" and submit
  // an unblock request AS that signed-in identity, without a new auth flow.
  // Needed because a DNS-sinkholed page keeps the ORIGINAL blocked domain in
  // the address bar (e.g. "pornhub.com") — there is no reliable hostname
  // check that says "this is ClassGuard's page", so the page announces
  // itself via custom events instead, and gets a postMessage reply.
  //
  // CG_GET_STATUS only exposes name/email/photo for display (never the JWT)
  // — display alone proves nothing, a student could still type a teacher's
  // name into a plain text field. The actual anti-impersonation guarantee is
  // CG_SUBMIT_UNBLOCK_REQUEST below: the JWT itself never leaves this
  // extension's trusted contexts (content script → service worker → backend),
  // so the backend can verify student_id cryptographically instead of
  // trusting whatever the page's own JS sent.
  // ---------------------------------------------------------------------------
  window.addEventListener('classguard:request-identity', () => {
    chrome.runtime.sendMessage({ type: 'CG_GET_STATUS' }, (status) => {
      const user = status?.authenticated ? status.user : null;
      window.postMessage({
        source: 'classguard-extension',
        type:   'classguard:identity',
        user:   user ? { name: user.name, email: user.email, photoUrl: user.photoUrl } : null,
      }, window.location.origin);
    });
  });

  window.addEventListener('classguard:submit-unblock-request', (e) => {
    const { domain, reason } = e.detail || {};
    chrome.runtime.sendMessage({ type: 'CG_SUBMIT_UNBLOCK_REQUEST', domain, reason }, (result) => {
      window.postMessage({
        source: 'classguard-extension',
        type:   'classguard:unblock-request-result',
        ...(result || { ok: false, error: 'No response from extension' }),
      }, window.location.origin);
    });
  });

  // ---------------------------------------------------------------------------
  // Keyword scanning
  // ---------------------------------------------------------------------------

  // { keyword: string, category: string }[]
  let _keywords = [];
  // Set of lowercase keywords for fast lookup
  let _keywordSet = new Set();

  function loadKeywords(keywords) {
    _keywords   = keywords || [];
    _keywordSet = new Set(_keywords.map(k => k.keyword.toLowerCase()));
  }

  function scanText(text) {
    if (!_keywordSet.size || !text) return null;
    const lower = text.toLowerCase();
    for (const { keyword, category } of _keywords) {
      // Word-boundary match to avoid partial hits (e.g. "class" in "classroom")
      const re = new RegExp(`(?<![a-z0-9])${escapeRegex(keyword)}(?![a-z0-9])`, 'i');
      if (re.test(lower)) return { keyword, category };
    }
    return null;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function runScan() {
    if (!_keywordSet.size) return;

    // Scan visible body text only — no passwords, hidden inputs, etc.
    const text = document.body?.innerText || '';
    const match = scanText(text);
    if (!match) return;

    // Debounce: don't fire the same keyword twice within 60 s
    const dedupeKey = `cg_flagged_${match.keyword}`;
    const last = sessionStorage.getItem(dedupeKey);
    if (last && Date.now() - parseInt(last, 10) < 60_000) return;
    sessionStorage.setItem(dedupeKey, Date.now().toString());

    chrome.runtime.sendMessage({
      type:     'CG_KEYWORD_VIOLATION',
      keyword:  match.keyword,
      category: match.category,
      url:      window.location.href,
      title:    document.title,
    }).catch(() => {});
  }

  // Initial keyword load from service worker cache
  chrome.runtime.sendMessage({ type: 'CG_GET_KEYWORDS' }, (response) => {
    if (response?.keywords) loadKeywords(response.keywords);
    // Run first scan after keywords are loaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', runScan, { once: true });
    } else {
      runScan();
    }
  });

  // ---------------------------------------------------------------------------
  // Messages from service worker
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CG_SHOW_NOTICE') {
      showNotice(msg.text, msg.level);
    } else if (msg.type === 'CG_KEYWORDS_UPDATED') {
      loadKeywords(msg.keywords);
      // Re-scan with new keyword list
      runScan();
    } else if (msg.type === 'CG_LOCK_SCREEN') {
      showLockOverlay(msg.message);
    } else if (msg.type === 'CG_UNLOCK_SCREEN') {
      hideLockOverlay();
    } else if (msg.type === 'CG_CHAT_MESSAGE') {
      onIncomingChatMessage(msg.threadId, msg.message);
    } else if (msg.type === 'CG_LESSON_STATE') {
      setLessonState(msg.inActiveLesson);
    }
  });

  // A lock engaged before this tab existed (or before this content script
  // re-injected, e.g. after a navigation) wouldn't otherwise reach this tab —
  // the service worker only messages tabs that are already open when it
  // locks. chrome.storage.local is the source of truth for "currently
  // locked", checked on every page load.
  chrome.storage.local.get('cg_locked', (data) => {
    if (data.cg_locked) showLockOverlay(data.cg_locked.message);
  });
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.cg_locked) return;
      if (changes.cg_locked.newValue) showLockOverlay(changes.cg_locked.newValue.message);
      else hideLockOverlay();
    });
  }

  // ---------------------------------------------------------------------------
  // Report page load
  // ---------------------------------------------------------------------------
  const report = () => {
    chrome.runtime.sendMessage({
      type:  'CG_PAGE_LOADED',
      url:   window.location.href,
      title: document.title,
    }).catch(() => {});
    // Scan after DOM is fully populated
    setTimeout(runScan, 500);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', report, { once: true });
  } else {
    report();
  }

  // ---------------------------------------------------------------------------
  // Notice banner
  // ---------------------------------------------------------------------------
  function showNotice(text, level = 'info') {
    const existing = document.getElementById('cg-notice');
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.id = 'cg-notice';
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'padding:8px 16px', 'font:bold 13px/1.4 system-ui,sans-serif',
      'text-align:center', 'color:#fff',
      `background:${level === 'warning' ? '#d97706' : '#1a56db'}`,
    ].join(';');
    bar.textContent = text;
    document.body.prepend(bar);

    setTimeout(() => bar.remove(), 5000);
  }

  // ---------------------------------------------------------------------------
  // Lock overlay — a soft lock: a full-viewport, undismissable-by-the-page
  // overlay that blocks clicks/scroll on everything beneath it. Like any
  // page-level mechanism it can't stop OS/browser-level escapes (devtools,
  // closing the browser itself) — same realistic limitation GoGuardian's
  // equivalent has. Intentionally idempotent (re-locking just updates the
  // message) since it's reachable from both a live message and a storage
  // change event for the same lock.
  // ---------------------------------------------------------------------------
  let _prevOverflow = null;

  function showLockOverlay(message) {
    let overlay = document.getElementById('cg-lock-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'cg-lock-overlay';
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647',
        'background:rgba(15,23,42,0.96)', 'color:#fff',
        'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
        'font:600 20px/1.5 system-ui,sans-serif', 'text-align:center', 'padding:32px',
        'pointer-events:auto', 'user-select:none',
      ].join(';');
      const text = document.createElement('div');
      text.id = 'cg-lock-overlay-text';
      overlay.appendChild(text);
      document.documentElement.appendChild(overlay);

      // Swallow clicks/keys so they never reach the page underneath.
      ['click', 'mousedown', 'keydown', 'wheel'].forEach((evt) => {
        overlay.addEventListener(evt, (e) => { e.stopPropagation(); }, true);
      });

      _prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
    }
    overlay.querySelector('#cg-lock-overlay-text').textContent =
      message || 'Your screen has been locked by your teacher.';
  }

  function hideLockOverlay() {
    const overlay = document.getElementById('cg-lock-overlay');
    if (overlay) overlay.remove();
    document.documentElement.style.overflow = _prevOverflow || '';
  }

  // ---------------------------------------------------------------------------
  // Chat widget — a non-blocking floating bubble, unlike the lock overlay it
  // never captures pointer events on the rest of the page. Lives in every
  // tab so a message can't be missed just because the student isn't on the
  // tab the teacher expects. The service worker proxies all REST calls
  // (CG_CHAT_*) since content scripts never call the backend directly here.
  // ---------------------------------------------------------------------------
  let _threads      = [];
  let _activeThread = null;     // thread id currently open in the panel
  let _messages     = [];       // messages for _activeThread
  let _expanded      = false;

  function totalUnread() {
    return _threads.reduce((sum, t) => sum + (t.unread_count || 0), 0);
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : s;
    return div.innerHTML;
  }

  function buildChatWidget() {
    if (document.getElementById('cg-chat-root')) return;

    const root = document.createElement('div');
    root.id = 'cg-chat-root';
    root.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483646;font:14px system-ui,sans-serif;';

    root.innerHTML = `
      <div id="cg-chat-bubble" style="
        width:48px;height:48px;border-radius:50%;background:#1a56db;color:#fff;
        display:flex;align-items:center;justify-content:center;font-size:22px;
        cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.25);position:relative;">
        💬
        <span id="cg-chat-badge" style="
          position:absolute;top:-4px;right:-4px;background:#dc2626;color:#fff;
          font-size:11px;font-weight:700;border-radius:9px;min-width:18px;height:18px;
          display:none;align-items:center;justify-content:center;padding:0 4px;">0</span>
      </div>
      <div id="cg-chat-panel" style="
        display:none;position:absolute;bottom:58px;right:0;width:320px;height:420px;
        background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.3);
        flex-direction:column;overflow:hidden;">
        <div style="background:#1a56db;color:#fff;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;">
          <select id="cg-chat-thread-select" style="flex:1;margin-right:8px;font-size:12px;border-radius:6px;border:none;padding:4px;"></select>
          <span id="cg-chat-close" style="cursor:pointer;font-weight:700;">✕</span>
        </div>
        <div id="cg-chat-messages" style="flex:1;overflow-y:auto;padding:10px;background:#f8fafc;"></div>
        <div style="display:flex;border-top:1px solid #e2e8f0;">
          <input id="cg-chat-input" type="text" placeholder="Type a message…" maxlength="2000"
            style="flex:1;border:none;padding:10px;font-size:13px;outline:none;">
          <button id="cg-chat-send" style="border:none;background:#1a56db;color:#fff;padding:0 14px;cursor:pointer;">Send</button>
        </div>
      </div>`;

    document.documentElement.appendChild(root);

    document.getElementById('cg-chat-bubble').addEventListener('click', () => toggleChatPanel(true));
    document.getElementById('cg-chat-close').addEventListener('click', () => toggleChatPanel(false));
    document.getElementById('cg-chat-thread-select').addEventListener('change', (e) => openThread(e.target.value));
    document.getElementById('cg-chat-send').addEventListener('click', sendChatMessage);
    document.getElementById('cg-chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChatMessage();
    });

    buildRaiseHandButton();
  }

  // Raise hand — a separate fixed-position button (not inside #cg-chat-root,
  // which is exactly chat-bubble-sized) sitting to the left of the chat
  // bubble along the same row. Hidden unless the student is actually in an
  // active lesson right now (see CG_LESSON_STATE / setLessonState below) --
  // raising a hand outside a lesson has no teacher dashboard to reach.
  let _inActiveLesson = false;
  let _handRaised = false;

  function buildRaiseHandButton() {
    if (document.getElementById('cg-raisehand-bubble')) return;
    const btn = document.createElement('div');
    btn.id = 'cg-raisehand-bubble';
    btn.style.cssText = `
      position:fixed;bottom:16px;right:76px;width:48px;height:48px;border-radius:50%;
      background:#ca8a04;color:#fff;display:none;align-items:center;justify-content:center;
      font-size:22px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.25);
      z-index:2147483646;font:14px system-ui,sans-serif;`;
    btn.title = 'Raise hand';
    btn.textContent = '🖐';
    btn.addEventListener('click', onRaiseHandClick);
    document.documentElement.appendChild(btn);
  }

  function setLessonState(inActiveLesson) {
    _inActiveLesson = inActiveLesson;
    if (!inActiveLesson) _handRaised = false;
    const btn = document.getElementById('cg-raisehand-bubble');
    if (!btn) return;
    btn.style.display = inActiveLesson ? 'flex' : 'none';
    renderRaiseHandButton();
  }

  function renderRaiseHandButton() {
    const btn = document.getElementById('cg-raisehand-bubble');
    if (!btn) return;
    btn.textContent = _handRaised ? '✓' : '🖐';
    btn.style.background = _handRaised ? '#16a34a' : '#ca8a04';
    btn.style.cursor = _handRaised ? 'default' : 'pointer';
  }

  async function onRaiseHandClick() {
    if (_handRaised || !_inActiveLesson) return;
    _handRaised = true;
    renderRaiseHandButton();
    const res = await chrome.runtime.sendMessage({ type: 'CG_RAISE_HAND' }).catch(() => null);
    if (!res?.ok) {
      // Failed silently (e.g. lesson ended between click and send) -- reset
      // so the student can try again rather than being stuck on a false
      // "raised" state.
      _handRaised = false;
      renderRaiseHandButton();
    }
  }

  function renderBadge() {
    const badge = document.getElementById('cg-chat-badge');
    if (!badge) return;
    const n = totalUnread();
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.style.display = n > 0 ? 'flex' : 'none';
  }

  function renderThreadOptions() {
    const select = document.getElementById('cg-chat-thread-select');
    if (!select) return;
    select.innerHTML = _threads.map(t => {
      const label = t.type === 'group' ? (t.name || 'Group chat') : 'Teacher';
      const unread = t.unread_count ? ` (${t.unread_count})` : '';
      return `<option value="${t.id}">${escapeHtml(label)}${unread}</option>`;
    }).join('') || '<option value="">No conversations yet</option>';
    if (_activeThread) select.value = _activeThread;
  }

  function formatBytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderMessages() {
    const container = document.getElementById('cg-chat-messages');
    if (!container) return;
    if (!_messages.length) {
      container.innerHTML = '<div style="color:#94a3b8;font-size:12px;text-align:center;margin-top:20px;">No messages yet</div>';
      return;
    }
    container.innerHTML = _messages.map(m => {
      const mine = m.sender_id === _selfId;
      const bodyHtml = m.deleted
        ? '<em style="color:#94a3b8;">message deleted</em>'
        : (m.body ? escapeHtml(m.body) : '');
      const attachmentHtml = (!m.deleted && m.attachment_name) ? `
        <div data-attachment-id="${m.id}" data-attachment-name="${escapeHtml(m.attachment_name)}"
          style="margin-top:4px;font-size:12px;text-decoration:underline;cursor:pointer;
          color:${mine ? '#dbeafe' : '#1a56db'};">
          📎 ${escapeHtml(m.attachment_name)} (${formatBytes(m.attachment_size)})
        </div>` : '';
      return `<div style="margin-bottom:8px;display:flex;justify-content:${mine ? 'flex-end' : 'flex-start'};">
        <div style="max-width:75%;padding:6px 10px;border-radius:10px;font-size:13px;
          background:${mine ? '#1a56db' : '#e2e8f0'};color:${mine ? '#fff' : '#1e293b'};">${bodyHtml}${attachmentHtml}</div>
      </div>`;
    }).join('');
    container.scrollTop = container.scrollHeight;
  }

  // Delegated click handler for attachment downloads -- renderMessages()
  // replaces container.innerHTML wholesale on every update, so a listener
  // bound directly to an attachment div would be lost on the next render.
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-attachment-id]');
    if (!el) return;
    chrome.runtime.sendMessage({
      type: 'CG_CHAT_DOWNLOAD_ATTACHMENT',
      messageId: el.dataset.attachmentId,
      filename:  el.dataset.attachmentName,
    }).catch(() => {});
  });

  let _selfId = null;

  async function refreshThreads() {
    const res = await chrome.runtime.sendMessage({ type: 'CG_CHAT_GET_THREADS' }).catch(() => null);
    _threads = res?.threads || [];
    if (!_activeThread && _threads[0]) _activeThread = _threads[0].id;
    renderThreadOptions();
    renderBadge();
  }

  async function openThread(threadId) {
    if (!threadId) return;
    _activeThread = threadId;
    const res = await chrome.runtime.sendMessage({ type: 'CG_CHAT_GET_MESSAGES', threadId }).catch(() => null);
    _messages = res?.messages || [];
    renderMessages();
    chrome.runtime.sendMessage({ type: 'CG_CHAT_MARK_READ', threadId }).catch(() => {});
    const t = _threads.find(x => x.id === threadId);
    if (t) t.unread_count = 0;
    renderBadge();
  }

  async function sendChatMessage() {
    const input = document.getElementById('cg-chat-input');
    const body = input.value.trim();
    if (!body || !_activeThread) return;
    input.value = '';
    const res = await chrome.runtime.sendMessage({ type: 'CG_CHAT_SEND_MESSAGE', threadId: _activeThread, body }).catch(() => null);
    if (res && !res.error) {
      _selfId = _selfId || res.sender_id;
      _messages.push(res);
      renderMessages();
    }
  }

  function toggleChatPanel(open) {
    _expanded = open;
    const panel = document.getElementById('cg-chat-panel');
    if (panel) panel.style.display = open ? 'flex' : 'none';
    if (open && _activeThread) openThread(_activeThread);
  }

  function onIncomingChatMessage(threadId, message) {
    buildChatWidget();
    const t = _threads.find(x => x.id === threadId);
    if (t) {
      t.last_message = message.deleted ? null : message.body;
    } else {
      _threads.push({ id: threadId, type: 'direct', unread_count: 0 });
    }
    if (_expanded && _activeThread === threadId) {
      _messages.push(message);
      renderMessages();
      chrome.runtime.sendMessage({ type: 'CG_CHAT_MARK_READ', threadId }).catch(() => {});
    } else {
      const target = _threads.find(x => x.id === threadId);
      if (target) target.unread_count = (target.unread_count || 0) + 1;
    }
    renderThreadOptions();
    renderBadge();
  }

  // Only build the widget for students — teachers/admins use the web app,
  // not the extension, for chat. CG_GET_STATUS already tells us the role.
  chrome.runtime.sendMessage({ type: 'CG_GET_STATUS' }, (status) => {
    if (status?.user?.role !== 'student') return;
    _selfId = status.user.id;
    buildChatWidget();
    refreshThreads();

    // Same reasoning as cg_locked above — a lesson that started before this
    // tab existed (or before this content script re-injected) wouldn't
    // otherwise reach this tab via the CG_LESSON_STATE broadcast, since the
    // service worker only messages tabs that are already open at that
    // moment. chrome.storage.local is the source of truth, checked here too.
    chrome.storage.local.get('cg_in_lesson', (data) => {
      if (data.cg_in_lesson) setLessonState(true);
    });
    if (chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !('cg_in_lesson' in changes)) return;
        setLessonState(!!changes.cg_in_lesson.newValue);
      });
    }
  });
}());
