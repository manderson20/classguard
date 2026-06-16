// ClassGuard content script — injected into every http/https page.
// Scans page text for flagged keywords and reports violations to the service worker.

(function () {
  if (window.__classguardInjected) return;
  window.__classguardInjected = true;

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
    }
  });

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
}());
