// Hadrius Studio — "Open in Studio" landing page (webhook service /api/studio-open?job=<id>).
// Marks the page so it knows the extension is installed, and forwards the button click to the
// background worker, which opens the side panel on that drift job (Chrome requires a click).
(() => {
  document.documentElement.dataset.hadriusStudio = '1';
  const btn = document.getElementById('hadrius-studio-open');
  if (!btn) return;
  const hint = document.getElementById('hadrius-studio-hint');
  btn.addEventListener('click', () => {
    const jobId = btn.dataset.job || '';
    btn.disabled = true;
    chrome.runtime.sendMessage({ type: 'OPEN_DRIFT_JOB', jobId }, (r) => {
      btn.disabled = false;
      const err = chrome.runtime.lastError?.message || (r && !r.ok ? r.error : null);
      if (hint) hint.textContent = err ? `Couldn't open Studio: ${err}` : 'Opened in the Studio side panel →';
    });
  });
})();
