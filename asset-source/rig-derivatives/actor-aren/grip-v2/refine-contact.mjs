import { readFile,writeFile } from 'node:fs/promises';
import { Vector3 } from 'three';
import { inspectGrip } from './inspect-grip.mjs';
import { loops,inside,pointSegment,rigidMatrix } from './fit-rigid-grip.mjs';
const anatomy=await inspectGrip(),fit=JSON.parse(await readFile(new URL('rigid-fit.json',import.meta.url))).best;
const {angleX,angleZ}=fit;
function sections(positions,triangles,y){const segments=[];for(const tri of triangles){const qs=tri.map(v=>new Vector3().fromArray(positions,3*v)),cuts=[];for(let a=0;a<3;a++){const b=(a+1)%3;if((qs[a].y<=y&&qs[b].y>y)||(qs[b].y<=y&&qs[a].y>y))cuts.push(qs[a].clone().lerp(qs[b],(y-qs[a].y)/(qs[b].y-qs[a].y)));}if(cuts.length===2)segments.push(cuts.map(q=>[q.x,q.z]));}return segments;}
const rotated=new Float64Array(anatomy.positions.length),m=rigidMatrix(angleX,angleZ,0,0);
for(const v of anatomy.staff)new Vector3().fromArray(anatomy.positions,3*v).applyMatrix4(m).toArray(rotated,3*v);
const body=anatomy.slices.map(s=>loops(s.segments)),shaft=anatomy.slices.map(s=>loops(sections(rotated,anatomy.staffTriangles,s.y)));
const cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
function intersection(a,b,c,d){const ab=[b[0]-a[0],b[1]-a[1]],cd=[d[0]-c[0],d[1]-c[1]],ac=[c[0]-a[0],c[1]-a[1]],den=cross(ab,cd);if(Math.abs(den)<1e-16)return false;const t=cross(ac,cd)/den,u=cross(ac,ab)/den;return t>1e-8&&t<1-1e-8&&u>1e-8&&u<1-1e-8;}
function contact(curve,shifted){let best={distance:Infinity};for(let i=0;i<shifted.length-1;i++)for(let j=0;j<curve.length-1;j++){
 const a=shifted[i],b=shifted[i+1],c=curve[j],d=curve[j+1];
 for(const p of [a,b]){const q=pointSegment(p,c,d);if(q.distance<best.distance)best={...q,staffPoint:p};}
 for(const q of [c,d]){const p=pointSegment(q,a,b);if(p.distance<best.distance)best={distance:p.distance,point:q,staffPoint:p.point};}
 }return best;}
function measure(dx,dz){const moved=shaft.map(curves=>curves.map(c=>c.map(p=>[p[0]+dx,p[1]+dz]))),penetration=[];
 for(let s=0;s<body.length;s++)for(const c of moved[s])for(const h of body[s]){
 const interior=c.filter(p=>inside(p,h)).length+ h.filter(p=>inside(p,c)).length;let crossings=0;
 for(let i=0;i<c.length-1;i++)for(let j=0;j<h.length-1;j++)if(intersection(c[i],c[i+1],h[j],h[j+1]))crossings++;
 if(interior||crossings)penetration.push({y:anatomy.slices[s].y,interior,crossings});
 }
 const contacts=body[4].map(curve=>contact(curve,moved[4][0]));return {contacts,penetration};
}
let dx=fit.dx,dz=fit.dz;const trajectory=[];
for(let i=0;i<12;i++){
 const result=measure(dx,dz);trajectory.push({dx,dz,...result});if(result.penetration.length)break;
 if(Math.max(...result.contacts.map(c=>c.distance))<1e-7)break;
 const a=result.contacts.map(c=>{const n=[c.point[0]-c.staffPoint[0],c.point[1]-c.staffPoint[1]];const d=Math.hypot(...n);return [n[0]/d,n[1]/d,d];});
 const determinant=a[0][0]*a[1][1]-a[1][0]*a[0][1];if(Math.abs(determinant)<.01)break;
 dx+=(a[0][2]*a[1][1]-a[1][2]*a[0][1])/determinant;dz+=(a[0][0]*a[1][2]-a[1][0]*a[0][2])/determinant;
}
const report={angleX,angleZ,trajectory,final:trajectory.at(-1),scope:'Exact segment/loop hand sections only; no full-body or articulation acceptance',productionAccepted:false};await writeFile(new URL('refined-contact.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
