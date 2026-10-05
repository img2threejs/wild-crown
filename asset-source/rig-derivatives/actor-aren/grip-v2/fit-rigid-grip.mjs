import { writeFile } from 'node:fs/promises';
import { Vector3,Matrix4 } from 'three';
import { inspectGrip } from './inspect-grip.mjs';
export function loops(segments){const key=p=>p.map(v=>Math.round(v*1e7)).join(','),map=new Map();for(let i=0;i<segments.length;i++)for(const p of segments[i]){const k=key(p);if(!map.has(k))map.set(k,[]);map.get(k).push(i);}const used=new Set(),result=[];for(let i=0;i<segments.length;i++){if(used.has(i))continue;const curve=[segments[i][0],segments[i][1]];used.add(i);for(let count=0;count<segments.length;count++){const at=curve.at(-1),next=(map.get(key(at))??[]).find(n=>!used.has(n));if(next===undefined)break;used.add(next);const [a,b]=segments[next];curve.push(key(a)===key(at)?b:a);}if(curve.length>4)result.push(curve);}return result.sort((a,b)=>b.length-a.length);}
export function inside(point,poly){let crosses=0;for(let i=0;i<poly.length-1;i++){const a=poly[i],b=poly[i+1];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])crosses++;}return crosses%2===1;}
export function pointSegment(p,a,b){const dx=b[0]-a[0],dy=b[1]-a[1],alpha=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)));const q=[a[0]+alpha*dx,a[1]+alpha*dy];return {distance:Math.hypot(p[0]-q[0],p[1]-q[1]),point:q};}
function sections(positions,triangles,y){const segments=[];for(const tri of triangles){const qs=tri.map(v=>new Vector3().fromArray(positions,3*v)),cuts=[];for(let a=0;a<3;a++){const b=(a+1)%3;if((qs[a].y<=y&&qs[b].y>y)||(qs[b].y<=y&&qs[a].y>y))cuts.push(qs[a].clone().lerp(qs[b],(y-qs[a].y)/(qs[b].y-qs[a].y)));}if(cuts.length===2)segments.push(cuts.map(q=>[q.x,q.z]));}return segments;}
export const pivot=new Vector3(-.0415,.435,.1993);
export function rigidMatrix(angleX,angleZ,dx,dz){const rotation=new Matrix4().makeRotationZ(angleZ).multiply(new Matrix4().makeRotationX(angleX));return new Matrix4().makeTranslation(dx+pivot.x,pivot.y,dz+pivot.z).multiply(rotation).multiply(new Matrix4().makeTranslation(-pivot.x,-pivot.y,-pivot.z));}
if(process.argv[1]===new URL(import.meta.url).pathname){
const anatomy=await inspectGrip(),body=anatomy.slices.map(s=>loops(s.segments)),opposed=body[4];
if(opposed.length!==2)throw new Error('Actual hand cross section requires two separate opposing feature curves');
const simplified=opposed.map(c=>c.filter((p,i)=>i%8===0||i===c.length-1));
const fits=[];let best=null;
for(const angleX of [-1.2,-.9,-.6,-.3,0,.3,.6,.9,1.2])for(const angleZ of [-1.2,-.9,-.6,-.3,0,.3,.6,.9,1.2]){
 const m=rigidMatrix(angleX,angleZ,0,0),rotated=new Float64Array(anatomy.positions.length);
 for(const v of anatomy.staff)new Vector3().fromArray(anatomy.positions,3*v).applyMatrix4(m).toArray(rotated,3*v);
 const shaft=anatomy.slices.map(s=>loops(sections(rotated,anatomy.staffTriangles,s.y)).flatMap(c=>c.filter((p,i)=>i%8===0||i===c.length-1)));
 let orientationBest=null;
 for(let ix=0;ix<=40;ix++)for(let iz=0;iz<=50;iz++){
  const dx=-.04+ix*.002,dz=-.115+iz*.002;
  if(shaft.some((points,j)=>points.some(p=>body[j].some(c=>inside([p[0]+dx,p[1]+dz],c)))))continue;
  const shifted=shaft[4].map(p=>[p[0]+dx,p[1]+dz]);if(!shifted.length)continue;
  const contacts=simplified.map(curve=>{let best={distance:Infinity};for(const p of shifted)for(let j=0;j<curve.length-1;j++){const q=pointSegment(p,curve[j],curve[j+1]);if(q.distance<best.distance)best={...q,staffPoint:p};}return best;});
  const center=shifted.reduce((sum,p)=>[sum[0]+p[0]/shifted.length,sum[1]+p[1]/shifted.length],[0,0]);
  const a=contacts[0].point.map((v,i)=>v-center[i]),b=contacts[1].point.map((v,i)=>v-center[i]),angle=Math.acos(Math.max(-1,Math.min(1,(a[0]*b[0]+a[1]*b[1])/(Math.hypot(...a)*Math.hypot(...b)))));
  if(angle<Math.PI/2)continue;const gap=Math.max(...contacts.map(c=>c.distance));if(!orientationBest||gap<orientationBest.maxContactGap)orientationBest={angleX,angleZ,dx,dz,contacts,contactOppositionRadians:angle,maxContactGap:gap};
 }
 fits.push({angleX,angleZ,best:orientationBest});if(orientationBest&&(!best||orientationBest.maxContactGap<best.maxContactGap))best=orientationBest;
}
const report={basis:'Actual body-only seed685164 terminal hand; cross-section thumb/finger opposition and all eight neighboring hand sections. No nearest-arbitrary-body or provider-name wrist inference.',pivot:pivot.toArray(),fits,best,limitations:['Coarse rigid pose fit only. Does not prove exact contact, whole-body clearance, articulation contact or visual grip.'],productionAccepted:false};await writeFile(new URL('rigid-fit.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({best,orientations:fits.length}));
}
