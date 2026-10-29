// Screenshot drift comparison: recorded capture vs today's read-only recapture.
// Pure Node (zlib only). Import has no side effects; the CLI is guarded at the bottom.
// Never writes outside the run directory it is given; never touches scripts/ or out/.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inflateSync,deflateSync} from 'node:zlib';

// pixel: per-channel max abs difference that counts as "changed" (absorbs AA/compression noise).
// diffFraction / ssim apply to NON-dynamic pixels/windows. targetPx: max edge delta tolerated.
export const DEFAULT_THRESHOLDS=Object.freeze({pixel:24,diffFraction:0.002,ssim:0.98,targetPx:4,cell:16});

// ---------- PNG ----------
function crc32(b){let c=0xffffffff;for(let i=0;i<b.length;i++){c^=b[i];for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crcFast(b){let c=0xffffffff;for(let i=0;i<b.length;i++)c=CRC_TABLE[(c^b[i])&0xff]^(c>>>8);return (c^0xffffffff)>>>0;}
export function decodePng(buf){
  const b=Buffer.from(buf);
  if(b.length<33||!b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw new Error('invalid_png');
  let pos=8,ih=null;const idat=[];
  while(pos+12<=b.length){const n=b.readUInt32BE(pos),type=b.toString('ascii',pos+4,pos+8),data=b.subarray(pos+8,pos+8+n);
    if(type==='IHDR')ih=data;else if(type==='IDAT')idat.push(data);else if(type==='IEND')break;pos+=12+n;}
  if(!ih)throw new Error('invalid_png');
  const width=ih.readUInt32BE(0),height=ih.readUInt32BE(4),depth=ih[8],ctype=ih[9],interlace=ih[12];
  const ch={0:1,2:3,4:2,6:4}[ctype];
  if(depth!==8||!ch||interlace!==0)throw new Error('unsupported_png');
  const raw=inflateSync(Buffer.concat(idat)),stride=width*ch;
  if(raw.length!==(stride+1)*height)throw new Error('invalid_png');
  const px=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++){const f=raw[y*(stride+1)],src=y*(stride+1)+1,dst=y*stride;
    for(let x=0;x<stride;x++){const v=raw[src+x],a=x>=ch?px[dst+x-ch]:0,up=y?px[dst-stride+x]:0,ul=(y&&x>=ch)?px[dst-stride+x-ch]:0;let o;
      switch(f){case 0:o=v;break;case 1:o=v+a;break;case 2:o=v+up;break;case 3:o=v+((a+up)>>1);break;
        case 4:{const p=a+up-ul,pa=Math.abs(p-a),pb=Math.abs(p-up),pc=Math.abs(p-ul);o=v+(pa<=pb&&pa<=pc?a:pb<=pc?up:ul);break;}
        default:throw new Error('invalid_png');}
      px[dst+x]=o&255;}}
  const data=new Uint8Array(width*height*4);
  for(let i=0,j=0;i<width*height;i++,j+=ch){const o=i*4;
    if(ch===1){data[o]=data[o+1]=data[o+2]=px[j];data[o+3]=255;}
    else if(ch===2){data[o]=data[o+1]=data[o+2]=px[j];data[o+3]=px[j+1];}
    else if(ch===3){data[o]=px[j];data[o+1]=px[j+1];data[o+2]=px[j+2];data[o+3]=255;}
    else{data[o]=px[j];data[o+1]=px[j+1];data[o+2]=px[j+2];data[o+3]=px[j+3];}}
  return {width,height,data};
}
function chunk(type,data){const len=Buffer.alloc(4),sum=Buffer.alloc(4),name=Buffer.from(type);len.writeUInt32BE(data.length);sum.writeUInt32BE(crcFast(Buffer.concat([name,data])));return Buffer.concat([len,name,data,sum]);}
export function encodePng({width,height,data}){
  const stride=width*4,raw=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y++){raw[y*(stride+1)]=0;Buffer.from(data.buffer,data.byteOffset+y*stride,stride).copy(raw,y*(stride+1)+1);}
  const ih=Buffer.alloc(13);ih.writeUInt32BE(width,0);ih.writeUInt32BE(height,4);ih[8]=8;ih[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ih),chunk('IDAT',deflateSync(raw,{level:6})),chunk('IEND',Buffer.alloc(0))]);
}
export {crc32};

// ---------- metrics ----------
function rectMask(width,height,rects){const m=new Uint8Array(width*height);for(const r of rects||[]){const x0=Math.max(0,Math.floor(r.x)),y0=Math.max(0,Math.floor(r.y)),x1=Math.min(width,Math.ceil(r.x+r.w)),y1=Math.min(height,Math.ceil(r.y+r.h));for(let y=y0;y<y1;y++)m.fill(1,y*width+x0,y*width+x1);}return m;}
export function diffImages(a,b,{pixel=DEFAULT_THRESHOLDS.pixel}={}){
  if(a.width!==b.width||a.height!==b.height)throw new Error('dimension_mismatch');
  const n=a.width*a.height,mask=new Uint8Array(n);let changedPixels=0;
  for(let i=0;i<n;i++){const o=i*4;const d=Math.max(Math.abs(a.data[o]-b.data[o]),Math.abs(a.data[o+1]-b.data[o+1]),Math.abs(a.data[o+2]-b.data[o+2]));if(d>pixel){mask[i]=1;changedPixels++;}}
  return {mask,changedPixels,fraction:changedPixels/n};
}
const luma=(img)=>{const n=img.width*img.height,l=new Float64Array(n);for(let i=0;i<n;i++){const o=i*4;l[i]=0.299*img.data[o]+0.587*img.data[o+1]+0.114*img.data[o+2];}return l;};
// Mean SSIM over 8x8 windows (stride 4) on luma. Windows touching `exclude` are skipped.
export function ssim(a,b,{exclude=null,win=8,step=4}={}){
  if(a.width!==b.width||a.height!==b.height)return null;
  const w=a.width,h=a.height,la=luma(a),lb=luma(b),C1=(0.01*255)**2,C2=(0.03*255)**2;let sum=0,count=0;
  const W=Math.min(win,w),H=Math.min(win,h);
  for(let y=0;y+H<=h;y+=Math.min(step,H)){for(let x=0;x+W<=w;x+=Math.min(step,W)){
    let skip=false,ma=0,mb=0;
    for(let yy=y;yy<y+H&&!skip;yy++)for(let xx=x;xx<x+W;xx++){const i=yy*w+xx;if(exclude&&exclude[i]){skip=true;break;}ma+=la[i];mb+=lb[i];}
    if(skip)continue;const N=W*H;ma/=N;mb/=N;let va=0,vb=0,cv=0;
    for(let yy=y;yy<y+H;yy++)for(let xx=x;xx<x+W;xx++){const i=yy*w+xx,da=la[i]-ma,db=lb[i]-mb;va+=da*da;vb+=db*db;cv+=da*db;}
    va/=N-1||1;vb/=N-1||1;cv/=N-1||1;
    sum+=((2*ma*mb+C1)*(2*cv+C2))/((ma*ma+mb*mb+C1)*(va+vb+C2));count++;}}
  return count?sum/count:1;
}
// Connected components (8-neighbour) over a coarse grid of changed cells.
export function changedRegions(mask,width,height,{cell=DEFAULT_THRESHOLDS.cell}={}){
  const gw=Math.ceil(width/cell),gh=Math.ceil(height/cell),grid=new Uint8Array(gw*gh);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(mask[y*width+x])grid[Math.floor(y/cell)*gw+Math.floor(x/cell)]=1;
  const seen=new Uint8Array(gw*gh),out=[];
  for(let s=0;s<gw*gh;s++){if(!grid[s]||seen[s])continue;let x0=gw,y0=gh,x1=0,y1=0;const st=[s];seen[s]=1;
    while(st.length){const c=st.pop(),cx=c%gw,cy=(c-cx)/gw;x0=Math.min(x0,cx);y0=Math.min(y0,cy);x1=Math.max(x1,cx);y1=Math.max(y1,cy);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=cx+dx,ny=cy+dy;if(nx<0||ny<0||nx>=gw||ny>=gh)continue;const k=ny*gw+nx;if(grid[k]&&!seen[k]){seen[k]=1;st.push(k);}}}
    const x=x0*cell,y=y0*cell;out.push({x,y,w:Math.min(width,(x1+1)*cell)-x,h:Math.min(height,(y1+1)*cell)-y});}
  return out.sort((p,q)=>p.y-q.y||p.x-q.x);
}
export function classifyStep({dimensionsMatch,diffFractionNonDynamic,ssimMasked,target},T=DEFAULT_THRESHOLDS){
  if(target&&target.status&&target.status!=='resolved')return 'target_missing';
  if(target&&target.delta&&target.delta.max>T.targetPx)return 'target_geometry_changed';
  if(!dimensionsMatch)return 'screenshot_changed';
  if(diffFractionNonDynamic>T.diffFraction||(ssimMasked!=null&&ssimMasked<T.ssim))return 'screenshot_changed';
  return 'unchanged';
}
const r6=(v)=>v==null?null:Math.round(v*1e6)/1e6;
export function compareImages(a,b,{dynamicRects=[],cell=DEFAULT_THRESHOLDS.cell,thresholds=DEFAULT_THRESHOLDS,target=null}={}){
  if(a.width!==b.width||a.height!==b.height){const res={dimensionsMatch:false,recorded:{w:a.width,h:a.height},today:{w:b.width,h:b.height},changedPixels:null,diffFraction:null,diffFractionNonDynamic:null,dynamicChangedPixels:null,ssim:null,ssimMasked:null,regions:[]};res.classification=classifyStep({...res,target},thresholds);return res;}
  const {mask,changedPixels,fraction}=diffImages(a,b,{pixel:thresholds.pixel});
  const dyn=rectMask(a.width,a.height,dynamicRects);let nonDyn=0,dynChanged=0;
  for(let i=0;i<mask.length;i++)if(mask[i]){if(dyn[i])dynChanged++;else nonDyn++;}
  const regions=changedRegions(mask,a.width,a.height,{cell}).map(r=>{let nd=0,all=0;for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++){const i=y*a.width+x;if(mask[i]){all++;if(!dyn[i])nd++;}}return {...r,changedPixels:all,dynamic:nd===0};});
  const res={dimensionsMatch:true,recorded:{w:a.width,h:a.height},today:{w:b.width,h:b.height},changedPixels,diffFraction:r6(fraction),diffFractionNonDynamic:r6(nonDyn/mask.length),dynamicChangedPixels:dynChanged,ssim:r6(ssim(a,b)),ssimMasked:dynamicRects.length?r6(ssim(a,b,{exclude:dyn})):r6(ssim(a,b)),regions};
  Object.defineProperty(res,'mask',{value:mask,enumerable:false});Object.defineProperty(res,'dynMask',{value:dyn,enumerable:false});
  res.classification=classifyStep({...res,target},thresholds);return res;
}

// ---------- images for humans ----------
function blank(w,h,[r,g,bb]=[255,255,255]){const d=new Uint8Array(w*h*4);for(let i=0;i<w*h;i++){d[i*4]=r;d[i*4+1]=g;d[i*4+2]=bb;d[i*4+3]=255;}return {width:w,height:h,data:d};}
function strokeRect(img,r,[cr,cg,cb],t=3){if(!r)return;const put=(x,y)=>{if(x<0||y<0||x>=img.width||y>=img.height)return;const o=(y*img.width+x)*4;img.data[o]=cr;img.data[o+1]=cg;img.data[o+2]=cb;img.data[o+3]=255;};
  for(let k=0;k<t;k++){for(let x=r.x;x<r.x+r.w;x++){put(x,r.y+k);put(x,r.y+r.h-1-k);}for(let y=r.y;y<r.y+r.h;y++){put(r.x+k,y);put(r.x+r.w-1-k,y);}}}
// Diff view: today's frame faded; changed px red, dynamic-region changes yellow, dynamic rects blue,
// recorded target magenta, today's target cyan.
export function renderDiff(today,cmp,{dynamicRects=[],recordedTarget=null,todayTarget=null}={}){
  const out={width:today.width,height:today.height,data:new Uint8Array(today.data)};
  for(let i=0;i<today.width*today.height;i++){const o=i*4;const g=0.299*today.data[o]+0.587*today.data[o+1]+0.114*today.data[o+2];const v=Math.round(200+g*0.2);out.data[o]=out.data[o+1]=out.data[o+2]=v;
    if(cmp.mask&&cmp.mask[i]){if(cmp.dynMask[i]){out.data[o]=240;out.data[o+1]=200;out.data[o+2]=0;}else{out.data[o]=230;out.data[o+1]=0;out.data[o+2]=0;}}}
  for(const r of dynamicRects)strokeRect(out,{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.w),h:Math.round(r.h)},[30,90,255],2);
  for(const r of cmp.regions||[])strokeRect(out,r,r.dynamic?[240,200,0]:[230,0,0],2);
  strokeRect(out,recordedTarget,[220,0,220],3);strokeRect(out,todayTarget,[0,200,220],3);
  return out;
}
export function scale(img,f){const w=Math.round(img.width*f),h=Math.round(img.height*f),d=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const x0=Math.floor(x/f),y0=Math.floor(y/f),x1=Math.min(img.width,Math.floor((x+1)/f)),y1=Math.min(img.height,Math.floor((y+1)/f));let s=[0,0,0,0],n=0;
    for(let yy=y0;yy<Math.max(y1,y0+1);yy++)for(let xx=x0;xx<Math.max(x1,x0+1);xx++){const o=(yy*img.width+xx)*4;s[0]+=img.data[o];s[1]+=img.data[o+1];s[2]+=img.data[o+2];s[3]+=img.data[o+3];n++;}
    const o=(y*w+x)*4;for(let k=0;k<4;k++)d[o+k]=Math.round(s[k]/n);}return {width:w,height:h,data:d};}
function blit(dst,src,ox,oy){for(let y=0;y<src.height;y++){const dy=oy+y;if(dy<0||dy>=dst.height)continue;for(let x=0;x<src.width;x++){const dx=ox+x;if(dx<0||dx>=dst.width)continue;const s=(y*src.width+x)*4,o=(dy*dst.width+dx)*4;for(let k=0;k<4;k++)dst.data[o+k]=src.data[s+k];}}}
const BAR={unchanged:[40,170,80],screenshot_changed:[230,140,0],target_geometry_changed:[220,0,220],target_missing:[220,0,0],needs_fixture:[60,60,200]};
// rows: [{classification, images:[recorded, today, diff]}] -> one PNG, columns recorded | today | diff.
export function contactSheet(rows,{f=0.5,gap=12,bar=14}={}){
  const cells=rows.map(r=>r.images.map(i=>i?scale(i,f):null));const cw=Math.max(...cells.flat().filter(Boolean).map(i=>i.width)),ch=Math.max(...cells.flat().filter(Boolean).map(i=>i.height));
  const sheet=blank(gap+3*(cw+gap),gap+rows.length*(ch+bar+gap),[245,245,245]);
  rows.forEach((r,ri)=>{const y=gap+ri*(ch+bar+gap);blit(sheet,blank(3*(cw+gap)-gap,bar,BAR[r.classification]||[120,120,120]),gap,y);
    cells[ri].forEach((img,ci)=>{if(img)blit(sheet,img,gap+ci*(cw+gap),y+bar);});});
  return sheet;
}

// ---------- CLI ----------
// node tools/drift/compare.mjs --run RUN_DIR --recordings RECORDING_DIR
// Reads RUN_DIR/run.json (written by capture.mjs) and writes compare.json, diff-NN.png, contact-sheet.png.
export function compareRun({runDir,recordingsDir,thresholds=DEFAULT_THRESHOLDS}){
  const run=JSON.parse(readFileSync(join(runDir,'run.json'),'utf8'));const steps=[],rows=[];
  for(const s of run.steps){
    const entry={index:s.index,action:s.action,url:s.url,todayUrl:s.todayUrl??null,recordedMedia:s.recordedMedia??null,todayScreenshot:s.screenshot??null,
      mutationGuard:s.mutationGuard??null,prerequisiteUnverified:!!s.prerequisiteUnverified};
    if(!s.screenshot||!s.recordedMedia){entry.classification=s.mutationGuard?.status==='needs_fixture'?'needs_fixture':s.target?.status&&s.target.status!=='resolved'?'target_missing':'not_captured';
      entry.reason=s.mutationGuard?.reason??s.error??'no screenshot';steps.push(entry);continue;}
    const rec=decodePng(readFileSync(join(recordingsDir,s.recordedMedia))),today=decodePng(readFileSync(join(runDir,s.screenshot)));
    const target=s.target?{status:s.target.status,delta:s.target.delta??null}:null;
    const cmp=compareImages(rec,today,{dynamicRects:s.dynamicRects??[],thresholds,target,cell:thresholds.cell});
    const diffName=`diff-${String(s.index).padStart(2,'0')}.png`;
    const diff=cmp.dimensionsMatch?renderDiff(today,cmp,{dynamicRects:s.dynamicRects??[],recordedTarget:s.target?.recordedRect??null,todayTarget:s.target?.rect??null}):blank(today.width,today.height,[255,0,0]);
    writeFileSync(join(runDir,diffName),encodePng(diff),{flag:'wx'});
    Object.assign(entry,{classification:cmp.classification,dimensions:{recorded:cmp.recorded,today:cmp.today,match:cmp.dimensionsMatch},changedPixels:cmp.changedPixels,diffFraction:cmp.diffFraction,diffFractionNonDynamic:cmp.diffFractionNonDynamic,dynamicChangedPixels:cmp.dynamicChangedPixels,ssim:cmp.ssim,ssimMasked:cmp.ssimMasked,regions:cmp.regions,dynamicRegions:s.dynamicRects??[],target:s.target??null,diff:diffName});
    steps.push(entry);rows.push({classification:cmp.classification,images:[rec,today,diff]});
  }
  const sheet=rows.length?contactSheet(rows):null;if(sheet)writeFileSync(join(runDir,'contact-sheet.png'),encodePng(sheet),{flag:'wx'});
  const report={schema:1,script:run.script,recordingId:run.recordingId,thresholds,legend:{columns:'recorded | today | diff',diffColours:{red:'changed (non-dynamic)',yellow:'changed inside detected dynamic text',blue:'dynamic text rect (today DOM)',magenta:'recorded target rect',cyan:"today's resolved target rect"},barColours:{green:'unchanged',orange:'screenshot_changed',magenta:'target_geometry_changed',red:'target_missing',blue:'needs_fixture (pre-action shot of the step the guard stopped at)'}},steps,contactSheet:sheet?'contact-sheet.png':null};
  writeFileSync(join(runDir,'compare.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}
function arg(args,name){const i=args.indexOf(name);return i>=0?args[i+1]:undefined;}
export function main(args=process.argv.slice(2)){
  const runDir=arg(args,'--run'),recordingsDir=arg(args,'--recordings');
  if(!runDir||!recordingsDir)throw new Error('usage: compare.mjs --run RUN_DIR --recordings RECORDING_DIR');
  if(!existsSync(join(resolve(runDir),'run.json')))throw new Error('run.json not found');
  const r=compareRun({runDir:resolve(runDir),recordingsDir:resolve(recordingsDir)});
  console.log(JSON.stringify(r.steps.map(s=>({index:s.index,classification:s.classification,diffFraction:s.diffFraction,diffFractionNonDynamic:s.diffFractionNonDynamic,ssim:s.ssim,ssimMasked:s.ssimMasked,regions:s.regions?.length})),null,2));return r;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{main();}catch(e){console.error(e.message);process.exitCode=1;}}
