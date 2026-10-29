// Read-only recapture of an existing walkthrough script, for drift detection.
// Import-safe: no side effects at import (Playwright is imported lazily inside captureRun).
// It never writes to scripts/ or out/, never types into the page, never reads .env.
//
// CLI:
//   node tools/drift/capture.mjs --script scripts/X.script.json --out /abs/NEW-run-directory \
//     [--profile /abs/.browser-profile-drift]
// Default profile: <repo>/.browser-profile-drift, signed in unattended by academy-login.mjs
// (ensureAcademySession) before capturing; any non-success session status fails closed.
// The run directory must not exist. Writes run.json, step-NN-today.png, requests.json.
import {mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {resolve,join,basename,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {ensureAcademySession} from './academy-login.mjs';

export const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
export const DEFAULT_PROFILE=join(REPO,'.browser-profile-drift');
export const SESSION_OK=Object.freeze(['already_signed_in','signed_in']);
export const VIEWPORT=Object.freeze({width:1600,height:900});
export const LIMITS=Object.freeze({stepMs:60_000,totalMs:5*60_000,settleMs:1500,idleMs:15_000,manualLoginMs:10*60_000,loadingWaitMs:15_000});
export const APP_BASE='https://app.hadrius.com';
// Same regex as tools/ai-record.mjs (LOGIN_PATH_RE); duplicated because importing ai-record pulls in
// coverage-scan/upload-fixtures.
export const LOGIN_PATH_RE=/\/(login|log-in|signin|sign-in|auth|sso|oauth|callback|mfa|verify|password)(\/|$|\?)/i;

const clean=(s)=>String(s??'').replace(/\s+/g,' ').trim();
const DATE_SRC=String.raw`\b(?:\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4})\b`;
const REL_SRC=String.raw`\b\d+\s+(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago\b|\bjust now\b|\byesterday\b`;
const TIME_SRC=String.raw`\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b`;
export const DYNAMIC_SOURCES=Object.freeze({date:DATE_SRC,relative_time:REL_SRC,time:TIME_SRC});
export function dynamicTextKind(text){for(const [k,src] of Object.entries(DYNAMIC_SOURCES))if(new RegExp(src,'i').test(text??''))return k;return null;}
export function normalizeName(s){return clean(s).toLowerCase().replace(new RegExp(DATE_SRC,'gi'),'<date>').replace(new RegExp(TIME_SRC,'gi'),'<time>').replace(new RegExp(REL_SRC,'gi'),'<rel>');}

// ---------- request guard ----------
const ABORT_PATH_RE=/(create|update|delete|archive|mutation|mutate|remove|destroy|upsert)/i;
const READ_PATH_RE=/(^|[/_-])(search|list|query|filter|count|lookup|batch-get|get)([/_.-]|$)/i;
// POSTs the app uses purely to read, each confirmed in hadrius_backend. Library permissions preview:
// POST /api/company/<id>/library/audience/compute/ -> document_library/views_audience.py
// post_compute_library_audience (@non_mutating, @no_audit_trail, validated_api read_only=True).
const KNOWN_READ_POST_RE=/^\/api\/company\/\d+\/library\/audience\/compute\/?$/;
// The live app's backend is hadriusapi.com (observed), the SPA is app.hadrius.com.
const isAppHost=(h)=>['hadrius.com','hadriusapi.com'].some(d=>h===d||h.endsWith('.'+d));
const isCognitoHost=(h)=>/^cognito-(idp|identity)\.[a-z0-9-]+\.amazonaws\.com$/.test(h);
function header(headers,name){if(!headers)return undefined;for(const [k,v] of Object.entries(headers))if(k.toLowerCase()===name)return v;return undefined;}
function graphqlOps(postData){let body;try{body=JSON.parse(postData??'');}catch{return null;}const list=Array.isArray(body)?body:[body];const ops=[];
  for(const b of list){if(!b||typeof b!=='object'||typeof b.query!=='string')return null;ops.push(b.query.replace(/#[^\n]*/g,'').trim());}return ops;}
/** -> {decision:'allow'|'allow_logged'|'block'|'abort', reason}. mode 'manual_login' is used only while a
 *  human signs in by hand in the visible window: Cognito auth flows pass; app writes are still blocked.
 *  mode 'auto_login' (academy-login.mjs inside capture): Cognito auth + hosted-UI POSTs pass, all other
 *  third-party POSTs (analytics, Sentry) and app writes are blocked. */
// Analytics beacons the app fires on every page view (observed: 4 per pilot recapture). Still ABORTED at the
// network layer (never reach the server) but they do not fail the video; everything else unknown does.
export const TELEMETRY_PATH_RE=/^\/api\/users\/analytics\/\d+\/track-event\/?$/;
const allowMatch=(entry,{method,host,path,postData})=>{if(typeof entry==='function')return entry({method,host,path,postData});
  if(!entry||typeof entry!=='object')return false;if(entry.method&&String(entry.method).toUpperCase()!==method)return false;
  if(entry.host&&entry.host!==host)return false;if(entry.path!=null&&entry.path!==path)return false;if(entry.pathRe&&!new RegExp(entry.pathRe).test(path))return false;
  return entry.path!=null||!!entry.pathRe;};
export function classifyRequest({method,url,postData,headers},{mode='recapture',allow=[]}={}){
  const m=String(method||'GET').toUpperCase();
  if(m==='GET'||m==='HEAD'||m==='OPTIONS')return {decision:'allow',reason:'read_method'};
  let u;try{u=new URL(url);}catch{return {decision:'block',reason:'unparsable_url'};}
  if(!/^https?:$/.test(u.protocol))return {decision:'allow',reason:'non_network_scheme'};
  const host=u.hostname.toLowerCase(),path=u.pathname;
  if(isCognitoHost(host)){
    const target=String(header(headers,'x-amz-target')??'');let body={};try{body=JSON.parse(postData??'{}');}catch{}
    if(/\.GetTokensFromRefreshToken$/.test(target))return {decision:'allow_logged',reason:'cognito_token_refresh'};
    if(/\.InitiateAuth$/.test(target)&&/^REFRESH_TOKEN(_AUTH)?$/.test(body.AuthFlow??''))return {decision:'allow_logged',reason:'cognito_token_refresh'};
    if(/\.(GetUser|GetId|GetCredentialsForIdentity)$/.test(target))return {decision:'allow_logged',reason:'cognito_read'};
    if((mode==='manual_login'||mode==='auto_login')&&/\.(InitiateAuth|RespondToAuthChallenge|ConfirmDevice|GetDevice|ListDevices|AssociateSoftwareToken|VerifySoftwareToken)$/.test(target))return {decision:'allow_logged',reason:'cognito_manual_sign_in'};
    return {decision:'block',reason:`cognito_${target||'unknown'}`};
  }
  if(/(^|\.)posthog\.com$/.test(host)&&/^\/(flags|decide)\/?$/.test(path))return {decision:'allow_logged',reason:'feature_flag_read'};
  // A human completing sign-in may need an identity provider's form POSTs; app writes still never pass.
  if(!isAppHost(host)){
    if(mode==='manual_login')return {decision:'allow_logged',reason:'manual_sign_in_third_party'};
    // Unattended sign-in (academy-login.mjs): only the Cognito hosted UI may receive form POSTs.
    if(mode==='auto_login'&&/\.amazoncognito\.com$/.test(host))return {decision:'allow_logged',reason:'cognito_hosted_ui_sign_in'};
    return {decision:'block',reason:'third_party_non_get'};
  }
  // App hosts (app.hadrius.com, hadriusapi.com): only auth refresh, known read-only POSTs and an explicit
  // allowlist (future: fixture record IDs) pass. Every other non-GET is aborted AND fails the video.
  if(/\/oauth2\/token$/.test(path)&&/grant_type=refresh_token/.test(postData??''))return {decision:'allow_logged',reason:'oauth_token_refresh'};
  // Fixture mode (fixtures.mjs): a predicate may return a reason string, e.g. 'fixture_create:risk' / 'fixture_id:<type>:<id>'.
  for(const e of allow||[]){const hit=allowMatch(e,{method:m,host,path,postData});if(hit)return {decision:'allow_logged',reason:typeof hit==='string'?hit:'allowlisted'};}
  if(ABORT_PATH_RE.test(path))return {decision:'abort',reason:'mutation_named_path'};
  if(m==='POST'&&TELEMETRY_PATH_RE.test(path))return {decision:'block',reason:'telemetry_blocked'};
  if(m!=='POST')return {decision:'abort',reason:'app_write_method'};
  if(/graphql/i.test(path)){const ops=graphqlOps(postData);if(!ops)return {decision:'abort',reason:'graphql_unparsable'};
    if(ops.some(q=>/^(mutation|subscription)\b/i.test(q)))return {decision:'abort',reason:'graphql_mutation'};
    return {decision:'allow_logged',reason:'graphql_query'};}
  if(READ_PATH_RE.test(path))return {decision:'allow_logged',reason:'read_named_post'};
  if(KNOWN_READ_POST_RE.test(path))return {decision:'allow_logged',reason:'known_read_only_post'};
  return {decision:'abort',reason:'unclassified_app_post'};
}

/** Network-layer guard, separate so a later fixture lifecycle can pass an allowlist keyed to its own record IDs.
 *  createRequestGuard({allow, requests, hostCounts}) -> {attach(ctx, mode, phase), failure(), requests, hostCounts}.
 *  allow entries: {method?, host?, path | pathRe} or (desc)=>boolean, matched only for app hosts.
 *  Every non-GET/HEAD is logged as {method, host, path, decision, reason}; an 'abort' decision aborts the request
 *  AND records the first failure, which fails the video. */
export function createRequestGuard({allow=[],requests=[],hostCounts={}}={}){
  let fail=null,step=null;
  const decide=(desc,mode='recapture',phase=mode)=>{
    const method=String(desc.method||'GET').toUpperCase();let host='',path='';try{const u=new URL(desc.url);host=u.hostname;path=u.pathname;}catch{}
    if(method==='GET'||method==='HEAD'){hostCounts[host]=(hostCounts[host]??0)+1;return {decision:'allow',reason:'read_method'};}
    const c=classifyRequest(desc,{mode,allow});
    let op=null;try{const b=JSON.parse(desc.postData??'');op=(Array.isArray(b)?b:[b]).map(x=>x?.operationName??null);}catch{}
    requests.push({at:new Date().toISOString(),phase,mode,step,method,host,path,url:String(desc.url).split('?')[0],decision:c.decision,reason:c.reason,operationName:op});
    if(c.decision==='abort'&&!fail)fail=`network_guard: ${method} ${host}${path} (${c.reason})`;
    return c;};
  return {requests,hostCounts,decide,failure:()=>fail,setStep:(i)=>{step=i??null;},
    attach:async(ctx,mode='recapture',phase=mode)=>ctx.route('**/*',async(route)=>{const req=route.request();
      const c=decide({method:req.method(),url:req.url(),postData:req.postData(),headers:req.headers()},mode,phase);
      if(c.decision==='allow'||c.decision==='allow_logged')return route.continue();
      return route.abort('blockedbyclient');})};
}

// ---------- sign-in / tenant ----------
export function signedInFromProbe({url,hasPassword,hasAppNav},base=APP_BASE){
  if(!url||!url.startsWith(base))return false;
  if(LOGIN_PATH_RE.test(new URL(url).pathname))return false;
  return !(hasPassword&&!hasAppNav);
}
export function companyIdOf(url){try{return new URL(url).searchParams.get('company_id');}catch{return null;}}
export function isProjectDetailHref(href,base=APP_BASE){try{const u=new URL(href);return u.origin===base&&/^\/marketing\/project\/\d+\/?$/.test(u.pathname);}catch{return false;}}

// ---------- target resolution ----------
/** candidates: [{role,tag,name,href,cssMatch,visible,bbox}] -> {status,method,index,candidate,matches,notes} */
export function resolveTarget(target,candidates,{requireHref=null}={}){
  const notes=[];const vis=candidates.map((c,i)=>({c,i})).filter(({c})=>c.visible!==false);
  const roleOk=({c})=>(!target.role||c.role===target.role)&&(!target.tag||c.tag===target.tag);
  const done=(method,list)=>{
    if(list.length>1)return {status:'ambiguous',method,index:null,candidate:null,matches:list.map(x=>x.i),notes};
    const {c,i}=list[0];
    if(method==='role_name_normalized')notes.push(`name_changed: recorded=${JSON.stringify(target.name)} today=${JSON.stringify(c.name)}`);
    if(method==='css')notes.push(`css_fallback: today name=${JSON.stringify(c.name)}`);
    if(requireHref&&!requireHref(c.href))return {status:'not_navigation',method,index:i,candidate:c,matches:[i],notes};
    return {status:'resolved',method,index:i,candidate:c,matches:[i],notes};
  };
  if(target.name){
    const exact=vis.filter(x=>roleOk(x)&&clean(x.c.name)===clean(target.name));if(exact.length)return done('role_name',exact);
    const norm=vis.filter(x=>roleOk(x)&&normalizeName(x.c.name)===normalizeName(target.name));if(norm.length)return done('role_name_normalized',norm);
  }
  // Form fields: the recorder names an unlabelled field by its placeholder; today it may carry a <label>.
  if(target.placeholder){const ph=vis.filter(x=>roleOk(x)&&x.c.placeholder&&clean(x.c.placeholder)===clean(target.placeholder));if(ph.length)return done('role_placeholder',ph);}
  const css=vis.filter(x=>x.c.cssMatch&&roleOk(x));if(css.length)return done('css',css);
  return {status:'missing',method:null,index:null,candidate:null,matches:[],notes};
}
export function rectDelta(a,b){if(!a||!b)return null;const d={dx:b.x-a.x,dy:b.y-a.y,dw:b.w-a.w,dh:b.h-a.h};d.max=Math.max(...Object.values(d).map(Math.abs));return d;}


// ---------- mutation guard (recorded actions) ----------
// A recorded click/press/type is replayed ONLY when it cannot change data. Anything matching these words
// (in the recorded name/text or today's accessible name), any typing, upload, form submit, toggle/selection
// control, unknown custom action or non-navigation key press is NOT performed: the replay stops there.
export const MUTATING_WORDS=Object.freeze(['save','submit','create','add','new','delete','remove','archive','unarchive','restore',
  'activate','deactivate','enable','disable','sandbox','run','rerun','send','resend','approve','reject','decline','accept','assign','unassign',
  'reassign','publish','unpublish','upload','import','export','download','confirm','cancel','withdraw','discard','resolve','reopen','complete',
  'finish','mark','invite','revoke','grant','request','generate','sync','duplicate','move','rename','edit','update','apply','reset','retry',
  'start','stop','pause','resume','schedule','pay','transfer','connect','disconnect','link','unlink','sign out','log out','logout','signout',
  'escalate','dismiss','snooze','acknowledge','attest','certify','sign','close task','cancel task','upgrade','downgrade','clone','merge',
  'trigger','launch','deploy','share','post','reply','comment','flag as','lock','unlock']);
const MUTATING_RE=new RegExp(String.raw`(^|[^a-z0-9])(${MUTATING_WORDS.map(w=>w.replace(/ /g,String.raw`\s+`)).join('|')})($|[^a-z0-9])`,'i');
// Roles whose click changes a value by itself (toggles/selections may auto-save).
export const MUTATING_ROLES=Object.freeze(['checkbox','switch','radio','menuitemcheckbox','menuitemradio','option','slider','spinbutton','textbox','searchbox']);
// Keys that only move focus/scroll or dismiss. Everything else (Enter, Space, letters) may submit or edit.
const SAFE_KEYS=/^(Escape|Esc|Tab|Shift\+Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End)$/;
// "Actions for <entity>" style menu openers: only the head names the action; the entity name is data.
const MENU_OPENER_RE=/^\s*((?:more\s+|row\s+)?(?:actions?|options|menu|open menu|more))\s+for\s+.+$/i;
export function mutatingWord(name){const s=clean(name);if(!s)return null;const m=MENU_OPENER_RE.exec(s);const head=m?m[1]:s;const hit=MUTATING_RE.exec(head);return hit?hit[2].toLowerCase().replace(/\s+/g,' '):null;}
/** step: recorded script step; today: resolved candidate from today's DOM (or null).
 *  -> {mutating:boolean, reason, word?}. Conservative: unknown => mutating. */
export function classifyStepMutation(step,today=null){
  const a=String(step?.action||'');const t=step?.target||{};
  if(a==='navigate')return {mutating:false,reason:'navigate_get'};
  if(a==='view')return {mutating:false,reason:'view_only'};
  if(a==='type')return {mutating:true,reason:'typing_into_input'};
  if(a==='upload')return {mutating:true,reason:'file_upload'};
  if(a==='press'){const k=String(step.key??step.value??'');return SAFE_KEYS.test(k)?{mutating:false,reason:'navigation_key'}:{mutating:true,reason:`key_press:${k||'unknown'}`};}
  if(a!=='click'&&a!=='hover')return {mutating:true,reason:`unknown_action:${a||'none'}`};
  for(const [field,val] of [['name',t.name],['text',t.text],['ariaLabel',t.ariaLabel],['todayName',today?.name],['todayAriaLabel',today?.ariaLabel]]){
    const w=mutatingWord(val);if(w)return {mutating:a==='click',reason:`${field}_matches:${w}`,word:w,hoverOnly:a==='hover'};}
  if(a==='hover')return {mutating:false,reason:'hover'};
  const role=today?.role??t.role;if(role&&MUTATING_ROLES.includes(role))return {mutating:true,reason:`control_role:${role}`};
  if(['input','textarea','select'].includes(today?.tag??t.tag))return {mutating:true,reason:`form_control:${today?.tag??t.tag}`};
  if(today?.submits)return {mutating:true,reason:'form_submit'};
  if(today?.fileInput)return {mutating:true,reason:'file_upload'};
  if(!t.name&&!t.text&&!today?.name)return {mutating:true,reason:'unnamed_target'};
  return {mutating:false,reason:'read_only_click'};
}
// ---------- fixture evidence (what a future job-owned test record must provide) ----------
/** Record references visible in a URL: numeric/uuid path segments named by the segment before them, *_id params. */
export function recordRefsFromUrl(url,source){const out=[];let u;try{u=new URL(url);}catch{return out;}
  const segs=u.pathname.split('/').filter(Boolean);
  segs.forEach((seg,i)=>{if(/^\d{2,}$/.test(seg)||/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg))out.push({kind:segs[i-1]??'record',id:seg,source});});
  for(const [k,v] of u.searchParams)if(/(^|_)id$/i.test(k)&&v)out.push({kind:k,id:v,source});return out;}
const MENU_ENTITY_RE=/^\s*(?:more\s+|row\s+)?(?:actions?|options|menu|open menu|more)\s+for\s+(.+)$/i;
/** -> {action, target:{name,role,tag,css,text}, recordedUrl, pageUrl, records:[{kind,id|name,source}]} */
export function fixtureEvidence(step,{pageUrl=null,today=null,prevStep=null}={}){
  const t=step?.target??{};const records=[];
  for(const [u,src] of [[step?.url,'recorded_url'],[pageUrl,'today_url'],[today?.href,'target_href']])if(u)for(const r of recordRefsFromUrl(u,src))
    if(!records.some(x=>x.kind===r.kind&&x.id===r.id))records.push(r);
  for(const [name,src] of [[t.name,'target_name'],[prevStep?.target?.name,'opened_from_menu']]){const m=MENU_ENTITY_RE.exec(name??'');if(m)records.push({kind:'named_entity',name:m[1].trim(),source:src});}
  if(today?.recordHint)records.push({kind:'dom_record',...today.recordHint,source:'dom'});
  return {action:step?.action??null,key:step?.key??null,typedValuePresent:step?.action==='type'?step.value!=null:undefined,
    target:{name:t.name??null,role:t.role??null,tag:t.tag??null,css:t.css??null,text:t.text??null,todayName:today?.name??null,todayHref:today?.href??null},
    recordedUrl:step?.url??null,pageUrl,records};
}
export function mutationPlan(script){const steps=script?.steps??[];return steps.map((s,i)=>{const m=classifyStepMutation(s);
  return {index:s.index,action:s.action,...m,...(m.mutating?{fixture:fixtureEvidence(s,{prevStep:steps[i-1]??null})}:{})};});}

// ---------- in-page helpers (strings evaluated by Playwright) ----------
const CANDIDATE_SEL='a,button,input,textarea,select,[role="slider"],[role="link"],[role="button"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="option"],[role="checkbox"],[role="switch"],[role="radio"],[role="combobox"],[role="row"],tbody tr';
// Mirrors ai-record DOM_HELPERS_JS implicitRole/accessibleName (links/buttons/controls). The recorded CSS
// selector's matches are added so role-less targets (div/span/td) can still be resolved and compared.
const CANDIDATES_FN=`({sel, css}) => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const roleOf = (el) => { const r = el.getAttribute('role'); if (r) return r; const t = el.tagName.toLowerCase(); if (t === 'button') return 'button'; if (t === 'a' && el.href) return 'link';
    if (t === 'tr' && el.closest('tbody')) return 'row'; if (t === 'textarea') return 'textbox'; if (t === 'select') return 'combobox';
    if (t === 'input') { const ty = (el.type || 'text').toLowerCase(); if (['checkbox', 'radio'].includes(ty)) return ty; if (ty === 'submit' || ty === 'button') return 'button'; return 'textbox'; } return null; };
  const nameOf = (el) => { const a = el.getAttribute('aria-label'); if (a) return clean(a);
    if (/^(input|textarea|select)$/i.test(el.tagName)) { if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return clean(l.textContent); }
      const w = el.closest('label'); if (w) return clean(w.textContent); if (el.placeholder) return clean(el.placeholder); }
    if (el.title) return clean(el.title); const t = clean(el.innerText || el.textContent); return t.length <= 80 ? t : t.slice(0, 80); };
  let cssList = []; try { cssList = Array.from(document.querySelectorAll(css)); } catch {}
  const cssSet = new Set(cssList); const all = Array.from(new Set([...document.querySelectorAll(sel), ...cssList]));
  window.__driftCandidates = all;
  return all.map((el, i) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); const t = el.tagName.toLowerCase(); const form = el.closest('form');
    const ty = (el.getAttribute('type') || '').toLowerCase();
    const submits = (t === 'button' && (ty === 'submit' || (!ty && !!form))) || (t === 'input' && ty === 'submit');
    return { i, tag: t, role: roleOf(el), name: nameOf(el), ariaLabel: el.getAttribute('aria-label') || null, placeholder: el.getAttribute('placeholder') || null, href: el.href || null, cssMatch: cssSet.has(el),
      recordHint: (() => { const holder = el.closest('[data-id],[data-row-key],[data-record-id],tr,[role="row"],[role="menu"]');
        if (!holder) return null; const id = holder.getAttribute('data-id') || holder.getAttribute('data-row-key') || holder.getAttribute('data-record-id');
        const label = holder.getAttribute('role') === 'menu' ? null : clean(holder.innerText || '').slice(0, 80); return id || label ? { id: id || null, label: label || null } : null; })(),
      submits, inForm: !!form, fileInput: (t === 'input' && ty === 'file') || !!el.querySelector?.('input[type="file"]'),
      visible: r.width > 3 && r.height > 3 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.right > 0 && r.left < innerWidth,
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }; });
}`;
const DYNAMIC_FN=`(sources) => {
  const res = Object.entries(sources).map(([k, s]) => [k, new RegExp(s, 'i')]); const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { const text = (n.textContent || '').replace(/\\s+/g, ' ').trim(); if (!text || text.length > 200) continue;
    const hit = res.find(([, re]) => re.test(text)); if (!hit) continue;
    const range = document.createRange(); range.selectNodeContents(n); const r = range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    out.push({ x: Math.max(0, Math.floor(r.x) - 4), y: Math.max(0, Math.floor(r.y) - 3), w: Math.ceil(r.width) + 8, h: Math.ceil(r.height) + 6, text, kind: hit[0] }); }
  return out;
}`;
// Diagnostic only: visible text that looks like a project ID label (e.g. "ID: PRJ-XXXX").
const ID_TEXT_FN=`() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const t = (n.textContent || '').replace(/\\s+/g, ' ').trim(); if (!/\\bID\\b|PRJ-/.test(t) || t.length > 80) continue;
    const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect(); if (b.width < 1) continue;
    out.push({ text: t, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), inViewport: b.top < innerHeight && b.bottom > 0 }); }
  return out; }`;
// True when the main area shows a visible loading indicator ("Loading...", aria-busy, spinner role) and no headings.
const LOADING_FN=`() => { const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && r.left > 240 && r.top < innerHeight; };
  const texts = Array.from(document.querySelectorAll('body *')).filter(el => el.children.length === 0 && /^\\s*Loading\\.{0,3}\\s*$/i.test(el.textContent || '') && vis(el));
  const busy = Array.from(document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')).filter(vis);
  return texts.length + busy.length > 0 && !Array.from(document.querySelectorAll('main h1, main h2, h1')).some(vis); }`;
const PROBE_FN=`() => ({ url: location.href, hasPassword: !!document.querySelector('input[type="password"]'),
  hasAppNav: !!document.querySelector('a[href*="/overview"], a[href*="/settings"], nav a[href*="/people"]'),
  academy: /Hadrius Academy/.test(document.body ? document.body.innerText : ''), title: document.title })`;

// ---------- browser run ----------
export function preflight({profileDir,bridgeStatus,psOutput}){
  const problems=[];
  if(!/^\.browser-profile-(ai-\d+|drift)$/.test(basename(profileDir)))problems.push('profile_not_ai_slot');
  if(!existsSync(profileDir))problems.push('profile_missing');
  if(existsSync(join(profileDir,'SingletonLock')))problems.push('profile_locked');
  if(!bridgeStatus||bridgeStatus.running!==false)problems.push('bridge_not_idle');
  // Only a browser launched on this profile counts (our own CLI argv also contains the path).
  if((psOutput??'').split('\n').some(l=>l.includes(`--user-data-dir=${profileDir}`)))problems.push('profile_in_use');
  return problems;
}
const withTimeout=(p,ms,label)=>{let t;return Promise.race([p.finally(()=>clearTimeout(t)),new Promise((_,rej)=>{t=setTimeout(()=>rej(new Error(`timeout:${label}`)),ms);})]);};

// The live session must be exactly what academy-login verified; an AI-slot profile keeps the legacy
// manual-sign-in path (a human signs in in a visible window; nothing is ever typed by this module).
export const isDriftProfile=(dir)=>basename(dir)==='.browser-profile-drift';
const urlKey=(u)=>{try{const x=new URL(u);return x.pathname+x.search;}catch{return null;}};
const pathOf=(u)=>{try{return new URL(u).pathname;}catch{return null;}};

export async function captureRun({scriptPath,profileDir=DEFAULT_PROFILE,outDir,base=APP_BASE,expectedCompany='1150',log=console.log,
  ensureSession=ensureAcademySession,chromium:chromiumOverride=null,limits=LIMITS,networkAllow=[],fixture=null}){
  const script=JSON.parse(readFileSync(scriptPath,'utf8'));
  if(existsSync(outDir))throw new Error('output_exists');
  mkdirSync(outDir,{mode:0o700});
  const plan=mutationPlan(script);
  const run={schema:2,script:script.name,scriptPath,recordingId:script.recording?.id??null,profile:profileDir,startedAt:new Date().toISOString(),viewport:VIEWPORT,
    session:null,signedIn:null,manualSignIn:false,tenantVerified:false,status:'running',findings:[],mutationPlan:plan,mutationStop:null,steps:[],aborted:null};
  // Fixture mode (fixtures.mjs session): its predicate admits only this run's fixture ids / own create requests.
  const net=createRequestGuard({allow:fixture?[...networkAllow,fixture.allow]:networkAllow});const {requests,hostCounts}=net;let abortReason=null;
  if(fixture)run.fixture={runId:fixture.runId,label:fixture.label,journal:fixture.journal.file,status:'pending'};
  const save=()=>{writeFileSync(join(outDir,'run.json'),JSON.stringify(run,null,2)+'\n');writeFileSync(join(outDir,'requests.json'),JSON.stringify({nonGet:requests,getCountsByHost:hostCounts},null,2)+'\n');};
  save();
  // Preflight (bridge idle, profile unused) is re-checked here, immediately before any launch.
  let bridgeStatus=null;try{bridgeStatus=await (await fetch('http://127.0.0.1:8787/render/status',{signal:AbortSignal.timeout(5000)})).json();}catch{}
  const psOutput=execFileSync('ps',['-axww','-o','pid,command'],{encoding:'utf8'});
  const problems=preflight({profileDir,bridgeStatus,psOutput});
  if(problems.length){run.status='preflight_failed';run.findings.push({kind:'preflight',problems});save();return run;}
  const {chromium}=chromiumOverride?{chromium:chromiumOverride}:await import('playwright');
  const ctxOpts={viewport:VIEWPORT,acceptDownloads:false,serviceWorkers:'block'};
  const probe=async(page)=>{await page.waitForURL(u=>LOGIN_PATH_RE.test(u.pathname),{timeout:6000}).catch(()=>{});await page.waitForTimeout(1000);
    const p=await page.evaluate(`(${PROBE_FN})()`).catch(()=>({url:page.url(),hasPassword:true,hasAppNav:false,academy:false}));return {...p,signedIn:signedInFromProbe(p,base)};};
  // Network layer: every non-GET/HEAD is logged; an app-host write that is not auth/read-only/allowlisted is
  // aborted before it leaves the browser and fails the video (net.failure()).
  const guard=async(ctx,mode='recapture',phase=mode)=>net.attach(ctx,mode,phase);
  const syncAbort=()=>{if(!abortReason&&net.failure())abortReason=net.failure();return abortReason;};
  // 0) Unattended sign-in of the dedicated drift profile (academy-login.mjs reads the Keychain itself).
  //    Its browser gets the same request guard (sign-in mode: Cognito auth passes, app writes never do).
  if(isDriftProfile(profileDir)){
    const guarded={launchPersistentContext:async(dir,opts)=>{const ctx=await chromium.launchPersistentContext(dir,{...opts,serviceWorkers:'block'});await guard(ctx,'auto_login','session');return ctx;}};
    let res;try{res=await ensureSession({profileDir,chromium:guarded,onLog:(m)=>log(`[session] ${m}`)});}catch(e){res={status:'unexpected',detail:String(e?.message||e).slice(0,200)};}
    run.session={status:res?.status??'unexpected',companyIds:res?.companyIds??null,detail:res?.detail??null};
    if(syncAbort()){run.status='aborted';run.aborted=abortReason;save();return run;}
    if(!SESSION_OK.includes(run.session.status)){run.status='session_failed';run.findings.push({kind:'session',status:run.session.status,detail:run.session.detail});save();return run;}
  }

  // 1) Headless sign-in probe; 2) AI-slot profiles only: visible window for MANUAL sign-in (never typed by us).
  let ctx=await chromium.launchPersistentContext(profileDir,{...ctxOpts,headless:true});
  try{await guard(ctx);const page=ctx.pages()[0]||await ctx.newPage();
    await page.goto(script.environment.startUrl,{waitUntil:'domcontentloaded',timeout:30000});const p=await probe(page);run.signedIn=p.signedIn;run.firstProbe={url:p.url,hasPassword:p.hasPassword,hasAppNav:p.hasAppNav};
  }finally{await ctx.close().catch(()=>{});}
  if(!run.signedIn&&!isDriftProfile(profileDir)){
    ctx=await chromium.launchPersistentContext(profileDir,{...ctxOpts,headless:false});
    try{await guard(ctx,'manual_login');const page=ctx.pages()[0]||await ctx.newPage();page.on('dialog',d=>d.dismiss().catch(()=>{}));
      await page.goto(script.environment.startUrl,{waitUntil:'domcontentloaded',timeout:30000});
      log('WAITING FOR MANUAL HADRIUS SIGN-IN in the visible Chromium window');
      const start=Date.now();let stable=0;await page.waitForURL(u=>LOGIN_PATH_RE.test(u.pathname),{timeout:6000}).catch(()=>{});
      while(Date.now()-start<limits.manualLoginMs){const p=await page.evaluate(`(${PROBE_FN})()`).catch(()=>({url:page.url(),hasPassword:true,hasAppNav:false}));
        if(signedInFromProbe(p,base)){if(++stable>=4){await page.waitForTimeout(1500);run.signedIn=true;run.manualSignIn=true;break;}}else stable=0;await page.waitForTimeout(1000);}
    }finally{await ctx.close().catch(()=>{});}
  }
  if(syncAbort()){run.status='aborted';run.aborted=abortReason;save();return run;}
  if(!run.signedIn){run.status='login_required';save();return run;}
  if(abortReason){run.status='aborted';run.aborted=abortReason;save();return run;}

  // 3) Headless read-only recapture with the mutation guard.
  ctx=await chromium.launchPersistentContext(profileDir,{...ctxOpts,headless:true});
  const overall=setTimeout(()=>{abortReason=abortReason??'overall_timeout';ctx.close().catch(()=>{});},limits.totalMs);
  let page=null;
  try{await guard(ctx);if(fixture?.pageInit)await ctx.addInitScript(fixture.pageInit);page=ctx.pages()[0]||await ctx.newPage();await page.setViewportSize(VIEWPORT);
    if(fixture)page.on('response',(r)=>{const q=r.request();if(['GET','HEAD','OPTIONS'].includes(q.method()))return;let u;try{u=new URL(q.url());}catch{return;}
      fixture.onResponse({method:q.method(),host:u.hostname,path:u.pathname,status:r.status(),json:()=>r.json()});});
    page.on('dialog',d=>d.dismiss().catch(()=>{}));page.on('download',d=>d.cancel().catch(()=>{}));page.on('filechooser',()=>{});
    const checkAbort=()=>{if(syncAbort())throw new Error(`aborted: ${abortReason}`);};
    const settle=async()=>{await page.waitForLoadState('networkidle',{timeout:limits.idleMs}).catch(()=>{});await page.waitForTimeout(limits.settleMs);};
    const shoot=async(i,rec)=>{const name=`step-${String(i).padStart(2,'0')}-today.png`;await page.screenshot({path:join(outDir,name),timeout:10000});rec.screenshot=name;
      rec.dynamicRects=await page.evaluate(`(${DYNAMIC_FN})(${JSON.stringify(DYNAMIC_SOURCES)})`).catch(()=>[]);rec.todayUrl=page.url();rec.title=await page.title().catch(()=>null);
      rec.idText=await page.evaluate(`(${ID_TEXT_FN})()`).catch(()=>[]);
      // Grounding for the narration judge (classify.mjs): what is actually rendered as text right now.
      rec.visibleText=await page.evaluate(`(document.body?.innerText||'').replace(/\\n{2,}/g,'\\n').slice(0,4000)`).catch(()=>null);};
    let stopped=null;
    // Fixture mode: verify the tenant on the start page, then reconcile/sweep/setup BEFORE any slide is captured.
    if(fixture){net.setStep('prepare');await page.goto(script.environment.startUrl,{waitUntil:'domcontentloaded',timeout:30000});const p=await probe(page);
      if(!p.signedIn||companyIdOf(page.url())!==expectedCompany||!p.academy)throw new Error('aborted: fixture_tenant_check_failed');
      await settle();checkAbort();await fixture.prepare(page);checkAbort();run.fixture.prepared=true;}
    for(const step of script.steps){net.setStep(step.index);
      const rec={index:step.index,action:step.action,url:step.url,route:step.route??null,recordedMedia:step.media?.pre??null,mutation:plan.find(p=>p.index===step.index)??null};run.steps.push(rec);
      if(stopped!==null&&step.action!=='navigate'){const prev=script.steps.find(s=>s.index===step.index-1);
        rec.mutationGuard={status:'needs_fixture',performed:false,reason:`replay stopped at data-changing step ${stopped}`,ownMutation:rec.mutation,fixture:fixtureEvidence(step,{prevStep:prev})};save();continue;}
      try{await withTimeout((async()=>{
        checkAbort();
        // Before a stop, a non-navigate step whose route differs is reached by direct GET navigation (recorded url).
        if(step.action==='navigate'||urlKey(page.url())!==step.route){
          const to=step.action==='navigate'?step.value||step.url:step.url;
          if(rec.index>0&&step.action!=='navigate')rec.reachedByDirectNavigation=true;
          await page.goto(to,{waitUntil:'domcontentloaded',timeout:30000});}
        if(stopped!==null){rec.prerequisiteUnverified=true;rec.mutationGuard={status:'captured_by_direct_navigation',performed:false,reason:`earlier mutating step ${stopped} was not replayed; state before this navigate is unverified`};}
        const p=await probe(page);checkAbort();
        if(!p.signedIn){rec.error='signed_out_midrun';throw new Error('signed_out_midrun');}
        if(rec.index===0){const cid=companyIdOf(page.url());const sess=run.session?.companyIds??null;
          // Some scripts start on a URL without ?company_id=. The Academy-only automation session can only
          // be in its own company, so a session scoped to exactly the expected company (plus Academy
          // visible on the page) verifies the tenant just as well.
          const sessionOnly=Array.isArray(sess)&&sess.length===1&&String(sess[0])===String(expectedCompany);
          run.tenant={urlCompanyId:cid,academyVisible:p.academy,session:sess,viaSession:cid==null&&sessionOnly};run.tenantVerified=(cid===expectedCompany||(cid==null&&sessionOnly))&&p.academy;
          if(!run.tenantVerified){rec.error='tenant_mismatch';throw new Error('tenant_mismatch');}}
        await settle();checkAbort();
        // A page still showing only a loading indicator is not today's UI: wait a bit longer, then record it.
        for(let w=0;w<limits.loadingWaitMs/1000&&await page.evaluate(`(${LOADING_FN})()`).catch(()=>false);w++)await page.waitForTimeout(1000);
        if(await page.evaluate(`(${LOADING_FN})()`).catch(()=>false)){rec.pageState='loading';run.findings.push({step:rec.index,kind:'page_still_loading',detail:`still loading after ${limits.loadingWaitMs/1000}s extra wait`});}
        let today=null,res=null;
        if(step.target&&['click','hover','view','type','press','upload'].includes(step.action)){
          const t=step.target,recordedRect=t.hint?.bbox??t.bbox??null;
          const cands=await page.evaluate(`(${CANDIDATES_FN})(${JSON.stringify({sel:CANDIDATE_SEL,css:t.css??''})})`);
          res=resolveTarget(t,cands);today=res.candidate;
          const nextStep=script.steps.find(s=>s.index===step.index+1);
          const hrefMatches=nextStep?.url&&nextStep.url!==step.url?cands.filter(c=>c.visible&&c.href&&c.href.split(/[?#]/)[0]===nextStep.url.split(/[?#]/)[0]):[];
          rec.target={status:res.status,method:res.method,notes:res.notes,matches:res.matches.map(i=>cands[i]),recordedRect,rect:res.candidate?.bbox??null,delta:res.status==='resolved'?rectDelta(recordedRect,res.candidate.bbox):null,resolved:res.candidate,recordedName:t.name,recordedCss:t.css,diagnosticHrefMatches:hrefMatches};
        }
        await shoot(rec.index,rec);checkAbort();
        if(step.action==='navigate'||step.action==='view')return;
        // Mutation guard: recorded semantics AND today's resolved element are both checked before acting.
        // Today's element only counts when it was found by name: a CSS-only match is never acted on anyway.
        const m=classifyStepMutation(step,res?.status==='resolved'&&res.method!=='css'?today:null);rec.mutation={...m,static:rec.mutation};
        const isMut=m.mutating||!!rec.mutation.static?.mutating;
        // A reviewed fixture spec may authorise this step on the run's own '[Studio QA]' records (network guard still applies).
        const fd=fixture?fixture.stepDecision(step,{mutating:isMut}):null;if(fd&&(fd.perform||fd.status))rec.fixtureDecision=fd;
        if(isMut&&!fd?.perform){stopped=rec.index;run.mutationStop={index:rec.index,action:step.action,reason:fd?.reason??(m.mutating?m.reason:rec.mutation.static.reason),targetName:step.target?.name??null};
          rec.mutationGuard={status:fd?.status??'needs_fixture',performed:false,reason:run.mutationStop.reason,
            fixture:fixtureEvidence(step,{pageUrl:page.url(),today,prevStep:script.steps.find(s=>s.index===step.index-1)})};
          run.mutationStop.fixture=rec.mutationGuard.fixture;
          run.findings.push({step:rec.index,kind:'mutation_guard_stop',reason:run.mutationStop.reason,detail:'pre-action screenshot taken; action NOT performed (needs a job-owned fixture record); later non-navigate steps not replayed'});return;}
        // Spec-provided input on a control the recorder could not capture (e.g. a slider dragged during a 'hover'):
        // located by the spec's selector, which must match exactly one element.
        if(fd?.perform&&fd.kind==='set_slider'){fixture.beforeStep(step);rec.mutationGuard={status:'performed_on_fixture',performed:true,kind:fd.kind,fixture:fd.fixture};
          const sl=page.locator(fd.selector);const n=await sl.count();if(n!==1)throw new Error(`fixture_slider_not_unique:${n}`);await sl.hover({timeout:10000});await sl.focus();
          for(let k=0;k<20&&String(await sl.getAttribute('aria-valuenow'))!==String(fd.value);k++){const v=Number(await sl.getAttribute('aria-valuenow'));
            await page.keyboard.press(Number.isFinite(v)&&v>fd.value?'ArrowLeft':'ArrowRight');await page.waitForTimeout(150);}
          rec.performed=`set_slider:${await sl.getAttribute('aria-valuenow')}`;await settle();checkAbort();rec.fixtureCheck=await fixture.afterStep(step,requests,page);return;}
        if(step.action==='press'&&!step.target){await page.keyboard.press(String(step.key??step.value));rec.performed=`press:${step.key??step.value}`;await settle();return;}
        if(!res){rec.performed=false;run.findings.push({step:rec.index,kind:'no_target',detail:`${step.action} without a target; not performed`});return;}
        if(res.status!=='resolved'){rec.clicked=false;run.findings.push({step:rec.index,kind:`target_${res.status}`,matches:res.matches.length,notes:res.notes});return;}
        // A CSS-only match means the recorded name is gone: never act on an element we cannot name.
        if(res.method==='css'){rec.clicked=false;rec.target.notClickedReason='css_only_match';run.findings.push({step:rec.index,kind:'target_renamed',today:res.candidate.name,recorded:step.target.name});return;}
        const h=await page.evaluateHandle((i)=>window.__driftCandidates?.[i]??null,res.index);
        // Same naming as CANDIDATES_FN (form fields: label[for] / wrapping label / placeholder).
        const again=await h.evaluate(el=>{if(!el)return null;const c=(x)=>(x||'').replace(/\s+/g,' ').trim();let n=el.getAttribute('aria-label');
          if(!n&&/^(input|textarea|select)$/i.test(el.tagName)){const l=el.id&&document.querySelector('label[for="'+CSS.escape(el.id)+'"]');n=l?l.textContent:(el.closest('label')?.textContent||el.placeholder||'');}
          if(!n)n=el.title||el.innerText||el.textContent||'';n=c(n);return {name:n.length<=80?n:n.slice(0,80),href:el.href||null};}).catch(()=>null);
        if(!again||again.href!==(res.candidate.href??null)||again.name!==res.candidate.name){rec.target.status='ambiguous';rec.target.notes.push('dom_changed_before_action');run.findings.push({step:rec.index,kind:'target_ambiguous',detail:'element changed between resolve and action; not performed'});return;}
        if(fd?.perform){fixture.beforeStep(step);rec.mutationGuard={status:'performed_on_fixture',performed:true,kind:fd.kind,fixture:fd.fixture};}
        const fixtureDone=async()=>{if(fd?.perform){checkAbort();rec.fixtureCheck=await fixture.afterStep(step,requests,page);}};
        if(fd?.perform&&fd.kind==='type'){await h.fill(String(fd.value),{timeout:10000});rec.performed='type';rec.typedValue=fd.value;await settle();await fixtureDone();return;}
        if(step.action==='hover'){await h.hover({timeout:10000});rec.performed='hover';await page.waitForTimeout(800);return;}
        if(step.action==='press'){await h.focus().catch(()=>{});await page.keyboard.press(String(step.key??step.value));rec.performed=`press:${step.key??step.value}`;await settle();return;}
        const before=page.url();await h.click({timeout:10000});rec.clicked=true;rec.performed='click';
        await page.waitForURL(u=>u.href!==before,{timeout:5000}).catch(()=>{});await settle();rec.afterClickUrl=page.url();
        const next=script.steps.find(s=>s.index===step.index+1);
        if(next?.url&&next.url!==step.url&&pathOf(page.url())!==pathOf(next.url))run.findings.push({step:rec.index,kind:'click_destination_differs',expected:next.url,actual:page.url()});
        if(next?.url&&next.url===step.url&&pathOf(page.url())!==pathOf(step.url))run.findings.push({step:rec.index,kind:'click_navigated_unexpectedly',expected:step.url,actual:page.url()});
        checkAbort();await fixtureDone();
      })(),limits.stepMs,`step${step.index}`);}
      catch(e){rec.error=rec.error??e.message;if(/aborted|tenant|signed_out|overall/.test(e.message)||syncAbort()){run.aborted=abortReason??e.message;break;}}
      if(syncAbort()){run.aborted=abortReason;save();break;}
      save();
    }
    const unverified=run.steps.filter(s=>['needs_fixture','needs_human'].includes(s.mutationGuard?.status)).length;
    run.status=run.aborted?'aborted':run.steps.length===script.steps.length&&run.steps.every(s=>s.screenshot||['needs_fixture','needs_human'].includes(s.mutationGuard?.status))?(unverified?'captured_partial_mutation_guard':'captured'):'partial';
    if(fixture&&run.steps.some(s=>s.fixtureCheck&&!s.fixtureCheck.ok)&&run.status==='captured')run.status='captured_fixture_check_failed';
  }catch(e){run.status=/^aborted/.test(e.message)?'aborted':'error';run.error=e.message;run.aborted=run.aborted??syncAbort()??(/^aborted/.test(e.message)?e.message:null);}
  finally{clearTimeout(overall);
    // Fixture teardown always runs (error/abort included) while the signed-in page is still open; whatever it
    // cannot finish stays journaled and is reconciled by the next run.
    if(fixture){net.setStep('teardown');try{if(page&&!page.isClosed())await fixture.teardown(page);else run.fixture.teardownSkipped='page_closed';}catch(e){run.fixture.teardownError=String(e?.message||e).slice(0,200);}
      const fin=fixture.finish(run.status);Object.assign(run.fixture,{status:fin.clean?'clean':'dirty',dirty:fin.dirty,report:fixture.report});}
    await ctx.close().catch(()=>{});if(syncAbort()&&run.status!=='error'){run.status='aborted';run.aborted=abortReason;}run.finishedAt=new Date().toISOString();save();}
  return run;
}

/** Signed-in, tenant-verified, guarded headless page for fixture maintenance (reconcile/sweep without a replay).
 *  Same preflight + unattended sign-in as captureRun; every non-GET goes through createRequestGuard({allow}). */
export async function withAppPage({profileDir=DEFAULT_PROFILE,startUrl,expectedCompany='1150',allow=[],pageInit=null,fn,log=console.log,
  ensureSession=ensureAcademySession,chromium:chromiumOverride=null}){
  let bridgeStatus=null;try{bridgeStatus=await (await fetch('http://127.0.0.1:8787/render/status',{signal:AbortSignal.timeout(5000)})).json();}catch{}
  const problems=preflight({profileDir,bridgeStatus,psOutput:execFileSync('ps',['-axww','-o','pid,command'],{encoding:'utf8'})});
  if(problems.length)return {status:'preflight_failed',problems};
  const {chromium}=chromiumOverride?{chromium:chromiumOverride}:await import('playwright');const net=createRequestGuard({allow});
  if(isDriftProfile(profileDir)){const guarded={launchPersistentContext:async(dir,opts)=>{const c=await chromium.launchPersistentContext(dir,{...opts,serviceWorkers:'block'});await net.attach(c,'auto_login','session');return c;}};
    const res=await ensureSession({profileDir,chromium:guarded,onLog:(m)=>log(`[session] ${m}`)}).catch(e=>({status:'unexpected',detail:String(e?.message||e)}));
    if(!SESSION_OK.includes(res?.status))return {status:'session_failed',session:res?.status,requests:net.requests};}
  const ctx=await chromium.launchPersistentContext(profileDir,{viewport:VIEWPORT,acceptDownloads:false,serviceWorkers:'block',headless:true});
  try{await net.attach(ctx);if(pageInit)await ctx.addInitScript(pageInit);const page=ctx.pages()[0]||await ctx.newPage();
    await page.goto(startUrl,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});await page.waitForTimeout(1500);
    const p=await page.evaluate(`(${PROBE_FN})()`).catch(()=>null);
    if(!p||!signedInFromProbe(p)||companyIdOf(page.url())!==expectedCompany||!p.academy)return {status:'tenant_check_failed',requests:net.requests};
    const result=await fn(page);return {status:net.failure()?'aborted':'ok',aborted:net.failure(),result,requests:net.requests};
  }finally{await ctx.close().catch(()=>{});}
}

function arg(args,name){const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}
export async function main(args=process.argv.slice(2)){
  const scriptPath=arg(args,'--script'),profileDir=arg(args,'--profile')??DEFAULT_PROFILE,outDir=arg(args,'--out');
  if(!scriptPath||!outDir)throw new Error('usage: capture.mjs --script SCRIPT --out NEW_DIR [--profile /abs/.browser-profile-drift|.browser-profile-ai-N]');
  if(!existsSync(dirname(resolve(outDir))))throw new Error('output parent missing');
  const run=await captureRun({scriptPath:resolve(scriptPath),profileDir:resolve(profileDir),outDir:resolve(outDir)});
  console.log(JSON.stringify({status:run.status,session:run.session,signedIn:run.signedIn,tenantVerified:run.tenantVerified,aborted:run.aborted,mutationStop:run.mutationStop,findings:run.findings,steps:run.steps.map(s=>({index:s.index,screenshot:s.screenshot,url:s.todayUrl,target:s.target?.status,guard:s.mutationGuard?.status,error:s.error}))},null,2));
  return run;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
