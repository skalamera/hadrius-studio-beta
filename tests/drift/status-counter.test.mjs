// Source-derived offline DOM fixtures; no app authentication, API requests, or production captures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {chromium} from 'playwright';
import {resolveTarget,normalizeName,classifyRequest} from '../../tools/drift/capture.mjs';
import {EXCEPTION_STATUS_LABELS,closedCounterTarget,statusCounterEvidence,closedFilterWitness,closedRecordWitness} from '../../tools/drift/status-counter.mjs';
const PAGE_URL='https://app.hadrius.com/account-surveillance?company_id=1048';
const target={name:'Closed 5',role:'button',tag:'button',label:'Exceptions'};
const candidate=(count='4',extra={})=>({role:'button',tag:'button',name:`Closed ${count}`,visible:true,cssMatch:false,submits:false,inForm:false,inDialog:false,
  statusCounter:{kind:'exceptions-status-counter-v1',label:'Closed',count,labels:[...EXCEPTION_STATUS_LABELS]},...extra});
test('Closed count data resolves only the source-vetted scoped status control',()=>{
  const r=resolveTarget(target,[candidate()],{pageUrl:PAGE_URL});assert.equal(r.status,'resolved');assert.equal(r.method,'status_counter');assert.equal(r.candidate.name,'Closed 4');
  for(const n of ['0','99','99+'])assert.equal(resolveTarget(target,[candidate(n)],{pageUrl:PAGE_URL}).status,'resolved');
});
test('counter duplicates stay ambiguous even when one count exactly matches; never use geometry',()=>{
  const r=resolveTarget(target,[candidate('5'),candidate('4')],{pageUrl:PAGE_URL});assert.equal(r.status,'ambiguous');assert.equal(r.method,'status_counter');
});
test('counter identity requires route, role, label, separate badge and complete ordered family',()=>{
  for(const c of [candidate('100'),candidate('4',{role:'link'}),candidate('4',{inDialog:true}),candidate('4',{submits:true}),candidate('4',{visible:false}),candidate('4',{statusCounter:null}),candidate('4',{statusCounter:{kind:'exceptions-status-counter-v1',label:'Closed',count:'4',labels:['Closed']}})])assert.equal(resolveTarget(target,[c],{pageUrl:PAGE_URL}).status,'missing');
  for(const pageUrl of ['https://evil.example/account-surveillance',PAGE_URL.replace('/account-surveillance','/employees/settings')])assert.notEqual(resolveTarget(target,[candidate()],{pageUrl}).method,'status_counter');
  for(const bad of [{...target,label:'Other table'},{...target,role:'link'},{...target,name:'Rule 5'},{...target,name:'Reopen 5'}])assert.notEqual(resolveTarget(bad,[candidate()],{pageUrl:PAGE_URL}).method,'status_counter');
  assert.equal(closedCounterTarget(target,PAGE_URL).count,'5');assert.notEqual(normalizeName('Rule 5'),normalizeName('Rule 4'));
  assert.equal(classifyRequest({method:'PATCH',url:'https://hadriusapi.com/api/company/1048/example/'}).decision,'abort');
});
const toolbar=(extra='')=>`<div><input placeholder="Search exceptions..."/><div><div>${EXCEPTION_STATUS_LABELS.map(label=>`<button type="button" style="display:inline-flex;gap:6px"><span>${label}</span><span style="display:inline-flex">${label==='Closed'?'4':'12'}</span></button>`).join('')}${extra}</div></div></div>`;
async function pageFixture(t,html){const b=await chromium.launch({headless:true});t.after(()=>b.close());const p=await b.newPage();await p.route('**/*',r=>r.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body>'+html+'</body></html>'}));await p.goto(PAGE_URL);return p;}
test('actual candidate extraction observes independent badge and toolbar context in offline Chip DOM',async t=>{
  const p=await pageFixture(t,toolbar());const source=fs.readFileSync(new URL('../../tools/drift/capture.mjs',import.meta.url),'utf8');
  const expression=source.match(/const CANDIDATES_FN=(`[^]*?`);\n/)?.[1];assert.ok(expression);
  const fn=vm.runInNewContext(expression,{statusCounterEvidence,EXCEPTION_STATUS_LABELS});
  const candidates=await p.evaluate(`(${fn})(${JSON.stringify({sel:'button',css:''})})`);const c=candidates.find(x=>x.name==='Closed 4');
  assert.equal(c.statusCounter?.label,'Closed');assert.equal(resolveTarget(target,candidates,{pageUrl:PAGE_URL}).method,'status_counter');
  const handle=await p.getByRole('button',{name:'Closed 4',exact:true}).elementHandle();
  assert.deepEqual(await handle.evaluate(statusCounterEvidence,EXCEPTION_STATUS_LABELS),c.statusCounter,'real element-handle recheck must invoke the function, not evaluate a function string');
});
test('a count-like button outside the vetted toolbar supplies no counter evidence',async t=>{
  const p=await pageFixture(t,'<button type="button"><span>Closed</span><span>4</span></button>');
  assert.equal(await p.evaluate(`(${statusCounterEvidence.toString()})(document.querySelector('button'),${JSON.stringify(EXCEPTION_STATUS_LABELS)})`),null);
});
const table=(status='Resolved',filter='CLOSED')=>`<table><thead><tr><th>ID</th><th>Status</th></tr></thead><tbody><tr><td><a href="/account-surveillance/rules/violations/999999?source=overview&filters=${filter}">FLAG-TESTONLY</a></td><td>${status}</td></tr></tbody></table>`;
test('CLOSED requires actual Resolved row status and coherent queue context, not URL text or Reopen visibility',async t=>{
  const p=await pageFixture(t,toolbar()+table());assert.equal((await p.evaluate(closedFilterWitness)).verified,true);
  for(const [status,filter] of [['New','CLOSED'],['Escalated','CLOSED'],['Resolved','OPEN']]){await p.setContent(toolbar()+table(status,filter));assert.equal((await p.evaluate(closedFilterWitness)).verified,false);}
  await p.setContent(toolbar()+'<button>Reopen exception</button>');assert.equal((await p.evaluate(closedFilterWitness)).verified,false);
});
test('queue witness rejects foreign origins, invalid/missing sources and conflicting filter/tenant parameters',async t=>{
  const p=await pageFixture(t,table());
  for(const html of [table().replace('source=overview&',''),table().replace('source=overview','source=bogus'),table().replace('href="/','href="https://evil.example/'),table().replace('filters=CLOSED','filters=CLOSED&filters=OPEN'),table().replace('filters=CLOSED','filters=CLOSED&company_id=1150')]){
    await p.setContent(html);assert.equal((await p.evaluate(closedFilterWitness)).verified,false,html);
  }
});
test('closed detail proof reads the actual unique review-status row, never a Reopen button or audit note',async t=>{
  const p=await pageFixture(t,'');await p.goto('https://app.hadrius.com/account-surveillance/rules/violations/999999?source=overview&filters=CLOSED');
  const row=status=>`<div style="display:flex"><p>Review status</p><span>${status}</span></div>`;
  await p.setContent(row('Closed'));assert.equal((await p.evaluate(closedRecordWitness)).verified,true);
  for(const status of ['Open','Escalated','Archived']){await p.setContent(row(status)+'<p>Review status Closed</p><button>Reopen exception</button>');const r=await p.evaluate(closedRecordWitness);assert.equal(r.verified,false);assert.equal(r.status,status);}
  await p.setContent(row('Closed')+row('Open'));assert.equal((await p.evaluate(closedRecordWitness)).verified,false);
});
