// KB Studio Recorder — content script
// Captures user actions as semantic fingerprints (not pixels) so a renderer can replay them
// after UI changes. Recording status (step count, last action, Stop/+Note) lives in the
// extension's side panel, not on the page — see sidepanel.html's #recordingHud.
(() => {
  if (window.__kbStudioLoaded) return;
  window.__kbStudioLoaded = true;

  let recording = false;
  let stepIndex = 0;
  let typingBuffer = null; // {fingerprint, text, startedAt}

  // ---------- utilities ----------
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function cssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let sel = node.tagName.toLowerCase();
      if (node.id && !/^\d|[:.]/.test(node.id)) { parts.unshift(`#${node.id}`); break; }
      const testid = node.getAttribute('data-testid');
      if (testid) { parts.unshift(`[data-testid="${testid}"]`); break; }
      const parent = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = parent;
    }
    return parts.join(' > ');
  }

  // Radios/checkboxes/options in shadcn-style UIs carry their label in a sibling or the row
  // container, not on the control. Walk out to the row and read its text (minus other controls).
  function rowLabel(el) {
    let node = el;
    for (let d = 0; node && d < 4; d++) {
      node = node.parentElement; if (!node) break;
      const controls = node.querySelectorAll('[role="radio"],[role="checkbox"],input,button');
      const txt = clean(node.innerText || node.textContent);
      if (txt && txt.length <= 160 && controls.length <= 2) return txt;
    }
    return '';
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const role = el.getAttribute('role') || implicitRole(el);
    if (['radio', 'checkbox', 'switch'].includes(role) && !clean(el.textContent)) {
      const rl = rowLabel(el); if (rl) return rl;
    }
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent).filter(Boolean).join(' ');
      if (t) return clean(t);
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return clean(lab.textContent);
    }
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) return clean(wrappingLabel.textContent);
    if (el.placeholder) return clean(el.placeholder);
    if (el.title) return clean(el.title);
    const txt = clean(el.innerText || el.textContent);
    return txt.length <= 80 ? txt : txt.slice(0, 80);
  }

  function nearestHeading(el) {
    let node = el;
    for (let depth = 0; node && depth < 8; depth++) {
      const h = node.querySelector?.('h1,h2,h3,h4,[role="heading"]');
      if (h && !h.contains(el) && h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) return clean(h.textContent).slice(0, 80);
      node = node.parentElement;
    }
    const all = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'));
    const before = all.filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before.length ? clean(before[before.length - 1].textContent).slice(0, 80) : null;
  }

  // Some buttons/links (e.g. an icon-only "enter this company" arrow on a company card) have no
  // accessible name at all — no text, no aria-label, no title. Rather than record an unusably
  // ambiguous fingerprint, look for a card/row-level title (bold text, heading) and use it as a
  // scoping label: "the button on the card titled X". Re-used by the resolver below.
  function cardTitleText(el) {
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      const title = node.querySelector?.('.text-2xl,.font-bold,h1,h2,h3,h4,[role="heading"]');
      if (title && clean(title.textContent) && clean(title.textContent).length <= 60) return clean(title.textContent);
      node = node.parentElement;
    }
    return null;
  }
  function findByCardText(cardText, wantRole) {
    if (!cardText) return null;
    const heads = Array.from(document.querySelectorAll('.text-2xl,.font-bold,h1,h2,h3,h4,[role="heading"]')).filter((h) => clean(h.textContent) === cardText);
    for (const h of heads) {
      let node = h;
      for (let i = 0; i < 8 && node; i++) {
        const candidates = Array.from(node.querySelectorAll('button,a,[role="button"]')).filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          if (wantRole) return (el.getAttribute('role') || implicitRole(el)) === wantRole;
          return true;
        });
        if (candidates.length) return candidates[0];
        node = node.parentElement;
      }
    }
    return null;
  }

  function fieldLabel(el) {
    // Label text visually preceding an input/combobox within its form row
    let node = el;
    for (let d = 0; node && d < 5; d++) {
      const prev = node.previousElementSibling;
      if (prev && /label|p|span|div/i.test(prev.tagName) && clean(prev.textContent).length < 60) return clean(prev.textContent);
      node = node.parentElement;
    }
    return null;
  }

  function interactiveTarget(el) {
    return (
      el.closest(
        'button,a,input,textarea,select,[role="button"],[role="option"],[role="radio"],[role="checkbox"],[role="combobox"],[role="tab"],[role="menuitem"],[role="switch"],[contenteditable="true"]'
      ) || el
    );
  }

  // Calendar day cells are labelled with the literal date ("Today, Tuesday, September 8th, 2026"),
  // which is wrong by tomorrow. Record what the click MEANT instead: today, or a day of the month.
  // Trailing suffix allowed: react-day-picker and similar libs append ", Selected" (or lowercase) to
  // the selected day's aria-label — without it the regex silently stopped matching the one cell that
  // actually needs {today|day} resolution (the day just clicked / already selected).
  const DATE_LABEL_RE = /^(Today, )?(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (?:January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})(?:st|nd|rd|th)?, \d{4}(?:,? [Ss]elected)?$/;
  function dateHint(el) {
    if (!el.closest('table,[role="grid"]')) return null;
    const m = (accessibleName(el) || '').match(DATE_LABEL_RE);
    const looksLikeDay = m || el.hasAttribute('data-day') || /day/i.test(el.className || '');
    if (!looksLikeDay) return null;
    const day = m ? parseInt(m[2], 10) : parseInt(clean(el.textContent), 10);
    if (!day) return null;
    const today = !!(m && m[1]) || el.getAttribute('aria-current') === 'date' || el.hasAttribute('data-today') || /(^|\s)(rdp-day_today|today)(\s|$)/.test(el.className || '');
    return today ? { today: true, day } : { day };
  }

  function isDatePickerButton(el) {
    if (!el || (el.tagName?.toLowerCase() !== 'button' && el.getAttribute?.('role') !== 'button')) return false;
    const text = clean(el.innerText || el.textContent);
    const isDateLike = /^(?:Pick|Select|Choose)\s+a?\s*date\b|^(?:Today|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i.test(text);
    const hasCalIcon = !!el.querySelector('svg') && /calendar/i.test(el.innerHTML);
    const label = fieldLabel(el) || '';
    const isDateLabel = /\b(date|due|deadline)\b/i.test(label);
    return isDateLike || (isDateLabel && (hasCalIcon || el.getAttribute('aria-haspopup') === 'dialog'));
  }

  function fingerprint(el) {
    const t = interactiveTarget(el);
    const r = t.getBoundingClientRect();
    const name = accessibleName(t);
    const role = t.getAttribute('role') || implicitRole(t);
    const cardText = !name && (role === 'button' || role === 'link') ? cardTitleText(t) : null;
    return {
      tag: t.tagName.toLowerCase(),
      role,
      name,
      date: dateHint(t),
      datePicker: isDatePickerButton(t) || undefined,
      text: clean(t.innerText || t.textContent).slice(0, 120),
      placeholder: t.placeholder || null,
      label: fieldLabel(t),
      testid: t.getAttribute('data-testid') || null,
      heading: nearestHeading(t),
      cardText,
      css: cssPath(t),
      inDialog: !!t.closest('[role="dialog"],[role="alertdialog"]'),
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.href) return 'link';
    if (tag === 'tr' && el.closest('tbody')) return 'row'; // AI-recorded row clicks resolve by role+name like everything else
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (['checkbox', 'radio'].includes(type)) return type;
      if (type === 'submit' || type === 'button') return 'button';
      return 'textbox';
    }
    return null;
  }

  // ---------- step emission ----------
  // captureId identifies this step's record-time screenshot on disk (out/_recordings/<id>/step_<captureId>.png).
  // It must survive editing (deleting/reordering steps re-numbers `index`) and survive the content
  // script re-injecting mid-recording (a page reload resets any in-memory counter) — a per-emit
  // timestamp+random string is simpler and safer than a counter for both.
  function newCaptureId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function cleanup() {
    recording = false;
    if (navObserver) clearInterval(navObserver);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('focusout', onBlur, true);
  }
  function emit(step) {
    if (!chrome.runtime?.id) {
      cleanup();
      return;
    }
    step.index = stepIndex++;
    step.captureId = newCaptureId();
    step.dpr = window.devicePixelRatio || 1;
    step.url = location.href;
    step.route = location.pathname + location.search;
    step.title = document.title;
    step.ts = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'KB_STEP', step })?.catch(() => {});
    } catch (_) {
      cleanup();
    }
  }

  function flushTyping() {
    if (!typingBuffer) return;
    const buf = typingBuffer; typingBuffer = null;
    if (buf.focus && buf.text === (buf.initial ?? '')) return; // focused but typed nothing
    emit({ action: 'type', target: buf.fingerprint, value: buf.text });
  }

  // Click capture — pointerdown fires before the app mutates the DOM (e.g. closes a dropdown)
  function onPointerDown(e) {
    if (!recording) return;
    if (e.button !== 0) return;
    flushTyping();
    const t = interactiveTarget(e.target);
    const fp = fingerprint(t);
    const isTextField = /^(input|textarea)$/i.test(t.tagName) && !['checkbox', 'radio', 'submit', 'button'].includes((t.type || '').toLowerCase());
    if (isTextField || t.isContentEditable) {
      // Don't emit a click for focusing a text field; the type step will carry the target.
      typingBuffer = { fingerprint: fp, text: t.value || '', initial: t.value || '', startedAt: Date.now(), focus: true };
      return;
    }
    // Clicks on anonymous containers (no role, no text, no id/testid) are almost always
    // "click outside to close a dropdown" on an invisible overlay. They can't be replayed
    // meaningfully, so don't record them — the renderer presses Escape between steps anyway.
    const anonymous = !fp.role && !fp.name && !fp.text && !/^#|\[data-testid/.test(fp.css || '') && !/^(button|a|input|select|textarea|label|summary)$/i.test(t.tagName);
    if (anonymous) return;
    emit({ action: 'click', target: fp });
  }

  function onInput(e) {
    if (!recording) return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable)) return;
    const path = cssPath(t);
    if (typingBuffer && typingBuffer.fingerprint?.css !== path) flushTyping(); // switched fields
    const fp = fingerprint(t);
    typingBuffer = { fingerprint: fp, text: t.isContentEditable ? clean(t.textContent) : t.value, startedAt: typingBuffer?.startedAt || Date.now(), initial: typingBuffer?.initial, focus: false };
  }

  function onKeyDown(e) {
    if (!recording) return;
    if (e.key === 'Enter' && typingBuffer) { flushTyping(); emit({ action: 'press', key: 'Enter' }); }
    if (e.key === 'Escape') { flushTyping(); emit({ action: 'press', key: 'Escape' }); }
    if (e.key === 'Tab') flushTyping();
  }

  function onBlur(e) {
    if (recording && typingBuffer && (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) flushTyping();
  }

  let lastUrl = location.href;
  const navObserver = setInterval(() => {
    if (!chrome.runtime?.id) {
      cleanup();
      return;
    }
    if (recording && location.href !== lastUrl) {
      lastUrl = location.href;
      emit({ action: 'navigate', value: location.href });
    }
  }, 300);

  // ---------- control ----------
  function start(fromIndex) {
    recording = true;
    stepIndex = fromIndex || 0;
    return true;
  }
  function stop() { flushTyping(); recording = false; }

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusout', onBlur, true);

  // ---------- "▶ AI" on a Workflow-guide step: let the AI perform ONE step in this tab ----------
  // The page snapshot the decision model sees (same shape tools/ai-record.mjs builds for the
  // unattended recorder): interactive elements tagged with a temporary data-kb-ai-id, plus the page's
  // own text (headings, labels, hints) so gates like "Select a representative first" are visible.
  function aiVisible(el) {
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    return r.width > 3 && r.height > 3 && cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function aiSnapshot() {
    document.querySelectorAll('[data-kb-ai-id]').forEach((el) => el.removeAttribute('data-kb-ai-id'));
    const clickableRow = (tr) => window.getComputedStyle(tr).cursor === 'pointer' || tr.hasAttribute('tabindex') || tr.hasAttribute('data-href');
    // Scoped to #__next (Next.js Pages Router always wraps <Main/> in this — confirmed against
    // hadrius_frontend's own pages/_document.tsx) rather than the whole document. Something
    // unrelated to the app itself (a toolbar with its own CSS-modules classes, e.g.
    // "styles-module__toolbarContainer...", confirmed sitting as a bare <div> sibling directly
    // under <body>, outside #__next entirely) can otherwise dominate this list: it renders
    // immediately and persists across every navigation, regardless of whether the actual routed
    // page has mounted yet, so an unscoped query can hand the AI decision model a page snapshot
    // that's entirely that widget's own controls and none of the real app.
    // A dialog/modal (Radix, shadcn, etc.) commonly portals its content to a bare div right at the
    // end of <body> — outside #__next entirely, same as the foreign widget above, but this time it's
    // legitimate in-app UI (confirmed live: the "Add a policy" dialog's own Name field went missing
    // from the AI's snapshot once the #__next scoping shipped). So scope to "inside the app OR inside
    // an open dialog", not just "inside the app" — that excludes the foreign widget (never a dialog)
    // while still including a portalled modal that's actually part of the workflow being recorded.
    const appRoot = document.getElementById('__next') || document.body;
    const inAppOrDialog = (el) => appRoot.contains(el) || !!el.closest('[role="dialog"],[role="alertdialog"]');
    const nodes = Array.from(document.querySelectorAll('button,a,input,textarea,select,[role],tbody tr'))
      .filter((el) => aiVisible(el) && inAppOrDialog(el) && (el.tagName !== 'TR' || el.getAttribute('role') || clickableRow(el)));
    const elements = nodes.slice(0, 320).map((el, i) => {
      el.setAttribute('data-kb-ai-id', String(i));
      return {
        id: i,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || implicitRole(el) || (el.tagName === 'TR' ? 'row' : null),
        name: (accessibleName(el) || '').slice(0, 90),
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        inDialog: !!el.closest('[role="dialog"],[role="alertdialog"]'),
      };
    });
    const elementNames = new Set(elements.map((e) => e.name.toLowerCase()));
    const root = document.querySelector('main,[role="main"]') || document.body;
    const ownsText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim().length >= 3);
    const inFixedWidget = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) { const role = n.getAttribute?.('role'); if (role === 'dialog' || role === 'alertdialog') return false; if (window.getComputedStyle(n).position === 'fixed') { const r = n.getBoundingClientRect(); return r.width < innerWidth * 0.6 && r.height < innerHeight * 0.6; } } return false; };
    const seen = new Set(); const text = [];
    for (const el of root.querySelectorAll('h1,h2,h3,h4,legend,label,[role="heading"],[role="alert"],[role="status"],p,li,small,span,div')) {
      if (!ownsText(el) || !aiVisible(el) || el.closest('nav,header,footer,aside,[role="navigation"],[role="menu"],[role="listbox"],[role="tablist"],button,a,select,textarea') || inFixedWidget(el)) continue;
      if (el.closest('li')?.querySelector('a')) continue;
      const t = clean(el.innerText || el.textContent); if (t.length < 3 || t.length > 180) continue;
      const key = t.toLowerCase().replace(/[^a-z0-9*]+/g, ' ').trim();
      if (seen.has(key) || elementNames.has(t.toLowerCase())) continue; seen.add(key);
      const tag = el.tagName.toLowerCase();
      text.push(/^h[1-4]$/.test(tag) || el.getAttribute('role') === 'heading' ? '# ' + t : tag === 'label' || tag === 'legend' ? 'label: ' + t : t);
      if (text.length >= 60) break;
    }
    return { url: location.href, title: document.title, elements, text };
  }
  // Scroll the chosen element into view and report its centre (viewport CSS px) so the background
  // can send a REAL click there via chrome.debugger — trusted events, so Radix menus open and this
  // recorder captures the action exactly as if the person had clicked.
  function aiPrepare(id) {
    const el = document.querySelector(`[data-kb-ai-id="${id}"]`);
    if (!el) return { ok: false, error: 'that element is no longer on the page' };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), name: accessibleName(el) || '' };
  }

  // Best-effort read of the current company name, for the recorder's tenant badge (Phase 0).
  // Confirmed live (2026-09): the company switcher is a Radix combobox — <button role="combobox"
  // aria-haspopup="dialog">, not the plain "listbox"/"menu" trigger the candidates below assume —
  // whose own text runs the company name straight into its numeric id with no separator
  // ("Stephen Investments1013"). Checked first, as the most specific known-accurate signature; the
  // older candidates stay as a fallback in case a different page/version uses that shape instead.
  function readCompanyName() {
    const idSuffixed = Array.from(document.querySelectorAll('button[role="combobox"]'))
      .map((el) => clean(el.textContent))
      .find((t) => t && t.length > 1 && t.length < 60 && /\d$/.test(t));
    if (idSuffixed) return idSuffixed;

    const candidates = [
      '[data-testid="company-switcher"]', '[data-testid*="company"]',
      'button[aria-haspopup="listbox"]', 'button[aria-haspopup="menu"]',
    ];
    for (const sel of candidates) {
      for (const el of document.querySelectorAll(sel)) {
        const t = clean(el.textContent);
        if (t && t.length < 60 && t.length > 1) return t;
      }
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'KB_PING') reply({ ok: true });
    // Same heuristic renderer/replay.mjs's settle()/waitForApp() already use to know a page has
    // really finished rendering (not just finished loading): no spinner/"Saving..." in flight, and
    // enough interactive elements present that this isn't still a bare loading shell. Used after a
    // fresh navigation, before the AI guide reads the page — otherwise it can snapshot a still-
    // mounting route and conclude the step "isn't doable" when the real content just wasn't there yet.
    // Scoped to #__next (see aiSnapshot's own comment on why) rather than the whole document: some
    // widget injected as a bare <div> sibling directly under <body>, outside the Next.js app root,
    // renders near-instantly and persists across every navigation regardless of whether the actual
    // routed page has mounted yet — an unscoped count can be satisfied by that alone.
    else if (msg.type === 'KB_SETTLED') {
      const busy = !!document.querySelector('[aria-busy="true"],.animate-spin');
      const saving = /Saving\.\.\./.test(document.body.innerText);
      const appRoot = document.getElementById('__next') || document.body;
      // Excludes the sidebar (nav/header chrome) on top of the #__next scoping: the sidebar's
      // several dozen links mount almost instantly and satisfy any plain count by themselves — as
      // confirmed live (58 elements, every single one a nav link, on a page whose actual routed
      // content — the entities table, the Add entity button — hadn't mounted yet). Same exclusion
      // vocabulary aiSnapshot()'s own text extraction already uses for the same reason.
      const real = Array.from(appRoot.querySelectorAll('input,textarea,select,button,a[href],[role="button"]'))
        .filter((el) => !el.closest('nav,header,[role="navigation"]'));
      reply({ ok: true, settled: !busy && !saving && real.length >= 3 });
    }
    else if (msg.type === 'KB_COMPANY_NAME') reply({ ok: true, name: readCompanyName() });
    else if (msg.type === 'KB_SNAPSHOT') { try { reply({ ok: true, ...aiSnapshot() }); } catch (e) { reply({ ok: false, error: String(e?.message || e) }); } }
    else if (msg.type === 'KB_AI_PREPARE') reply(aiPrepare(msg.id));
    else if (msg.type === 'KB_AI_SELECT_ALL') { // before typing: select the field's current text so insertText replaces it
      const el = document.querySelector(`[data-kb-ai-id="${msg.id}"]`);
      try { if (el && typeof el.select === 'function') el.select(); else if (el?.isContentEditable) { const sel = window.getSelection(); const range = document.createRange(); range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range); } } catch (_) {}
      reply({ ok: !!el });
    }
    else if (msg.type === 'KB_AI_BLUR') { // after typing: commit the recorder's type step now instead of on the next click
      const el = document.querySelector(`[data-kb-ai-id="${msg.id}"]`);
      try { el?.blur(); } catch (_) {}
      reply({ ok: true });
    }
    else if (msg.type === 'KB_START') reply({ ok: start(msg.fromIndex) });
    else if (msg.type === 'KB_STOP') { stop(); reply({ ok: true }); }
    else if (msg.type === 'KB_STATUS') reply({ recording, stepIndex });
    else if (msg.type === 'KB_HIGHLIGHT') {
      (async () => {
        let el = null;
        let method = 'direct';

        for (let i = 0; i < 8; i++) {
          el = resolve(msg.target);
          if (el) break;
          await new Promise((r) => setTimeout(r, 100));
        }

        let triggerEl = null;
        if (!el && msg.parentTrigger) {
          triggerEl = resolve(msg.parentTrigger);
          if (triggerEl) {
            try {
              triggerEl.click();
              method = 'opened-portal';
              for (let i = 0; i < 12; i++) {
                await new Promise((r) => setTimeout(r, 150));
                el = resolve(msg.target);
                if (el) break;
              }
            } catch (_) {}
          }
        }

        let inDialogVerified = false;
        if (!el && (msg.target?.inDialog || msg.target?.role === 'option' || msg.target?.role === 'menuitem') && triggerEl) {
          inDialogVerified = true;
          method = 'dialog-trigger-verified';
        }

        document.querySelectorAll('.kb-studio-outline').forEach((n) => n.classList.remove('kb-studio-outline'));
        if (el) {
          el.classList.add('kb-studio-outline');
          if (!document.getElementById('kb-studio-outline-style')) {
            const s = document.createElement('style'); s.id = 'kb-studio-outline-style';
            s.textContent = '.kb-studio-outline{outline:3px solid #4c3dab!important;outline-offset:3px;box-shadow:0 0 0 2px #ffffff,0 0 14px rgba(76,61,171,.75)!important}';
            document.head.appendChild(s);
          }
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }

        if (msg.closeOpenDialogs) {
          try {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27 }));
          } catch (_) {}
        }

        reply({
          found: !!el || inDialogVerified,
          method,
          inDialog: !!msg.target?.inDialog || msg.target?.role === 'option' || method === 'opened-portal'
        });
      })();
      return true;
    }
    else if (msg.type === 'KB_GET_CANDIDATES') {
      const visible = (el) => {
        try {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const s = window.getComputedStyle(el);
          return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        } catch (_) { return false; }
      };
      const elements = Array.from(document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"]')).filter(visible);
      const candidates = elements.slice(0, 120).map((el, idx) => {
        const fp = fingerprint(el);
        return {
          candidateId: idx,
          tag: fp.tag,
          role: fp.role,
          name: fp.name,
          text: fp.text,
          label: fp.label,
          placeholder: fp.placeholder,
          testid: fp.testid,
          heading: fp.heading,
          cardText: fp.cardText,
          css: fp.css,
          bbox: fp.bbox,
          inDialog: fp.inDialog
        };
      });
      reply({ ok: true, candidates, url: location.href, route: location.pathname + location.search, title: document.title });
    }
    else if (msg.type === 'KB_FINGERPRINT_CANDIDATE') {
      const visible = (el) => {
        try {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        } catch (_) { return false; }
      };
      const elements = Array.from(document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"]')).filter(visible);
      const el = elements[msg.candidateId];
      if (el) {
        const fp = fingerprint(el);
        document.querySelectorAll('.kb-studio-outline').forEach((n) => n.classList.remove('kb-studio-outline'));
        el.classList.add('kb-studio-outline');
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        reply({ ok: true, fingerprint: fp });
      } else {
        reply({ ok: false, error: 'Candidate element not found on page' });
      }
    }
    return true;
  });

  // Same resolver the renderer uses (ranked fallbacks), so the sidepanel can show "still resolves" per step.
  function resolve(fp) {
    if (!fp) return null;
    const visible = (el) => {
      try {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
      } catch (_) { return false; }
    };
    const all = () => Array.from(document.querySelectorAll('button,a,input,textarea,select,[role],tbody tr')).filter(visible);
    const roleOf = (el) => el.getAttribute('role') || implicitRole(el);

    if (fp.testid) { const el = document.querySelector(`[data-testid="${fp.testid}"]`); if (el && visible(el)) return el; }
    if (fp.date) { // calendar day: resolve by meaning (today / day-of-month), not by the recorded date label
      const cells = all().filter((el) => el.closest('table,[role="grid"]') && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      let el = null;
      if (fp.date.today) el = cells.find((c) => c.getAttribute('aria-current') === 'date') || cells.find((c) => /^Today\b/i.test(accessibleName(c) || '')) || cells.find((c) => /(^|\s)(rdp-day_today|today)(\s|$)/.test(c.className || ''));
      if (!el && fp.date.day) { const byDay = cells.filter((c) => clean(c.textContent) === String(fp.date.day)); el = byDay.find((c) => !/outside/i.test(c.className || '') && !c.hasAttribute('data-outside')) || byDay[0]; }
      if (el) return el;
    }
    // Date picker trigger button: resolve by label / calendar affordance
    // \b after the alternation is required: without it "Mar" (March) matches the first three letters
    // of "Mark as resolved" and the button is wrongly treated as a date-picker trigger.
    const isDateText = (s) => /^(Today, )?(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{1,2}\/\d{1,2}|Pick a date|Select date|Choose date)\b/i.test(s || '');
    const isDateTrigger = fp.datePicker || (fp.role === 'button' && (isDateText(fp.name) || (fp.label && /\b(date|due|deadline)\b/i.test(fp.label))));
    if (isDateTrigger) {
      if (fp.label) {
        const labs = Array.from(document.querySelectorAll('label,p,span,div')).filter((e) => e.children.length <= 1 && clean(e.textContent) === fp.label);
        for (const l of labs) {
          let n = l;
          for (let d = 0; n && d < 4; d++) {
            n = n.parentElement;
            const c = n && Array.from(n.querySelectorAll('button,[role="button"]')).find((el) => visible(el) && (el.querySelector('svg') || isDateText(accessibleName(el)) || el.getAttribute('aria-haspopup') === 'dialog'));
            if (c) return c;
          }
        }
      }
      if (fp.inDialog) {
        const dlg = document.querySelector('[role="dialog"],[data-radix-portal]');
        if (dlg) {
          const dButtons = Array.from(dlg.querySelectorAll('button,[role="button"]')).filter((el) => visible(el) && (el.querySelector('svg') || isDateText(accessibleName(el))));
          if (dButtons.length === 1) return dButtons[0];
        }
      }
    }
    if (fp.role && fp.name) {
      const m = all().filter((el) => roleOf(el) === fp.role && accessibleName(el) === fp.name);
      if (m.length === 1) return m[0];
      if (m.length > 1 && fp.inDialog) { const d = m.find((el) => el.closest('[role="dialog"]')); if (d) return d; }
      if (m.length) return m[0];
    }
    if (fp.placeholder) {
      const el = document.querySelector(`[placeholder="${CSS.escape(fp.placeholder)}"]`);
      if (el && visible(el)) return el;
    }
    if (fp.role && fp.name) {
      const n = fp.name.toLowerCase();
      const fuzzyOk = (el) => {
        const en = (accessibleName(el) || '').toLowerCase();
        if (en.length < 3) return false;
        return en.startsWith(n.slice(0, 40)) || n.startsWith(en.slice(0, 40));
      };
      const m = all().filter((el) => roleOf(el) === fp.role && fuzzyOk(el));
      if (m.length) return m[0];
    }
    if (fp.label && fp.role) {
      const fieldRole = /^(textbox|combobox|listbox|checkbox|radio|switch|slider|spinbutton|searchbox)$/.test(fp.role);
      if (fieldRole) {
        const labs = Array.from(document.querySelectorAll('label,p,span,div')).filter((e) => e.children.length <= 1 && clean(e.textContent) === fp.label);
        for (const l of labs) {
          let n = l;
          for (let d = 0; n && d < 4; d++) {
            n = n.parentElement;
            const c = n && Array.from(n.querySelectorAll('button,input,textarea,[role]')).find((el) => roleOf(el) === fp.role && visible(el));
            if (c) return c;
          }
        }
      }
    }
    if (fp.name) { const m = all().filter((el) => accessibleName(el) === fp.name); if (m.length) return m[0]; }
    if (fp.cardText) { const el = findByCardText(fp.cardText, fp.role); if (el) return el; }
    if (fp.text) { const m = all().filter((el) => clean(el.textContent) === fp.text); if (m.length) return m[0]; }
    try { const el = document.querySelector(fp.css); if (el && visible(el)) return el; } catch (_) {}
    return null;
  }

  // Resume if a recording was in progress across a navigation
  chrome.storage.session?.get(['recording', 'stepIndex'], (s) => { if (s?.recording) start(s.stepIndex || 0); });
})();
