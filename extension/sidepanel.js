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
  $('#workflowsView').hidden = name !== 'workflows';
  $('#recordingView').hidden = name !== 'recording';
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === name));
}
$$('.tab').forEach((tab) => tab.onclick = () => switchView(tab.dataset.view));

async function refreshAll() {
  const [workflowResult, pylonResult] = await Promise.allSettled([api('/workflows'), api('/pylon/articles')]);
  if (workflowResult.status === 'fulfilled') catalog = workflowResult.value;
  if (pylonResult.status === 'fulfilled') pylon = pylonResult.value;
  const workflowOk = workflowResult.status === 'fulfilled';
  const pylonOk = pylonResult.status === 'fulfilled';
  if (workflowOk && pylonOk) {
    $('#syncStatus').textContent = `Live Pylon sync · ${new Date(pylon.syncedAt).toLocaleTimeString()} · ${catalog.modules.reduce((n,m)=>n+m.workflows.length,0)} workflows`;
  } else if (!workflowOk) {
    $('#syncStatus').textContent = `Workflows unavailable: ${workflowResult.reason?.message || 'bridge error'}. Stop the old bridge and run npm start from hadrius-studio-beta.`;
  } else {
    $('#syncStatus').textContent = `Workflow plans loaded · Pylon unavailable: ${pylonResult.reason?.message || 'bridge error'}`;
  }
  renderModules();
}

function normalizeTitle(value) { return slug(value).replace(/^(how-to|how-do-i)-/,''); }
function articleMatches(workflow, article) {
  const a = normalizeTitle(article.title), w = normalizeTitle(workflow.title);
  return a === w || a.includes(w) || w.includes(a);
}

function renderModules() {
  const q = $('#search').value.trim().toLowerCase();
  $('#modules').innerHTML = '';
  for (const group of catalog.modules || []) {
    const articles = pylon.modules?.[group.module]?.articles || [];
    const workflows = (group.workflows || []).filter((w) => !q || `${w.title} ${w.purpose}`.toLowerCase().includes(q));
    const visibleArticles = articles.filter((a) => !q || a.title.toLowerCase().includes(q));
    if (q && !workflows.length && !visibleArticles.length) continue;
    const section = document.createElement('section'); section.className = 'module';
    section.innerHTML = `<div class="module-head"><h2>${esc(group.module)}</h2><span class="counts">${workflows.length} workflows · ${visibleArticles.length} articles</span></div><div class="module-body"></div>`;
    const body = section.querySelector('.module-body');
    body.innerHTML = '<div class="subhead">Recording opportunities</div>';
    for (const workflow of workflows) {
      const match = articles.find((article) => articleMatches(workflow, article));
      const item = document.createElement('div'); item.className = 'item';
      item.innerHTML = `<div class="item-title">${esc(workflow.title)}${match ? '<span class="badge published">Article linked</span>' : '<span class="badge">Needs article</span>'}</div><p>${esc(workflow.purpose)}</p><div class="item-actions"><button class="primary choose">Record this</button><button class="secondary plan">View plan</button>${match ? `<button class="secondary articleLink">Open article ↗</button>` : ''}</div>`;
      item.querySelector('.choose').onclick = () => chooseWorkflow(group.module, workflow);
      item.querySelector('.plan').onclick = () => chooseWorkflow(group.module, workflow, false);
      if (match) item.querySelector('.articleLink').onclick = () => chrome.tabs.create({url:match.url});
      body.appendChild(item);
    }
    body.insertAdjacentHTML('beforeend','<div class="subhead">Pylon articles</div>');
    if (!visibleArticles.length) body.insertAdjacentHTML('beforeend','<div class="item muted">No articles currently in this collection.</div>');
    for (const article of visibleArticles) {
      const item = document.createElement('div'); item.className = 'item article';
      item.innerHTML = `<div class="item-title"><a href="#">${esc(article.title)}</a><span class="badge ${article.isPublished?'published':''}">${article.isPublished?'Published':'Draft'}</span></div>`;
      item.querySelector('a').onclick = (event) => { event.preventDefault(); chrome.tabs.create({url:article.url}); };
      body.appendChild(item);
    }
    const moduleBody = section.querySelector('.module-body');
    section.querySelector('.module-head').onclick = () => moduleBody.hidden = !moduleBody.hidden;
    $('#modules').appendChild(section);
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

async function chooseWorkflow(module, workflow, start=true) {
  const steps = resolveSteps(module, workflow);
  selected = { module, ...workflow, steps };
  $('#selectedWorkflow').hidden = false;
  $('#selectedWorkflow').innerHTML = `<h2>${esc(workflow.title)}</h2><p class="muted">${esc(module)} · Follow this plan while recording:</p><ol>${steps.map((s)=>`<li>${esc(s)}</li>`).join('')}</ol>`;
  $('#scriptName').value = workflow.title;
  await send({type:'PANEL_UPDATE_SCRIPT',patch:{name:workflow.title,module,workflowPlan:steps,sourceFiles:workflow.sources || []}});
  switchView('recording');
  if (start) await startRecording();
}

async function loadState() {
  state = await send({type:'PANEL_GET_STATE'});
  $('#stepCount').textContent = state.steps.length;
  $('#recordBtn').hidden = state.recording;
  $('#stopBtn').hidden = !state.recording;
  if (!$('#scriptName').value) $('#scriptName').value = state.script?.name || '';
  renderSteps();
}

async function startRecording() {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return alert('Open PROD or Staging in the active tab before recording.');
  const env = document.querySelector('input[name=environment]:checked').value;

  if (selected?.startRoute && tab.url) {
    try {
      const currentUrl = new URL(tab.url);
      const isHadrius = currentUrl.hostname.endsWith('hadrius.com') || currentUrl.hostname === 'localhost';
      const targetOrigin = isHadrius ? currentUrl.origin : (env === 'staging' ? 'https://staging.hadrius.com' : 'https://app.hadrius.com');
      const targetUrl = new URL(selected.startRoute, targetOrigin);

      if (currentUrl.searchParams.has('company_id') && !targetUrl.searchParams.has('company_id')) {
        targetUrl.searchParams.set('company_id', currentUrl.searchParams.get('company_id'));
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
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch (err) {
      console.warn('Auto-navigation failed:', err);
    }
  }

  await send({type:'PANEL_UPDATE_SCRIPT',patch:{name:$('#scriptName').value.trim() || selected?.title || 'Untitled walkthrough',module:selected?.module || '',environmentName:env}});
  const result = await send({type:'PANEL_START',tabId:tab.id,fresh:state.steps.length===0});
  if (!result?.ok) return alert(result?.error || 'Could not start recording.');
  await loadState();
}

async function stopAndNarrate() {
  await send({type:'PANEL_STOP'});
  await loadState();
  if (!state.steps.length) return;
  $('#narrationStatus').hidden = false;
  $('#narrationStatus').textContent = 'Drafting narration with Gemini…';
  const payload = state.steps.map((s) => ({index:s.index,action:s.action,key:s.key,route:s.route,target:s.target ? {role:s.target.role,name:s.target.name,label:s.target.label,text:s.target.text,placeholder:s.target.placeholder}:null}));
  const result = await send({type:'PANEL_AI_NARRATE',steps:payload,scriptName:$('#scriptName').value.trim()});
  if (result?.ok && Array.isArray(result.lines)) {
    for (let i=0;i<state.steps.length;i++) if (result.lines[i]) await send({type:'PANEL_UPDATE_STEP',index:state.steps[i].index,patch:{narration:result.lines[i],caption:result.lines[i]}});
    $('#narrationStatus').textContent = `Narration drafted automatically with ${result.model?.startsWith('gemini')?'Gemini':'Claude fallback'}. Review any line below before rendering.`;
  } else $('#narrationStatus').textContent = `Narration could not be drafted: ${result?.error || 'unknown error'}. Your recording is saved.`;
  await loadState();
}

function renderSteps() {
  const root = $('#steps'); root.innerHTML = '';
  if (!state.steps.length) { root.innerHTML = '<div class="selected muted">Choose a workflow, click Record, and perform it in Hadrius. Clicks, typing, navigation, and screenshots are captured live.</div>'; return; }
  state.steps.forEach((step,i) => {
    const target = step.target?.label || step.target?.name || step.target?.text || step.target?.placeholder || step.key || '';
    const card = document.createElement('article'); card.className='step';
    card.innerHTML = `<div class="step-head"><span class="step-no">${i+1}</span><span class="step-action">${esc(step.action)} ${esc(target)}</span><span class="step-route">${esc(step.route || '')}</span></div><div class="step-grid"><textarea class="narration" placeholder="Narration">${esc(step.narration || '')}</textarea><input class="caption" value="${esc(step.caption || '')}" placeholder="On-screen caption"></div><div class="step-tools"><button class="secondary up" ${i===0?'disabled':''}>↑</button><button class="secondary down" ${i===state.steps.length-1?'disabled':''}>↓</button><button class="secondary del">Delete</button></div>`;
    const update = (patch) => { Object.assign(step,patch); send({type:'PANEL_UPDATE_STEP',index:step.index,patch}); };
    card.querySelector('.narration').onchange = (e) => update({narration:e.target.value});
    card.querySelector('.caption').onchange = (e) => update({caption:e.target.value});
    card.querySelector('.up').onclick = async()=>{await send({type:'PANEL_MOVE_STEP',index:step.index,dir:-1});await loadState();};
    card.querySelector('.down').onclick = async()=>{await send({type:'PANEL_MOVE_STEP',index:step.index,dir:1});await loadState();};
    card.querySelector('.del').onclick = async()=>{await send({type:'PANEL_DELETE_STEP',index:step.index});await loadState();};
    root.appendChild(card);
  });
}

function toScript() {
  const now = new Date().toISOString();
  const firstUrl = state.steps.find((s)=>s.url)?.url || null;
  return {version:1,name:$('#scriptName').value.trim() || 'untitled',module:selected?.module || state.script?.module || '',workflowPlan:selected?.steps || state.script?.workflowPlan || [],createdAt:state.script?.createdAt || now,updatedAt:now,environment:{name:document.querySelector('input[name=environment]:checked').value,startUrl:firstUrl},recording:{id:state.recordingId,recordedAt:now},captionsFromNarration:false,steps:state.steps.map((s)=>({index:s.index,action:s.action,...(s.key?{key:s.key}:{}),...(s.value!==undefined?{value:s.value}:{}),target:s.target?stripBbox(s.target):undefined,route:s.route,url:s.url,dpr:s.dpr,...(s.captureId?{media:{pre:`step_${s.captureId}.png`}}:{}),narration:s.narration||'',caption:s.caption||s.narration||'',capture:s.capture!==false,motion:!!s.motion}))};
}
function stripBbox(target){const {bbox,viewport,...rest}=target;return {...rest,hint:{bbox,viewport}};}

async function renderVideo() {
  if (!state.steps.length) return alert('Record at least one step first.');
  $('#renderStatus').textContent='Starting render…';
  const result=await send({type:'PANEL_RENDER',script:toScript(),mode:'video'});
  if (!result?.ok) return $('#renderStatus').textContent=result?.error || 'Render failed';
  clearInterval(renderTimer); renderTimer=setInterval(checkRender,1500); checkRender();
}
async function checkRender(){const result=await send({type:'PANEL_RENDER_STATUS'});if(!result?.ok)return;$('#renderStatus').textContent=result.running?(result.phase||'Rendering…'):(result.error?`Failed: ${result.error}`:'MP4 ready');if(!result.running)clearInterval(renderTimer);}
function exportScript(){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(toScript(),null,2)],{type:'application/json'}));a.download=`${slug(toScript().name)||'walkthrough'}.script.json`;a.click();URL.revokeObjectURL(a.href);}

$('#search').oninput=renderModules;
$('#scanBtn').onclick=async()=>{if(!confirm('Run a new Gemini codebase scan through the Hadrius MCP? This can take several minutes.'))return;$('#scanBtn').disabled=true;try{await api('/workflows',{method:'POST'});$('#syncStatus').textContent='Gemini is scanning the Hadrius codebase through the MCP. Only source-evidenced plans will be saved.';pollScan();}catch(e){alert(e.message);$('#scanBtn').disabled=false;}};
async function pollScan(){try{const result=await api('/workflows');catalog=result;if(result.scan?.running)return setTimeout(pollScan,2500);$('#scanBtn').disabled=false;await refreshAll();if(result.scan?.error)alert(result.scan.error);}catch(e){$('#scanBtn').disabled=false;}}
$('#recordBtn').onclick=startRecording;$('#stopBtn').onclick=stopAndNarrate;
$('#clearBtn').onclick=async()=>{if(confirm('Clear this recording?')){await send({type:'PANEL_CLEAR'});selected=null;$('#selectedWorkflow').hidden=true;await loadState();}};
$('#scriptName').onchange=(e)=>send({type:'PANEL_UPDATE_SCRIPT',patch:{name:e.target.value}});
$('#renderBtn').onclick=renderVideo;$('#downloadBtn').onclick=exportScript;
chrome.runtime.onMessage.addListener((message)=>{if(message.type==='KB_STEPS_UPDATED')loadState();});

(async()=>{try{const health=await api('/health');if(health.product==='hadrius-studio-beta')$('#bridgeDot').classList.add('ok');else throw new Error('The bridge on port 8787 is not Hadrius Studio Lite.');}catch(e){$('#syncStatus').textContent=`${e.message} Stop it and run npm start from hadrius-studio-beta.`;}await loadState();await refreshAll();checkRender();setInterval(refreshAll,60000);})();
