const params       = new URLSearchParams(window.location.search);
const reason       = params.get('reason') || 'policy';

const blockedDomain = (() => {
  try {
    const ref = document.referrer;
    return ref ? new URL(ref).hostname : null;
  } catch { return null; }
})();
const domain = blockedDomain || window.location.hostname;

const CONFIGS = {
  lesson: {
    emoji:   '📚',
    cls:     'lesson',
    badge:   'Active Lesson',
    heading: 'Website Not Allowed During Lesson',
    message: 'Your teacher has restricted internet access to specific sites for this lesson.',
  },
  penalty: {
    emoji:   '⚠️',
    cls:     'penalty',
    badge:   'Internet Restricted',
    heading: 'Your Internet Access Is Restricted',
    message: 'A teacher has temporarily limited your browser activity. Please see your teacher for more information.',
  },
  policy: {
    emoji:   '🛡️',
    cls:     'policy',
    badge:   'Blocked by Policy',
    heading: 'This Site Is Blocked',
    message: "This website is blocked by your school's internet safety policy.",
  },
};

const cfg = CONFIGS[reason] || CONFIGS.policy;

// Set base content immediately (no flash)
document.getElementById('badge').textContent = cfg.badge;
document.getElementById('badge').classList.add(cfg.cls);
document.getElementById('heading').textContent = cfg.heading;
document.getElementById('message').textContent  = cfg.message;

if (reason === 'lesson' || reason === 'penalty') {
  document.getElementById('icon').textContent = cfg.emoji;
  document.getElementById('icon').classList.add(cfg.cls);
  document.getElementById('icon').style.display = 'flex';
} else {
  document.getElementById('classguard-logo').style.display = 'block';
}

if (blockedDomain) {
  const el = document.getElementById('domain');
  el.textContent = blockedDomain;
  el.style.display = 'inline-block';
}

// Toggle the reason textarea visible when button is clicked
window.toggleForm = function () {
  const form = document.getElementById('unblock-form');
  form.style.display = form.style.display === 'block' ? 'none' : 'block';
  if (form.style.display === 'block') {
    document.getElementById('req-reason').focus();
  }
};

window.submitRequest = function () {
  const reasonText = document.getElementById('req-reason').value.trim();
  const btn = document.getElementById('submit-req');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  chrome.runtime.sendMessage({ type: 'CG_REQUEST_UNBLOCK', domain, reason: reasonText }, (resp) => {
    btn.textContent = 'Send Request';
    const resultEl = document.getElementById('req-result');
    if (chrome.runtime.lastError || resp?.error) {
      btn.disabled = false;
      resultEl.textContent = resp?.error || 'Request failed. Please try again.';
      resultEl.className = 'err';
      resultEl.style.display = 'block';
    } else {
      resultEl.textContent = 'Request submitted — IT will review it shortly.';
      resultEl.className = 'ok';
      resultEl.style.display = 'block';
      btn.disabled = true;
      document.getElementById('unblock-btn').disabled = true;
    }
  });
};

// Apply branding and decide whether to show the unblock button
chrome.storage.local.get(['cg_branding', 'cg_policy'], ({ cg_branding: branding, cg_policy: policy }) => {
  // Color theming
  if (branding?.primary_color) {
    document.documentElement.style.setProperty('--primary',      branding.primary_color);
    document.documentElement.style.setProperty('--primary-light', branding.primary_color + '22');
    document.documentElement.style.setProperty('--primary-text',  branding.primary_color);
  }

  // School logo (policy blocks only)
  if (branding?.logo && reason !== 'lesson' && reason !== 'penalty') {
    const img = document.getElementById('school-logo');
    img.src = branding.logo;
    img.style.display = 'block';
    document.getElementById('classguard-logo').style.display = 'none';
  }

  // School name
  if (branding?.school_name) {
    document.getElementById('school-name').textContent = branding.school_name;
    document.getElementById('footer').textContent = `ClassGuard — ${branding.school_name}`;
  }

  // Custom block message (policy-specific overrides district message)
  if (reason === 'policy') {
    const customMsg = policy?.block_page_message || branding?.message;
    if (customMsg) document.getElementById('message').textContent = customMsg;
  }

  // Contact email
  if (branding?.contact_email) {
    const el = document.getElementById('contact');
    el.innerHTML = `If you believe this is an error, contact IT at <a href="mailto:${branding.contact_email}">${branding.contact_email}</a>.`;
    el.style.display = 'block';
  }

  // Unblock request button — policy blocks only, based on OU and setting
  if (reason === 'policy') {
    const who = branding?.unblock_requests_who || 'all';
    if (who !== 'off') {
      const studentOu = policy?.google_ou || '';
      // If "staff" mode, only show button for OUs that don't look like student OUs.
      // The simplest heuristic: show unless "staff" mode AND the OU contains /student (case-insensitive).
      const isStudentOu = /\/student/i.test(studentOu);
      const allowed = who === 'all' || (who === 'staff' && !isStudentOu);
      if (allowed) {
        document.getElementById('unblock-wrap').style.display = 'block';
      }
    }
  }

  // Lesson mode — show allowed domains
  if (reason === 'lesson') {
    const domains = policy?.resolvedAllowDomains || [];
    if (domains.length > 0) {
      const container = document.getElementById('allowed-list');
      const list      = document.getElementById('allowed-items');
      domains.forEach((d) => {
        const li = document.createElement('li');
        li.textContent = d;
        list.appendChild(li);
      });
      container.style.display = 'block';
    }
  }
});
