// Manages chrome.declarativeNetRequest dynamic rules based on the active policy.
//
// Blocking architecture:
//   • DNS engine  — handles bulk blocklist (400K+ domains) at network level
//   • Extension   — enforces lesson whitelists, penalty box, and per-policy custom rules
//
// Rule ID ranges:
//   1     — catch-all block/redirect (lesson / penalty_box modes)
//   2     — catch-all block for non-main-frame resources
//   10–9  — reserved
//   100+  — per-domain block rules (standard mode deny list, batched 100/rule)
//   2000+ — per-domain allow rules (overrides, lesson whitelist)
//   3000  — YouTube-Restrict header injection
//   4000+ — per-pattern URL-path rules (e.g. GoGuardian import) — one rule
//           per pattern since urlFilter has no multi-pattern batching
//   20000 — override codes (kept clear of the 4000+ range)

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'script', 'stylesheet',
  'image', 'font', 'xmlhttprequest', 'media', 'websocket', 'other',
];
const PAGE_TYPES    = ['main_frame'];
const SUB_TYPES     = ALL_RESOURCE_TYPES.filter(t => t !== 'main_frame');

const BLOCK_ALL_MAIN   = 1;
const BLOCK_ALL_SUB    = 2;
const YT_RESTRICT_RULE = 3000;   // YouTube-Restrict header injection

// Build a redirect rule for main_frame to the blocked page
function redirectRule(id, condition, reason) {
  return {
    id,
    priority: 1,
    action: {
      type:     'redirect',
      redirect: { extensionPath: `/blocked.html?reason=${reason}` },
    },
    condition: { ...condition, resourceTypes: PAGE_TYPES },
  };
}

function blockRule(id, condition) {
  return {
    id,
    priority: 1,
    action: { type: 'block' },
    condition: { ...condition, resourceTypes: SUB_TYPES },
  };
}

function allowRule(id, domains) {
  return {
    id,
    priority: 10,
    action: { type: 'allow' },
    condition: { requestDomains: domains, resourceTypes: ALL_RESOURCE_TYPES },
  };
}

export async function enforcePolicy(policy) {
  if (!policy) {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    if (existing.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map(r => r.id),
        addRules: [],
      });
    }
    return;
  }

  // Read active (non-expired) override domains and clean up stale ones
  const { cg_overrides = [] } = await chrome.storage.local.get('cg_overrides');
  const now = Date.now();
  const activeOverrides = cg_overrides.filter(o => new Date(o.expires_at).getTime() > now);
  if (activeOverrides.length !== cg_overrides.length) {
    await chrome.storage.local.set({ cg_overrides: activeOverrides });
  }

  const newRules = buildRules(policy, activeOverrides.map(o => o.domain));
  const existing = await chrome.declarativeNetRequest.getDynamicRules();

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(r => r.id),
    addRules:      newRules,
  });
}

function buildRules(policy, overrideDomains = []) {
  const rules = [];
  const { mode = 'standard', resolvedAllowDomains = [], resolvedDenyDomains = [] } = policy;

  if (mode === 'lesson') {
    // Whitelist mode: block everything, then allow specific domains
    rules.push(redirectRule(BLOCK_ALL_MAIN, { urlFilter: '|http' }, 'lesson'));
    rules.push(blockRule(BLOCK_ALL_SUB,     { urlFilter: '|http' }));

    if (resolvedAllowDomains.length > 0) {
      rules.push(allowRule(2000, resolvedAllowDomains));
    }

  } else if (mode === 'penalty_box') {
    // Block all, allow Google sign-in endpoints so the student can still authenticate
    rules.push(redirectRule(BLOCK_ALL_MAIN, { urlFilter: '|http' }, 'penalty'));
    rules.push(blockRule(BLOCK_ALL_SUB,     { urlFilter: '|http' }));
    rules.push(allowRule(2000, ['accounts.google.com', 'oauth2.googleapis.com']));

  } else {
    // Standard mode: block only the custom deny list; allow list takes priority
    let ruleId = 100;

    const denyBatches = chunk(resolvedDenyDomains, 100);
    for (const batch of denyBatches) {
      rules.push({
        id:       ruleId++,
        priority: 5,
        action:   { type: 'redirect', redirect: { extensionPath: '/blocked.html?reason=policy' } },
        condition: { requestDomains: batch, resourceTypes: PAGE_TYPES },
      });
      rules.push({
        id:       ruleId++,
        priority: 5,
        action:   { type: 'block' },
        condition: { requestDomains: batch, resourceTypes: SUB_TYPES },
      });
    }

    // Explicit allow rules override any block
    if (resolvedAllowDomains.length > 0) {
      rules.push(allowRule(2000, resolvedAllowDomains));
    }

    // URL-path rules (e.g. imported from GoGuardian) — these are MORE
    // specific than a domain-level rule, so they outrank domain-allow: a
    // path denied here still blocks even under an otherwise-allowed domain
    // (e.g. allow youtube.com generally, but block one specific video URL).
    // declarativeNetRequest has no batched multi-pattern condition like
    // requestDomains, so this is one rule per pattern.
    const urlRules = policy?.resolvedUrlRules || [];
    let urlRuleId = 4000;
    for (const { pattern, rule_type } of urlRules) {
      if (rule_type === 'deny') {
        rules.push({
          id:        urlRuleId++,
          priority:  15,
          action:    { type: 'redirect', redirect: { extensionPath: '/blocked.html?reason=policy' } },
          condition: { urlFilter: pattern, resourceTypes: PAGE_TYPES },
        });
        rules.push({
          id:        urlRuleId++,
          priority:  15,
          action:    { type: 'block' },
          condition: { urlFilter: pattern, resourceTypes: SUB_TYPES },
        });
      } else {
        rules.push({
          id:        urlRuleId++,
          priority:  16,
          action:    { type: 'allow' },
          condition: { urlFilter: pattern, resourceTypes: ALL_RESOURCE_TYPES },
        });
      }
    }
  }

  // Override codes — highest priority allow rules, bypass all blocks except CIPA
  // (id kept well clear of the 4000+ per-pattern URL-rule range above)
  if (overrideDomains.length > 0) {
    rules.push({
      id:       20000,
      priority: 20,
      action:   { type: 'allow' },
      condition: { requestDomains: overrideDomains, resourceTypes: ALL_RESOURCE_TYPES },
    });
  }

  // YouTube Restricted Mode — injects YouTube-Restrict header on all youtube.com requests.
  // Works at the network layer for all resource types, including iframes and embeds.
  // The youtube_categories content script handles per-category and per-video blocking on top.
  const ytRestricted = policy?.youtube_restricted || 'off';
  if (ytRestricted !== 'off') {
    const value = ytRestricted === 'strict' ? 'Strict' : 'Moderate';
    rules.push({
      id:       YT_RESTRICT_RULE,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{
          header:    'YouTube-Restrict',
          operation: 'set',
          value,
        }],
      },
      condition: {
        urlFilter:     'youtube.com',
        resourceTypes: ALL_RESOURCE_TYPES,
      },
    });
  }

  return rules;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
