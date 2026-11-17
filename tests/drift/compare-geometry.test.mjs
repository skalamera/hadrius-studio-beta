// compareRun at a recording's own pixel ratio: DOM boxes (CSS px) must land on the same image pixels they cover.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {compareRun,encodePng} from '../../tools/drift/compare.mjs';

const img=(w,h,block=null)=>{const d=new Uint8Array(w*h*4).fill(255);
  if(block)for(let y=block.y;y<block.y+block.h;y++)for(let x=block.x;x<block.x+block.w;x++){const o=(y*w+x)*4;d[o]=d[o+1]=d[o+2]=0;}
  return encodePng({width:w,height:h,data:d});};

test('compareRun: data boxes are scaled by the run deviceScaleFactor, so a change inside a record row stays data-only', () => {
  const dir=mkdtempSync(join(tmpdir(),'drift-cmp-geo-'));const rec=join(dir,'rec');mkdirSync(rec);const runDir=join(dir,'run');mkdirSync(runDir);
  // 2x frames: the record row is CSS {x:60,y:20,w:40,h:20} = image {120,40,80,40}; today's change is inside it in image px.
  writeFileSync(join(rec,'r.png'),img(320,160));
  writeFileSync(join(runDir,'t.png'),img(320,160,{x:130,y:45,w:60,h:30}));
  writeFileSync(join(runDir,'run.json'),JSON.stringify({script:'s',recordingId:'r',viewport:{width:160,height:80},deviceScaleFactor:2,
    steps:[{index:0,action:'click',screenshot:'t.png',recordedMedia:'r.png',dynamicRects:[],dataRects:[{x:60,y:20,w:40,h:20}],target:{status:'resolved',delta:{max:0}}}]}));
  const report=compareRun({runDir,recordingsDir:rec});
  const s=report.steps[0];
  assert.ok(s.dataChangedPixels>0,'the change is counted inside the data area');
  assert.equal(s.diffFractionUi,0,'no UI pixels changed outside the data area');
  assert.equal(s.dataOnly,true);
  assert.deepEqual(JSON.parse(readFileSync(join(runDir,'compare.json'),'utf8')).steps[0].dataRegions,[{x:60,y:20,w:40,h:20}],'stored boxes stay CSS px');
});
