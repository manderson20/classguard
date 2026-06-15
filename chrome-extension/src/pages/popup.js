// ClassGuard extension popup

const content    = document.getElementById('content');
const headerSub  = document.getElementById('header-sub');
const btnSync    = document.getElementById('btn-sync');
const btnSignout = document.getElementById('btn-signout');

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

function render({ authenticated, user, policy, socketConnected }) {
  if (!authenticated || !user) {
    headerSub.textContent = 'Not signed in';
    content.innerHTML = `
      <div class="section">
        <div class="label">Status</div>
        <div class="value" style="color:#ef4444">Not authenticated</div>
        <p style="font-size:12px;color:#94a3b8;margin-top:6px">
          Sign in to your school Google account to activate ClassGuard.
        </p>
      </div>`;
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

btnSignout.addEventListener('click', async () => {
  if (!confirm('Sign out of ClassGuard? Your internet access restrictions will be removed on this device.')) return;
  await sendMessage({ type: 'CG_SIGN_OUT' });
  await loadStatus();
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
