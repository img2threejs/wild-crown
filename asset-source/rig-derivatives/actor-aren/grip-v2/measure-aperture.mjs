import { writeFile } from 'node:fs/promises';
import { inspectGrip } from './inspect-grip.mjs';
const { slices }=await inspectGrip();
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
function pointSegment(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],alpha=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)));const q=[a[0]+alpha*dx,a[1]+alpha*dy];return {distance:distance(p,q),point:q};}
function loops(segments){const key=p=>p.map(v=>Math.round(v*1e7)).join(','),map=new Map();for(let i=0;i<segments.length;i++)for(const p of segments[i]){const k=key(p);if(!map.has(k))map.set(k,[]);map.get(k).push(i);}const used=new Set(),result=[];for(let i=0;i<segments.length;i++){if(used.has(i))continue;const curve=[segments[i][0],segments[i][1]];used.add(i);for(let count=0;count<segments.length;count++){const at=curve.at(-1),next=(map.get(key(at))??[]).find(n=>!used.has(n));if(next===undefined)break;used.add(next);const [a,b]=segments[next];curve.push(key(a)===key(at)?b:a);}if(curve.length>4)result.push(curve);}return result.sort((a,b)=>b.length-a.length);}
function inside(point,poly){let crosses=0;for(let i=0;i<poly.length-1;i++){const a=poly[i],b=poly[i+1];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])crosses++;}return crosses%2===1;}
const summaries=slices.map(s=>({y:s.y,bodyLoops:loops(s.segments).map(c=>({vertices:c.length,min:[Math.min(...c.map(p=>p[0])),Math.min(...c.map(p=>p[1]))],max:[Math.max(...c.map(p=>p[0])),Math.max(...c.map(p=>p[1]))]})),staffLoops:loops(s.staffSegments).map(c=>({vertices:c.length,min:[Math.min(...c.map(p=>p[0])),Math.min(...c.map(p=>p[1]))],max:[Math.max(...c.map(p=>p[0])),Math.max(...c.map(p=>p[1]))]}))}));
const slice=slices.find(s=>s.y===.435),body=loops(slice.segments),shaft=loops(slice.staffSegments)[0];
if(body.length!==2)throw new Error('Measured thumb/palm cross section did not resolve exactly two curves');
const curves=body.map(c=>c.filter((p,i)=>i%8===0||i===c.length-1)),shaftSamples=shaft.filter((p,i)=>i%8===0||i===shaft.length-1);
const constraints=slices.map(s=>({body:loops(s.segments),shaft:loops(s.staffSegments).flatMap(c=>c.filter((p,i)=>i%8===0||i===c.length-1))}));
let best=null,feasible=0;
for(let ix=0;ix<=80;ix++)for(let iz=0;iz<=100;iz++){
 const translation=[-.04+ix*.001,-.115+iz*.001];const shifted=shaftSamples.map(p=>[p[0]+translation[0],p[1]+translation[1]]);
 if(constraints.some(s=>s.shaft.some(p=>s.body.some(c=>inside([p[0]+translation[0],p[1]+translation[1]],c)))))continue;
 const contacts=curves.map(curve=>{let best={distance:Infinity};for(const p of shifted)for(let j=0;j<curve.length-1;j++){const q=pointSegment(p,curve[j],curve[j+1]);if(q.distance<best.distance)best={...q,staffPoint:p};}return best;});
 const center=shifted.reduce((sum,p)=>[sum[0]+p[0]/shifted.length,sum[1]+p[1]/shifted.length],[0,0]);
 const a=contacts[0].point.map((v,i)=>v-center[i]),b=contacts[1].point.map((v,i)=>v-center[i]),angle=Math.acos(Math.max(-1,Math.min(1,(a[0]*b[0]+a[1]*b[1])/(Math.hypot(...a)*Math.hypot(...b)))));
 if(angle<Math.PI/2)continue;feasible++;const score=Math.max(...contacts.map(c=>c.distance));if(!best||score<best.maxContactGap)best={translation,contacts,center,contactOppositionRadians:angle,maxContactGap:score};
}
const output={scope:'Bounded actual palm/finger + thumb cross-section, not arbitrary body-nearest attachment. Coarse search is diagnostic, not contact/penetration proof.',sliceSummaries:summaries,grid:{xNative:[-.04,.04],zNative:[-.115,-.015],stepNative:.001,orientation:'Original upright staff, no rotation/scale',samples:8181},feasibleCoarseCandidates:feasible,bestCoarseCandidate:best,productionAccepted:false};
await writeFile(new URL('aperture-measurements.json',import.meta.url),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2));
