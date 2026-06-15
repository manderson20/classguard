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

const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'script', 'stylesheet',
  'image', 'font', 'xmlhttprequest', 'media', 'websocket', 'other',
];
const PAGE_TYPES    = ['main_frame'];
const SUB_TYPES     = ALL_RESOURCE_TYPES.filter(t => t !== 'main_frame');

const BLOCK_ALL_MAIN = 1;
const BLOCK_ALL_SUB  = 2;

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
    // Signed out or unknown — remove all rules
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    if (existing.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map(r => r.id),
        addRules: [],
      });
    }
    return;
  }

  const newRules = buildRules(policy);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(r => r.id),
    addRules:      newRules,
  });
}

function buildRules(policy) {
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
