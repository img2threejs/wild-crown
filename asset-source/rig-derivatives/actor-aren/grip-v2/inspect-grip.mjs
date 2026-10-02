import { readFile,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { source,sourceHash,hash,unpack,accessor } from '../inspect-region.mjs';
import { staffRegion } from '../author-rig.mjs';
export async function inspectGrip(){
 const bytes=await readFile(source);assert.equal(hash(bytes),sourceHash);const {document,bin}=unpack(bytes),p=document.meshes[0].primitives[0];
 const positions=accessor(document,bin,p.attributes.POSITION),indices=accessor(document,bin,p.indices),weights=accessor(document,bin,p.attributes.WEIGHTS_0),joints=accessor(document,bin,p.attributes.JOINTS_0),staff=staffRegion(document,bin),staffSet=new Set(staff);
 const seed=685164,seedPoint=new Vector3().fromArray(positions,seed*3),hand=[];
 // Bound measured terminal hand by seed distance and native chain influence;
 // do not infer anatomy from provider bone names or nearest arbitrary body point.
 for(let v=0;v<positions.length/3;v++){if(staffSet.has(v))continue;const q=new Vector3().fromArray(positions,v*3);let armWeight=0;for(let s=0;s<4;s++)if([8,9].includes(joints[4*v+s]))armWeight+=weights[4*v+s];if(armWeight>.8&&q.distanceTo(seedPoint)<.065&&q.y<.475)hand.push(v);}
 const handSet=new Set(hand),bodyTriangles=[],staffTriangles=[];
 for(let t=0;t<indices.length;t+=3){const tri=[indices[t],indices[t+1],indices[t+2]];if(staffSet.has(tri[0]))staffTriangles.push(tri);else if(tri.some(v=>handSet.has(v)))bodyTriangles.push(tri);}
 const slices=[];
 for(const y of [.395,.405,.415,.424940527,.435,.445,.455,.465]){
  const sections=[];
  for(const tri of bodyTriangles){const qs=tri.map(v=>new Vector3().fromArray(positions,3*v)),cuts=[];for(let a=0;a<3;a++){const b=(a+1)%3;if((qs[a].y<=y&&qs[b].y>y)||(qs[b].y<=y&&qs[a].y>y)){const alpha=(y-qs[a].y)/(qs[b].y-qs[a].y);cuts.push(qs[a].clone().lerp(qs[b],alpha));}}if(cuts.length===2)sections.push(cuts.map(q=>[q.x,q.z]));}
  const rays=[];for(const x of [-.075,-.065,-.055,-.045,-.035,-.025]){const hits=[];for(const segment of sections){const [a,b]=segment;if((a[0]<=x&&b[0]>x)||(b[0]<=x&&a[0]>x)){const z=a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);hits.push(z);}}hits.sort((a,b)=>a-b);rays.push({x,zSurfaceCrossings:hits});}
  const staffCuts=[];for(const tri of staffTriangles){const qs=tri.map(v=>new Vector3().fromArray(positions,3*v)),cuts=[];for(let a=0;a<3;a++){const b=(a+1)%3;if((qs[a].y<=y&&qs[b].y>y)||(qs[b].y<=y&&qs[a].y>y))cuts.push(qs[a].clone().lerp(qs[b],(y-qs[a].y)/(qs[b].y-qs[a].y)));}if(cuts.length===2)staffCuts.push(cuts.map(q=>[q.x,q.z]));}
  slices.push({y,segments:sections,staffSegments:staffCuts,rays});
 }
 const bounds=(ids)=>{const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(const v of ids)for(let a=0;a<3;a++){min[a]=Math.min(min[a],positions[3*v+a]);max[a]=Math.max(max[a],positions[3*v+a]);}return {min,max};};
 const report={sourceSha256:sourceHash,handLandmark:{vertex:seed,position:seedPoint.toArray(),jointInfluences:[0,1,2,3].map(s=>({skinIndex:joints[4*seed+s],node:document.skins[0].joints[joints[4*seed+s]],weight:weights[4*seed+s]}))},boundedTerminalHand:{vertexCount:hand.length,bounds:bounds(hand),selection:'Body-only, distance<.065native from measured hand685164, y<.475, combined skin8/9 influence>.8; contact decision must inspect actual triangle sections, not this coarse ROI alone.'},staff:{vertexCount:staff.length,bounds:bounds(staff)},slices:slices.map(({segments,staffSegments,...s})=>({...s,segmentCount:segments.length,staffSegmentCount:staffSegments.length})),productionAccepted:false};
 await writeFile(new URL('hand-anatomy.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 // Plain SVG is an inspectable geometric cross-section artifact, not GPU/visual acceptance.
 const scale=5000,panels=slices.map((s,i)=>{const ox=(i%4)*350+190,oy=Math.floor(i/4)*380+350;return `<g><text x="${ox-170}" y="${oy-320}" fill="black">hand y=${s.y}</text>${s.segments.map(([a,b])=>`<line x1="${ox+a[0]*scale}" y1="${oy-a[1]*scale}" x2="${ox+b[0]*scale}" y2="${oy-b[1]*scale}" stroke="black" stroke-width="1"/>`).join('')}</g>`;});
 await writeFile(new URL('hand-sections.svg',import.meta.url),`<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="760" viewBox="-200 -520 1400 760"><rect x="-200" y="-520" width="1400" height="760" fill="white"/>${panels.join('')}</svg>`);
 console.log(JSON.stringify({sourceSha256:sourceHash,hand:report.boundedTerminalHand,staff:report.staff,sections:slices.length}));return {bytes,document,bin,positions,indices,staff,hand,bodyTriangles,staffTriangles,slices,report};
}
if(process.argv[1]===new URL(import.meta.url).pathname)await inspectGrip();
