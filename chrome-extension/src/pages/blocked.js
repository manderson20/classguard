// Populates the blocked page based on the ?reason= URL parameter.
// Loads school branding from chrome.storage.local (synced by the service worker).
// In lesson mode also shows which domains are allowed.

const params = new URLSearchParams(window.location.search);
const reason = params.get('reason') || 'policy';

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
    message: "This website is blocked by your school's internet safety policy.",
  },
};

const cfg = CONFIGS[reason] || CONFIGS.policy;

// Set base content immediately (no flash of empty page)
document.getElementById('icon').textContent = cfg.emoji;
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

// Apply school branding and policy-specific overrides from storage
chrome.storage.local.get(['cg_branding', 'cg_policy'], ({ cg_branding: branding, cg_policy: policy }) => {
  // Primary color theming
  if (branding?.primary_color) {
    document.documentElement.style.setProperty('--primary',      branding.primary_color);
    document.documentElement.style.setProperty('--primary-light', branding.primary_color + '22');
    document.documentElement.style.setProperty('--primary-text',  branding.primary_color);
  }

  // School logo — replaces the emoji icon
  if (branding?.logo) {
    const img = document.getElementById('school-logo');
    img.src = branding.logo;
    img.style.display = 'block';
    document.getElementById('icon').style.display = 'none';
  }

  // School name
  if (branding?.school_name) {
    document.getElementById('school-name').textContent = branding.school_name;
    document.getElementById('footer').textContent = `ClassGuard — ${branding.school_name}`;
  }

  // Message: per-policy override > district branding message > hardcoded default
  if (reason === 'policy') {
    const customMsg = policy?.block_page_message || branding?.message;
    if (customMsg) {
      document.getElementById('message').textContent = customMsg;
    }
  }

  // Contact email
  if (branding?.contact_email) {
    const el = document.getElementById('contact');
    el.innerHTML = `If you believe this is an error, contact your IT administrator at <a href="mailto:${branding.contact_email}">${branding.contact_email}</a>.`;
    el.style.display = 'block';
  }

  // Lesson mode: show allowed domains
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
