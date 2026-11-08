// Source-vetted CLOSED exception filter only. Counts are data, not arbitrary name/record-ID aliases.
export const EXCEPTION_STATUS_LABELS=Object.freeze(['All','Open','New','Escalated','Closed','Archived']);
const count=/^(?:0|[1-9]\d?|99\+)$/;
export function closedCounterTarget(target,pageUrl){
  let url;try{url=new URL(pageUrl);}catch{return null;}
  if(url.origin!=='https://app.hadrius.com'||url.pathname.replace(/\/$/,'')!=='/account-surveillance'
    ||target?.role!=='button'||target.tag!=='button'||target.label!=='Exceptions'||target.inDialog)return null;
  const match=/^Closed (0|[1-9]\d?|99\+)$/.exec(String(target.name??'').replace(/\s+/g,' ').trim());
  return match?{label:'Closed',count:match[1]}:null;
}
export function isClosedCounterEvidence(candidate){
  const e=candidate?.statusCounter;
  return candidate?.role==='button'&&candidate.tag==='button'&&candidate.visible!==false&&!candidate.submits&&!candidate.inForm&&!candidate.inDialog
    &&e?.kind==='exceptions-status-counter-v1'&&e.label==='Closed'&&count.test(e.count??'')
    &&candidate.name===`Closed ${e.count}`&&JSON.stringify(e.labels)===JSON.stringify(EXCEPTION_STATUS_LABELS);
}
// Self-contained for serialization into the guarded browser. No site mutation, selectors by geometry or React internals.
export function statusCounterEvidence(el,labels){
  const clean=s=>String(s??'').replace(/\s+/g,' ').trim();
  if(location.origin!=='https://app.hadrius.com'||location.pathname.replace(/\/$/,'')!=='/account-surveillance'
    ||el.tagName!=='BUTTON'||el.closest('form,[role="dialog"],[role="alertdialog"],dialog'))return null;
  const group=el.parentElement,toolbar=group?.parentElement?.parentElement;
  if(!toolbar?.querySelector('input[placeholder="Search exceptions..."]'))return null;
  const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>3&&r.height>3&&s.display!=='none'&&s.visibility!=='hidden';};
  const parse=button=>{
    if(button.tagName!=='BUTTON'||!visible(button)||button.disabled||button.getAttribute('type')!=='button')return null;
    const spans=[...button.children];if(spans.length!==2||spans.some(x=>x.tagName!=='SPAN'||x.children.length))return null;
    const label=clean(spans[0].textContent),n=clean(spans[1].textContent);
    if(!labels.includes(label)||!/^(?:0|[1-9]\d?|99\+)$/.test(n)||clean(button.innerText)!==`${label} ${n}`)return null;
    return {label,count:n};
  };
  const buttons=[...group.children].filter(x=>x.tagName==='BUTTON'&&clean(x.innerText)!=='Clear all');
  const chips=buttons.map(parse);
  if(chips.length!==labels.length||chips.some((x,i)=>!x||x.label!==labels[i]))return null;
  const own=parse(el);return own?{kind:'exceptions-status-counter-v1',...own,labels:[...labels]}:null;
}
// Queue-context hrefs PLUS the actual status column establish a CLOSED table, not URL text alone.
export function closedFilterWitness(){
  const clean=s=>String(s??'').replace(/\s+/g,' ').trim();
  if(location.origin!=='https://app.hadrius.com'||location.pathname.replace(/\/$/,'')!=='/account-surveillance')return {verified:false,reason:'wrong_filter_page'};
  const tables=[...document.querySelectorAll('table')].filter(t=>[...t.querySelectorAll('tbody a[href]')].some(a=>{
    try{return /^\/account-surveillance\/rules\/violations\/\d+$/.test(new URL(a.href).pathname);}catch{return false;}}));
  if(tables.length!==1)return {verified:false,reason:'exception_table_not_unique_or_empty'};
  const table=tables[0],headers=[...table.querySelectorAll('thead th')].map(x=>clean(x.innerText)),indices=headers.flatMap((x,i)=>x==='Status'?[i]:[]);
  if(indices.length!==1)return {verified:false,reason:'status_column_not_unique'};
  const rows=[...table.querySelectorAll('tbody tr')].filter(row=>row.querySelector('a[href*="/account-surveillance/rules/violations/"]'));
  const facts=rows.map(row=>{
    const links=[...row.querySelectorAll('a[href]')].filter(a=>{try{return /^\/account-surveillance\/rules\/violations\/\d+$/.test(new URL(a.href).pathname);}catch{return false;}});
    const status=clean(row.children[indices[0]]?.innerText);
    const href=links.length===1?new URL(links[0].href):null,currentCompany=new URL(location.href).searchParams.get('company_id');
    const queueClosed=!!href&&href.origin===location.origin&&JSON.stringify(href.searchParams.getAll('source'))==='["overview"]'
      &&JSON.stringify(href.searchParams.getAll('filters'))==='["CLOSED"]'&&href.searchParams.getAll('company_id').length<=1
      &&(!currentCompany||!href.searchParams.has('company_id')||href.searchParams.get('company_id')===currentCompany);
    return {status,queueClosed};
  });
  return {verified:facts.length>0&&facts.every(x=>x.status==='Resolved'&&x.queueClosed),reason:facts.length?'closed_rows_and_queue_context':'no_closed_rows',rows:facts.length,statuses:[...new Set(facts.map(x=>x.status))]};
}
// Pinned page_specific_violation.tsx: the review-status label and badge share one row.
// A Reopen action alone also exists for Escalated, so it is not a CLOSED-state witness.
export function closedRecordWitness(){
  const clean=s=>String(s??'').replace(/\s+/g,' ').trim();
  if(location.origin!=='https://app.hadrius.com'||!/^\/account-surveillance\/rules\/violations\/\d+$/.test(location.pathname))return {verified:false,reason:'wrong_record_page'};
  const labels=[...document.querySelectorAll('p,span,div,dt')].filter(el=>{
    const r=el.getBoundingClientRect(),s=getComputedStyle(el);
    return el.children.length===0&&clean(el.innerText)==='Review status'&&r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';
  });
  if(labels.length!==1)return {verified:false,reason:'review_status_not_unique'};
  const row=clean(labels[0].parentElement?.innerText),match=/^Review status (Closed|Open|Escalated|Archived)$/.exec(row);
  return {verified:match?.[1]==='Closed',reason:match?.[1]==='Closed'?'review_status_closed':'review_status_not_closed',status:match?.[1]??null};
}
