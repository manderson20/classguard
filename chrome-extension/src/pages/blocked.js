// Populates the blocked page based on the ?reason= URL parameter.
// Also loads the current policy from storage to show allowed domains in lesson mode.

const params = new URLSearchParams(window.location.search);
const reason = params.get('reason') || 'policy';

// Attempt to extract the original URL from the referrer (best-effort)
const blockedDomain = (() => {
  try {
    const ref = document.referrer;
    return ref ? new URL(ref).hostname : null;
  } catch {
    return null;
  }
})();

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
    message: 'This website is blocked by your school's internet safety policy.',
  },
};

const cfg = CONFIGS[reason] || CONFIGS.policy;

document.getElementById('icon').textContent  = cfg.emoji;
document.getElementById('icon').classList.add(cfg.cls);
document.getElementById('badge').textContent = cfg.badge;
document.getElementById('badge').classList.add(cfg.cls);
document.getElementById('heading').textContent = cfg.heading;
document.getElementById('message').textContent  = cfg.message;

if (blockedDomain) {
  const el = document.getElementById('domain');
  el.textContent = blockedDomain;
  el.style.display = 'inline-block';
}

// In lesson mode, show which sites are allowed
if (reason === 'lesson') {
  chrome.storage.local.get('cg_policy', ({ cg_policy: policy }) => {
    const domains = policy?.resolvedAllowDomains || [];
    if (domains.length === 0) return;

    const container = document.getElementById('allowed-list');
    const list      = document.getElementById('allowed-items');
    domains.forEach((d) => {
      const li = document.createElement('li');
      li.textContent = d;
      list.appendChild(li);
    });
    container.style.display = 'block';
  });
}
