import {createHash,randomUUID} from 'node:crypto';
export function requireValue(ok,code){if(!ok)throw Object.assign(new Error(code),{code});}
export function canonical(value){
  if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'){requireValue(Number.isFinite(value),'invalid_json');return JSON.stringify(value);}
  requireValue(value&&typeof value==='object'&&(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype),'invalid_json');
  if(Array.isArray(value)){requireValue(Object.keys(value).length===value.length,'invalid_json');return `[${value.map(canonical).join(',')}]`;}
  return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export const bytesDigest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const digest=value=>bytesDigest(canonical(value));
export function identify(script,makeId=randomUUID){
  canonical(script);requireValue(script&&Array.isArray(script.steps),'invalid_script');const out=structuredClone(script);
  if(!Object.hasOwn(out,'id'))out.id=makeId();
  requireValue(typeof out.id==='string'&&out.id.length>0,'invalid_id');
  for(const step of out.steps){requireValue(step&&typeof step==='object'&&!Array.isArray(step),'invalid_step');if(!Object.hasOwn(step,'id'))step.id=makeId();requireValue(typeof step.id==='string'&&step.id.length>0,'invalid_id');}
  requireValue(new Set(out.steps.map(s=>s.id)).size===out.steps.length,'duplicate_step_id');return out;
}
const allowed=new Set(['media','captureId','target','dpr']);
// Strip only geometry to ensure semantic target selectors cannot silently change.
function semantics(target){const copy=structuredClone(target??{});if(copy&&typeof copy==='object'){delete copy.bbox;delete copy.viewport;if(copy.hint){delete copy.hint.bbox;delete copy.hint.viewport;if(!Object.keys(copy.hint).length)delete copy.hint;}}return copy;}
export function applyVisualPatch(base,plan,replacements){
  requireValue(digest(base)===plan?.baseHash,'base_conflict');
  requireValue(base.id&&base.steps.every(s=>s.id),'identity_required');identify(base);
  requireValue(Array.isArray(plan.structuralChanges)&&plan.structuralChanges.length===0,'needs_structural_review');
  requireValue(Array.isArray(plan.changes)&&Array.isArray(replacements),'invalid_patch');
  const changes=new Map(plan.changes.map(c=>[c.stepId,c]));const fresh=new Map(replacements.map(r=>[r.stepId,r.fields]));
  requireValue(changes.size===plan.changes.length&&fresh.size===replacements.length,'duplicate_replacement');
  requireValue(changes.size===fresh.size&&[...changes.keys()].every(id=>fresh.has(id)),'capture_set_mismatch');
  requireValue([...changes.keys()].every(id=>base.steps.some(s=>s.id===id)),'unknown_step');
  const out=structuredClone(base);out.steps=out.steps.map(old=>{if(!changes.has(old.id))return old;
    requireValue(digest(old)===changes.get(old.id).beforeHash,'step_conflict');requireValue(old.capture!==false,'not_a_slide');const fields=fresh.get(old.id);
    requireValue(fields&&Object.keys(fields).every(k=>allowed.has(k)),'field_not_allowed');canonical(fields);
    requireValue(typeof fields.media?.pre==='string'&&fields.media.pre.length>0,'capture_required');
    requireValue(digest({...old.media,pre:fields.media.pre})===digest(fields.media),'field_not_allowed');
    if(Object.hasOwn(fields,'target')){
      requireValue(canonical(semantics(fields.target))===canonical(semantics(old.target??null)),'field_not_allowed');
      for(const geom of [fields.target,fields.target?.hint]){
        if(!geom)continue;
        if(Object.hasOwn(geom,'bbox'))requireValue(geom.bbox&&['x','y','w','h'].every(k=>Number.isFinite(geom.bbox[k]))&&geom.bbox.w>0&&geom.bbox.h>0,'invalid_geometry');
        if(Object.hasOwn(geom,'viewport'))requireValue(geom.viewport&&['w','h'].every(k=>Number.isFinite(geom.viewport[k])&&geom.viewport[k]>0),'invalid_geometry');
      }
    }
    if(Object.hasOwn(fields,'dpr'))requireValue(Number.isFinite(fields.dpr)&&fields.dpr>0,'invalid_geometry');
    return {...old,...structuredClone(fields)};
  });return out;
}
