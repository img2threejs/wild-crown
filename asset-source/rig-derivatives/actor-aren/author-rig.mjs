import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Matrix4, Vector3 } from 'three';
import { source, sourceHash, hash, unpack, accessor, worlds, connectedComponents } from './inspect-region.mjs';

export const targetJoint = 8; // Existing measured node5 forearm/hand, not generic bone-name mapping.
export function staffRegion(document, bin) {
  const p=document.meshes[0].primitives[0];
  const groups=connectedComponents(accessor(document,bin,p.attributes.POSITION),accessor(document,bin,p.indices));
  assert.equal(groups.size,2,'Native connected geometry changed: require anatomy remapping');
  const staff=[...groups.values()].find(ids=>ids.includes(554945));
  assert(staff.includes(651930) && !staff.includes(685164));
  assert.equal(staff.length,75684);
  return staff;
}
export function matrices(document, bin) {
  const world=worlds(document),skin=document.skins[0],ibm=accessor(document,bin,skin.inverseBindMatrices);
  return skin.joints.map((node,i)=>world[node].clone().multiply(new Matrix4().fromArray(ibm,i*16)));
}
export function deform(position, joints, weights, vertex, matrices, out=new Vector3()) {
  const p=new Vector3().fromArray(position,vertex*3);out.set(0,0,0);
  for(let slot=0;slot<4;slot++)if(weights[vertex*4+slot])out.addScaledVector(p.clone().applyMatrix4(matrices[joints[vertex*4+slot]]),weights[vertex*4+slot]);
  return out;
}
export function restProof(original, originalBin, document, bin) {
  const primitive=original.meshes[0].primitives[0],position=accessor(original,originalBin,primitive.attributes.POSITION);
  const js=accessor(original,originalBin,primitive.attributes.JOINTS_0),ws=accessor(original,originalBin,primitive.attributes.WEIGHTS_0);
  const repairedJoints=accessor(document,bin,primitive.attributes.JOINTS_0),repairedWeights=accessor(document,bin,primitive.attributes.WEIGHTS_0);
  const before=matrices(original,originalBin),after=matrices(document,bin);
  // Conservative accumulated float32 transform bound: 64 rounding operations
  // per hierarchy level at the measured scene scale. No fitted epsilon or mm waiver.
  const world=worlds(original);let scale=1;
  for(const m of world)if(m)for(const value of m.elements)scale=Math.max(scale,Math.abs(value));
  let maxDepth=0;
  function depth(id,n){maxDepth=Math.max(maxDepth,n);for(const child of original.nodes[id].children??[])depth(child,n+1);}
  for(const id of original.scenes[original.scene??0].nodes)depth(id,1);
  const tolerance=64*2**-23*maxDepth*scale;
  let sourceNeutralError=0,derivativeNeutralError=0,neutralChange=0;
  const a=new Vector3(),b=new Vector3(),native=new Vector3();
  for(let v=0;v<position.length/3;v++) {
    native.fromArray(position,v*3);deform(position,js,ws,v,before,a);deform(position,repairedJoints,repairedWeights,v,after,b);
    sourceNeutralError=Math.max(sourceNeutralError,a.distanceTo(native));derivativeNeutralError=Math.max(derivativeNeutralError,b.distanceTo(native));neutralChange=Math.max(neutralChange,a.distanceTo(b));
  }
  assert(sourceNeutralError<tolerance,'Original native bind exceeds calibrated float32 bound');
  assert(derivativeNeutralError<tolerance,'Repaired native bind exceeds calibrated float32 bound');
  assert(neutralChange<tolerance,'Repair changes neutral surface beyond calibrated float32 bound');
  return {vertices:position.length/3,float32Epsilon:2**-23,maxHierarchyDepth:maxDepth,sceneScale:scale,toleranceNative:tolerance,sourceNeutralErrorNative:sourceNeutralError,derivativeNeutralErrorNative:derivativeNeutralError,neutralChangeNative:neutralChange};
}
export function pack(document,bin) {
  const text=Buffer.from(JSON.stringify(document)),json=Buffer.concat([text,Buffer.alloc((4-text.length%4)%4,32)]);
  const binary=Buffer.concat([bin,Buffer.alloc((4-bin.length%4)%4)]),header=Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+binary.length,8);
  const chunk=(size,type)=>{const h=Buffer.alloc(8);h.writeUInt32LE(size);h.writeUInt32LE(type,4);return h;};
  return Buffer.concat([header,chunk(json.length,0x4e4f534a),json,chunk(binary.length,0x004e4942),binary]);
}
if(process.argv[1]===new URL(import.meta.url).pathname) {
  const bytes=await readFile(source);assert.equal(hash(bytes),sourceHash);
  const {document,bin}=unpack(bytes),staff=staffRegion(document,bin),repaired=Buffer.from(bin),primitive=document.meshes[0].primitives[0];
  assert.equal(document.skins[0].joints[targetJoint],5);
  const joints=accessor(document,repaired,primitive.attributes.JOINTS_0),weights=accessor(document,repaired,primitive.attributes.WEIGHTS_0);
  for(const v of staff)for(let s=0;s<4;s++){joints[v*4+s]=s===0?targetJoint:0;weights[v*4+s]=s===0?1:0;}
  // Inspection and calibration run BEFORE any derivative GLB export.
  const neutral=restProof(document,bin,document,repaired);
  const position=accessor(document,bin,primitive.attributes.POSITION),world=worlds(document),inverseHand=world[5].clone().invert();
  const sockets=Object.fromEntries([['staffBase',554945],['staffTop',651930]].map(([name,v])=>[name,{surfaceVertex:v,node:5,skinIndex:targetJoint,boneLocalOffset:new Vector3().fromArray(position,v*3).applyMatrix4(inverseHand).toArray()}]));
  // Keep the entire original container and JSON/material bytes, not only parsed document equality.
  const result=Buffer.from(bytes);repaired.copy(result,28+bytes.readUInt32LE(12));
  const rigRevision='aren-rigid-staff-component-r1';
  const provenance={schemaVersion:1,rigRevision,source:{path:'asset-source/rigged/actor-aren/rig/tripo-out/rig-3-1fc43928/model.glb',sha256:sourceHash,bytes:bytes.length},derivative:{path:'asset-source/rig-derivatives/actor-aren/aren-rigid-staff.glb',sha256:hash(result),bytes:result.length},policy:{region:'Exact POSITION-welded triangle component containing native vertices554945 and651930, excluding hand685164. Not all node4 or node5 weighted vertices.',componentSeed:483173,vertexCount:staff.length,regionVertexIdsSha256:hash(Buffer.from(new Uint32Array(staff).buffer)),attachment:{node:5,skinIndex:targetJoint,existingInverseBind:true,newNodes:0},jointOrder:document.skins[0].joints,sockets,handSurfaceVertex:685164,handWeightsUnchanged:true},preservation:{documentUnchanged:true,positionNormalUVIndicesMaterialsTexturesOriginalBytes:true,originalNodesTRSJointOrderInverseBindBytes:true,onlyStaffJointsWeightsChanged:true},neutralPreExport:neutral,invalidates:['All source-bound authored deformation/socket/staff measurements must be rebuilt against this derivative hash and rigRevision. Original authored clips are not verification of the repaired rig.'],prerequisites:{node:'Node with repository three dependency available; exporter uses no image decoding dependency',verification:'Native GLTFLoader smoke imports authored inspect-anatomy.mjs; existing external sharp0.34.5 is required and NOT supplied by npm ci.'},limitations:['Numerical rig repair only; no animation-ready, final rig, G6/G10 or production approval.','Original disconnected body/staff geometry has at least0.020650446native rest z gap (~35.85mm normalized). Rigid binding cannot create missing anatomical grip contact without changing prohibited geometry or rest alignment.'],productionAccepted:false,browserLaunched:false,providerSpend:0};
  provenance.reproduction={workingDirectory:'Repository root (all paths resolved relative to module URLs)',commands:['node asset-source/rig-derivatives/actor-aren/inspect-region.mjs','node asset-source/rig-derivatives/actor-aren/author-rig.mjs','node asset-source/rig-derivatives/actor-aren/verify-rig.mjs'],readonlyAuthoredInputs:['inspect-anatomy.mjs','aren-idle-lateral-dodge.glb','authoring.json','measurements.json'],verificationOutput:'asset-source/rig-derivatives/actor-aren/verification-results.json',clips:'Existing native channels exercised on repaired skin in memory only; original canary is not replaced.'};
  provenance.preservation.originalContainerJsonMaterialBytes=true;
  provenance.missingAnatomyPrerequisite='Authorized anatomically grounded hand/staff contact geometry or rest alignment change; immutable-source skin repair alone cannot close the measured original gap. No random relabeling or hand/body/foot weight edits permitted.';
  await writeFile(new URL('aren-rigid-staff.glb',import.meta.url),result);
  await writeFile(new URL('provenance.json',import.meta.url),JSON.stringify(provenance,null,2)+'\n');
  console.log(JSON.stringify({rigRevision,derivative:provenance.derivative,policy:provenance.policy,neutral},null,2));
}
