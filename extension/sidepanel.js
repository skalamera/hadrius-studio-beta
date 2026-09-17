const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const BRIDGE = 'http://127.0.0.1:8787';
let state = { recording:false, steps:[], script:{}, recordingId:null };
let catalog = { modules:[] };
let pylon = { modules:{} };
let selected = null;
let renderTimer = null;

const send = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(response || { ok:false, error:chrome.runtime.lastError?.message })));
const esc = (v='') => String(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = (v='') => v.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

async function api(path, options) {
  const response = await fetch(BRIDGE + path, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { throw new Error(`Incompatible bridge response for ${path} (HTTP ${response.status})`); }
  if (!response.ok || !body || body.ok === false) throw new Error(body?.error || `Bridge returned HTTP ${response.status} for ${path}`);
  return body;
}

function switchView(name) {
  const isRecord = name === 'record' || name === 'recording';
  const isToRecord = name === 'toRecord' || name === 'workflows';
  const isRecorded = name === 'recorded' || name === 'pylonArticles';

  $('#recordingView').hidden = !isRecord;
  $('#workflowsView').hidden = !isToRecord;
  $('#pylonArticlesView').hidden = !isRecorded;

  $$('.tab').forEach((tab) => {
    const v = tab.dataset.view;
    const active = (v === name) ||
      (isRecord && (v === 'record' || v === 'recording')) ||
      (isToRecord && (v === 'toRecord' || v === 'workflows')) ||
      (isRecorded && (v === 'recorded' || v === 'pylonArticles'));
    tab.classList.toggle('active', active);
  });

  if (isToRecord || isRecorded) {
    refreshAll();
  }
}
$$('.tab').forEach((tab) => tab.onclick = () => switchView(tab.dataset.view));

let scanPollTimer = null;
function updateScanStatus(scan) {
  const banner = $('#scanBanner');
  const scanBtn = $('#scanBtn');
  if (!banner) return;
  if (scan?.running) {
    banner.hidden = false;
    if (scanBtn) {
      scanBtn.disabled = true;
      scanBtn.textContent = 'Scanning…';
    }
    const logs = scan.log || [];
    const latest = logs[logs.length - 1] || 'Scanning Hadrius modules via MCP…';
    $('#scanBannerDetail').textContent = latest;
    if (!scanPollTimer) {
      scanPollTimer = setTimeout(pollScan, 2000);
    }
  } else {
    if (scanPollTimer) {
      clearTimeout(scanPollTimer);
      scanPollTimer = null;
    }
    if (!banner.hidden) {
      if (scan?.error) {
        $('#scanBannerDetail').textContent = `Scan failed: ${scan.error}`;
      } else {
        $('#scanBannerDetail').textContent = '✓ Scan complete! Workflows updated.';
      }
      setTimeout(() => { banner.hidden = true; }, 4000);
    } else {
      banner.hidden = true;
    }
    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.innerHTML = 'Scan codebase <span class="beta-chip">Beta</span>';
    }
  }
}

async function pollScan() {
  scanPollTimer = null;
  try {
    const result = await api('/workflows');
    catalog = result;
    updateScanStatus(result.scan);
    if (result.scan?.running) {
      scanPollTimer = setTimeout(pollScan, 2000);
    } else {
      await refreshAll();
      if (result.scan?.error) alert(`Codebase scan error: ${result.scan.error}`);
    }
  } catch (e) {
    updateScanStatus({ running: false });
  }
}

let manualLinks = new Set();
let dismissedWorkflows = new Set();

async function initManualLinks() {
  try {
    const res = await chrome.storage.local.get(['manualLinks', 'dismissedWorkflows']);
    if (Array.isArray(res.manualLinks)) {
      for (const t of res.manualLinks) manualLinks.add(t);
    }
    if (Array.isArray(res.dismissedWorkflows)) {
      for (const t of res.dismissedWorkflows) dismissedWorkflows.add(t);
    }
  } catch (_) {}
}

async function markWorkflowLinked(title, moduleName) {
  manualLinks.add(title);
  await chrome.storage.local.set({ manualLinks: [...manualLinks] });
  api('/workflows/link', { method: 'POST', body: JSON.stringify({ title, module: moduleName }) }).catch(() => {});
  renderModules();
}

async function unmarkWorkflowLinked(title, moduleName) {
  manualLinks.delete(title);
  await chrome.storage.local.set({ manualLinks: [...manualLinks] });
  api('/workflows/link', { method: 'POST', body: JSON.stringify({ title, module: moduleName, unmark: true }) }).catch(() => {});
  toast(`✓ Reverted "${title}" back to To Record`);
  renderModules();
}

async function dismissWorkflow(title, moduleName) {
  if (!confirm(`Are you sure you want to dismiss and delete "${title}"? This will permanently remove this recording opportunity.`)) return;
  dismissedWorkflows.add(title);
  await chrome.storage.local.set({ dismissedWorkflows: [...dismissedWorkflows] });
  api('/workflows/dismiss', { method: 'POST', body: JSON.stringify({ title, module: moduleName }) }).catch(() => {});
  renderModules();
}

async function refreshAll() {
  const [workflowResult, pylonResult] = await Promise.allSettled([api('/workflows'), api('/pylon/articles')]);
  if (workflowResult.status === 'fulfilled') {
    catalog = workflowResult.value;
    if (Array.isArray(catalog.manualLinks)) {
      manualLinks = new Set(catalog.manualLinks);
      chrome.storage.local.set({ manualLinks: [...manualLinks] });
    }
    if (Array.isArray(catalog.dismissed)) {
      dismissedWorkflows = new Set(catalog.dismissed);
      chrome.storage.local.set({ dismissedWorkflows: [...dismissedWorkflows] });
    }
    updateScanStatus(catalog.scan);
  }
  if (pylonResult.status === 'fulfilled') {
    pylon = pylonResult.value;
    if (pylon?.syncedAt) {
      const syncTime = new Date(pylon.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
      const el = $('#pylonLastSync');
      if (el) el.textContent = `Last Pylon sync: ${syncTime}`;
    }
  } else {
    const el = $('#pylonLastSync');
    if (el) el.textContent = 'Last Pylon sync: unavailable';
  }
  const workflowOk = workflowResult.status === 'fulfilled';
  const pylonOk = pylonResult.status === 'fulfilled';
  if (workflowOk && pylonOk) {
    if (!catalog.scan?.running) {
      const sourceLabel = catalog.shared ? 'Shared team repository' : 'Local repository';
      const totalWfs = catalog.modules.reduce((n,m)=>n+m.workflows.length,0);
      $('#syncStatus').textContent = `${sourceLabel} · ${totalWfs} workflows`;
      const wfFooter = $('#workflowsCountFooter');
      if (wfFooter) wfFooter.textContent = `${sourceLabel} · ${totalWfs} total workflows`;
    } else {
      $('#syncStatus').textContent = 'Codebase scan in progress…';
    }
  } else if (!workflowOk) {
    $('#syncStatus').textContent = `Workflows unavailable: ${workflowResult.reason?.message || 'bridge error'}. Stop the old bridge and run npm start from hadrius-studio-beta.`;
  } else {
    $('#syncStatus').textContent = `Workflow plans loaded · Pylon unavailable: ${pylonResult.reason?.message || 'bridge error'}`;
  }
  renderModules();
  renderPylonArticles();
}

function normalizeTitle(value) { return slug(value).replace(/^(how-to|how-do-i)-/,''); }
function articleMatches(workflow, article) {
  const a = normalizeTitle(article.title), w = normalizeTitle(workflow.title);
  return a === w || a.includes(w) || w.includes(a);
}

const WORKFLOW_MODULE_ORDER = [
  'Testing program',
  'People oversight',
  'Branches',
  'Communications',
  'Marketing',
  'Account surveillance',
  'Other'
];

function getModuleArticles(moduleName) {
  if (!pylon?.modules) return [];
  const target = String(moduleName || '').trim().toLowerCase();
  for (const [k, v] of Object.entries(pylon.modules)) {
    if (k.toLowerCase() === target && Array.isArray(v.articles)) return v.articles;
  }
  return [];
}

function getModuleCollectionUrl(moduleName) {
  if (!pylon?.modules) return null;
  const target = String(moduleName || '').trim().toLowerCase();
  for (const [k, v] of Object.entries(pylon.modules)) {
    if (k.toLowerCase() === target && v.collectionUrl) return v.collectionUrl;
  }
  return null;
}

function moduleIconPath(moduleName) {
  const s = slug(moduleName || 'other');
  return `icons/modules/${s}.png`;
}

const openPylonSections = new Set();
const openModuleBodies = new Set();
const openDoneSections = new Set();

function renderModules() {
  const q = $('#search').value.trim().toLowerCase();
  const scrollTarget = document.scrollingElement || document.documentElement || document.body;
  const prevScrollTop = scrollTarget ? scrollTarget.scrollTop : 0;

  $('#modules').innerHTML = '';

  const moduleMap = new Map();
  for (const group of catalog.modules || []) {
    moduleMap.set(group.module.toLowerCase(), group);
  }

  const orderedGroups = [];
  for (const modName of WORKFLOW_MODULE_ORDER) {
    const existing = moduleMap.get(modName.toLowerCase());
    if (existing) {
      orderedGroups.push(existing);
      moduleMap.delete(modName.toLowerCase());
    } else {
      orderedGroups.push({ module: modName, workflows: [] });
    }
  }
  const otherGroup = orderedGroups.pop();
  for (const remaining of moduleMap.values()) {
    orderedGroups.push(remaining);
  }
  orderedGroups.push(otherGroup);

  let totalOpportunities = 0;
  for (const group of orderedGroups) {
    const articles = getModuleArticles(group.module);
    const unlinked = (group.workflows || []).filter((w) => {
      const isAutoLinked = articles.some((article) => articleMatches(w, article));
      const isManuallyLinked = manualLinks.has(w.title);
      const isDismissed = dismissedWorkflows.has(w.title);
      return !isAutoLinked && !isManuallyLinked && !isDismissed;
    });
    totalOpportunities += unlinked.length;
  }

  const toRecordTabBadge = $('#toRecordCount');
  if (toRecordTabBadge) {
    toRecordTabBadge.textContent = totalOpportunities;
    toRecordTabBadge.hidden = totalOpportunities === 0;
  }

  for (const group of orderedGroups) {
    const modKey = group.module.toLowerCase();
    const articles = getModuleArticles(group.module);

    // Only display recording opportunities that do NOT have a linked article and are not dismissed
    const unlinkedWorkflows = (group.workflows || []).filter((w) => {
      const isAutoLinked = articles.some((article) => articleMatches(w, article));
      const isManuallyLinked = manualLinks.has(w.title);
      const isDismissed = dismissedWorkflows.has(w.title);
      return !isAutoLinked && !isManuallyLinked && !isDismissed;
    });

    const matchingWorkflows = unlinkedWorkflows.filter((w) => !q || `${w.title} ${w.purpose}`.toLowerCase().includes(q));
    const visibleArticles = articles.filter((a) => !q || a.title.toLowerCase().includes(q));
    if (q && !matchingWorkflows.length && !visibleArticles.length) continue;

    const isModuleOpen = q ? true : openModuleBodies.has(modKey);
    const iconSrc = moduleIconPath(group.module);
    const section = document.createElement('section'); section.className = 'module';
    section.innerHTML = `<div class="module-head"><span class="module-caret">${isModuleOpen ? '▾' : '▸'}</span><img class="module-icon" src="${iconSrc}" alt="" /><h2>${esc(group.module)}</h2><span class="counts">${unlinkedWorkflows.length} ${unlinkedWorkflows.length === 1 ? 'opportunity' : 'opportunities'}</span></div><div class="module-body" ${isModuleOpen ? '' : 'hidden'}></div>`;
    const body = section.querySelector('.module-body');

    if (!matchingWorkflows.length) {
      body.insertAdjacentHTML('beforeend', '<div class="item muted">All workflows in this module have linked articles ✓</div>');
    }

    for (const workflow of matchingWorkflows) {
      const item = document.createElement('div'); item.className = 'item';
      const blocker = autoRecordBlocker(workflow);
      const aiBtn = blocker
        ? `<span class="auto-record-off" title="${esc(`Auto-record unavailable: ${blocker}. Record manually, or open View plan → Enhance so every step gets verified.`)}">⚡ Auto-record unavailable</span>`
        : `<button class="ai-beta aiRecord" title="Beta — drives your browser autonomously to perform and record this workflow. Every step of this plan was verified against the source, but results can still be inconsistent; review the result.">⚡ Auto-record <span class="beta-chip">Beta</span></button>`;
      item.innerHTML = `<div class="item-title">${esc(workflow.title)}<span class="badge">Needs article</span></div><p>${esc(workflow.purpose)}</p><div class="item-actions">${aiBtn}<button class="secondary choose" title="Record this workflow manually">Record manually</button><button class="secondary plan">View plan</button><button class="icon-action check markLinked push-right" type="button" title="Mark as done" aria-label="Mark as done">✓</button><button class="icon-action dismissWf" type="button" title="Dismiss this opportunity" aria-label="Dismiss">✕</button></div>`;
      const aiEl = item.querySelector('.aiRecord'); if (aiEl) aiEl.onclick = () => startAiBrowserRecording(group.module, workflow);
      item.querySelector('.choose').onclick = () => chooseWorkflow(group.module, workflow);
      item.querySelector('.plan').onclick = () => openViewPlanModal(group.module, workflow);
      item.querySelector('.markLinked').onclick = () => markWorkflowLinked(workflow.title, group.module);
      item.querySelector('.dismissWf').onclick = () => dismissWorkflow(workflow.title, group.module);
      body.appendChild(item);
    }

    const manuallyLinkedInModule = (group.workflows || []).filter((w) => manualLinks.has(w.title) && !dismissedWorkflows.has(w.title));
    if (manuallyLinkedInModule.length > 0) {
      const isDoneOpen = q ? true : openDoneSections.has(modKey);
      const manualSec = document.createElement('div');
      manualSec.className = 'module-done-section';
      manualSec.innerHTML = `
        <div class="module-done-head">
          <span class="done-caret">${isDoneOpen ? '▾' : '▸'}</span>
          <span class="done-title">✓ Marked as Done (${manuallyLinkedInModule.length})</span>
          <button class="link-btn resetAllDoneBtn" type="button" title="Revert all marked as done in this module">Revert all</button>
        </div>
        <div class="module-done-body" ${isDoneOpen ? '' : 'hidden'}></div>
      `;

      const doneBody = manualSec.querySelector('.module-done-body');
      for (const w of manuallyLinkedInModule) {
        const dItem = document.createElement('div');
        dItem.className = 'item done-item';
        dItem.innerHTML = `
          <div class="item-title">${esc(w.title)}<span class="badge done-badge">✓ Marked as done</span></div>
          <p>${esc(w.purpose || '')}</p>
          <div class="item-actions">
            <button class="secondary revertBtn" title="Revert this workflow back to To Record">↩ Revert to To Record</button>
            <button class="secondary plan">View plan</button>
          </div>
        `;
        dItem.querySelector('.revertBtn').onclick = () => unmarkWorkflowLinked(w.title, group.module);
        dItem.querySelector('.plan').onclick = () => openViewPlanModal(group.module, w);
        doneBody.appendChild(dItem);
      }

      manualSec.querySelector('.module-done-head').onclick = (e) => {
        if (e.target.closest('button')) return;
        doneBody.hidden = !doneBody.hidden;
        const caret = manualSec.querySelector('.done-caret');
        if (caret) caret.textContent = doneBody.hidden ? '▸' : '▾';
        if (doneBody.hidden) openDoneSections.delete(modKey);
        else openDoneSections.add(modKey);
      };

      manualSec.querySelector('.resetAllDoneBtn').onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Revert all ${manuallyLinkedInModule.length} workflows in ${group.module} back to To Record?`)) return;
        for (const w of manuallyLinkedInModule) {
          manualLinks.delete(w.title);
          api('/workflows/link', { method: 'POST', body: JSON.stringify({ title: w.title, module: group.module, unmark: true }) }).catch(() => {});
        }
        await chrome.storage.local.set({ manualLinks: [...manualLinks] });
        toast(`✓ Reverted ${manuallyLinkedInModule.length} workflows back to To Record`);
        renderModules();
      };

      body.appendChild(manualSec);
    }

    const moduleBody = section.querySelector('.module-body');
    section.querySelector('.module-head').onclick = () => {
      moduleBody.hidden = !moduleBody.hidden;
      const caret = section.querySelector('.module-caret');
      if (caret) caret.textContent = moduleBody.hidden ? '▸' : '▾';
      if (moduleBody.hidden) {
        openModuleBodies.delete(modKey);
      } else {
        openModuleBodies.add(modKey);
      }
    };
    $('#modules').appendChild(section);
  }

  if (scrollTarget && prevScrollTop > 0) {
    requestAnimationFrame(() => {
      scrollTarget.scrollTop = prevScrollTop;
    });
  }
}

const openPylonArticleModules = new Set();

function renderPylonArticles() {
  const q = ($('#pylonSearch')?.value || '').trim().toLowerCase();
  const listEl = $('#pylonModules');
  if (!listEl) return;

  const scrollTarget = document.scrollingElement || document.documentElement || document.body;
  const prevScrollTop = scrollTarget ? scrollTarget.scrollTop : 0;

  listEl.innerHTML = '';

  const uniqueCollections = new Map();
  if (pylon?.modules) {
    for (const [k, v] of Object.entries(pylon.modules)) {
      uniqueCollections.set(k.toLowerCase(), { module: k, ...v });
    }
  }

  let totalArticles = 0;
  for (const v of uniqueCollections.values()) {
    if (Array.isArray(v?.articles)) totalArticles += v.articles.length;
  }

  const syncStatusEl = $('#pylonSyncStatus');
  if (syncStatusEl) {
    const collCount = uniqueCollections.size;
    syncStatusEl.textContent = `${totalArticles} recorded Pylon ${totalArticles === 1 ? 'article' : 'articles'} across ${collCount} module collections`;
  }

  const tabBadge = $('#pylonArticleCount');
  if (tabBadge) {
    tabBadge.textContent = totalArticles;
    tabBadge.hidden = totalArticles === 0;
  }

  const orderedGroups = [];
  for (const modName of WORKFLOW_MODULE_ORDER) {
    const existing = uniqueCollections.get(modName.toLowerCase());
    if (existing) {
      orderedGroups.push(existing);
      uniqueCollections.delete(modName.toLowerCase());
    } else {
      orderedGroups.push({ module: modName, articles: getModuleArticles(modName) });
    }
  }
  for (const remaining of uniqueCollections.values()) {
    orderedGroups.push(remaining);
  }

  for (const group of orderedGroups) {
    const articles = group.articles || getModuleArticles(group.module);
    const visibleArticles = articles.filter((a) => !q || a.title.toLowerCase().includes(q));
    if (q && !visibleArticles.length) continue;

    const iconSrc = moduleIconPath(group.module);
    const modKey = group.module.toLowerCase();
    const isModuleOpen = q ? true : openPylonArticleModules.has(modKey);

    const collectionUrl = getModuleCollectionUrl(group.module);
    const collectionLinkHtml = collectionUrl ? `<a href="${collectionUrl}" class="pylon-collection-link" target="_blank" rel="noopener noreferrer" style="margin-left: 8px;">↗ Collection</a>` : '';

    const section = document.createElement('section');
    section.className = 'module';
    section.innerHTML = `
      <div class="module-head">
        <span class="module-caret">${isModuleOpen ? '▾' : '▸'}</span>
        <img class="module-icon" src="${iconSrc}" alt="" />
        <h2>${esc(group.module)}</h2>
        <span class="counts">${visibleArticles.length} ${visibleArticles.length === 1 ? 'article' : 'articles'}</span>
        ${collectionLinkHtml}
      </div>
      <div class="module-body" ${isModuleOpen ? '' : 'hidden'}></div>
    `;

    const moduleHead = section.querySelector('.module-head');
    const moduleBody = section.querySelector('.module-body');

    moduleHead.onclick = (e) => {
      if (e.target.closest('.pylon-collection-link')) return;
      moduleBody.hidden = !moduleBody.hidden;
      const caret = section.querySelector('.module-caret');
      if (caret) caret.textContent = moduleBody.hidden ? '▸' : '▾';
      if (moduleBody.hidden) {
        openPylonArticleModules.delete(modKey);
      } else {
        openPylonArticleModules.add(modKey);
      }
    };

    if (!visibleArticles.length) {
      moduleBody.innerHTML = '<div class="item muted">No articles in this collection yet.</div>';
    } else {
      for (const article of visibleArticles) {
        const item = document.createElement('div');
        item.className = 'pylon-article-item';
        const cleanTitle = formatHumanTitle(article.title);
        const statusClass = article.isPublished ? 'published' : 'draft';
        const statusLabel = article.isPublished ? 'Published' : 'Draft';
        item.innerHTML = `
          <a href="#" class="pylon-article-title">${esc(cleanTitle)}</a>
          <span class="badge ${statusClass}">${statusLabel}</span>
        `;
        item.querySelector('a').onclick = (e) => {
          e.preventDefault();
          chrome.tabs.create({ url: article.url });
        };
        moduleBody.appendChild(item);
      }
    }

    listEl.appendChild(section);
  }

  if (scrollTarget && prevScrollTop > 0 && !$('#pylonArticlesView').hidden) {
    requestAnimationFrame(() => {
      scrollTarget.scrollTop = prevScrollTop;
    });
  }
}

function resolveSteps(module, workflow) {
  const steps = [...(workflow.steps || [])];
  if (!steps.length) return steps;
  const first = steps[0] || '';
  const hasNav = /^(navigate to|open|go to)\s+/i.test(first) && (first.includes('>') || first.toLowerCase().includes(module.toLowerCase()));
  if (!hasNav && workflow.startRoute) {
    const tab = workflow.startRoute.split('/').filter(Boolean).pop()?.replace(/[-_]/g, ' ') || 'Overview';
    const tabLabel = tab.charAt(0).toUpperCase() + tab.slice(1);
    steps.unshift(`Navigate to ${module} > ${tabLabel}`);
  }
  return steps;
}

function formatPlanStep(text) {
  if (!text) return '';
  let s = String(text).replace(/&quot;/g, '"');
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/&gt;/g, "<span class='plan-nav-arrow'>›</span>");
  s = s.replace(/"([^"]+)"/g, "<strong class='plan-quoted-action'>\"$1\"</strong>");
  return s;
}

function renderPlanCard(module, workflow, steps) {
  const iconSrc = moduleIconPath(module);
  const el = $('#selectedWorkflow');
  el.className = 'selected plan-card';
  el.hidden = false;
  el.innerHTML = `
    <div class="plan-card-header">
      <div class="plan-card-tag">
        <img class="module-icon small" src="${iconSrc}" alt="" />
        <span class="plan-module-name">${esc(module)}</span>
        <span class="plan-pill">Workflow Plan</span>
      </div>
      <button id="closePlanBtn" class="plan-close-btn" type="button" title="Dismiss plan">✕</button>
    </div>
    <h2 class="plan-card-title">${esc(workflow.title)}</h2>
    <p class="plan-card-subtitle">Follow this step-by-step plan while recording in Hadrius:</p>
    <ul class="plan-steps-list">
      ${(steps || []).map((s, i) => `
        <li class="plan-step-item" data-step-idx="${i}">
          <span class="plan-step-check"></span>
          <span class="plan-step-num">${i + 1}.</span>
          <span class="plan-step-desc">${formatPlanStep(s)}</span>
        </li>
      `).join('')}
    </ul>
  `;

  el.querySelector('#closePlanBtn').onclick = () => {
    el.hidden = true;
  };

  el.querySelectorAll('.plan-step-item').forEach((item) => {
    item.onclick = () => {
      item.classList.toggle('done');
    };
  });
}

async function chooseWorkflow(module, workflow, start=true) {
  const steps = resolveSteps(module, workflow);
  selected = { module, ...workflow, steps };
  renderPlanCard(module, workflow, steps);
  $('#scriptName').value = workflow.title;
  await send({type:'PANEL_UPDATE_SCRIPT',patch:{name:workflow.title,module,workflowPlan:steps,sourceFiles:workflow.sources || []}});
  switchView('recording');
  if (start) await startRecording();
}

let activeViewPlanModal = null; // { module, originalWorkflow, currentPlan, enhancedPlan }

function renderViewPlanContent(plan, isProposed = false) {
  if (!plan) return;
  const mod = plan.module || activeViewPlanModal?.module || 'Workflow';
  $('#viewPlanModalModule').textContent = mod;

  const route = plan.startRoute || plan.start_route || '';
  const routeEl = $('#viewPlanModalRoute');
  if (route) {
    routeEl.textContent = route;
    routeEl.hidden = false;
  } else {
    routeEl.hidden = true;
  }

  const badgeEl = $('#viewPlanStatusBadge');
  if (isProposed) {
    badgeEl.textContent = '✨ Proposed Enhancement';
    badgeEl.hidden = false;
  } else {
    badgeEl.hidden = true;
  }

  $('#viewPlanModalTitle').textContent = plan.title || activeViewPlanModal?.originalWorkflow?.title || '';
  $('#viewPlanModalSummary').textContent = plan.summary || plan.purpose || '';

  // Auto-record only for fully verified plans; otherwise say exactly why it's off.
  const aiRecordBtn = $('#viewPlanAiRecordBtn');
  const aiNote = $('#viewPlanAutoRecordNote');
  if (aiRecordBtn && aiNote) {
    const src = isProposed ? plan : (activeViewPlanModal?.originalWorkflow || plan);
    const blocker = autoRecordBlocker({ ...src, steps: plan.steps || src.steps, grounding: plan.grounding || src.grounding, provisionable: plan.provisionable || src.provisionable });
    aiRecordBtn.hidden = !!blocker || isProposed;
    aiNote.hidden = !blocker || isProposed;
    if (blocker) aiNote.textContent = `Auto-record unavailable — ${blocker}. Record manually or run Enhance plan.`;
  }

  // Plans are shared live across every install; say who last changed this one and when, so a
  // teammate's edit landing under you is visible rather than mysterious.
  const metaEl = $('#viewPlanUpdatedMeta');
  if (metaEl) {
    const at = plan.planUpdatedAt || activeViewPlanModal?.originalWorkflow?.planUpdatedAt;
    const by = plan.planUpdatedBy || activeViewPlanModal?.originalWorkflow?.planUpdatedBy;
    if (at && !isProposed) {
      const d = new Date(at);
      const ago = Math.max(0, Date.now() - d.getTime());
      const rel = ago < 60e3 ? 'just now' : ago < 3600e3 ? `${Math.round(ago / 60e3)} min ago` : ago < 86400e3 ? `${Math.round(ago / 3600e3)} h ago` : ago < 14 * 86400e3 ? `${Math.round(ago / 86400e3)} d ago` : d.toLocaleDateString();
      metaEl.textContent = `Plan updated ${rel}${by ? ` by ${by}` : ''} · shared with the whole team`;
      metaEl.hidden = false;
    } else {
      metaEl.hidden = true;
    }
  }

  const prereqSection = $('#viewPlanPrerequisitesSection');
  const prereqList = $('#viewPlanPrerequisitesList');
  const prereqBadge = $('#viewPlanPrereqBadge');
  const blockerNote = $('#viewPlanBlockerNote');
  const prerequisites = plan.prerequisites || activeViewPlanModal?.originalWorkflow?.prerequisites || [];
  const provisionable = plan.provisionable || activeViewPlanModal?.originalWorkflow?.provisionable || null;
  const blockerReason = plan.blockerReason || activeViewPlanModal?.originalWorkflow?.blockerReason || '';
  if (prerequisites.length > 0 || blockerReason) {
    prereqSection.hidden = false;
    prereqList.innerHTML = prerequisites.map((p) => `<li class="plan-prereq-item">${esc(p)}</li>`).join('') || '<li class="plan-prereq-item">No special setup needed.</li>';
    if (provisionable === 'structurally-blocked') {
      prereqBadge.textContent = 'Cannot be set up via UI';
      prereqBadge.className = 'badge blocked';
      prereqBadge.hidden = false;
    } else if (provisionable === 'self-serve-quick' || provisionable === 'needs-deliberate-setup') {
      prereqBadge.textContent = 'Needs setup first';
      prereqBadge.className = 'badge needs-setup';
      prereqBadge.hidden = false;
    } else if (provisionable) {
      prereqBadge.textContent = 'Usually ready';
      prereqBadge.className = 'badge ready';
      prereqBadge.hidden = false;
    } else {
      prereqBadge.hidden = true;
    }
    if (blockerReason) {
      blockerNote.textContent = `Why this can't be auto-set-up: ${blockerReason}`;
      blockerNote.hidden = false;
    } else {
      blockerNote.hidden = true;
    }
  } else {
    prereqSection.hidden = true;
  }

  const steps = Array.isArray(plan.steps) ? plan.steps : resolveSteps(mod, plan);
  $('#viewPlanStepsCount').textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;

  const stepsList = $('#viewPlanModalStepsList');
  if (steps.length > 0) {
    stepsList.innerHTML = steps.map((s, i) => `
      <li class="plan-step-item">
        <span class="plan-step-num">${i + 1}.</span>
        <span class="plan-step-desc">${formatPlanStep(s)}</span>
      </li>
    `).join('');
  } else {
    stepsList.innerHTML = '<li class="plan-step-item muted">No steps defined yet.</li>';
  }

  const sources = plan.sources || activeViewPlanModal?.originalWorkflow?.sources || [];
  const sourcesSection = $('#viewPlanSourcesSection');
  const sourcesList = $('#viewPlanSourcesList');
  if (sources.length > 0) {
    sourcesSection.hidden = false;
    sourcesList.textContent = sources.map(s => s.split('/').slice(-2).join('/')).join(', ');
  } else {
    sourcesSection.hidden = true;
  }
}

function openViewPlanModal(moduleName, workflow) {
  activeViewPlanModal = {
    module: moduleName,
    originalWorkflow: workflow,
    currentPlan: {
      title: workflow.title,
      module: moduleName,
      startRoute: workflow.startRoute || workflow.start_route,
      summary: workflow.purpose || workflow.summary || '',
      steps: resolveSteps(moduleName, workflow),
      sources: workflow.sources || [],
      prerequisites: workflow.prerequisites || [],
      provisionable: workflow.provisionable || null,
      blockerReason: workflow.blockerReason || '',
      grounding: workflow.grounding || null,
      autoRecordBlocker: workflow.autoRecordBlocker,
      planUpdatedAt: workflow.planUpdatedAt || null,
      planUpdatedBy: workflow.planUpdatedBy || null
    },
    enhancedPlan: null
  };

  renderViewPlanContent(activeViewPlanModal.currentPlan, false);

  $('#viewPlanAiPromptInput').value = '';
  $('#viewPlanClarifyInput').value = '';
  $('#viewPlanAiPromptBox').hidden = false;
  $('#viewPlanAiReviewBox').hidden = true;
  $('#viewPlanLoadingState').hidden = true;
  $('#viewPlanModal').hidden = false;
}

function closeViewPlanModal() {
  $('#viewPlanModal').hidden = true;
  activeViewPlanModal = null;
}

async function enhancePlanInModal() {
  if (!activeViewPlanModal) return;
  const promptInput = $('#viewPlanAiPromptInput');
  const clarification = promptInput.value.trim();

  $('#viewPlanLoadingState').hidden = false;
  $('#viewPlanAiPromptBox').hidden = true;
  $('#viewPlanAiReviewBox').hidden = true;

  try {
    const res = await api('/workflows/enhance', {
      method: 'POST',
      body: JSON.stringify({
        module: activeViewPlanModal.module,
        workflow: activeViewPlanModal.currentPlan || activeViewPlanModal.originalWorkflow,
        clarification: clarification || null
      })
    });
    if (!res?.ok || !res.plan) throw new Error(res?.error || 'Enhance plan failed');

    activeViewPlanModal.enhancedPlan = res.plan;
    renderViewPlanContent(res.plan, true);

    $('#viewPlanLoadingState').hidden = true;
    $('#viewPlanAiReviewBox').hidden = false;
    $('#viewPlanClarifyInput').value = '';
  } catch (err) {
    alert(`Could not enhance plan: ${err.message}`);
    $('#viewPlanLoadingState').hidden = true;
    $('#viewPlanAiPromptBox').hidden = false;
  }
}

async function refinePlanInModal() {
  if (!activeViewPlanModal?.enhancedPlan) return;
  const clarifyInput = $('#viewPlanClarifyInput');
  const clarification = clarifyInput.value.trim();
  if (!clarification) {
    clarifyInput.focus();
    return alert('Please enter clarification or details on what to change.');
  }

  $('#viewPlanLoadingState').hidden = false;
  $('#viewPlanAiReviewBox').hidden = true;

  try {
    const res = await api('/workflows/enhance', {
      method: 'POST',
      body: JSON.stringify({
        module: activeViewPlanModal.module,
        workflow: activeViewPlanModal.enhancedPlan,
        clarification
      })
    });
    if (!res?.ok || !res.plan) throw new Error(res?.error || 'Refining plan failed');

    activeViewPlanModal.enhancedPlan = res.plan;
    renderViewPlanContent(res.plan, true);

    $('#viewPlanLoadingState').hidden = true;
    $('#viewPlanAiReviewBox').hidden = false;
    $('#viewPlanClarifyInput').value = '';
  } catch (err) {
    alert(`Could not refine plan: ${err.message}`);
    $('#viewPlanLoadingState').hidden = true;
    $('#viewPlanAiReviewBox').hidden = false;
  }
}

async function acceptEnhancedPlanInModal() {
  if (!activeViewPlanModal?.enhancedPlan) return;
  const { module: modName, originalWorkflow, enhancedPlan } = activeViewPlanModal;

  try {
    const res = await api('/workflows/opportunity', {
      method: 'POST',
      body: JSON.stringify({ module: modName, workflow: enhancedPlan })
    });
    if (!res?.ok) throw new Error(res?.error || 'Failed to update workflow plan');

    originalWorkflow.steps = enhancedPlan.steps;
    if (enhancedPlan.summary) originalWorkflow.purpose = enhancedPlan.summary;
    if (enhancedPlan.sources) originalWorkflow.sources = enhancedPlan.sources;

    if (selected && selected.title === originalWorkflow.title) {
      selected.steps = enhancedPlan.steps;
      renderPlanCard(modName, originalWorkflow, enhancedPlan.steps);
      send({
        type: 'PANEL_UPDATE_SCRIPT',
        patch: { workflowPlan: enhancedPlan.steps, sourceFiles: enhancedPlan.sources || [] }
      });
    }

    activeViewPlanModal.currentPlan = enhancedPlan;
    activeViewPlanModal.enhancedPlan = null;

    renderViewPlanContent(enhancedPlan, false);
    $('#viewPlanAiPromptInput').value = '';
    $('#viewPlanAiPromptBox').hidden = false;
    $('#viewPlanAiReviewBox').hidden = true;

    toast(`✓ Plan for "${originalWorkflow.title}" updated!`);
    renderModules();
  } catch (err) {
    alert(`Failed to save enhanced plan: ${err.message}`);
  }
}

function discardEnhancedPlanInModal() {
  if (!activeViewPlanModal) return;
  activeViewPlanModal.enhancedPlan = null;
  renderViewPlanContent(activeViewPlanModal.currentPlan, false);
  $('#viewPlanAiPromptBox').hidden = false;
  $('#viewPlanAiReviewBox').hidden = true;
  $('#viewPlanLoadingState').hidden = true;
  $('#viewPlanClarifyInput').value = '';
}

let activeAiRecordKey = null;
let activeAiPollInterval = null;

// Mirrors the bridge's rule (tools/ai-bridge.mjs autoRecordBlocker): the browser agent stalls on any
// step the planner couldn't pin to one exact control, so Auto-record is offered only for plans whose
// every step was verified against the source. The bridge re-checks and refuses regardless.
function autoRecordBlocker(w) {
  if (w?.autoRecordBlocker !== undefined && w.autoRecordBlocker !== null) return w.autoRecordBlocker || null;
  const steps = Array.isArray(w?.steps) ? w.steps : [];
  if (steps.length < 3) return 'the plan has fewer than 3 steps';
  if (w?.provisionable === 'structurally-blocked') return 'its prerequisites cannot be set up in this environment';
  const g = w?.grounding;
  if (!g) return 'the plan has not been verified against the codebase yet';
  if (g.confidence !== 'high') return `the plan is only ${g.confidence || 'partially'}-confidence`;
  if (Array.isArray(g.unverified) && g.unverified.length) return `${g.unverified.length} step(s) could not be pinned to an exact control`;
  return null;
}

async function startAiBrowserRecording(moduleName, workflow) {
  if (!workflow) return;
  const blocker = autoRecordBlocker(workflow);
  if (blocker) return alert(`Auto-record is unavailable for this plan: ${blocker}.\n\nRecord it manually, or open View plan → Enhance plan so every step is verified first.`);
  const title = workflow.title;
  const steps = resolveSteps(moduleName, workflow);
  const stepsCount = steps.length;
  const confirmed = confirm(`⚡ Launch AI Browser Automation for:\n"${title}" (${stepsCount} steps)?\n\nA visible browser window will open on your screen and execute the steps live with on-screen spotlight and takeover controls.`);
  if (!confirmed) return;

  // Close modals
  closeViewPlanModal();
  closeRecordStartModal();

  // Load the plan into the Record tab and switch to it immediately
  selected = { module: moduleName, ...workflow, steps };
  renderPlanCard(moduleName, workflow, steps);
  $('#scriptName').value = title;
  switchView('recording');

  state.recording = true;
  updateRecordingButtons();
  const banner = $('#recordingBanner');
  if (banner) {
    banner.hidden = false;
    $('#recordingStepIndicator').textContent = `⚡ AI recording live: "${title}"…`;
  }

  toast(`Launching AI browser automation for "${title}"…`);
  try {
    const res = await api('/workflows/ai-record', {
      method: 'POST',
      body: JSON.stringify({ module: moduleName, workflow: { ...workflow, steps } })
    });
    if (!res?.ok) throw new Error(res?.error || 'Failed to start AI recording');

    activeAiRecordKey = res.key;
    pollAiRecordJob(res.key, title, steps);
  } catch (err) {
    state.recording = false;
    activeAiRecordKey = null;
    if (activeAiPollInterval) { clearInterval(activeAiPollInterval); activeAiPollInterval = null; }
    updateRecordingButtons();
    alert(`Could not start AI recording: ${err.message}`);
  }
}

function pollAiRecordJob(key, title, planSteps = []) {
  if (activeAiPollInterval) clearInterval(activeAiPollInterval);

  function updateSidepanelPlanProgress(currentStepIdx) {
    const items = document.querySelectorAll('#selectedWorkflow .plan-step-item');
    items.forEach((item, idx) => {
      if (idx < currentStepIdx) {
        item.classList.add('done');
        item.classList.remove('ai-active');
      } else if (idx === currentStepIdx) {
        item.classList.add('ai-active');
        item.classList.remove('done');
        item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        item.classList.remove('done', 'ai-active');
      }
    });
  }

  activeAiPollInterval = setInterval(async () => {
    try {
      const res = await api(`/workflows/ai-record?key=${encodeURIComponent(key)}`);
      if (!res?.ok || !res.job) return;
      const job = res.job;

      if (job.state === 'running') {
        const lastLog = job.log?.[job.log.length - 1] || 'Driving browser…';
        const cleanMsg = lastLog.replace(/^turn \d+:\s*/i, '');
        const banner = $('#recordingBanner');
        if (banner) {
          banner.hidden = false;
          $('#recordingStepIndicator').textContent = `⚡ ${cleanMsg}`;
        }

        let stepIdx = 0;
        const turnMatch = lastLog.match(/turn\s+(\d+)/i);
        if (turnMatch) {
          stepIdx = Math.min(Math.max(0, parseInt(turnMatch[1], 10) - 1), Math.max(0, planSteps.length - 1));
        }
        updateSidepanelPlanProgress(stepIdx);
      } else if (job.state === 'done') {
        if (activeAiPollInterval) { clearInterval(activeAiPollInterval); activeAiPollInterval = null; }
        activeAiRecordKey = null;
        state.recording = false;
        updateRecordingButtons();
        document.querySelectorAll('#selectedWorkflow .plan-step-item').forEach((item) => {
          item.classList.add('done');
          item.classList.remove('ai-active');
        });

        const scriptName = job.result?.scriptName;
        if (scriptName) {
          try {
            const r = await send({ type: 'PANEL_LIBRARY_GET', name: scriptName });
            if (r?.ok && r.item?.script) {
              await send({ type: 'PANEL_LOAD_SCRIPT', script: r.item.script });
              await loadState();
              const humanTitle = r.item.script.title || formatHumanTitle(r.item.script.name) || title;
              $('#scriptName').value = humanTitle;
              switchView('recording');
            }
          } catch (loadErr) {
            console.warn('Could not auto-load script into sidebar:', loadErr);
          }
        }

        toast(`✓ AI recording complete for "${title}"!`);
        alert(`✓ AI browser recording complete for "${title}"!\n\nCaptured script has been loaded into the sidebar with drafted narration, ready to review and render.`);
        await refreshAll();
      } else if (job.state === 'failed') {
        if (activeAiPollInterval) { clearInterval(activeAiPollInterval); activeAiPollInterval = null; }
        activeAiRecordKey = null;
        state.recording = false;
        updateRecordingButtons();
        alert(`AI recording stopped: ${job.error || 'unknown error'}`);
      }
    } catch (_) {}
  }, 1500);
}

let activeRecordAiPlan = null; // { userPrompt, plan, previousPlan }

function getModuleUnlinkedWorkflows(modName) {
  if (!catalog?.modules) return [];
  const modGroup = catalog.modules.find((m) => m.module.toLowerCase() === modName.toLowerCase());
  if (!modGroup) return [];
  const articles = getModuleArticles(modName);
  return (modGroup.workflows || []).filter((w) => {
    const isAutoLinked = articles.some((article) => articleMatches(w, article));
    const isManuallyLinked = manualLinks.has(w.title);
    const isDismissed = dismissedWorkflows.has(w.title);
    return !isAutoLinked && !isManuallyLinked && !isDismissed;
  });
}

function populateRecordModalModules() {
  const select = $('#recordModuleSelect');
  if (!select) return;

  const currentVal = select.value;
  select.innerHTML = '<option value="">Select a module…</option>';

  const moduleMap = new Map();
  for (const group of catalog.modules || []) {
    moduleMap.set(group.module.toLowerCase(), group);
  }

  const orderedModules = [];
  for (const modName of WORKFLOW_MODULE_ORDER) {
    if (moduleMap.has(modName.toLowerCase())) {
      orderedModules.push(modName);
      moduleMap.delete(modName.toLowerCase());
    }
  }
  for (const remaining of moduleMap.values()) {
    orderedModules.push(remaining.module);
  }

  for (const modName of orderedModules) {
    const unlinked = getModuleUnlinkedWorkflows(modName);
    const opt = document.createElement('option');
    opt.value = modName;
    opt.textContent = `${modName} (${unlinked.length} opportunities)`;
    select.appendChild(opt);
  }

  if (currentVal) {
    select.value = currentVal;
    renderRecordModalOpportunities(currentVal);
  } else {
    $('#recordModalOppsList').hidden = true;
    $('#recordModalOppsList').innerHTML = '';
  }
}

function renderRecordModalOpportunities(moduleName) {
  const list = $('#recordModalOppsList');
  if (!list) return;

  if (!moduleName) {
    list.hidden = true;
    list.innerHTML = '';
    return;
  }

  const unlinked = getModuleUnlinkedWorkflows(moduleName);
  list.hidden = false;

  if (!unlinked.length) {
    list.innerHTML = '<div class="muted small" style="padding: 10px; text-align: center;">All workflows in this module have linked articles ✓</div>';
    return;
  }

  list.innerHTML = unlinked.map((w) => {
    const stepCount = (w.steps?.length || 0);
    const route = w.startRoute || w.start_route || '';
    return `
      <div class="record-opp-item">
        <div class="record-opp-info">
          <div class="record-opp-title">${esc(w.title)}</div>
          <div class="record-opp-purpose">${esc(w.purpose || '')}</div>
          <div class="record-opp-meta">
            <span class="badge">${stepCount} step${stepCount === 1 ? '' : 's'}</span>
            ${route ? `<span class="plan-route-pill">${esc(route)}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:5px;">
          <button class="primary record-opp-action-btn" type="button" title="Load this plan and start recording">● Record</button>
          ${autoRecordBlocker(w)
            ? `<span class="auto-record-off small" title="${esc(`Auto-record unavailable: ${autoRecordBlocker(w)}`)}">⚡ n/a</span>`
            : `<button class="ai-beta record-opp-ai-btn" type="button" title="Beta — drives your browser autonomously to perform and record this workflow. Results can be inconsistent; use with caution.">⚡ Auto <span class="beta-chip">Beta</span></button>`}
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.record-opp-item').forEach((itemEl, i) => {
    const w = unlinked[i];
    const aiBtn = itemEl.querySelector('.record-opp-ai-btn');
    if (aiBtn) aiBtn.onclick = () => {
      startAiBrowserRecording(moduleName, w);
    };
    itemEl.querySelector('.record-opp-action-btn').onclick = async () => {
      closeRecordStartModal();
      await chooseWorkflow(moduleName, w, true);
    };
  });
}

function openRecordStartModal() {
  activeRecordAiPlan = null;
  const currentTitle = $('#scriptName').value.trim();
  $('#recordAiPromptInput').value = currentTitle;
  $('#recordPlanClarifyInput').value = '';

  const currentPlanBox = $('#recordModalCurrentPlanBox');
  if (selected?.steps && selected.steps.length > 0) {
    if (currentPlanBox) currentPlanBox.hidden = false;
    const planTitleEl = $('#recordModalCurrentPlanTitle');
    if (planTitleEl) planTitleEl.textContent = `${selected.title || 'Selected Workflow'} (${selected.steps.length} steps)`;
  } else {
    if (currentPlanBox) currentPlanBox.hidden = true;
  }

  showRecordModalView('choice');
  populateRecordModalModules();
  $('#recordStartModal').hidden = false;
  setTimeout(() => $('#recordModuleSelect').focus(), 50);
}

function closeRecordStartModal() {
  $('#recordStartModal').hidden = true;
  activeRecordAiPlan = null;
}

function showRecordModalView(viewName) {
  $('#recordModalChoiceView').hidden = viewName !== 'choice';
  $('#recordModalLoadingView').hidden = viewName !== 'loading';
  $('#recordModalReviewView').hidden = viewName !== 'review';
}

async function generateRecordAiPlan(clarification = null) {
  const promptInput = $('#recordAiPromptInput');
  const userPrompt = activeRecordAiPlan?.userPrompt || promptInput.value.trim();

  if (!userPrompt) {
    promptInput.focus();
    return alert('Please describe what you want to achieve in the walkthrough.');
  }

  showRecordModalView('loading');

  const payload = {
    userPrompt,
    previousPlan: clarification ? activeRecordAiPlan?.plan : null,
    clarification: clarification || null
  };

  const res = await send({ type: 'PANEL_GENERATE_PLAN', payload });

  if (!res?.ok || !res.plan) {
    alert(res?.error || 'Could not generate walkthrough plan. Please try again.');
    if (activeRecordAiPlan?.plan) {
      showRecordModalView('review');
    } else {
      showRecordModalView('choice');
    }
    return;
  }

  const plan = res.plan;
  activeRecordAiPlan = {
    userPrompt,
    plan,
    previousPlan: activeRecordAiPlan?.plan || null
  };

  $('#recordPlanModuleTag').textContent = plan.module || 'Workflow';
  $('#recordPlanProposedTitle').textContent = plan.title || 'Proposed Walkthrough';
  $('#recordPlanProposedSummary').textContent = plan.summary || '';

  const stepsList = $('#recordPlanProposedStepsList');
  stepsList.innerHTML = (plan.steps || []).map((s, i) => `
    <li class="plan-step-item">
      <span class="plan-step-num">${i + 1}.</span>
      <span class="plan-step-desc">${formatPlanStep(s)}</span>
    </li>
  `).join('');

  $('#recordPlanClarifyInput').value = '';
  showRecordModalView('review');
}

function refineRecordAiPlan() {
  const clarification = $('#recordPlanClarifyInput').value.trim();
  if (!clarification) {
    $('#recordPlanClarifyInput').focus();
    return alert('Please enter clarification or details on what to change.');
  }
  generateRecordAiPlan(clarification);
}

async function acceptAndRecordPlan() {
  if (!activeRecordAiPlan?.plan) return;
  const plan = activeRecordAiPlan.plan;
  const mod = plan.module || 'Workflow';
  const steps = plan.steps || [];

  selected = { module: mod, ...plan, steps };
  renderPlanCard(mod, plan, steps);
  $('#scriptName').value = plan.title || '';

  await send({
    type: 'PANEL_UPDATE_SCRIPT',
    patch: {
      name: plan.title,
      module: mod,
      workflowPlan: steps,
      sourceFiles: plan.sources || []
    }
  });

  closeRecordStartModal();
  await startRecordingDirectly();
}

async function saveRecordPlanLater() {
  if (!activeRecordAiPlan?.plan) return;
  const plan = activeRecordAiPlan.plan;
  const mod = plan.module || 'Testing program';
  const title = plan.title;

  try {
    const res = await api('/workflows/opportunity', {
      method: 'POST',
      body: JSON.stringify({ module: mod, workflow: plan })
    });
    if (!res?.ok) throw new Error(res?.error || 'Failed to save opportunity');

    dismissedWorkflows.delete(title);
    manualLinks.delete(title);
    await chrome.storage.local.set({
      dismissedWorkflows: [...dismissedWorkflows],
      manualLinks: [...manualLinks]
    });

    refreshAll().catch(() => {});
    closeRecordStartModal();
    toast(`✓ Saved "${title}" as an opportunity on Workflows tab.`);
  } catch (err) {
    alert(`Could not save opportunity: ${err.message}`);
  }
}

// Ad hoc recording: no plan, no modal — capture whatever the person does next in the active tab.
async function recordNow() {
  if (state.recording) return;
  await startRecordingDirectly();
}

let isRenderingActive = false;

function updateRenderButtons() {
  const hasSteps = (state.steps?.length || 0) > 0;
  const disableRender = !hasSteps || isRenderingActive;
  $('#renderBtn').disabled = disableRender;
  $('#renderBothBtn').disabled = disableRender;
  $('#downloadBtn').disabled = !hasSteps;
  if ($('#clearBtn')) $('#clearBtn').disabled = !hasSteps && !($('#scriptName').value || '').trim();
}

function updateRecordingButtons() {
  const isRec = !!state.recording;
  $('#recordBtn').hidden = isRec;
  $('#stopBtn').hidden = !isRec;
  $('#cancelRecordBtn').hidden = !isRec;
  $('#clearBtn').hidden = isRec;
  updateRecordingBanner();
  updateRenderButtons();
}

function updateRecordingBanner() {
  const banner = $('#recordingBanner');
  if (!banner) return;
  if (state.recording) {
    banner.hidden = false;
    const count = state.steps?.length || 0;
    const lastStep = state.steps?.[count - 1];
    const route = lastStep?.route ? ` · ${lastStep.route}` : '';
    $('#recordingStepIndicator').textContent = `${count} ${count === 1 ? 'step' : 'steps'} captured${route}`;
  } else {
    banner.hidden = true;
  }
}

async function cancelRecording() {
  if (activeAiPollInterval) {
    clearInterval(activeAiPollInterval);
    activeAiPollInterval = null;
  }
  const banner = $('#recordingBanner');
  if (banner) banner.hidden = true;

  if (activeAiRecordKey) {
    if (!confirm('Stop the active AI recording?')) return;
    const keyToStop = activeAiRecordKey;
    activeAiRecordKey = null;
    try {
      await api('/workflows/ai-record/stop', { method: 'POST', body: JSON.stringify({ key: keyToStop }) });
    } catch (_) {}
    state.recording = false;
    updateRecordingButtons();
    return;
  }

  try {
    await api('/workflows/ai-record/stop', { method: 'POST', body: JSON.stringify({}) });
  } catch (_) {}

  if (state.steps?.length && !confirm('Cancel this recording? Captured steps will be discarded.')) return;
  await send({ type: 'PANEL_STOP' });
  await send({ type: 'PANEL_CLEAR' });
  state.recording = false;
  $('#narrationStatus').hidden = true;
  $('#narrationStatus').textContent = '';
  updateRecordingButtons();
  await loadState();
}

async function loadState() {
  state = await send({type:'PANEL_GET_STATE'});
  const count = state.steps?.length || 0;
  if (count > 0) {
    $('#stepCount').textContent = count;
    $('#stepCount').hidden = false;
  } else {
    $('#stepCount').textContent = '';
    $('#stepCount').hidden = true;
  }
  updateRecordingButtons();
  if (!count) {
    $('#narrationStatus').hidden = true;
    $('#narrationStatus').textContent = '';
  }
  $('#scriptName').value = state.script?.name || '';
  renderSteps();
}

async function detectEnvironment() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.url) {
    try {
      const u = new URL(activeTab.url);
      if (u.hostname.includes('staging.hadrius.com') || u.hostname === 'localhost') {
        const envInfo = { env: 'staging', origin: u.origin, companyId: u.searchParams.get('company_id') };
        await chrome.storage.local.set({ lastHadriusEnv: envInfo });
        return envInfo;
      }
      if (u.hostname.includes('app.hadrius.com')) {
        const envInfo = { env: 'prod', origin: u.origin, companyId: u.searchParams.get('company_id') };
        await chrome.storage.local.set({ lastHadriusEnv: envInfo });
        return envInfo;
      }
    } catch (_) {}
  }
  const tabs = await chrome.tabs.query({ currentWindow: true });
  for (const t of tabs) {
    if (t.url) {
      try {
        const u = new URL(t.url);
        if (u.hostname.includes('staging.hadrius.com') || u.hostname === 'localhost') {
          const envInfo = { env: 'staging', origin: u.origin, companyId: u.searchParams.get('company_id') };
          await chrome.storage.local.set({ lastHadriusEnv: envInfo });
          return envInfo;
        }
        if (u.hostname.includes('app.hadrius.com')) {
          const envInfo = { env: 'prod', origin: u.origin, companyId: u.searchParams.get('company_id') };
          await chrome.storage.local.set({ lastHadriusEnv: envInfo });
          return envInfo;
        }
      } catch (_) {}
    }
  }
  const { lastHadriusEnv } = await chrome.storage.local.get('lastHadriusEnv');
  return lastHadriusEnv || { env: 'staging', origin: 'https://staging.hadrius.com', companyId: null };
}

async function startRecording() {
  if (state.recording) return;
  openRecordStartModal();
}

async function startRecordingDirectly() {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return alert('Open PROD or Staging in the active tab before recording.');

  const envInfo = await detectEnvironment();

  if (selected?.startRoute && tab.url) {
    try {
      const currentUrl = new URL(tab.url);
      const isHadrius = currentUrl.hostname.endsWith('hadrius.com') || currentUrl.hostname === 'localhost';
      const targetOrigin = isHadrius ? currentUrl.origin : envInfo.origin;
      const targetUrl = new URL(selected.startRoute, targetOrigin);

      const compId = currentUrl.searchParams.get('company_id') || envInfo.companyId;
      if (compId && !targetUrl.searchParams.has('company_id')) {
        targetUrl.searchParams.set('company_id', compId);
      }

      if (currentUrl.origin !== targetUrl.origin || currentUrl.pathname !== targetUrl.pathname) {
        await chrome.tabs.update(tab.id, { url: targetUrl.href });
        await new Promise((resolve) => {
          const onUpdated = (tid, info) => {
            if (tid === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(onUpdated);
          setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 8000);
        });
        await new Promise((r) => setTimeout(r, 600));
      }
    } catch (err) {
      console.warn('Auto-navigation failed:', err);
    }
  }

  // Construct initial navigation step for fresh recording
  let initialNav = null;
  if (state.steps.length === 0) {
    try {
      const [refreshedTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentTabUrl = refreshedTab?.url || tab.url;
      let currentPath = '/';
      try { currentPath = new URL(currentTabUrl).pathname; } catch (_) {}

      let navText = '';
      if (selected?.steps?.length && /^(navigate to|open|go to)\s+/i.test(selected.steps[0])) {
        navText = selected.steps[0];
      } else if (selected?.module) {
        const tabName = currentPath.split('/').filter(Boolean).pop()?.replace(/[-_]/g, ' ') || 'Overview';
        navText = `We'll start in ${selected.module} > ${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`;
      } else {
        const tabName = currentPath.split('/').filter(Boolean).pop()?.replace(/[-_]/g, ' ') || 'Overview';
        navText = `First, let's head over to ${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`;
      }

      initialNav = {
        url: currentTabUrl,
        route: selected?.startRoute || currentPath,
        narration: navText,
        caption: navText
      };
    } catch (navErr) {
      console.warn('Could not build initialNav:', navErr);
    }
  }

  await send({type:'PANEL_UPDATE_SCRIPT',patch:{name:$('#scriptName').value.trim() || selected?.title || 'Untitled walkthrough',module:selected?.module || '',environmentName:envInfo.env}});
  const result = await send({type:'PANEL_START',tabId:tab.id,fresh:state.steps.length===0,initialNav});
  if (!result?.ok) return alert(result?.error || 'Could not start recording.');
  await loadState();
}

async function stopAndNarrate() {
  await send({type:'PANEL_STOP'});
  await loadState();
  if (!state.steps.length) return;
  $('#narrationStatus').hidden = false;
  $('#narrationStatus').textContent = 'Drafting narration…';
  const payload = state.steps.map((s) => ({index:s.index,action:s.action,key:s.key,route:s.route,target:s.target ? {role:s.target.role,name:s.target.name,label:s.target.label,text:s.target.text,placeholder:s.target.placeholder}:null}));
  const result = await send({type:'PANEL_AI_NARRATE',steps:payload,scriptName:$('#scriptName').value.trim()});
  if (result?.ok && Array.isArray(result.lines)) {
    for (let i=0;i<state.steps.length;i++) if (result.lines[i]) await send({type:'PANEL_UPDATE_STEP',index:state.steps[i].index,patch:{narration:result.lines[i],caption:result.lines[i]}});
    $('#narrationStatus').textContent = `Narration drafted automatically with ${result.model?.startsWith('gemini')?'Gemini fallback':'Claude'}. Review any line below before rendering.`;
  } else $('#narrationStatus').textContent = `Narration could not be drafted: ${result?.error || 'unknown error'}. Your recording is saved.`;
  await loadState();
}

function describe(step) {
  const t = step.target;
  if (step.action === 'navigate') {
    try { return new URL(step.value || step.url).pathname; } catch { return step.value || step.url || 'navigate'; }
  }
  if (step.action === 'press') return step.key || 'key press';
  const isDate = t?.datePicker || (t?.role === 'button' && t?.label && /\b(date|due|deadline)\b/i.test(t.label));
  const name = (isDate && t?.label) ? `${t.label} (date picker)` : (t?.label || t?.name || t?.placeholder || t?.text || t?.css || step.value || '');
  if (step.action === 'type') return `"${step.value || ''}" → ${t?.label || t?.placeholder || name || 'input'}`;
  return `${t?.role ? t.role + ' ' : ''}"${name || step.action}"${t?.inDialog ? ' (in dialog)' : ''}`;
}

let openStepIndex = null;

function renderSteps() {
  const root = $('#steps'); root.innerHTML = '';
  if (!state.steps.length) {
    root.innerHTML = '<div class="selected muted">Choose a workflow, click Record, or load a saved script to view and edit steps. Clicks, typing, navigation, and screenshots are captured live.</div>';
    return;
  }

  const recId = state.recordingId || state.script?.recording?.id || null;

  state.steps.forEach((step, i) => {
    const card = document.createElement('article');
    const isOpen = openStepIndex === i;
    card.className = 'step' + (isOpen ? ' open' : '') + (step.narration ? ' has-narration' : '');

    const targetDesc = describe(step);
    const actionClass = (step.action || 'click').toLowerCase();

    let thumbUrl = step.thumb || null;
    if (!thumbUrl && recId && step.media?.pre) {
      thumbUrl = `http://127.0.0.1:8787/capture/${recId}/slide/${step.media.pre}`;
    }

    card.innerHTML = `
      <div class="row">
        <span class="idx">${i + 1}</span>
        <span class="action ${actionClass}">${esc(step.action)}</span>
        <span class="target" title="${esc(targetDesc)}">${esc(targetDesc)}</span>
        ${step.narration ? '<span class="step-narration-icon" title="Has narration">🗣</span>' : ''}
        <span class="tools">
          <button class="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="down" title="Move down" ${i === state.steps.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="del" title="Delete step">✕</button>
        </span>
      </div>
      <div class="detail" ${isOpen ? '' : 'hidden'}>
        ${step.route ? `<div class="step-route-badge">Route: ${esc(step.route)}</div>` : ''}
        ${thumbUrl ? `<img class="thumb" src="${thumbUrl}" alt="Step ${i + 1} capture" loading="lazy" />` : ''}
        <label class="step-field-label">
          <span>Narration</span>
          <textarea class="narration" placeholder="What the voice says while this step happens">${esc(step.narration || '')}</textarea>
        </label>
        <label class="step-field-label">
          <span>Caption</span>
          <input class="caption" value="${esc(step.caption || '')}" placeholder="Defaults to narration" />
        </label>
      </div>
    `;

    card.querySelector('.row').onclick = (e) => {
      if (e.target.closest('.tools')) return;
      openStepIndex = (openStepIndex === i) ? null : i;
      renderSteps();
    };

    const update = (patch) => {
      Object.assign(step, patch);
      send({ type: 'PANEL_UPDATE_STEP', index: step.index, patch });
    };

    card.querySelector('.narration').onchange = (e) => update({ narration: e.target.value });
    card.querySelector('.caption').onchange = (e) => update({ caption: e.target.value });

    card.querySelector('.up').onclick = async (e) => {
      e.stopPropagation();
      await send({ type: 'PANEL_MOVE_STEP', index: step.index, dir: -1 });
      if (openStepIndex === i) openStepIndex = i - 1;
      else if (openStepIndex === i - 1) openStepIndex = i;
      await loadState();
    };

    card.querySelector('.down').onclick = async (e) => {
      e.stopPropagation();
      await send({ type: 'PANEL_MOVE_STEP', index: step.index, dir: 1 });
      if (openStepIndex === i) openStepIndex = i + 1;
      else if (openStepIndex === i + 1) openStepIndex = i;
      await loadState();
    };

    card.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      await send({ type: 'PANEL_DELETE_STEP', index: step.index });
      if (openStepIndex === i) openStepIndex = null;
      else if (openStepIndex > i) openStepIndex--;
      await loadState();
    };

    root.appendChild(card);
  });
}

function toScript() {
  const now = new Date().toISOString();
  const firstUrl = state.steps.find((s)=>s.url)?.url || null;
  const envName = state.script?.environmentName || (firstUrl?.includes('staging') ? 'staging' : 'prod');
  const humanTitle = $('#scriptName').value.trim() || 'untitled';
  return {
    version: 1,
    name: humanTitle,
    title: humanTitle,
    module: selected?.module || state.script?.module || '',
    workflowPlan: selected?.steps || state.script?.workflowPlan || [],
    createdAt: state.script?.createdAt || now,
    updatedAt: now,
    environment: { name: envName, startUrl: firstUrl },
    recording: { id: state.recordingId || state.script?.recording?.id, recordedAt: now },
    captionsFromNarration: false,
    steps: state.steps.map((s) => ({
      index: s.index,
      action: s.action,
      ...(s.key ? { key: s.key } : {}),
      ...(s.value !== undefined ? { value: s.value } : {}),
      target: s.target ? stripBbox(s.target) : undefined,
      route: s.route,
      url: s.url,
      dpr: s.dpr,
      ...(s.captureId ? { media: { pre: `step_${s.captureId}.png` } } : (s.media ? { media: s.media } : {})),
      narration: s.narration || '',
      caption: s.caption || s.narration || '',
      capture: s.capture !== false,
      motion: !!s.motion
    }))
  };
}
function stripBbox(target){const {bbox,viewport,...rest}=target;return {...rest,hint:{bbox,viewport}};}

async function renderVideo(mode = 'video') {
  if (!state.steps.length) return alert('Record at least one step first.');
  isRenderingActive = true;
  updateRenderButtons();
  $('#renderStatusRow').hidden = false;
  $('#renderLinks').hidden = true;
  $('#pylonArticleLink').hidden = true;
  $('#renderStatus').classList.remove('ready');
  $('#renderStatus').textContent = mode === 'both' ? 'Starting video render & Pylon article…' : 'Starting render…';

  const result = await send({ type: 'PANEL_RENDER', script: toScript(), mode });
  if (!result?.ok) {
    isRenderingActive = false;
    updateRenderButtons();
    $('#renderStatus').classList.remove('ready');
    $('#renderStatus').textContent = result?.error || 'Render failed';
    return;
  }
  clearInterval(renderTimer);
  renderTimer = setInterval(checkRender, 1500);
  checkRender();
}

async function checkRender() {
  const result = await send({ type: 'PANEL_RENDER_STATUS' });
  if (!result?.ok || result.phase === 'idle') {
    $('#renderStatusRow').hidden = true;
    $('#renderLinks').hidden = true;
    $('#pylonArticleLink').hidden = true;
    $('#renderStatus').classList.remove('ready');
    $('#renderStatus').textContent = '';
    isRenderingActive = false;
    updateRenderButtons();
    return;
  }

  $('#renderStatusRow').hidden = false;

  if (result.running) {
    const phaseNames = {
      replaying: 'Assembling slides…',
      assembling: 'Generating narration, captions and video…'
    };
    $('#renderStatus').classList.remove('ready');
    $('#renderStatus').textContent = phaseNames[result.phase] || result.phase || 'Rendering…';
    $('#renderLinks').hidden = true;
    isRenderingActive = true;
    updateRenderButtons();
    return;
  }

  // Not running
  isRenderingActive = false;
  updateRenderButtons();

  if (result.error) {
    $('#renderStatus').classList.remove('ready');
    $('#renderStatus').textContent = `Failed: ${result.error}`;
    $('#renderLinks').hidden = false;
    $('#pylonArticleLink').hidden = true;
    clearInterval(renderTimer);
    return;
  }

  const mode = result.mode || 'video';
  const pylon = result.pylon;

  if (mode === 'both' && pylon?.status === 'pending') {
    $('#renderStatus').classList.remove('ready');
    $('#renderStatus').textContent = '✓ MP4 ready · Drafting Pylon KB article…';
    $('#renderLinks').hidden = false;
    $('#pylonArticleLink').hidden = true;
    isRenderingActive = true;
    updateRenderButtons();
    return;
  }

  clearInterval(renderTimer);
  isRenderingActive = false;
  updateRenderButtons();
  $('#renderLinks').hidden = false;

  if (mode === 'both' && pylon?.status === 'done') {
    $('#renderStatus').textContent = '✓ MP4 & Pylon article ready';
    $('#renderStatus').classList.add('ready');
    if (pylon.url) {
      $('#pylonArticleLink').href = pylon.url;
      $('#pylonArticleLink').hidden = false;
    }

    const finishedTitle = $('#scriptName').value.trim() || selected?.title || state.script?.name || '';
    if (finishedTitle) {
      manualLinks.add(finishedTitle);
      chrome.storage.local.set({ manualLinks: [...manualLinks] });
    }
    refreshAll().catch(() => {});
  } else if (mode === 'both' && pylon?.status === 'failed') {
    $('#renderStatus').textContent = `✓ MP4 ready (Pylon article failed: ${pylon.error || 'error'})`;
    $('#renderStatus').classList.add('ready');
    $('#pylonArticleLink').hidden = true;
  } else {
    $('#renderStatus').textContent = '✓ MP4 ready';
    $('#renderStatus').classList.add('ready');
    $('#pylonArticleLink').hidden = true;
  }
}

function exportScript(){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(toScript(),null,2)],{type:'application/json'}));a.download=`${slug(toScript().name)||'walkthrough'}.script.json`;a.click();URL.revokeObjectURL(a.href);}

async function resetRecordingSession() {
  clearInterval(renderTimer);
  renderTimer = null;
  isRenderingActive = false;
  selected = null;
  activeRecordAiPlan = null;
  activeViewPlanModal = null;

  // 1. Immediately reset DOM inputs, notices, and modal states
  $('#selectedWorkflow').hidden = true;
  $('#selectedWorkflow').innerHTML = '';
  $('#scriptName').value = '';
  $('#narrationStatus').hidden = true;
  $('#narrationStatus').textContent = '';
  $('#renderStatusRow').hidden = true;
  $('#renderLinks').hidden = true;
  $('#pylonArticleLink').hidden = true;
  $('#renderStatus').classList.remove('ready');
  $('#renderStatus').textContent = '';
  $('#stepCount').textContent = '';
  $('#stepCount').hidden = true;
  $('#steps').innerHTML = '';
  closeRecordStartModal();

  // 2. Clear local in-memory state and redraw empty list immediately
  state.steps = [];
  state.script = { name: '' };
  state.recordingId = null;
  state.recording = false;
  renderSteps();
  updateRenderButtons();
  updateRecordingButtons();

  // 3. Clear background worker, bridge render state, and draft storage
  try { await send({ type: 'PANEL_CLEAR' }); } catch (_) {}
  try { await send({ type: 'PANEL_RENDER_CLEAR' }); } catch (_) {}
  try { await chrome.storage.local.remove('kbDraft'); } catch (_) {}

  // 4. Reload verified state
  await loadState();
}

function formatHumanTitle(str) {
  if (!str) return 'Walkthrough';
  let t = String(str).trim();
  if (t.includes('-') && (!t.includes(' ') || t.startsWith('How-to-') || t.startsWith('how-to-'))) {
    t = t.replace(/^How-to-/i, 'How to ').replace(/-/g, ' ');
  } else {
    t = t.replace(/^How-to-/i, 'How to ');
  }
  return t.replace(/\s+/g, ' ').trim();
}

let savedScripts = [];
let savedOpenModules = new Set(); // Collapsed by default

const SAVED_MODULE_ORDER = [
  'Testing program',
  'People oversight',
  'Branches',
  'Communications',
  'Marketing',
  'Account surveillance'
];

function resolveScriptModule(script) {
  if (script.module) {
    const m = SAVED_MODULE_ORDER.find((a) => a.toLowerCase() === script.module.toLowerCase());
    if (m) return m;
    return script.module;
  }
  const title = (script.title || script.name || '').toLowerCase();
  for (const group of catalog.modules || []) {
    for (const wf of group.workflows || []) {
      if (wf.title.toLowerCase() === title || slug(wf.title) === slug(script.name)) {
        return group.module;
      }
    }
  }
  if (title.includes('branch')) return 'Branches';
  if (title.includes('employee') || title.includes('people')) return 'People oversight';
  if (title.includes('test') || title.includes('policy') || title.includes('risk') || title.includes('control')) return 'Testing program';
  if (title.includes('communication') || title.includes('email') || title.includes('message')) return 'Communications';
  if (title.includes('marketing') || title.includes('campaign')) return 'Marketing';
  if (title.includes('surveillance') || title.includes('alert') || title.includes('trade')) return 'Account surveillance';
  return 'Other';
}

async function openSavedScriptsModal() {
  $('#savedScriptsModal').hidden = false;
  await loadSavedScripts();
}

function closeSavedScriptsModal() {
  $('#savedScriptsModal').hidden = true;
}

async function loadSavedScripts() {
  const listEl = $('#savedScriptsList');
  listEl.innerHTML = '<p class="muted small" style="padding: 16px; text-align: center;">Loading saved walkthroughs…</p>';
  const r = await send({ type: 'PANEL_LIBRARY_LIST' });
  if (!r?.ok) {
    listEl.innerHTML = `<p class="muted small" style="padding: 16px; color: var(--red); text-align: center;">${esc(r?.error || 'Failed to load saved walkthroughs.')}</p>`;
    return;
  }
  savedScripts = r.items || [];
  $('#savedScriptsCount').textContent = savedScripts.length;
  renderSavedScripts();
}

function renderSavedScripts() {
  const listEl = $('#savedScriptsList');
  listEl.innerHTML = '';
  const q = $('#savedScriptsSearch').value.trim().toLowerCase();
  const filtered = savedScripts.filter((s) => {
    if (!q) return true;
    const title = (s.title || s.name || '').toLowerCase();
    const mod = (s.module || '').toLowerCase();
    return title.includes(q) || mod.includes(q);
  });

  if (!filtered.length) {
    listEl.innerHTML = `<p class="muted small" style="padding: 20px; text-align: center;">${q ? 'No walkthroughs matching "' + esc(q) + '"' : 'No saved walkthroughs yet.'}</p>`;
    return;
  }

  // Group by module
  const byModule = new Map();
  for (const it of filtered) {
    const mod = resolveScriptModule(it);
    if (!byModule.has(mod)) byModule.set(mod, []);
    byModule.get(mod).push(it);
  }

  // Sort modules by canonical order
  const sortedModules = [...byModule.keys()].sort((a, b) => {
    const ia = SAVED_MODULE_ORDER.indexOf(a);
    const ib = SAVED_MODULE_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  for (const mod of sortedModules) {
    const items = byModule.get(mod);
    const isOpen = q ? true : savedOpenModules.has(mod);

    const section = document.createElement('section');
    section.className = 'saved-module-section';

    const isKnownModule = SAVED_MODULE_ORDER.includes(mod);
    const iconHtml = isKnownModule ? `<img class="module-icon" src="${moduleIconPath(mod)}" alt="" />` : '';

    const header = document.createElement('div');
    header.className = 'saved-module-header' + (isOpen ? '' : ' collapsed');
    header.innerHTML = `
      <span class="saved-caret">${isOpen ? '▾' : '▸'}</span>
      ${iconHtml}
      <span class="saved-module-title">${esc(mod)}</span>
      <span class="saved-module-count">${items.length}</span>
    `;

    header.onclick = () => {
      if (savedOpenModules.has(mod)) savedOpenModules.delete(mod);
      else savedOpenModules.add(mod);
      renderSavedScripts();
    };
    section.appendChild(header);

    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'saved-module-items';
    if (!isOpen) itemsContainer.hidden = true;

    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'saved-script-card';
      const humanTitle = it.title || formatHumanTitle(it.name);
      const when = it.updated_at ? new Date(it.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
      const mp4Badge = it.mp4_ready ? '<span class="mp4-badge">🎬 MP4 ready</span>' : '';

      card.innerHTML = `
        <div class="saved-script-top">
          <div class="saved-script-title">${esc(humanTitle)}</div>
          ${mp4Badge}
        </div>
        <div class="saved-script-meta">
          <span>${it.step_count} step${it.step_count === 1 ? '' : 's'}</span> ·
          <span>${when}</span>
          ${it.updated_by && it.updated_by !== 'local' ? `<span>· by ${esc(it.updated_by)}</span>` : ''}
        </div>
        <div class="saved-script-actions">
          <button class="btn-del-script" type="button" title="Delete this script">🗑</button>
          <button class="btn-open-script" type="button">Open & Edit</button>
        </div>
      `;

      card.querySelector('.btn-open-script').onclick = () => openScript(it.name);
      card.querySelector('.btn-del-script').onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${humanTitle}" from saved scripts?`)) return;
        await send({ type: 'PANEL_LIBRARY_DELETE', name: it.name });
        await loadSavedScripts();
      };

      itemsContainer.appendChild(card);
    }

    section.appendChild(itemsContainer);
    listEl.appendChild(section);
  }
}

async function openScript(name) {
  if (state.steps.length && !confirm(`Replace the current steps in the editor with "${name}"?`)) return;
  const r = await send({ type: 'PANEL_LIBRARY_GET', name });
  if (!r?.ok || !r.item?.script) return alert(r?.error || 'Could not load script.');
  const script = r.item.script;
  await send({ type: 'PANEL_LOAD_SCRIPT', script });
  closeSavedScriptsModal();
  await loadState();
  const humanTitle = script.title || formatHumanTitle(script.name) || '';
  $('#scriptName').value = humanTitle;
  if (script.module) {
    selected = {
      module: script.module,
      title: humanTitle,
      steps: script.workflowPlan || []
    };
    if (script.workflowPlan?.length) {
      renderPlanCard(script.module, { title: humanTitle }, script.workflowPlan);
    } else {
      $('#selectedWorkflow').hidden = false;
      $('#selectedWorkflow').className = 'selected';
      $('#selectedWorkflow').innerHTML = `<strong>${esc(selected.title)}</strong><span class="muted">${esc(selected.module)}</span>`;
    }
  }
  switchView('recording');
}

$('#search').oninput=renderModules;
$('#scanBtn').onclick = async () => {
  if (!confirm('Run a new Gemini codebase scan through the Hadrius MCP? This can take several minutes.')) return;
  updateScanStatus({ running: true, log: ['Starting codebase scan via Hadrius MCP…'] });
  try {
    await api('/workflows', { method: 'POST' });
    pollScan();
  } catch (e) {
    alert(e.message);
    updateScanStatus({ running: false });
  }
};
$('#recordBtn').onclick = startRecording;
$('#openSavedBtn').onclick = openSavedScriptsModal;
$('#closeSavedModalBtn').onclick = closeSavedScriptsModal;
$('#savedScriptsSearch').oninput = renderSavedScripts;
$('#savedScriptsModal').onclick = (e) => {
  if (e.target.id === 'savedScriptsModal') closeSavedScriptsModal();
};

// Record Start Prompt Modal
$('#closeRecordModalBtn').onclick = closeRecordStartModal;
$('#recordStartModal').onclick = (e) => {
  if (e.target.id === 'recordStartModal') closeRecordStartModal();
};
$('#recordModalCurrentPlanBtn').onclick = () => {
  closeRecordStartModal();
  startRecordingDirectly();
};
$('#recordModuleSelect').onchange = (e) => {
  renderRecordModalOpportunities(e.target.value);
};
$('#recordNowBtn').onclick = recordNow;
$('#recordAiGenerateBtn').onclick = () => generateRecordAiPlan();
$('#recordAiPromptInput').onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    generateRecordAiPlan();
  }
};
$('#recordPlanIterateBtn').onclick = refineRecordAiPlan;
$('#recordPlanClarifyInput').onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    refineRecordAiPlan();
  }
};
$('#recordPlanAcceptAndRecordBtn').onclick = acceptAndRecordPlan;
$('#recordPlanSaveLaterBtn').onclick = saveRecordPlanLater;
$('#recordPlanDismissBtn').onclick = closeRecordStartModal;

// View & Enhance Plan Modal
$('#closeViewPlanModalBtn').onclick = closeViewPlanModal;
$('#viewPlanAiRecordBtn').onclick = () => {
  if (!activeViewPlanModal) return;
  // Prefer the full workflow object: it carries the grounding record the auto-record gate needs.
  const wf = activeViewPlanModal.enhancedPlan || activeViewPlanModal.originalWorkflow || activeViewPlanModal.currentPlan;
  startAiBrowserRecording(activeViewPlanModal.module, wf);
};
$('#viewPlanEnhanceBtn').onclick = enhancePlanInModal;
$('#viewPlanIterateBtn').onclick = refinePlanInModal;
$('#viewPlanAcceptBtn').onclick = acceptEnhancedPlanInModal;
$('#viewPlanDiscardBtn').onclick = discardEnhancedPlanInModal;
$('#viewPlanModal').onclick = (e) => {
  if (e.target.id === 'viewPlanModal') closeViewPlanModal();
};
$('#viewPlanClarifyInput').onkeydown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    refinePlanInModal();
  }
};
$('#viewPlanAiPromptInput').onkeydown = (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    enhancePlanInModal();
  }
};

const fileInput = $('#scriptFileInput');
if (fileInput) {
  fileInput.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const script = JSON.parse(text);
      if (!Array.isArray(script.steps)) throw new Error('Invalid script file: no steps array');
      await send({ type: 'PANEL_LOAD_SCRIPT', script });
      closeSavedScriptsModal();
      await loadState();
      $('#scriptName').value = script.title || formatHumanTitle(script.name) || '';
      switchView('recording');
    } catch (err) {
      alert('Failed to import script: ' + err.message);
    } finally {
      e.target.value = '';
    }
  };
}

$('#stopBtn').onclick = stopAndNarrate;
$('#bannerStopBtn').onclick = stopAndNarrate;
$('#cancelRecordBtn').onclick = cancelRecording;
$('#bannerCancelBtn').onclick = cancelRecording;
$('#clearBtn').onclick = async () => { if (confirm('Clear this recording?')) { await resetRecordingSession(); } };
$('#scriptName').onchange = (e) => send({ type: 'PANEL_UPDATE_SCRIPT', patch: { name: e.target.value } });
$('#renderBtn').onclick = () => renderVideo('video');
$('#renderBothBtn').onclick = () => renderVideo('both');
$('#downloadBtn').onclick = exportScript;

$('#viewFinderLink').onclick = async (e) => {
  e.preventDefault();
  await send({ type: 'PANEL_RENDER_OPEN' });
};

$('#pylonArticleLink').onclick = (e) => {
  e.preventDefault();
  const url = $('#pylonArticleLink').href;
  if (url) chrome.tabs.create({ url });
};

$('#dismissResetBtn').onclick = resetRecordingSession;

$('#refreshWorkflowsBtn').onclick = async () => {
  const btn = $('#refreshWorkflowsBtn');
  btn.classList.add('refreshing');
  try {
    await refreshAll();
  } finally {
    setTimeout(() => btn.classList.remove('refreshing'), 400);
  }
};

$('#pylonSearch').oninput = renderPylonArticles;

$('#refreshPylonBtn').onclick = async () => {
  const btn = $('#refreshPylonBtn');
  btn.classList.add('refreshing');
  try {
    await refreshAll();
  } finally {
    setTimeout(() => btn.classList.remove('refreshing'), 400);
  }
};

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

async function takeUiScreenshot() {
  const camBtn = $('#floatingCameraBtn');
  if (camBtn) camBtn.style.display = 'none';

  const t = $('#toast');
  if (t) t.hidden = true;

  let shutter = document.getElementById('cameraShutterFlash');
  if (!shutter) {
    shutter = document.createElement('div');
    shutter.id = 'cameraShutterFlash';
    shutter.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#fff;opacity:0;pointer-events:none;z-index:999999;transition:opacity 0.15s ease-out;';
    document.body.appendChild(shutter);
  }

  try {
    if (typeof html2canvas === 'undefined') {
      throw new Error('html2canvas is not loaded');
    }

    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 40)));

    const canvas = await html2canvas(document.documentElement, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: '#f4f7f5',
      ignoreElements: (el) => el.id === 'floatingCameraBtn' || el.id === 'cameraShutterFlash' || el.id === 'toast'
    });

    shutter.style.opacity = '0.6';
    setTimeout(() => { shutter.style.opacity = '0'; }, 150);

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `hadrius-studio-ui-${timestamp}.png`;

    canvas.toBlob(async (blob) => {
      if (!blob) throw new Error('Failed to create image blob');
      let copied = false;
      try {
        if (navigator.clipboard && window.ClipboardItem) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          copied = true;
        }
      } catch (clipErr) {
        console.warn('Clipboard write failed:', clipErr);
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);

      toast(copied ? '📸 Screenshot copied to clipboard & downloaded!' : '📸 Screenshot downloaded!');
    }, 'image/png');
  } catch (err) {
    console.error('UI screenshot failed:', err);
    toast(`Screenshot failed: ${err.message}`);
  } finally {
    if (camBtn) camBtn.style.display = 'flex';
  }
}

const camBtn = $('#floatingCameraBtn');
if (camBtn) {
  camBtn.addEventListener('click', (e) => {
    e.preventDefault();
    takeUiScreenshot();
  });
}

window.addEventListener('keydown', (e) => {
  if (e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    takeUiScreenshot();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'KB_STEPS_UPDATED') loadState();
  if (message.type === 'KB_RECORDING') {
    state.recording = !!message.recording;
    updateRecordingButtons();
  }
});

// Claude CLI / hadrius-codebase MCP indicators in the header — every AI feature (narration, plan
// grounding, recording decisions) depends on both, and each expires silently (separate OAuth
// sessions), so a red dot with the exact terminal fix on hover beats discovering it mid-recording.
function renderToolStatus(dotEl, tooltipEl, label, state) {
  dotEl.classList.remove('ok', 'bad');
  if (state.connected) {
    dotEl.classList.add('ok');
    tooltipEl.textContent = `${label}: connected.`;
  } else {
    dotEl.classList.add('bad');
    tooltipEl.textContent = '';
    tooltipEl.append((state.detail || `${label} is not connected.`) + '\n');
    const code = document.createElement('code');
    code.textContent = state.fixCommand;
    tooltipEl.append(code);
  }
}
async function refreshToolStatus(fresh) {
  try {
    const s = await api(`/status/tools${fresh ? '?fresh=1' : ''}`);
    renderToolStatus($('#claudeDot'), $('#claudeTooltip'), 'Claude', s.claude);
    renderToolStatus($('#codebaseDot'), $('#codebaseTooltip'), 'Codebase', s.codebase);
  } catch (_) { /* bridge unreachable — leave the bridgeDot check below to surface that */ }
}

(async()=>{try{const health=await api('/health');if(health.product==='hadrius-studio-beta')$('#bridgeDot').classList.add('ok');else throw new Error('The bridge on port 8787 is not Hadrius Studio Lite.');}catch(e){$('#syncStatus').textContent=`${e.message} Stop it and run npm start from hadrius-studio-beta.`;}await initManualLinks();await loadState();await refreshAll();checkRender();refreshToolStatus(true);setInterval(()=>refreshToolStatus(false),45000);})();
