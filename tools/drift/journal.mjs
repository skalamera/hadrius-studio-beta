// Write-ahead journal for drift fixture runs (job-owned '[Studio QA]' test records in Academy prod).
// Import-safe: no side effects at import. One append-only JSONL file per run:
//   <dir>/<runId>.jsonl     (default dir: <repo>/out/_drift-fixtures/journal, gitignored via out/)
// Every entry is fsync'd BEFORE the action it announces (create / mutate / undo / cleanup), so a crash at
// any point leaves enough to reconcile: the record's unique label is journaled before its create request
// is sent, and its id as soon as the create response arrives.
import {mkdirSync,openSync,writeSync,fsyncSync,closeSync,readFileSync,readdirSync,existsSync,unlinkSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

export const REPO=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
export const DEFAULT_JOURNAL_DIR=join(REPO,'out','_drift-fixtures','journal');
const RUN_ID_RE=/^[0-9]{8}T[0-9]{6}Z-[a-z0-9]{4,12}$/;

/** Run ids carry their UTC start time (used by the sweep to age '[Studio QA]' labels). */
export function newRunId(now=new Date(),rand=Math.random){
  const s=now.toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
  return `${s}-${Math.floor(rand()*36**6).toString(36).padStart(6,'0')}`;}
export function isRunId(s){return RUN_ID_RE.test(String(s??''));}
export function runIdTime(runId){const m=/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(String(runId??''));
  return m?Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]):null;}

function appendDurable(file,obj){const fd=openSync(file,'a',0o600);try{writeSync(fd,obj==null?'\n':JSON.stringify(obj)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}

/** -> {runId,file,append(type,data)->entry,entries()} ; append is synchronous + fsync'd. */
export function openJournal({dir=DEFAULT_JOURNAL_DIR,runId,now=()=>new Date()}={}){
  if(!isRunId(runId))throw new Error('invalid_run_id');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const file=join(dir,`${runId}.jsonl`);let seq=0;
  if(existsSync(file)){const e=readJournalFile(file);seq=e.length?Math.max(...e.map(x=>Number(x.seq)||0))+1:0;
    // A crash mid-write leaves a torn last line: terminate it so the next entry starts on its own line.
    const raw=readFileSync(file,'utf8');if(raw.length&&!raw.endsWith('\n'))appendDurable(file,null);}
  return {runId,file,append(type,data={}){const e={seq:seq++,at:now().toISOString(),runId,type,...data};appendDurable(file,e);return e;},
    entries:()=>readJournalFile(file)};
}
/** Torn last line (crash mid-write) is ignored; every complete line is kept. */
export function readJournalFile(file){const out=[];for(const line of readFileSync(file,'utf8').split('\n')){if(!line.trim())continue;try{out.push(JSON.parse(line));}catch{}}return out;}
export function listJournals(dir=DEFAULT_JOURNAL_DIR){if(!existsSync(dir))return [];
  return readdirSync(dir).filter(f=>f.endsWith('.jsonl')&&isRunId(f.slice(0,-6))).sort().map(f=>({runId:f.slice(0,-6),file:join(dir,f)}));}

/** Pure reduction of a run's entries.
 *  -> {runId, video, ended, endStatus, fixtures:{key:{key,recordType,name,label,id,createIntent,created,cleanupIntent,cleaned,verifiedAbsent,mutations:[]}}, open:boolean}
 *  A run is "open" (needs reconcile) when it has no run_end, or any fixture with a create intent is not verified absent. */
export function reduceJournal(entries){
  const st={runId:entries[0]?.runId??null,video:null,ended:false,endStatus:null,fixtures:{},reconciledBy:null};
  const fx=(e)=>st.fixtures[e.fixture]??=({key:e.fixture,recordType:e.recordType??null,name:e.name??null,label:e.label??null,id:null,createIntent:false,created:false,
    cleanupIntent:false,cleaned:false,verifiedAbsent:false,mutations:[]});
  for(const e of entries){
    switch(e.type){
      case 'run_begin':st.video=e.video??null;st.spec=e.spec??null;break;
      case 'create_intent':{const f=fx(e);f.createIntent=true;f.recordType=e.recordType??f.recordType;f.name=e.name??f.name;f.label=e.label??f.label;f.via=e.via??null;break;}
      case 'created':{const f=fx(e);f.created=true;if(e.id!=null)f.id=e.id;break;}
      case 'create_failed':{const f=fx(e);f.createFailed=e.reason??true;break;}
      case 'mutate_intent':fx(e).mutations.push({step:e.step,done:false,undone:false});break;
      case 'mutated':{const m=fx(e).mutations.findLast?.(x=>x.step===e.step)??null;if(m)m.done=true;break;}
      case 'undo_intent':break;
      case 'undone':{const m=fx(e).mutations.findLast?.(x=>x.step===e.step)??null;if(m)m.undone=true;break;}
      case 'cleanup_intent':{const f=fx(e);f.cleanupIntent=true;if(e.id!=null)f.id=e.id;break;}
      case 'cleaned':fx(e).cleaned=true;break;
      case 'verified_absent':{const f=fx(e);f.verifiedAbsent=true;f.cleaned=true;break;}
      case 'run_end':st.ended=true;st.endStatus=e.status??null;break;
      case 'reconciled_by':st.reconciledBy=e.by??null;break;
    }
  }
  const dirty=Object.values(st.fixtures).filter(f=>f.createIntent&&!f.verifiedAbsent);
  st.open=!st.ended||dirty.length>0;st.dirty=dirty.map(f=>f.key);
  return st;
}
export function openRuns(dir=DEFAULT_JOURNAL_DIR,{exceptRunId=null}={}){
  return listJournals(dir).filter(j=>j.runId!==exceptRunId).map(j=>({...j,state:reduceJournal(readJournalFile(j.file))})).filter(j=>j.state.open);}

// ---------- single-runner lock (stale when the pid is gone) ----------
const alive=(pid)=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
export function acquireLock(dir=DEFAULT_JOURNAL_DIR,{pid=process.pid,isAlive=alive}={}){
  mkdirSync(dir,{recursive:true,mode:0o700});const f=join(dir,'fixtures.lock');
  if(existsSync(f)){let o=null;try{o=JSON.parse(readFileSync(f,'utf8'));}catch{}
    if(o?.pid&&o.pid!==pid&&isAlive(o.pid))return {ok:false,heldBy:o};}
  writeFileSync(f,JSON.stringify({pid,at:new Date().toISOString()})+'\n',{mode:0o600});
  return {ok:true,file:f,release(){try{const o=JSON.parse(readFileSync(f,'utf8'));if(o.pid===pid)unlinkSync(f);}catch{}}};
}
