// ClassGuard content script — injected into every http/https page.
// Minimal Phase 5 implementation: reports page loads to the service worker.
// Phase 6 will add screenshot capture and teacher overlay notifications.

(function () {
  // Avoid double-injection
  if (window.__classguardInjected) return;
  window.__classguardInjected = true;

  // Report page load when DOM is ready
  const report = () => {
    chrome.runtime.sendMessage({
      type:  'CG_PAGE_LOADED',
      url:   window.location.href,
      title: document.title,
    }).catch(() => {}); // extension may be reloading
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', report, { once: true });
  } else {
    report();
  }

  // Listen for messages from the service worker (Phase 6: show notice / screenshot)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CG_SHOW_NOTICE') {
      showNotice(msg.text, msg.level);
    }
  });

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
