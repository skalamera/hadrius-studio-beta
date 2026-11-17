// classifyRun's offline disambiguation at a recording's own pixel ratio: boxes are CSS px, so today's viewport is the
// run's CSS viewport, and the visual check (which reads boxes as image px) is skipped unless the ratio is 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {encodePng} from '../../tools/drift/compare.mjs';
import {classifyRun} from '../../tools/drift/classify.mjs';

const blank=(w,h)=>encodePng({width:w,height:h,data:new Uint8Array(w*h*4).fill(255)});
const URL_='https://app.hadrius.com/testing-program/policies?company_id=1150';

function fixture(k){
  const dir=mkdtempSync(join(tmpdir(),'drift-cls-geo-'));const rec=join(dir,'rec');mkdirSync(rec);const runDir=join(dir,'run');mkdirSync(runDir);
  const vp={width:400,height:200},recordedRect={x:100,y:50,w:40,h:20};
  writeFileSync(join(rec,'r0.png'),blank(vp.width*k,vp.height*k));writeFileSync(join(runDir,'t0.png'),blank(vp.width*k,vp.height*k));
  const A={role:'button',name:'Edit',bbox:{x:100,y:50,w:40,h:20}},B={role:'button',name:'Edit',bbox:{x:300,y:150,w:40,h:20}};
  writeFileSync(join(runDir,'run.json'),JSON.stringify({script:'g',status:'captured',viewport:vp,deviceScaleFactor:k,findings:[],
    steps:[{index:0,action:'click',url:URL_,todayUrl:URL_,screenshot:'t0.png',recordedMedia:'r0.png',
      target:{status:'ambiguous',method:'role_name',matches:[A,B],recordedRect,notes:[]}}]}));
  writeFileSync(join(runDir,'compare.json'),JSON.stringify({steps:[{index:0,todayUrl:URL_,todayScreenshot:'t0.png',classification:'target_missing',
    dimensions:{match:true},diffFractionNonDynamic:0,ssimMasked:1,regions:[]}]}));
  const script={name:'g',steps:[{index:0,action:'click',url:URL_,dpr:k,narration:'Click Edit.',media:{pre:'r0.png'},
    target:{role:'button',name:'Edit',hint:{bbox:recordedRect,viewport:{w:vp.width,h:vp.height}}}}]};
  return {runDir,rec,script};
}

test('classifyRun: offline disambiguation at pixel ratio 2 compares CSS boxes against the CSS viewport, position-only', async () => {
  const {runDir,rec,script}=fixture(2);
  const out=await classifyRun({runDir,script,recordingsDir:rec,write:false});
  const t=out.steps[0].target;
  assert.equal(t.status,'resolved','the recorded box sits exactly on candidate A');
  assert.equal(t.disambiguation.chosen,0);assert.equal(t.disambiguation.method,'bbox');
  assert.equal(t.disambiguation.imagesUsed,false,'no visual check when boxes are not image px');
  assert.equal(t.offline,true);
});

test('classifyRun: at pixel ratio 1 the offline disambiguation still uses the images', async () => {
  const {runDir,rec,script}=fixture(1);
  const out=await classifyRun({runDir,script,recordingsDir:rec,write:false});
  assert.equal(out.steps[0].target.disambiguation.imagesUsed,true);
});
