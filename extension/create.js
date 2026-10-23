// Create ✨ tab: describe a workflow or module -> approve an AI outline -> download a marked-up
// PowerPoint + PDF built from recorded screenshots. Talks to the bridge's /decks endpoints
// (tools/deck-studio.mjs). Uses sidepanel.js globals: $, $$, api, esc, BRIDGE, moduleIconPath.
(() => {
  const cr = {
    deckId: null, deck: null, poll: null,
    suggestions: [], shown: [],
    audience: 'admin', style: 'standard', length: 'auto',
    removed: new Set(), // slide ids removed in the outline review
    lbIndex: 0, booted: false,
    mode: 'create', library: [], libLoaded: false, libConnected: true, me: null, libTimer: null,
  };
  const STORE = 'createDeckState';
  const save = () => chrome.storage.local.set({ [STORE]: { deckId: cr.deckId, audience: cr.audience, style: cr.style, length: cr.length, prompt: $('#crPrompt').value } });

  const PLAN_STAGES = [
    { key: 'find', label: 'Finding recordings that cover it', match: /finding|starting|sync|search/i },
    { key: 'code', label: 'Reading the product code', match: /reading|outline/i },
    { key: 'outline', label: 'Drafting the outline', match: /drafting/i },
  ];
  const BUILD_STAGES = [
    { key: 'shots', label: 'Collecting screenshots', match: /collecting/i },
    { key: 'write', label: 'Verifying against the code and writing slides', match: /verifying|writing/i },
    { key: 'audit', label: 'Double-checking UI labels', match: /double-checking/i },
    { key: 'render', label: 'Marking up screenshots and building the deck', match: /marking|building the powerpoint/i },
  ];
  const AUD = { admin: 'Admins', employee: 'Employees', both: 'Admins + employees' };
  const STY = { standard: 'Standard', detailed: 'Detailed', visual: 'Visual' };
  const LEN = { auto: 'Auto length', quick: 'Quick', standard: 'Standard length', complete: 'Complete' };

  function show(which) {
    cr.current = which;
    for (const id of ['crCompose', 'crWorking', 'crOutline', 'crDone', 'crFailed']) $(`#${id}`).hidden = cr.mode === 'library' || id !== which;
    $('#createBusyDot').hidden = which !== 'crWorking';
  }
  function setMode(mode) {
    cr.mode = mode;
    $('#crModeCreate').classList.toggle('active', mode === 'create'); $('#crModeCreate').setAttribute('aria-selected', String(mode === 'create'));
    $('#crModeLibrary').classList.toggle('active', mode === 'library'); $('#crModeLibrary').setAttribute('aria-selected', String(mode === 'library'));
    $('#crLibrary').hidden = mode !== 'library';
    $('#createView').classList.toggle('lib-mode', mode === 'library');
    $('.cr-history').hidden = mode === 'library';
    show(cr.current || 'crCompose');
    if (mode === 'library') { loadLibrary(); setTimeout(() => $('#crLibSearch').focus(), 50); }
  }

  // ---------------------------------------------------------------- shared library (Drive "Slide Decks")
  const STOP = new Set('a an and the to of for in on with how do i my our is are be from by at as it this that guide deck slide slides getting started create make new show me about using use'.split(' '));
  const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length > 1 && !STOP.has(t));
  const stem = (t) => t.replace(/(ing|ed|es|s)$/, '');
  function scoreDeck(d, q) {
    const raw = tokens(q);
    const qs = raw.map(stem);
    if (!qs.length) return 0;
    // the word still being typed matches as a prefix, so results don't blink out mid-word ("impor" -> "import")
    const partial = /[a-z0-9]$/i.test(String(q).trim()) && !/\s$/.test(String(q)) ? raw[raw.length - 1] : null;
    const fields = [[d.title, 4], [d.request, 2], [d.module, 2], [(d.sections || []).join(' '), 1.5], [(d.slides || []).join(' '), 1], [d.subtitle, 1], [d.summary, 0.5]];
    let score = 0, hit = 0;
    for (const [i, t] of qs.entries()) {
      let best = 0;
      const pre = i === qs.length - 1 && partial ? partial : null;
      for (const [text, w] of fields) {
        const ft = tokens(text);
        if (ft.map(stem).includes(t) || (pre && ft.some((x) => x.startsWith(pre)))) best = Math.max(best, w);
      }
      if (best) { hit++; score += best; }
    }
    return hit ? score * (hit / qs.length) : 0;
  }
  function highlight(text, q) {
    const qs = tokens(q);
    let out = esc(text || '');
    if (!qs.length) return out;
    const re = new RegExp(`\\b(${qs.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return out.replace(re, '<mark>$1</mark>');
  }
  const coverUrl = (d) => (d.files?.cover ? `${BRIDGE}/decks/library/cover/${d.files.cover.id}` : '');
  const fileUrl = (f) => `${BRIDGE}/decks/library/file/${f.id}`;
  const fmtSize = (n) => (n ? (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`) : '');

  async function loadLibrary(fresh = false) {
    try {
      const r = await api(`/decks/library${fresh ? '?fresh=1' : ''}`);
      cr.libConnected = r.connected !== false; cr.me = r.me; cr.library = r.items || []; cr.libLoaded = true;
      if (r.folderUrl) { $('#crLibFolder').href = r.folderUrl; $('#crLibFolder').hidden = false; }
      $('#crLibCount').hidden = !cr.library.length; $('#crLibCount').textContent = cr.library.length;
      const mods = [...new Set(cr.library.map((d) => d.module).filter(Boolean))].sort();
      const sel = $('#crLibModule'); const cur = sel.value;
      sel.innerHTML = '<option value="">All modules</option>' + mods.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
      sel.value = mods.includes(cur) ? cur : '';
      renderLibrary(); renderExisting();
    } catch (e) {
      $('#crLibStatus').textContent = `Couldn't load the library: ${e.message}`;
    }
  }
  function renderLibrary() {
    if (!cr.libConnected) {
      $('#crLibStatus').textContent = '';
      $('#crLibList').innerHTML = '<div class="cr-lib-empty"><b>Google Drive isn\'t connected</b>Connect Drive on this computer (see the Drive dot in the header) to browse the shared Slide Decks library.</div>';
      return;
    }
    const q = $('#crLibSearch').value.trim();
    const fm = $('#crLibModule').value, fa = $('#crLibAudience').value, fs = $('#crLibStyle').value;
    let items = cr.library.filter((d) => (!fm || d.module === fm) && (!fa || d.audience === fa) && (!fs || d.style === fs));
    if (q && tokens(q).length) items = items.map((d) => [d, scoreDeck(d, q)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([d]) => d);
    $('#crLibStatus').textContent = cr.library.length
      ? `${items.length} of ${cr.library.length} deck${cr.library.length === 1 ? '' : 's'}${q ? ` matching "${q}"` : ''}`
      : '';
    if (!cr.library.length) {
      $('#crLibList').innerHTML = '<div class="cr-lib-empty"><b>No shared decks yet</b>Every deck you build is saved here for the whole team. Switch to ✨ New deck to make the first one.</div>';
      return;
    }
    if (!items.length) {
      $('#crLibList').innerHTML = `<div class="cr-lib-empty"><b>Nothing matches yet</b>No shared deck covers that. <button type="button" class="cr-btn-primary" id="crLibMake" style="margin-top:8px">✨ Create "${esc(clipText(q || 'a new deck', 40))}"</button></div>`;
      $('#crLibMake')?.addEventListener('click', () => { if (q) $('#crPrompt').value = q; updateCount(); save(); setMode('create'); show('crCompose'); renderExisting(); });
      return;
    }
    const card = (d) => `
      <div class="cr-lib-card${isGettingStarted(d) ? ' gs' : ''}" data-id="${esc(d.deckId)}">
        <div class="cr-lib-cover" title="Open the PDF in Google Drive">${coverUrl(d) ? `<img loading="lazy" src="${coverUrl(d)}" alt="">` : ''}${d.pages ? `<span class="cr-lib-pages">${d.pages} pp</span>` : ''}</div>
        <div class="cr-lib-body">
          <div class="cr-lib-title">${highlight(d.title, q)}</div>
          <div class="cr-lib-sub">${highlight(d.subtitle || d.request || '', q)}</div>
          <div class="cr-lib-meta">${d.module ? `<span class="cr-pill">${esc(d.module)}</span>` : ''}${d.audience ? `<span class="cr-pill">${esc(AUD[d.audience] || d.audience)}</span>` : ''}${d.style ? `<span class="cr-pill">${esc(STY[d.style] || d.style)}</span>` : ''}</div>
          <div class="cr-lib-by">${esc(d.createdBy || d.owner || '')}${d.createdAt ? ` · ${new Date(d.createdAt).toLocaleDateString()}` : ''}</div>
          <div class="cr-lib-actions">
            ${d.files.pdf ? `<a class="pdf" href="${fileUrl(d.files.pdf)}" title="Download PDF ${fmtSize(d.files.pdf.size)}">↓ PDF</a>` : ''}
            ${d.files.pptx ? `<a class="pptx" href="${fileUrl(d.files.pptx)}" title="Download PowerPoint ${fmtSize(d.files.pptx.size)}">↓ PPTX</a>` : ''}
            ${(d.files.pdf || d.files.pptx)?.url ? `<a href="${esc((d.files.pdf || d.files.pptx).url)}" target="_blank" rel="noopener noreferrer" title="View in Google Drive">View ↗</a>` : ''}
            ${d.createdBy && d.createdBy === cr.me ? '<button type="button" class="cr-lib-del" title="Remove from the shared library (you made this deck)">🗑</button>' : ''}
          </div>
        </div>
      </div>`;
    // Getting Started guides get their own collapsible group at the top; everything else lists below it.
    const gs = items.filter(isGettingStarted), rest = items.filter((d) => !isGettingStarted(d));
    const gsOpen = q || localStorage.getItem('crLibGsOpen') !== '0';   // a search always shows its matches
    $('#crLibList').innerHTML = (gs.length ? `
      <details class="cr-lib-group gs"${gsOpen ? ' open' : ''}>
        <summary><span>🚀 Getting Started Guides</span><span class="cr-lib-group-n">${gs.length}</span></summary>
        <div class="cr-lib-group-list">${gs.map(card).join('')}</div>
      </details>` : '')
      + (gs.length && rest.length ? '<div class="cr-lib-group-head">Other decks</div>' : '')
      + rest.map(card).join('');
    $('#crLibList .cr-lib-group.gs')?.addEventListener('toggle', (e) => { if (!q) localStorage.setItem('crLibGsOpen', e.target.open ? '1' : '0'); });
    $$('#crLibList .cr-lib-card').forEach((card) => {
      const d = cr.library.find((x) => x.deckId === card.dataset.id);
      card.querySelector('.cr-lib-cover').addEventListener('click', () => { const u = (d.files.pdf || d.files.pptx)?.url; if (u) window.open(u, '_blank', 'noopener'); });
      card.querySelector('.cr-lib-del')?.addEventListener('click', async () => {
        if (!confirm(`Remove "${d.title}" from the shared library for everyone?`)) return;
        try { await api(`/decks/library/${d.deckId}`, { method: 'DELETE' }); } catch (e) { alert(e.message); }
        loadLibrary(true);
      });
    });
  }
  const isGettingStarted = (d) => /getting\s+started/i.test(`${d.title || ''} ${d.request || ''}`);
  const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  function renderExisting() {
    const box = $('#crExisting');
    const q = $('#crPrompt').value.trim();
    if (!box || q.length < 4 || !cr.library.length) { if (box) box.hidden = true; return; }
    const hits = cr.library.map((d) => [d, scoreDeck(d, q)]).filter(([, s]) => s >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d);
    box.hidden = !hits.length;
    if (!hits.length) return;
    box.innerHTML = `<div class="cr-existing-head"><span>📚 Already in the shared library</span><button type="button" class="cr-ghost-btn" id="crExistingAll">See all</button></div>` + hits.map((d) => `
      <div class="cr-existing-item">${coverUrl(d) ? `<img src="${coverUrl(d)}" alt="">` : ''}<span class="t">${esc(d.title)}<small>${esc([d.module, AUD[d.audience], STY[d.style], d.pages ? `${d.pages} pages` : ''].filter(Boolean).join(' · '))}</small></span>
        ${d.files.pdf ? `<a href="${fileUrl(d.files.pdf)}" title="Download PDF">PDF</a>` : ''}${d.files.pptx ? `<a href="${fileUrl(d.files.pptx)}" title="Download PowerPoint">PPTX</a>` : ''}</div>`).join('');
    $('#crExistingAll').addEventListener('click', () => { $('#crLibSearch').value = q; setMode('library'); });
  }
  function setSeg(groupId, value) {
    $$(`#${groupId} [role=radio]`).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === value)));
  }
  function bindSeg(groupId, key) {
    $$(`#${groupId} [role=radio]`).forEach((b) => b.addEventListener('click', () => { cr[key] = b.dataset.v; setSeg(groupId, cr[key]); save(); }));
  }

  // ---------------------------------------------------------------- suggestions
  function shuffle(a) { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }
  function pickSuggestions() {
    const curated = cr.suggestions.slice(0, 22);
    const modules = shuffle(curated.filter((s) => s.kind === 'module')).slice(0, 2);
    const flows = shuffle(cr.suggestions.filter((s) => s.kind === 'workflow' && !modules.includes(s)));
    // favour the hand-picked workflows, sprinkle in recorded ones
    const pickedFlows = shuffle([...flows.filter((s) => curated.includes(s)).slice(0, 3), ...flows.filter((s) => !curated.includes(s)).slice(0, 1)]);
    cr.shown = [...modules, ...pickedFlows].slice(0, 6);
    renderSuggestions();
  }
  function renderSuggestions() {
    const box = $('#crSuggestions');
    if (!cr.shown.length) { box.innerHTML = '<span class="muted">Ideas load when the bridge is connected.</span>'; return; }
    box.innerHTML = cr.shown.map((s, i) => `<button type="button" class="cr-chip ${s.kind === 'module' ? 'module' : ''}" data-i="${i}" title="${esc(s.label)}">
      <img src="${moduleIconPath(s.module)}" alt=""><span class="cr-chip-text">${esc(s.label)}</span>${s.audience === 'employee' ? '<span class="cr-chip-aud">Employee</span>' : ''}</button>`).join('');
    box.querySelectorAll('.cr-chip').forEach((b) => b.addEventListener('click', () => {
      const s = cr.shown[+b.dataset.i];
      $('#crPrompt').value = s.prompt;
      cr.audience = s.audience; setSeg('crAudience', cr.audience);
      if (s.kind === 'module' && cr.length === 'auto') { /* auto picks a full guide for "Getting started" */ }
      updateCount(); save(); renderExisting();
      $('#crPrompt').focus();
    }));
  }
  async function loadSuggestions() {
    try {
      const r = await api('/decks/suggestions');
      cr.suggestions = r.items || [];
      $('#crRecCount').textContent = r.recordings ? `Built from ${r.recordings} recorded walkthroughs.` : '';
      pickSuggestions();
    } catch (e) {
      $('#crSuggestions').innerHTML = `<span class="muted">Couldn't load ideas: ${esc(e.message)}</span>`;
    }
  }
  function updateCount() { const n = $('#crPrompt').value.length; $('#crPromptCount').textContent = n ? `${n}/1200` : ''; }

  // ---------------------------------------------------------------- polling
  function stopPoll() { if (cr.poll) { clearTimeout(cr.poll); cr.poll = null; } }
  async function pollDeck() {
    stopPoll();
    if (!cr.deckId) return;
    try {
      const r = await api(`/decks/${cr.deckId}`);
      cr.deck = r.deck;
      renderDeck();
      if (['planning', 'building'].includes(cr.deck.status) || cr.deck.publishing) cr.poll = setTimeout(pollDeck, 2500);
      else { loadHistory(); if (cr.deck.status === 'done' && cr.deck.drive && !cr.library.some((x) => x.deckId === cr.deck.id)) loadLibrary(true); }
    } catch (e) {
      if (/not found/i.test(e.message)) { cr.deckId = null; save(); show('crCompose'); return; }
      cr.poll = setTimeout(pollDeck, 5000);
    }
  }

  function renderStages(stages, phase, statusDone) {
    let activeIdx = stages.findIndex((s) => s.match.test(phase || ''));
    if (activeIdx < 0) activeIdx = 0;
    $('#crStages').innerHTML = stages.map((s, i) => {
      const cls = statusDone || i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
      return `<li class="${cls}"><span class="cr-st-icon">${cls === 'done' ? '✓' : cls === 'active' ? '' : i + 1}</span>${esc(s.label)}</li>`;
    }).join('');
  }

  function renderDeck() {
    const d = cr.deck;
    if (!d) return;
    if (d.status === 'planning' || d.status === 'building') {
      show('crWorking');
      const building = d.status === 'building';
      $('#crWorkTitle').textContent = building ? `Building "${d.outline?.title || 'your deck'}"` : 'Drafting your outline';
      $('#crWorkPhase').textContent = d.phase || 'Working…';
      renderStages(building ? BUILD_STAGES : PLAN_STAGES, d.phase);
      const pr = d.progress;
      $('#crProgressWrap').hidden = !(building && pr && pr.total);
      if (building && pr && pr.total) $('#crProgressBar').style.width = `${Math.round((pr.done / pr.total) * 100)}%`;
      const last = (d.log || []).slice(-1)[0] || '';
      $('#crWorkLog').textContent = last.replace(/^\S+\s+\S*\s+/, '');
      $('#crWorkNote').textContent = building
        ? `Claude reads the real components for every screen, so this takes a few minutes${d.estimate > 25 ? ' (longer for big decks)' : ''}. You can switch tabs or close the panel.`
        : 'Usually under a minute. You can switch tabs or close the panel.';
      return;
    }
    if (d.status === 'outline') { renderOutline(); return; }
    if (d.status === 'done') { renderDone(); return; }
    // failed / cancelled
    show('crFailed');
    $('#crFailMsg').textContent = d.status === 'cancelled' ? 'This deck was cancelled.' : (d.error || 'Something went wrong.');
    $('#crRetryBtn').textContent = d.outline ? 'Back to the outline' : 'Try again';
  }

  // ---------------------------------------------------------------- outline review
  function renderOutline() {
    show('crOutline');
    const d = cr.deck, o = d.outline;
    $('#crOutTitle').textContent = o.title;
    $('#crOutSubtitle').textContent = o.subtitle || '';
    const slides = o.sections.reduce((n, s) => n + s.slides.length, 0);
    const recs = new Set(o.sections.flatMap((s) => s.slides.map((x) => x.source?.script).filter(Boolean)));
    $('#crOutMeta').innerHTML = [
      `👥 ${AUD[d.input.audience]}`, `🎨 ${STY[d.input.style]}`,
      `📄 ~${d.estimate || slides} pages`, `🎬 ${recs.size} recording${recs.size === 1 ? '' : 's'}`,
    ].map((t) => `<span class="cr-pill">${esc(t)}</span>`).join('');
    const gaps = o.gaps || [];
    $('#crOutGaps').hidden = !gaps.length;
    $('#crOutGaps').innerHTML = gaps.length ? `<b>⚠ Not covered by any recording yet</b><ul>${gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : '';
    $('#crOutSections').innerHTML = o.sections.map((s, si) => `
      <div class="cr-sec">
        <div class="cr-sec-head"><span class="cr-sec-num">${si + 1}</span><div><div class="cr-sec-title">${esc(s.title)}</div><div class="cr-sec-sum">${esc(s.summary || '')}</div></div><span class="cr-sec-count">${s.slides.length} slide${s.slides.length === 1 ? '' : 's'}</span></div>
        <ul class="cr-slides">${s.slides.map((x) => `
          <li class="cr-slide ${cr.removed.has(x.id) ? 'removed' : ''}" data-id="${x.id}">
            <span class="cr-slide-icon" title="${x.kind === 'concept' ? 'Overview slide' : 'Step-by-step slide'}">${x.kind === 'concept' ? '💡' : '🖼️'}</span>
            <div class="cr-slide-body"><div class="cr-slide-title">${esc(x.title)}</div>
              <div class="cr-slide-meta">${x.kind === 'concept' ? esc(x.purpose || 'Overview') : `${esc(x.recording || '')} · ${x.source.steps.length} step${x.source.steps.length === 1 ? '' : 's'}`}</div></div>
            <button type="button" class="cr-slide-x" title="${cr.removed.has(x.id) ? 'Put back' : 'Remove this slide'}">${cr.removed.has(x.id) ? '↺' : '✕'}</button>
          </li>`).join('')}</ul>
      </div>`).join('');
    $$('#crOutSections .cr-slide-x').forEach((b) => b.addEventListener('click', () => {
      const id = b.closest('.cr-slide').dataset.id;
      if (cr.removed.has(id)) cr.removed.delete(id); else cr.removed.add(id);
      renderOutline();
    }));
    const left = slides - cr.removed.size;
    $('#crBuildBtn').disabled = left < 1;
    $('#crBuildBtn').innerHTML = `<span class="cr-cta-spark">✨</span> ${cr.removed.size ? `Build ${left} slide${left === 1 ? '' : 's'}` : 'Looks good, build it'}`;
  }
  function editedOutline() {
    const o = JSON.parse(JSON.stringify(cr.deck.outline));
    o.sections = o.sections.map((s) => ({ ...s, slides: s.slides.filter((x) => !cr.removed.has(x.id)) })).filter((s) => s.slides.length);
    return o;
  }

  // ---------------------------------------------------------------- done
  function renderDone() {
    show('crDone');
    const d = cr.deck;
    $('#crDoneTitle').textContent = d.outline?.title || 'Slide deck';
    $('#crDoneMeta').innerHTML = [`📄 ${d.pages} pages`, `👥 ${AUD[d.input.audience]}`, `🎨 ${STY[d.input.style]}`].map((t) => `<span class="cr-pill">${esc(t)}</span>`).join('');
    const pptx = $('#crDlPptx'), pdf = $('#crDlPdf');
    pptx.href = `${BRIDGE}/decks/${d.id}/download/pptx`; pptx.setAttribute('aria-disabled', String(!d.files?.pptx));
    pdf.href = `${BRIDGE}/decks/${d.id}/download/pdf`; pdf.setAttribute('aria-disabled', String(!d.files?.pdf));
    $('#crPdfError').hidden = !d.pdfError; $('#crPdfError').textContent = d.pdfError || '';
    const sh = $('#crShared');
    if (d.publishing) sh.innerHTML = '☁️ Saving to the shared <b>Slide Decks</b> library in Google Drive…';
    else if (d.drive) sh.innerHTML = `☁️ Saved to the shared <b>Slide Decks</b> library, so the team can find and download it from 📚 Library. ${d.drive.pdf || d.drive.pptx ? `<a href="${esc((d.drive.pdf || d.drive.pptx).url)}" target="_blank" rel="noopener noreferrer">Open in Drive ↗</a>` : ''}`;
    else if (d.driveError) { sh.innerHTML = `⚠ ${esc(d.driveError)} <button type="button" class="cr-ghost-btn" id="crRepublish">Try again</button>`; $('#crRepublish')?.addEventListener('click', async () => { try { await api(`/decks/${d.id}/publish`, { method: 'POST' }); } catch (_) {} pollDeck(); }); }
    else sh.innerHTML = '';
    const v = d.verification || {};
    const m = v.markup || {};
    const inCode = (v.cited || 0) + (v.confirmed || 0);
    const boxed = (m.boxed_dom || 0) + (m.boxed_ocr || 0);
    const dropped = (m.box_blank || 0) + (m.box_conflict || 0) + (m.box_offset || 0);
    const unv = v.unverified || [];
    $('#crVerify').innerHTML = `
      <div>✓ <b>${v.labels || 0} UI labels checked</b>: ${v.recorded || 0} captured from the live product, ${inCode} confirmed in the frontend code${v.corrected ? `, <b>${v.corrected} corrected</b> to match the code` : ''}.</div>
      <div>✓ <b>${boxed} screenshot callouts</b> placed from recorded element positions${m.boxed_ocr ? ` (${m.boxed_ocr} by on-screen text)` : ''}, each checked against its screenshot. Steps without a reliable position get no box rather than a wrong one.</div>
      ${dropped || m.stale ? `<div>✓ ${[dropped ? `${dropped} recorded position${dropped === 1 ? '' : 's'} didn't match the screenshot and got no box` : '', m.stale ? `${m.stale} outdated screenshot${m.stale === 1 ? ' was' : 's were'} left out` : ''].filter(Boolean).join('; ')}.</div>` : ''}
      ${unv.length ? `<div class="cr-danger-text">⚠ ${unv.length} label${unv.length === 1 ? '' : 's'} couldn't be confirmed and ${unv.length === 1 ? 'is' : 'are'} shown as plain text: ${unv.slice(0, 6).map(esc).join(', ')}</div>` : ''}
      ${(v.corrections || []).length ? `<details><summary>What Claude corrected</summary><ul>${v.corrections.slice(0, 12).map((c) => `<li>"${esc(c.was)}" → "${esc(c.now)}"</li>`).join('')}</ul></details>` : ''}`;
    const thumbs = d.thumbs || [];
    $('#crThumbs').innerHTML = thumbs.map((t, i) => `<img loading="lazy" src="${BRIDGE}/decks/${d.id}/thumb/${encodeURIComponent(t)}" data-i="${i}" alt="Slide ${i + 1}">`).join('');
    $$('#crThumbs img').forEach((img) => img.addEventListener('click', () => openLightbox(+img.dataset.i)));
  }
  function openLightbox(i) {
    const thumbs = cr.deck?.thumbs || [];
    if (!thumbs.length) return;
    cr.lbIndex = (i + thumbs.length) % thumbs.length;
    $('#crLightboxImg').src = `${BRIDGE}/decks/${cr.deck.id}/thumb/${encodeURIComponent(thumbs[cr.lbIndex])}`;
    $('#crLightbox').hidden = false;
  }

  // ---------------------------------------------------------------- history
  async function loadHistory() {
    try {
      const r = await api('/decks');
      const items = r.items || [];
      if (!items.length) { $('#crHistory').innerHTML = '<p class="muted">No decks yet. Your finished decks will be listed here.</p>'; return; }
      const label = { done: 'Ready', outline: 'Outline to review', planning: 'Drafting outline…', building: 'Building…', failed: 'Failed', cancelled: 'Cancelled' };
      $('#crHistory').innerHTML = items.slice(0, 12).map((it) => `
        <div class="cr-hist" data-id="${esc(it.id)}">
          <span class="cr-hist-icon">${it.style === 'visual' ? '🖼️' : it.style === 'detailed' ? '📘' : '📊'}</span>
          <div class="cr-hist-body"><div class="cr-hist-title">${esc(it.title || it.request || 'Untitled')}</div>
            <div class="cr-hist-meta"><span class="cr-status-dot ${esc(it.status)}"></span>${esc(label[it.status] || it.status)} · ${esc(AUD[it.audience] || '')} · ${esc(STY[it.style] || '')}${it.pages ? ` · ${it.pages} pages` : ''} · ${new Date(it.createdAt).toLocaleDateString()}</div></div>
          ${it.status === 'done' && it.files ? `<span class="cr-hist-dl">${it.files.pptx ? `<a href="${BRIDGE}/decks/${esc(it.id)}/download/pptx" title="Download PowerPoint">PPTX</a>` : ''}${it.files.pdf ? `<a href="${BRIDGE}/decks/${esc(it.id)}/download/pdf" title="Download PDF">PDF</a>` : ''}</span>` : ''}
          <button type="button" class="cr-hist-del" title="Delete this deck">🗑</button>
        </div>`).join('');
      $$('#crHistory .cr-hist').forEach((row) => {
        row.addEventListener('click', (e) => {
          if (e.target.closest('a')) return;
          if (e.target.closest('.cr-hist-del')) return;
          openDeck(row.dataset.id);
        });
        row.querySelector('.cr-hist-del').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('Delete this deck and its files?')) return;
          try { await api(`/decks/${row.dataset.id}`, { method: 'DELETE' }); } catch (_) {}
          if (cr.deckId === row.dataset.id) { cr.deckId = null; cr.deck = null; save(); show('crCompose'); }
          loadHistory();
        });
      });
    } catch (e) {
      $('#crHistory').innerHTML = `<p class="muted">Couldn't load decks: ${esc(e.message)}</p>`;
    }
  }
  function openDeck(id) {
    cr.deckId = id; cr.removed = new Set(); save();
    pollDeck();
    $('#createView').scrollTo?.({ top: 0, behavior: 'smooth' }); window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------------------------------------------------------------- actions
  async function startPlan(extra = {}) {
    const request = $('#crPrompt').value.trim();
    if (request.length < 4) { $('#crPrompt').focus(); $('.cr-prompt-wrap').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 250 }); return; }
    const btn = $('#crPlanBtn'); btn.disabled = true;
    try {
      const r = await api('/decks/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request, audience: cr.audience, style: cr.style, length: cr.length, ...extra }) });
      cr.deckId = r.id; cr.removed = new Set(); save();
      cr.deck = { status: 'planning', phase: 'Starting', input: { audience: cr.audience, style: cr.style } };
      renderDeck();
      pollDeck();
    } catch (e) {
      alert(`Couldn't start: ${e.message}`);
    } finally { btn.disabled = false; }
  }

  function boot() {
    if (cr.booted) return;
    cr.booted = true;
    bindSeg('crAudience', 'audience'); bindSeg('crStyle', 'style'); bindSeg('crLength', 'length');
    let existTimer = null;
    $('#crPrompt').addEventListener('input', () => { updateCount(); save(); clearTimeout(existTimer); existTimer = setTimeout(renderExisting, 250); });
    $('#crModeCreate').addEventListener('click', () => setMode('create'));
    $('#crModeLibrary').addEventListener('click', () => setMode('library'));
    $('#crLibSearch').addEventListener('input', () => renderLibrary());
    ['#crLibModule', '#crLibAudience', '#crLibStyle'].forEach((s) => $(s).addEventListener('change', () => renderLibrary()));
    $('#crLibRefresh').addEventListener('click', () => loadLibrary(true));
    $('#crPrompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) startPlan(); });
    $('#crShuffle').addEventListener('click', pickSuggestions);
    $('#crPlanBtn').addEventListener('click', () => startPlan());
    $('#crCancelBtn').addEventListener('click', async () => {
      if (!cr.deckId) return;
      try { await api(`/decks/${cr.deckId}/cancel`, { method: 'POST' }); } catch (_) {}
      pollDeck();
    });
    $('#crBuildBtn').addEventListener('click', async () => {
      const btn = $('#crBuildBtn'); btn.disabled = true;
      try {
        await api(`/decks/${cr.deckId}/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outline: editedOutline() }) });
        cr.removed = new Set();
        pollDeck();
      } catch (e) { alert(e.message); btn.disabled = false; }
    });
    $('#crReviseBtn').addEventListener('click', () => { $('#crReviseBox').hidden = false; $('#crReviseText').focus(); });
    $('#crReviseCancel').addEventListener('click', () => { $('#crReviseBox').hidden = true; });
    $('#crReviseSend').addEventListener('click', () => {
      const feedback = $('#crReviseText').value.trim();
      if (!feedback) { $('#crReviseText').focus(); return; }
      const d = cr.deck;
      $('#crPrompt').value = d.input.request;
      cr.audience = d.input.audience; cr.style = d.input.style; cr.length = d.input.length || 'auto';
      $('#crReviseText').value = ''; $('#crReviseBox').hidden = true;
      startPlan({ feedback, fromId: d.id, outline: editedOutline() });
    });
    const restart = () => { stopPoll(); cr.deckId = null; cr.deck = null; cr.removed = new Set(); save(); show('crCompose'); loadHistory(); };
    $('#crRestartBtn').addEventListener('click', restart);
    $('#crFailRestart').addEventListener('click', restart);
    $('#crNewBtn').addEventListener('click', () => { restart(); $('#crPrompt').value = ''; updateCount(); save(); pickSuggestions(); $('#crPrompt').focus(); });
    $('#crRebuildBtn').addEventListener('click', () => { cr.deck.status = 'outline'; renderOutline(); });
    $('#crRetryBtn').addEventListener('click', () => {
      const d = cr.deck;
      if (d?.outline) { d.status = 'outline'; renderOutline(); return; }
      if (d?.input) { $('#crPrompt').value = d.input.request; cr.audience = d.input.audience; cr.style = d.input.style; cr.length = d.input.length || 'auto'; }
      setSeg('crAudience', cr.audience); setSeg('crStyle', cr.style); setSeg('crLength', cr.length);
      startPlan();
    });
    $('#crHistoryRefresh').addEventListener('click', loadHistory);
    $('#crLightboxClose').addEventListener('click', () => { $('#crLightbox').hidden = true; });
    $('#crLightbox').addEventListener('click', (e) => { if (e.target.id === 'crLightbox') $('#crLightbox').hidden = true; });
    $('#crLbPrev').addEventListener('click', () => openLightbox(cr.lbIndex - 1));
    $('#crLbNext').addEventListener('click', () => openLightbox(cr.lbIndex + 1));
    document.addEventListener('keydown', (e) => {
      if ($('#crLightbox').hidden) return;
      if (e.key === 'Escape') $('#crLightbox').hidden = true;
      if (e.key === 'ArrowLeft') openLightbox(cr.lbIndex - 1);
      if (e.key === 'ArrowRight') openLightbox(cr.lbIndex + 1);
    });

    chrome.storage.local.get([STORE], (r) => {
      const s = r?.[STORE] || {};
      cr.audience = s.audience || 'admin'; cr.style = s.style || 'standard'; cr.length = s.length || 'auto';
      setSeg('crAudience', cr.audience); setSeg('crStyle', cr.style); setSeg('crLength', cr.length);
      if (s.prompt) { $('#crPrompt').value = s.prompt; updateCount(); }
      if (s.deckId) { cr.deckId = s.deckId; pollDeck(); } else show('crCompose');
    });
    loadSuggestions();
    loadHistory();
    loadLibrary();
    cr.libTimer = setInterval(() => { if (!$('#createView').hidden) loadLibrary(); }, 60000);
  }

  window.onCreateViewShown = () => {
    boot();
    if (cr.deckId && !cr.poll) pollDeck();
    loadHistory();
  };
  // Keep the tab's busy dot honest even before the tab is opened.
  chrome.storage.local.get([STORE], (r) => {
    const id = r?.[STORE]?.deckId;
    if (!id) return;
    api(`/decks/${id}`).then((x) => { $('#createBusyDot').hidden = !['planning', 'building'].includes(x.deck.status); }).catch(() => {});
  });
})();
