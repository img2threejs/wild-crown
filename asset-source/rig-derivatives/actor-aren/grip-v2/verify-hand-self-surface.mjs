import { readFile,writeFile } from 'node:fs/promises';
import { Vector3 } from 'three';
import { buildHandRig,poseMatrices,point } from './hand-rig.mjs';
import { surfaceIndex } from './surface-index.mjs';
const rig=await buildHandRig(),candidate=JSON.parse(await readFile(new URL('candidate-grip-pose.json',import.meta.url))),posed=poseMatrices(rig,candidate.fullHandMeasurement.parameters.pose),neutral=poseMatrices(rig,{}),handSet=new Set(rig.hand),vertexIds=[...new Set(rig.bodyTriangles.flat())],positions=new Float64Array(rig.positions);
const seams=new Map();for(const v of vertexIds){point(rig,v,posed.matrices).toArray(positions,v*3);const key=Array.from(rig.positions.subarray(v*3,v*3+3)).join(',');if(!seams.has(key))seams.set(key,[]);seams.get(key).push(v);}
const edges=new Map();for(const tri of rig.bodyTriangles)for(let e=0;e<3;e++){const a=tri[e],b=tri[(e+1)%3],key=a<b?`${a},${b}`:`${b},${a}`;if(!edges.has(key))edges.set(key,[a,b]);}
const index=surfaceIndex(positions,rig.bodyTriangles),source=surfaceIndex(rig.positions,rig.bodyTriangles);let newIntersectingEdges=0;const examples=[];let maxEdgeStretch=0;
for(const [a,b] of edges.values()){
 const A=new Vector3().fromArray(positions,a*3),B=new Vector3().fromArray(positions,b*3),restA=point(rig,a,neutral.matrices),restB=point(rig,b,neutral.matrices),length=restA.distanceTo(restB);if(length>1e-7)maxEdgeStretch=Math.max(maxEdgeStretch,A.distanceTo(B)/length);
 const keyA=Array.from(rig.positions.subarray(a*3,a*3+3)).join(','),keyB=Array.from(rig.positions.subarray(b*3,b*3+3)).join(',');
 const ignored=[...(seams.get(keyA)??[]),...(seams.get(keyB)??[])];
 const hits=index.segmentHits(A,B,{ignoreVertices:ignored});if(!hits.length)continue;const sourceHits=source.segmentHits(new Vector3().fromArray(rig.positions,a*3),new Vector3().fromArray(rig.positions,b*3),{ignoreVertices:ignored});const sourceKeys=new Set(sourceHits.map(h=>h.triangle.toSorted((a,b)=>a-b).join(','))),newHits=hits.filter(h=>!sourceKeys.has(h.triangle.toSorted((a,b)=>a-b).join(',')));
 if(newHits.length){newIntersectingEdges++;if(examples.length<20)examples.push({edge:[a,b],intersectedTriangles:newHits.map(h=>h.triangle)});}
}
const report={completeLocalHandTriangles:rig.bodyTriangles.length,uniqueEdges:edges.size,newIntersectingEdges,examples,maxEdgeStretchRatio:maxEdgeStretch,acceptedForExport:newIntersectingEdges===0&&maxEdgeStretch<2,productionAccepted:false};await writeFile(new URL('hand-self-surface-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
