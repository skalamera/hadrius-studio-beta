// KB Studio Recorder — background service worker
// Owns recording state, collects steps + screenshots, exposes them to the side panel.

const state = { recording: false, tabId: null, steps: [], pendingNote: null, script: { name: '' }, recordingId: null,
  // Re-record mode: while set, newly captured steps go into `buffer` and, on stop, REPLACE the step
  // at `replaceIndex` (a broken click can legitimately become 1..n new steps). Null = normal mode.
  rerecord: null /* { replaceIndex, buffer: [] } */ };

async function persist() {
  await chrome.storage.session.set({ recording: state.recording, stepIndex: state.steps.length });
  await chrome.storage.local.set({ kbDraft: { steps: state.steps, script: state.script, tabId: state.tabId, recordingId: state.recordingId } });
}

async function getSettings() {
  const { kbSettings } = await chrome.storage.local.get('kbSettings');
  return { bridgePort: 8787, ...(kbSettings || {}) };
}

async function restore() {
  const { kbDraft } = await chrome.storage.local.get('kbDraft');
  if (kbDraft) { state.steps = kbDraft.steps || []; state.script = kbDraft.script || state.script; state.tabId = kbDraft.tabId || null; state.recordingId = kbDraft.recordingId || null; }
  const s = await chrome.storage.session.get('recording');
  state.recording = !!s.recording;
}
// Chrome stops this service worker after ~30s idle and starts it again for the next event — with
// `state` back to its empty defaults. Every listener awaits this before touching state: without that,
// a panel click that woke the worker (e.g. moving a step) ran against steps: [], and its persist()
// then saved that empty list over the real draft — wiping every step.
const restored = restore();

chrome.runtime.onInstalled.addListener(() => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }));

// Record-time capture ("Staged Studio" Phase 0 experiment 3): the human's own click-through is the
// only moment a workflow is guaranteed to be in the right state, so its screenshots become the
// video's raw material directly — renderer/from-recording.mjs assembles from these with no replay,
// no second staging visit. One capture per step, reused for both the panel's thumbnail (existing
// behavior) and the full-res slide asset (new), so recording stays within Chrome's ~2/s
// captureVisibleTab rate limit.
// Give the route a chance to actually finish rendering before the pixels get frozen into a slide —
// otherwise a step captured right after a navigation (or a click that triggers one) can catch the
// loading spinner or a skeleton table instead of the real content. Reuses content.js's own
// KB_SETTLED heuristic (same one the AI recorder relies on before reading a page).
//
// A single poll is not enough, though — confirmed live against staging: the app's sidebar alone
// satisfies the element-count part of the check at all times, so "settled" hinges on a loading
// indicator being present at the exact instant of the poll, and there are two windows with none:
// the un-hydrated SSR shell right after a full page load (before the app mounts its loader), and
// the beat between a client-side URL change and React swapping in the new route's skeleton. One
// poll in either window passes, and the capture then lands on the skeleton. So a settled reading
// only counts once it has held for `stable` consecutive polls and at least `minMs` have elapsed.
async function waitForSettled(tabId, { maxMs = 6000, intervalMs = 250, minMs = 0, stable = 1 } = {}) {
  const start = Date.now();
  let run = 0, errors = 0, busySeen = false, lastErr = null;
  while (Date.now() - start < maxMs) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'KB_SETTLED' });
      errors = 0;
      if (r?.settled) run++; else { run = 0; busySeen = true; }
      if (run >= stable && Date.now() - start >= minMs) return { settled: true, ms: Date.now() - start, busySeen };
    } catch (e) {
      lastErr = String(e?.message || e);
      // No listener at all (not a Hadrius page, or the recorder isn't injected) — nothing to wait on.
      if (++errors >= 3) return { settled: true, ms: Date.now() - start, busySeen, error: lastErr };
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return { settled: false, ms: Date.now() - start, busySeen, error: lastErr };
}

// A click is captured at pointerdown and must show the page as it was before the click, so it only
// waits if the page is actually mid-load at that moment. A navigation always changes the page, so it
// gets a grace period long enough to outlast both blind windows above; the very first slide comes
// right after a full page load and gets a longer one for hydration.
function settleOptsFor(step) {
  if (step.action !== 'navigate') return { minMs: 0, stable: 1 };
  return step.index === 0 ? { minMs: 2500, stable: 3, maxMs: 8000 } : { minMs: 1500, stable: 3 };
}

// Staging can take longer to finish loading a data-heavy route than our first wait allows for (seen
// elsewhere this session: multi-second table/export latency). Rather than raise the first wait so
// high it delays every step, give a slow step one more chance in the background to settle and
// silently replace the slide with the fully-loaded version — same captureId, so it overwrites the
// file already saved rather than adding a duplicate.
async function recaptureIfSettles(step, tabId, recordingId) {
  try {
    const { settled, ms } = await waitForSettled(tabId, { maxMs: 12000, intervalMs: 300, stable: 3 });
    console.log(`[capture] step ${step.index} background recheck settled=${settled} after ${ms}ms`);
    if (!settled || !state.recording) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    step.thumb = png;
    await bridge('POST', `/capture/${encodeURIComponent(recordingId)}/slide`, { captureId: step.captureId, dataUrl: png });
    broadcast({ type: 'KB_STEPS_UPDATED', steps: state.steps });
  } catch (_) {}
}

async function captureStep(step, attempt = 0, settled = null) {
  try {
    const tab = await chrome.tabs.get(state.tabId);
    if (!tab) return;
    // Wait once per step, not once per attempt — but a retry after a captureVisibleTab failure must
    // still know whether that wait timed out, or the background re-capture below never fires for it.
    if (settled === null) {
      const r = await waitForSettled(state.tabId, settleOptsFor(step));
      settled = r.settled;
      console.log(`[capture] step ${step.index} (${step.action} ${step.route || ''}) settled=${settled} after ${r.ms}ms busySeen=${r.busySeen}${r.error ? ` err=${r.error}` : ''}`);
    }
    const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    step.thumb = png;
    if (!state.recordingId) state.recordingId = crypto.randomUUID();
    await bridge('POST', `/capture/${encodeURIComponent(state.recordingId)}/slide`, { captureId: step.captureId, dataUrl: png });
    if (!settled) recaptureIfSettles(step, state.tabId, state.recordingId);
  } catch (e) {
    step.thumbError = String(e?.message || e);
    // Retry up to 3 times to handle Chrome capture rate limit and page transitions
    if (attempt < 3 && state.recording) {
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
      return captureStep(step, attempt + 1, settled);
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await restored;
    switch (msg.type) {
      case 'KB_STEP': {
        if (!state.recording) return reply({ ok: false });
        const step = msg.step;
        if (state.pendingNote) { step.narration = state.pendingNote; state.pendingNote = null; }
        if (state.rerecord) {
          // Re-recording one step: collect into the buffer; splice in on stop.
          step.index = state.rerecord.replaceIndex + state.rerecord.buffer.length;
          state.rerecord.buffer.push(step);
          await captureStep(step);
          broadcast({ type: 'KB_RERECORD_PROGRESS', count: state.rerecord.buffer.length, replaceIndex: state.rerecord.replaceIndex });
          return reply({ ok: true });
        }
        // Reserve this step's slot synchronously (push first) so two KB_STEP messages arriving
        // close together — e.g. right after a navigation — can never read the same stale index
        // before either has pushed. The async screenshot capture happens after the index is fixed.
        step.index = state.steps.length;
        state.steps.push(step);
        state.script.updatedAt = new Date().toISOString();
        await captureStep(step);
        await persist();
        broadcast({ type: 'KB_STEPS_UPDATED', steps: state.steps });
        return reply({ ok: true });
      }
      case 'KB_NOTE': state.pendingNote = msg.text; broadcast({ type: 'KB_NOTE_PENDING', text: msg.text }); return reply({ ok: true });

      // ---- side panel API ----
      case 'PANEL_GET_STATE': return reply({ recording: state.recording, steps: state.steps, script: state.script, tabId: state.tabId, recordingId: state.recordingId, rerecord: state.rerecord ? { replaceIndex: state.rerecord.replaceIndex, count: state.rerecord.buffer.length } : null });
      case 'PANEL_START': return reply(await startRecording(msg.tabId, msg.fresh, msg.initialNav));
      case 'PANEL_STOP': await stopRecording(); return reply({ ok: true });
      case 'PANEL_UPDATE_STEP': {
        const i = state.steps.findIndex((s) => s.index === msg.index);
        if (i < 0) return reply({ ok: false, error: 'step not found' }); // never persist a no-op
        Object.assign(state.steps[i], msg.patch);
        await persist(); return reply({ ok: true });
      }
      case 'PANEL_DELETE_STEP': {
        state.steps = state.steps.filter((s) => s.index !== msg.index).map((s, i) => ({ ...s, index: i }));
        await persist(); broadcast({ type: 'KB_STEPS_UPDATED', steps: state.steps }); return reply({ ok: true });
      }
      case 'PANEL_MOVE_STEP': {
        const i = state.steps.findIndex((s) => s.index === msg.index); const j = i + msg.dir;
        // Nothing to move (unknown step, or already at the edge): leave the stored draft alone rather
        // than re-saving and re-broadcasting whatever is in memory.
        if (i < 0 || j < 0 || j >= state.steps.length) return reply({ ok: false, error: 'step not found or already at the edge' });
        [state.steps[i], state.steps[j]] = [state.steps[j], state.steps[i]]; state.steps.forEach((s, k) => (s.index = k));
        await persist(); broadcast({ type: 'KB_STEPS_UPDATED', steps: state.steps }); return reply({ ok: true });
      }
      case 'PANEL_UPDATE_SCRIPT': Object.assign(state.script, msg.patch); await persist(); return reply({ ok: true });
      case 'PANEL_CLEAR': {
        state.steps = [];
        state.pendingNote = null;
        state.script = { name: '' };
        state.recordingId = null;
        await persist();
        broadcast({ type: 'KB_STEPS_UPDATED', steps: [] });
        return reply({ ok: true });
      }
      case 'PANEL_GET_SETTINGS': return reply(await getSettings());
      case 'PANEL_SET_SETTINGS': await chrome.storage.local.set({ kbSettings: { ...(await getSettings()), ...msg.patch } }); return reply({ ok: true });
      case 'PANEL_AI_NARRATE': {
        try { return reply(await aiNarrate(msg.steps, msg.scriptName)); }
        catch (e) { return reply({ ok: false, error: String(e?.message || e) }); }
      }
      case 'PANEL_RENDER': {
        try { return reply(await bridge('POST', '/render', { script: msg.script, mode: msg.mode || 'both' })); }
        catch (e) { return reply({ ok: false, error: String(e?.message || e) }); }
      }
      case 'PANEL_RENDER_STATUS': {
        try { return reply(await bridge('GET', '/render/status')); }
        catch (e) { return reply({ ok: false, error: String(e?.message || e) }); }
      }
      case 'PANEL_RENDER_OPEN': {
        try { return reply(await bridge('POST', '/render/open')); }
        catch (e) { return reply({ ok: false, error: String(e?.message || e) }); }
      }
      case 'PANEL_RENDER_CLEAR': {
        try { return reply(await bridge('POST', '/render/clear')); }
        catch (e) { return reply({ ok: false, error: String(e?.message || e) }); }
      }
      case 'PANEL_HIGHLIGHT': {
        try {
          if (msg.tabId) state.tabId = msg.tabId;
          const r = msg.isNavigate
            ? await checkNavigate(msg.url)
            : await checkStep(msg.target, msg.url, msg.parentTrigger, msg.closeOpenDialogs);
          return reply(r);
        } catch (e) { return reply({ found: false, error: String(e) }); }
      }

      // ---- load an existing script (from the shared library or an uploaded file) into the editor ----
      case 'PANEL_LOAD_SCRIPT': {
        try {
          const sc = msg.script;
          if (!sc || !Array.isArray(sc.steps)) throw new Error('That file is not a Hadrius Studio script (no steps array).');
          if (state.recording) await stopRecording();
          state.steps = sc.steps.map((s, i) => ({ ...s, index: i, target: s.target ? unstripBbox(s.target) : s.target }));
          // Carry over the loaded script's own recording binding (or its absence) — otherwise
          // toScript() on Save would stamp it with whatever recordingId this session last used
          // (a stale or unrelated one), silently mis-wiring which capture folder it points to.
          state.recordingId = sc.recording?.id || null;
          state.script = {
            name: sc.name || '',
            title: sc.title || '', // lets Save keep the loaded library name (e.g. "…-ai") while the title is unchanged
            captionsFromNarration: !!sc.captionsFromNarration,
            createdAt: sc.createdAt || new Date().toISOString(),
            updatedAt: sc.updatedAt || sc.createdAt || new Date().toISOString(),
          };
          state.pendingNote = null; state.rerecord = null;
          await persist();
          broadcast({ type: 'KB_STEPS_UPDATED', steps: state.steps });
          return reply({ ok: true, count: state.steps.length });
        } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); }
      }

      // ---- re-record ONE broken step: record until stop, then splice the new steps in its place ----
      case 'PANEL_RERECORD_START': {
        const i = state.steps.findIndex((s) => s.index === msg.index);
        if (i < 0) return reply({ ok: false, error: 'step not found' });
        const tab = msg.tabId; if (!tab) return reply({ ok: false, error: 'no tab' });
        const target = state.steps[i];
        // Put the tab on the page this step belongs to, so the user re-does just that action.
        // Only navigate when the tab is somewhere else entirely (different path). Many Hadrius
        // screens are single-URL wizards: reloading the same URL would wipe the form the user
        // just filled in to reach this step.
        let navigated = false;
        if (target.url) {
          try {
            const cur = await chrome.tabs.get(tab);
            const samePage = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch (_) { return a === b; } };
            if (!cur?.url || !samePage(cur.url, target.url)) {
              await chrome.tabs.update(tab, { url: target.url });
              await new Promise((resolve) => { const on = (id, info) => { if (id === tab && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(on); resolve(); } }; chrome.tabs.onUpdated.addListener(on); setTimeout(resolve, 8000); });
              await new Promise((r) => setTimeout(r, 500));
              navigated = true;
            }
          } catch (_) {}
        }
        state.rerecord = { replaceIndex: i, buffer: [] };
        const r = await startRecording(tab, false);
        if (!r.ok) { state.rerecord = null; return reply(r); }
        broadcast({ type: 'KB_RERECORD_PROGRESS', count: 0, replaceIndex: i });
        return reply({ ok: true, url: target.url || null, navigated });
      }
      case 'PANEL_RERECORD_FINISH': {
        const rr = state.rerecord; state.rerecord = null;
        await stopRecording();
        if (!rr) return reply({ ok: false, error: 'not re-recording' });
        if (!rr.buffer.length) return reply({ ok: true, replaced: 0 }); // nothing captured: keep the old step
        const old = state.steps[rr.replaceIndex];
        // The recorder emits a synthetic "navigate" when it starts on a page; when re-recording
        // in place (same page the step already lived on) that's noise — drop it so a single
        // click replaces a single step.
        let buf = rr.buffer;
        const samePath = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch (_) { return false; } };
        if (buf.length > 1 && buf[0].action === 'navigate' && old && old.action !== 'navigate' && samePath(old.url || '', buf[0].value || buf[0].url || '')) buf = buf.slice(1);
        // Carry the old narration/caption/capture settings onto the first meaningful replacement
        // step so the user doesn't lose their writing just because a button got renamed.
        const first = buf.find((s) => s.action !== 'navigate') || buf[0];
        if (old) { if (!first.narration) first.narration = old.narration || ''; if (old.caption && !first.caption) first.caption = old.caption; first.capture = old.capture; first.motion = old.motion; }
        state.steps.splice(rr.replaceIndex, 1, ...buf);
        state.steps.forEach((s, k) => (s.index = k));
        await persist();
        broadcast({ type: 'KB_STEPS_UPDATED', steps: state.steps });
        return reply({ ok: true, replaced: buf.length, at: rr.replaceIndex });
      }
      case 'PANEL_RERECORD_CANCEL': { state.rerecord = null; await stopRecording(); return reply({ ok: true }); }

      // ---- shared library + last render report (proxied through the local bridge) ----
      case 'PANEL_LIBRARY_LIST': { try { return reply(await bridge('GET', '/library')); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_LIBRARY_ATTENTION': { try { return reply(await bridge('GET', '/library?attention=1')); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_RUN_HEALTH_CHECK': { try { return reply(await bridge('POST', '/health-check')); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_LIBRARY_GET': { try { return reply(await bridge('GET', `/library?name=${encodeURIComponent(msg.name)}`)); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_LIBRARY_SAVE': { try { return reply(await bridge('POST', '/library', { script: msg.script, broken_steps: msg.broken_steps, healed_step_index: msg.healed_step_index })); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_LIBRARY_DELETE': { try { return reply(await bridge('DELETE', `/library?name=${encodeURIComponent(msg.name)}`)); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_GENERATE_PLAN': { try { return reply(await bridge('POST', '/plan/generate', msg.payload)); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      // ---- workflow coverage ----
      case 'PANEL_COVERAGE_GET': { try { return reply(await bridge('GET', '/coverage')); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_COVERAGE_PATCH': { try { return reply(await bridge('PATCH', '/coverage', msg.patch)); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_COVERAGE_SCAN_START': { try { return reply(await bridge('POST', '/coverage/scan', msg.opts || {})); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_COVERAGE_SCAN_STATUS': { try { return reply(await bridge('GET', '/coverage/scan')); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_COVERAGE_AI_START': { try { return reply(await bridge('POST', '/coverage/ai-record', { keys: msg.keys })); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_COVERAGE_AI_STATUS': { try { return reply(await bridge('GET', '/coverage/ai-record')); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_COVERAGE_PLANS_START': { try { return reply(await bridge('POST', '/coverage/plans', msg.opts || {})); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_COVERAGE_PLANS_STATUS': { try { return reply(await bridge('GET', '/coverage/plans')); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_COMPANY_NAME': { try { const r = await chrome.tabs.sendMessage(msg.tabId, { type: 'KB_COMPANY_NAME' }); return reply(r?.ok ? r : { ok: false }); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_AI_DECIDE': { try { return reply(await bridge('POST', '/act', msg.body)); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_AI_PERFORM': { try { return reply(await aiPerform(msg)); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_CLAUDE_AUTH': { try { return reply(await bridge('GET', `/auth${msg.fresh ? '?fresh=1' : ''}`)); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_COVERAGE_AI_CANCEL': { try { return reply(await bridge('DELETE', `/coverage/ai-record?key=${encodeURIComponent(msg.key)}`)); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_OPEN_URL': {
        // Wait for the navigation to actually land, then confirm the recorder content script is
        // alive on the new page, before replying — otherwise a caller that chains straight into its
        // next action on this reply (aiDoGuideStep's navigate fast-path, especially back-to-back
        // under "Run all with AI") can fire before the new page is ready, and every
        // chrome.tabs.sendMessage to it fails with "Could not establish connection. Receiving end
        // does not exist." A human clicking each guide step by hand never hit this — there was
        // always enough real-world delay between clicks for the page to settle.
        const waitForLoad = (tabId) => new Promise((resolve) => {
          const on = (id, info) => { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(on); resolve(); } };
          chrome.tabs.onUpdated.addListener(on);
          setTimeout(resolve, 10000);
        });
        // A heavy client-rendered route can still not be idle right when the browser calls the load
        // "complete" — ensureContentScript's own single ping-or-inject-and-ping isn't always enough
        // time, so retry it for a few seconds instead of reporting success on one guess.
        const waitForContentScript = async (tabId) => {
          for (let i = 0; i < 10; i++) {
            if (await ensureContentScript(tabId)) return true;
            await new Promise((r) => setTimeout(r, 400));
          }
          return false;
        };
        const notReadyError = { ok: false, error: 'The new page never became ready to record on. Reload the tab and try again.' };
        // Loading finishing and the content script responding both just mean the SHELL is there —
        // a client-rendered SPA route can still be fetching/mounting its actual content well after
        // that (renderer/replay.mjs's settle()/waitForApp() exist for exactly this in the offline
        // renderer). Best-effort only: if this never reports settled, proceed anyway rather than
        // hard-failing the whole navigate on a heuristic that just didn't confirm in time.
        const waitForSettled = async (tabId, timeoutMs = 6000) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const r = await chrome.tabs.sendMessage(tabId, { type: 'KB_SETTLED' }).catch(() => null);
            if (r?.ok && r.settled) return true;
            await new Promise((res) => setTimeout(res, 300));
          }
          return false;
        };
        try {
          // Prefer the tab the caller already resolved and is about to keep sending other messages
          // to (e.g. aiDoGuideStep) — falling back to "whatever's active right now" only when no
          // specific tab was given, since with several hadrius.com tabs open at once those can
          // silently disagree.
          let tabId = msg.tabId;
          if (!tabId) { const tabs = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tabs[0]?.id; }
          if (tabId) {
            await chrome.tabs.update(tabId, { url: msg.url });
            await waitForLoad(tabId);
            if (!(await waitForContentScript(tabId))) return reply(notReadyError);
            await waitForSettled(tabId);
            return reply({ ok: true, tabId });
          }
          const t = await chrome.tabs.create({ url: msg.url });
          await waitForLoad(t.id);
          if (!(await waitForContentScript(t.id))) return reply(notReadyError);
          await waitForSettled(t.id);
          return reply({ ok: true, tabId: t.id });
        } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); }
      }
      case 'PANEL_AUTO_HEAL': {
        try {
          const stepIndex = msg.stepIndex;
          const step = state.steps[stepIndex];
          if (!step) throw new Error(`Step #${stepIndex + 1} not found`);

          if (msg.tabId) state.tabId = msg.tabId;
          if (!state.tabId) {
            const tabs = await chrome.tabs.query({ url: ['*://*.hadrius.com/*', 'http://localhost/*'] });
            if (tabs[0]) state.tabId = tabs[0].id;
          }
          if (!state.tabId) throw new Error('No active Hadrius tab found to inspect.');

          if (step.url) {
            let tab = await chrome.tabs.get(state.tabId).catch(() => null);
            if (tab && tab.url !== step.url) {
              await chrome.tabs.update(state.tabId, { url: step.url });
              await new Promise((resolve) => {
                const onUpdated = (id, info) => { if (id === state.tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); } };
                chrome.tabs.onUpdated.addListener(onUpdated);
                setTimeout(resolve, 8000);
              });
              await new Promise((r) => setTimeout(r, 600));
            }
          }

          let cRes = await chrome.tabs.sendMessage(state.tabId, { type: 'KB_GET_CANDIDATES' }).catch(() => null);
          if (!cRes?.candidates?.length) {
            await chrome.scripting.executeScript({ target: { tabId: state.tabId }, files: ['content.js'] }).catch(() => {});
            await new Promise((r) => setTimeout(r, 400));
            cRes = await chrome.tabs.sendMessage(state.tabId, { type: 'KB_GET_CANDIDATES' }).catch(() => null);
          }
          if (!cRes?.candidates?.length) throw new Error('No interactive elements found on the current page.');

          const healRes = await bridge('POST', '/auto-heal', {
            step,
            candidates: cRes.candidates,
            route: cRes.route || step.route,
            scriptName: state.script?.name
          });

          if (!healRes.ok || healRes.candidateId == null) {
            throw new Error(healRes.error || 'AI could not find a matching replacement element with high confidence.');
          }

          const fpRes = await chrome.tabs.sendMessage(state.tabId, {
            type: 'KB_FINGERPRINT_CANDIDATE',
            candidateId: healRes.candidateId
          });
          if (!fpRes?.fingerprint) throw new Error('Failed to capture fingerprint for the selected candidate.');

          step.target = fpRes.fingerprint;
          step.url = cRes.url;
          step.route = cRes.route;
          await persist();
          broadcast({ type: 'KB_STEPS_UPDATED', steps: state.steps });

          return reply({
            ok: true,
            stepIndex,
            healedTarget: fpRes.fingerprint,
            explanation: healRes.explanation || '',
            codeEvidence: healRes.codeEvidence || '',
            model: healRes.model || 'ai'
          });
        } catch (e) {
          return reply({ ok: false, error: String(e?.message || e) });
        }
      }
      case 'PANEL_REPORT': { try { return reply(await bridge('GET', `/report?name=${encodeURIComponent(msg.name)}`)); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_RECIPE_LOOKUP': { try { return reply(await bridge('GET', `/recipe?name=${encodeURIComponent(msg.name)}`)); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      case 'PANEL_BRIDGE_HEALTH': { try { return reply(await bridge('GET', '/health')); } catch (e) { return reply({ ok: false, error: String(e?.message || e) }); } }
      default: return reply({ ok: false, error: 'unknown message' });
    }
  })();
  return true;
});

// Make sure the recorder content script is present in a tab. Tabs opened before the extension
// was (re)loaded don't have it; inject it on demand (content.js is idempotent).
async function ensureContentScript(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'KB_PING' });
    if (r?.ok) return true;
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((res) => setTimeout(res, 150));
    const r = await chrome.tabs.sendMessage(tabId, { type: 'KB_PING' });
    return !!r?.ok;
  } catch (_) { return false; }
}

async function startRecording(tabId, fresh, initialNav = null) {
  state.tabId = tabId;
  if (fresh) {
    state.steps = [];
    state.pendingNote = null;
    state.recordingId = crypto.randomUUID(); // new recording -> its own slide folder, out/_recordings/<id>/
    const now = new Date().toISOString();
    state.script.createdAt = now;
    state.script.updatedAt = now;
  }
  let ok = await ensureContentScript(tabId);
  if (!ok) {
    // Injection can't run on a page that hasn't finished loading or isn't a real web page; one
    // reload-and-retry covers the common "tab was left half-loaded" case.
    try {
      await chrome.tabs.reload(tabId);
      await new Promise((resolve) => { const on = (id, info) => { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(on); resolve(); } }; chrome.tabs.onUpdated.addListener(on); setTimeout(resolve, 10000); });
      await new Promise((res) => setTimeout(res, 600));
      ok = await ensureContentScript(tabId);
    } catch (_) {}
    if (!ok) return { ok: false, error: 'Could not start recording on this tab. Make sure it is a staging.hadrius.com page and try again.' };
  }

  // If this is a fresh recording and initialNav was provided, capture initial navigate slide as Step 0
  if (fresh && initialNav) {
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const navUrl = initialNav.url || tab?.url || '';
      let navRoute = initialNav.route;
      if (!navRoute && navUrl) {
        try { navRoute = new URL(navUrl).pathname; } catch (_) { navRoute = navUrl; }
      }
      const navStep = {
        index: 0,
        action: 'navigate',
        value: navUrl,
        url: navUrl,
        route: navRoute || '/',
        captureId: crypto.randomUUID(),
        narration: initialNav.narration || '',
        caption: initialNav.caption || initialNav.narration || ''
      };
      state.steps.push(navStep);
      await captureStep(navStep);
    } catch (navErr) {
      console.warn('Initial navigate slide capture failed:', navErr);
    }
  }

  let r = null;
  try { r = await chrome.tabs.sendMessage(tabId, { type: 'KB_START', fromIndex: state.steps.length }); } catch (_) {}
  if (!r?.ok) return { ok: false, error: 'The recorder did not respond on this tab. Reload the page and try again.' };
  state.recording = true;
  await persist();
  broadcast({ type: 'KB_RECORDING', recording: true });
  broadcast({ type: 'KB_STEPS_UPDATED', steps: state.steps });
  return { ok: true };
}

async function stopRecording() {
  state.recording = false;
  if (state.tabId) { try { await chrome.tabs.sendMessage(state.tabId, { type: 'KB_STOP' }); } catch (_) {} }
  await persist();
  broadcast({ type: 'KB_RECORDING', recording: false });
}

// Re-arm content script after navigation within the recorded tab
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  await restored;
  if (state.recording && tabId === state.tabId && info.status === 'complete') {
    try { await chrome.tabs.sendMessage(tabId, { type: 'KB_START', fromIndex: state.steps.length }); } catch (_) {}
  }
});

function broadcast(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

// ---- "▶ AI" on a Workflow-guide step: perform ONE action in the user's own tab ----
// Uses chrome.debugger (CDP) so the events are TRUSTED: Radix/shadcn menus and comboboxes open on
// real pointer events, and the content-script recorder captures the action as an ordinary step.
// Attach → act → detach, so Chrome's "is debugging this browser" bar only shows for the moment.
const cdpSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function aiPerform({ tabId, id, action, text, key }) {
  const target = { tabId };
  const cs = (m) => chrome.tabs.sendMessage(tabId, m);
  const prep = await cs({ type: 'KB_AI_PREPARE', id });
  if (!prep?.ok) return { ok: false, error: prep?.error || 'could not locate the element' };
  await cdpSleep(150); // let scrollIntoView settle before measuring where to click
  const pos = await cs({ type: 'KB_AI_PREPARE', id });
  if (!pos?.ok) return pos;
  await chrome.debugger.attach(target, '1.3');
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  try {
    const click = async () => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    };
    const pressKey = async (k) => {
      const codes = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38 };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: codes[k] || 0 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: codes[k] || 0 });
    };
    if (action === 'click') { await click(); await cdpSleep(400); }
    else if (action === 'type') {
      await click(); await cdpSleep(150);
      await cs({ type: 'KB_AI_SELECT_ALL', id }); // replace, don't append to, existing text
      for (const ch of String(text ?? '')) { await send('Input.insertText', { text: ch }); await cdpSleep(12); }
      await cdpSleep(200);
      await cs({ type: 'KB_AI_BLUR', id }); // commit the recorder's type step immediately
    }
    else if (action === 'press') { await pressKey(key || 'Enter'); await cdpSleep(300); }
    else return { ok: false, error: `unknown action "${action}"` };
    return { ok: true, name: pos.name };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

// Exported scripts fold the recorded bbox/viewport into target.hint (see sidepanel toScript);
// bring them back to the live shape when a script is loaded for editing.
function unstripBbox(t) {
  if (!t || !t.hint) return t;
  const { hint, ...rest } = t;
  return { ...rest, ...(hint.bbox ? { bbox: hint.bbox } : {}), ...(hint.viewport ? { viewport: hint.viewport } : {}) };
}

// Generic call to the local bridge (tools/ai-bridge.mjs) — the only thing on this machine that can
// run the claude CLI and render.sh on the extension's behalf.
async function bridge(method, route, body) {
  const { bridgePort } = await getSettings();
  const url = `http://127.0.0.1:${bridgePort}${route}`;
  let res;
  try {
    res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error(`Can't reach the Hadrius Studio bridge at ${url}. Run ./setup.sh (or "node tools/ai-bridge.mjs") first, then try again.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `bridge returned ${res.status}`);
  return data;
}

// Calls the local AI bridge (tools/ai-bridge.mjs), which runs the `claude` CLI under the user's
// own authenticated seat — no API key stored in the extension, no separate billing.
async function aiNarrate(steps, scriptName) {
  return bridge('POST', '/narrate', { steps, scriptName }); // { ok: true, lines: [...] }
}

// Navigate the recording tab to the step's own URL (if it's on a different page right now), then
// ask the content script to resolve the fingerprint. Without this, checking a step recorded after
// a navigate always fails — it was being checked against whatever page happened to be open, not
// the page the step actually belongs to.
async function checkStep(target, stepUrl, parentTrigger, closeOpenDialogs) {
  if (!state.tabId) return { found: false, error: 'no tab' };
  let tab;
  try { tab = await chrome.tabs.get(state.tabId); } catch (_) { return { found: false, error: 'tab not found' }; }
  if (!tab) return { found: false, error: 'tab not found' };
  let navigated = false;
  if (stepUrl && tab.url !== stepUrl) {
    navigated = true;
    try {
      await chrome.tabs.update(state.tabId, { url: stepUrl });
      await new Promise((resolve) => {
        const onUpdated = (id, info) => { if (id === state.tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); } };
        chrome.tabs.onUpdated.addListener(onUpdated);
        setTimeout(resolve, 8000); // don't hang forever on a slow/broken route
      });
      await new Promise((r) => setTimeout(r, 800)); // give single-page React app room to hydrate
    } catch (_) {}
  }
  try {
    let r = await chrome.tabs.sendMessage(state.tabId, { type: 'KB_HIGHLIGHT', target, parentTrigger, closeOpenDialogs });
    if (!r?.found) {
      // Retry once after 600ms in case a portal or table row was still animating in
      await new Promise((res) => setTimeout(res, 600));
      r = await chrome.tabs.sendMessage(state.tabId, { type: 'KB_HIGHLIGHT', target, parentTrigger, closeOpenDialogs }).catch(() => r);
    }
    return { ...r, navigated, checkedUrl: stepUrl || tab.url };
  } catch (e) {
    // Content script isn't injected on this page yet (e.g. we just navigated) — one retry.
    await new Promise((r) => setTimeout(r, 600));
    try {
      const r = await chrome.tabs.sendMessage(state.tabId, { type: 'KB_HIGHLIGHT', target, parentTrigger, closeOpenDialogs });
      return { ...r, navigated, checkedUrl: stepUrl || tab.url };
    } catch (err) {
      return { found: false, error: String(err?.message || err) };
    }
  }
}

// Checking a `navigate` step means: does actually going to this URL work (no 404 / redirect
// elsewhere)? There's no element to resolve — we just navigate and confirm we land where expected.
async function checkNavigate(url) {
  if (!state.tabId || !url) return { found: false, error: 'no tab or url' };
  try {
    await chrome.tabs.update(state.tabId, { url });
    await new Promise((resolve) => {
      const onUpdated = (id, info) => { if (id === state.tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); } };
      chrome.tabs.onUpdated.addListener(onUpdated);
      setTimeout(resolve, 8000);
    });
  } catch (_) {
    return { found: false, error: 'failed to navigate tab' };
  }
  // SPAs often client-side redirect (e.g. bad route -> /overview) slightly AFTER the tab's
  // "complete" event fires, without another chrome.tabs.onUpdated firing. Poll the tab's actual
  // URL for a bit so a late redirect isn't missed and reported as a false "found".
  let tab;
  try { tab = await chrome.tabs.get(state.tabId); } catch (_) { return { found: false, error: 'tab not found' }; }
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 300));
    let again;
    try { again = await chrome.tabs.get(state.tabId); } catch (_) { break; }
    if (!again || again.url === tab?.url) break; // settled
    tab = again;
  }
  let expectedPath = url; try { expectedPath = new URL(url).pathname + new URL(url).search; } catch (_) {}
  let actualPath = tab?.url || ''; try { actualPath = new URL(actualPath).pathname + new URL(actualPath).search; } catch (_) {}
  return { found: actualPath === expectedPath, navigated: true, checkedUrl: tab?.url, expected: url };
}
