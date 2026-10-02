import { readFile,writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Vector3,Quaternion } from 'three';
import { buildHandRig,poseMatrices,point } from './hand-rig.mjs';
import { matrices,deform } from '../author-rig.mjs';
import { unpack,accessor,worlds } from '../inspect-region.mjs';
const rig=await buildHandRig(),original=unpack(rig.bytes),primitive=original.document.meshes[0].primitives[0],originalJoints=accessor(original.document,original.bin,primitive.attributes.JOINTS_0),originalWeights=accessor(original.document,original.bin,primitive.attributes.WEIGHTS_0),originalMatrices=matrices(original.document,original.bin),bind=poseMatrices(rig,{});
const handSet=new Set(rig.hand),staffSet=new Set(rig.staff),tolerance=64*2**-23*12;
let maxNativeNeutralError=0,maxSourceNeutralChange=0,bodyOutsideHandVertices=0;
for(let v=0;v<rig.positions.length/3;v++){if(staffSet.has(v))continue;const originalPoint=deform(rig.positions,originalJoints,originalWeights,v,originalMatrices),native=new Vector3().fromArray(rig.positions,3*v),repaired=point(rig,v,bind.matrices);maxNativeNeutralError=Math.max(maxNativeNeutralError,native.distanceTo(repaired));maxSourceNeutralChange=Math.max(maxSourceNeutralChange,originalPoint.distanceTo(repaired));if(!handSet.has(v))bodyOutsideHandVertices++;}
assert(maxNativeNeutralError<tolerance);assert(maxSourceNeutralChange<tolerance);
for(let i=0;i<18*16;i++)assert.equal(rig.inverseBind[i],accessor(original.document,original.bin,original.document.skins[0].inverseBindMatrices)[i]);
const originalWorld=worlds(original.document);for(let i=0;i<original.document.nodes.length;i++){assert.deepEqual(bind.document.nodes[i].translation,original.document.nodes[i].translation);assert.deepEqual(bind.document.nodes[i].rotation,original.document.nodes[i].rotation);assert.deepEqual(bind.document.nodes[i].scale,original.document.nodes[i].scale);assert.deepEqual(originalWorld[i].elements,bind.world[i].elements);}
const seamGroups=new Map();for(let v=0;v<rig.positions.length/3;v++)if(!staffSet.has(v)){const key=Array.from(rig.positions.subarray(v*3,v*3+3)).join(',');if(!seamGroups.has(key))seamGroups.set(key,[]);seamGroups.get(key).push(v);}
const seams=[...seamGroups.values()].filter(ids=>ids.length>1&&ids.some(v=>handSet.has(v)));
const edges=new Map();for(const ids of rig.bodyTriangles)for(let e=0;e<3;e++){const a=ids[e],b=ids[(e+1)%3];if(!handSet.has(a)&&!handSet.has(b))continue;const key=a<b?`${a},${b}`:`${b},${a}`;if(!edges.has(key))edges.set(key,[a,b]);}
const candidate=JSON.parse(await readFile(new URL('candidate-grip-pose.json',import.meta.url))).fullHandMeasurement.parameters.pose;
const controls=rig.jointMap.map(j=>({label:j.name,node:j.node,axis:j.name.includes('thumb_opposition')?[0,1,0]:j.name.includes('wrist')||j.name.includes('palm')?[0,0,1]:[1,0,0],angle:.25}));
const proofs=[];
for(const control of [...controls,{label:'candidate-ready-grip',pose:candidate}]){
 let posed;if(control.pose)posed=poseMatrices(rig,control.pose);else{posed=poseMatrices(rig,{});const n=posed.document.nodes[control.node];n.rotation=new Quaternion(...n.rotation).multiply(new Quaternion().setFromAxisAngle(new Vector3(...control.axis),control.angle)).toArray();posed.world=worlds(posed.document);posed.matrices=posed.document.skins[0].joints.map((node,i)=>posed.world[node].clone().multiply(bind.matrices[i].clone().identity().fromArray(rig.inverseBind,i*16)));}
 let maxOutsideMotion=0,maxHandMotion=0,seamError=0,maxEdgeStretch=0,worstEdge=null;
 for(let v=0;v<rig.positions.length/3;v++){if(staffSet.has(v))continue;const motion=point(rig,v,posed.matrices).distanceTo(point(rig,v,bind.matrices));if(handSet.has(v))maxHandMotion=Math.max(maxHandMotion,motion);else maxOutsideMotion=Math.max(maxOutsideMotion,motion);}
 for(const ids of seams){const first=point(rig,ids[0],posed.matrices);for(const v of ids)seamError=Math.max(seamError,first.distanceTo(point(rig,v,posed.matrices)));}
 for(const [a,b] of edges.values()){const rest=point(rig,a,bind.matrices).distanceTo(point(rig,b,bind.matrices));if(rest<1e-7)continue;const ratio=point(rig,a,posed.matrices).distanceTo(point(rig,b,posed.matrices))/rest;if(ratio>maxEdgeStretch){maxEdgeStretch=ratio;worstEdge=[a,b];}}
 assert.equal(maxOutsideMotion,0,`${control.label} moves body outside terminal hand`);assert(maxHandMotion>.00001,`${control.label} does not drive actual hand`);
 proofs.push({control:control.label,maxOutsideHandBodyMotionNative:maxOutsideMotion,maxHandMotionNative:maxHandMotion,maxWeldedSeamErrorNative:seamError,maxNativeTriangleEdgeStretchRatio:maxEdgeStretch,worstEdge,seamAndTearingAccepted:seamError<tolerance&&maxEdgeStretch<2});
}
const report={sourceSha256:rig.report.sourceSha256,allBodyNeutralVertices:rig.positions.length/3-rig.staff.length,maxNativeNeutralError,maxSourceNeutralChange,toleranceNative:tolerance,original18JointTrsWorldInverseBindPreserved:true,bodyOutsideHandVertices,handVertices:rig.hand.length,jointMap:rig.jointMap,proofs,allSeamAndTearingControlsAccepted:proofs.every(p=>p.seamAndTearingAccepted),exportAllowed:false,productionAccepted:false};await writeFile(new URL('hand-bind-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
