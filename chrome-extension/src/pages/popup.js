// ClassGuard extension popup

const content    = document.getElementById('content');
const headerSub  = document.getElementById('header-sub');
const btnSync    = document.getElementById('btn-sync');

// ---------------------------------------------------------------------------
// Load status from service worker
// ---------------------------------------------------------------------------
async function loadStatus() {
  try {
    const status = await sendMessage({ type: 'CG_GET_STATUS' });
    render(status);
  } catch {
    content.innerHTML = '<p class="loading">ClassGuard is loading…</p>';
  }
}

function formatSyncedAt(ts) {
  if (!ts) return 'Never';
  const diffMin = Math.round((Date.now() - ts) / 60_000);
  if (diffMin < 1)  return 'Just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  return new Date(ts).toLocaleString();
}

function render({ authenticated, user, policy, socketConnected, policySyncedAt, version }) {
  const versionFooter = `
    <div class="section" style="border-bottom:none">
      <div style="font-size:11px;color:#94a3b8;display:flex;justify-content:space-between">
        <span>Extension v${esc(version || '?')}</span>
        ${authenticated ? `<span>Policy synced: ${esc(formatSyncedAt(policySyncedAt))}</span>` : ''}
      </div>
    </div>`;

  if (!authenticated || !user) {
    headerSub.textContent = 'Not signed in';
    content.innerHTML = `
      <div class="section">
        <div class="label">Status</div>
        <div class="value" style="color:#ef4444">Not authenticated</div>
        <p style="font-size:12px;color:#94a3b8;margin-top:6px">
          Sign in to your school Google account to activate ClassGuard.
        </p>
      </div>
      ${versionFooter}`;
    return;
  }

  const modeCls   = policy?.mode || 'standard';
  const modeLabel = { lesson: 'Lesson Active', penalty_box: 'Restricted', standard: 'Active' };

  headerSub.textContent = user.email || 'Signed in';

  content.innerHTML = `
    <div class="section">
      <div class="label">Student</div>
      <div class="value">${esc(user.name || user.email)}</div>
      <div style="font-size:12px;color:#64748b;margin-top:2px">${esc(user.email || '')}</div>
    </div>

    <div class="section">
      <div class="row">
        <div>
          <div class="label">Policy Mode</div>
          <div class="value">
            <span class="badge ${modeCls === 'penalty_box' ? 'penalty' : modeCls}">
              ${esc(modeLabel[modeCls] || modeCls)}
            </span>
          </div>
        </div>
        ${policy?.name ? `<div style="font-size:12px;color:#64748b;text-align:right;max-width:120px">${esc(policy.name)}</div>` : ''}
      </div>
    </div>

    <div class="section">
      <div class="row">
        <div>
          <div class="label">Server Connection</div>
          <div class="value" style="display:flex;align-items:center;gap:6px">
            <div class="dot ${socketConnected ? 'green' : 'yellow'}"></div>
            ${socketConnected ? 'Connected' : 'Polling'}
          </div>
        </div>
      </div>
    </div>
    ${versionFooter}
  `;
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------
btnSync.addEventListener('click', async () => {
  btnSync.textContent = 'Syncing…';
  btnSync.disabled = true;
  await sendMessage({ type: 'CG_FORCE_SYNC' });
  await loadStatus();
  btnSync.textContent = 'Sync Policy';
  btnSync.disabled = false;
});

// ---------------------------------------------------------------------------
// Listen for push updates from the service worker
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CG_POLICY_UPDATED') loadStatus();
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

// Init
loadStatus();
