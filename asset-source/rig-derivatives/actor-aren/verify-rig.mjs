import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { AnimationMixer, Vector3, Quaternion, LoopOnce } from 'three';
import { load } from '../../authored/actor-aren/inspect-anatomy.mjs';
import { source, sourceHash, hash, unpack, accessor } from './inspect-region.mjs';
import { staffRegion, restProof, targetJoint, pack } from './author-rig.mjs';

const bytes=await readFile(source),derivative=await readFile(new URL('aren-rigid-staff.glb',import.meta.url));
assert.equal(hash(bytes),sourceHash);
const original=unpack(bytes),repaired=unpack(derivative),provenance=JSON.parse(await readFile(new URL('provenance.json',import.meta.url)));
assert.equal(hash(derivative),provenance.derivative.sha256);
assert.deepEqual(repaired.document,original.document,'Original GLB document including nodes/TRS/joints/IBM/accessors/geometry/material descriptions must be identical');
const staff=staffRegion(original.document,original.bin),primitive=original.document.meshes[0].primitives[0];
const expected=Buffer.from(original.bin),expectedJoints=accessor(original.document,expected,primitive.attributes.JOINTS_0),expectedWeights=accessor(original.document,expected,primitive.attributes.WEIGHTS_0);
for(const v of staff)for(let slot=0;slot<4;slot++){expectedJoints[v*4+slot]=slot===0?targetJoint:0;expectedWeights[v*4+slot]=slot===0?1:0;}
assert(expected.equals(repaired.bin),'Any byte outside exact staff JOINTS/WEIGHTS repair changed');
const expectedContainer=Buffer.from(bytes);expected.copy(expectedContainer,28+bytes.readUInt32LE(12));
assert(expectedContainer.equals(derivative),'Original container/JSON/material bytes outside staff joint-weight repair changed');
const neutral=restProof(original.document,original.bin,repaired.document,repaired.bin);
const authoredBytes=await readFile(new URL('../../authored/actor-aren/aren-idle-lateral-dodge.glb',import.meta.url)),authored=unpack(authoredBytes);
assert(authored.bin.subarray(0,original.bin.length).equals(original.bin),'Original authored canary source changed');
const metadata=JSON.parse(await readFile(new URL('../../authored/actor-aren/authoring.json',import.meta.url)));
const oldMeasurements=JSON.parse(await readFile(new URL('../../authored/actor-aren/measurements.json',import.meta.url)));
const meters=metadata.metersPerNativeUnit,tolerance=neutral.toleranceNative;
const originalGltf=await load(authoredBytes);
// Clip channels remain an in-memory exercise only. No repaired-source canary is exported or silently cut over.
const clipBin=Buffer.from(authored.bin);repaired.bin.copy(clipBin,0);
const repairedGltf=await load(pack(authored.document,clipBin));
function surface(gltf){let mesh;gltf.scene.traverse(n=>{if(n.isSkinnedMesh)mesh=n;});assert(mesh);const bones=mesh.skeleton.bones,position=mesh.geometry.attributes.position;
  const rest=bones.map(b=>({p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}));
  const vertex=(id)=>{const v=new Vector3().fromBufferAttribute(position,id);mesh.applyBoneTransform(id,v);return mesh.localToWorld(v);};
  const reset=()=>{bones.forEach((b,i)=>{b.position.copy(rest[i].p);b.quaternion.copy(rest[i].q);b.scale.copy(rest[i].s);});gltf.scene.updateMatrixWorld(true);mesh.skeleton.update();};
  const bone=node=>bones[original.document.skins[0].joints.indexOf(node)];return {mesh,bones,position,rest,vertex,reset,bone,gltf};
}
const before=surface(originalGltf),after=surface(repairedGltf);
const footIds=[...oldMeasurements.footLandmarks.left.surfaceVertices,...oldMeasurements.footLandmarks.right.surfaceVertices];
assert(footIds.every(id=>!staff.includes(id)),'Foot landmark intersects repair');
let nativeNeutralChange=0;for(let v=0;v<after.position.count;v++)nativeNeutralChange=Math.max(nativeNeutralChange,before.vertex(v).distanceTo(after.vertex(v)));
assert(nativeNeutralChange<tolerance,'Actual GLTFLoader neutral deformation changed');
const restStaff=staff.map(after.vertex),restSpan=after.vertex(554945).distanceTo(after.vertex(651930));
function toeIndependence(surface) {
  surface.reset();const initial=staff.map(surface.vertex);let max=0;
  for(const node of [9,13])for(const angle of [-.65,.65]) {
    surface.reset();surface.bone(node).quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),angle));surface.gltf.scene.updateMatrixWorld(true);
    for(let i=0;i<staff.length;i++)max=Math.max(max,surface.vertex(staff[i]).distanceTo(initial[i]));
  }
  surface.reset();assert(max<tolerance,`Independent toe flex moves staff: ${max} native > ${tolerance}`);return max;
}
const toeMotion=toeIndependence(after);
const handRestLocal=after.bone(5).worldToLocal(after.vertex(685164));
const staffRestLocals=restStaff.map(p=>after.bone(5).worldToLocal(p.clone()));
let handSocketError=0,spanError=0,handMotion=0,footChange=0,handSurfaceSocketError=0,entireStaffRigidError=0;
for(const node of [5,6])for(const angle of [-.35,.35]) {
  before.reset();after.reset();const rotation=new Quaternion().setFromAxisAngle(new Vector3(1,0,0),angle);
  before.bone(node).quaternion.multiply(rotation);after.bone(node).quaternion.multiply(rotation);before.gltf.scene.updateMatrixWorld(true);after.gltf.scene.updateMatrixWorld(true);
  handSurfaceSocketError=Math.max(handSurfaceSocketError,after.bone(5).localToWorld(handRestLocal.clone()).distanceTo(after.vertex(685164)));
  for(const socket of Object.values(provenance.policy.sockets)) {
    const expectedPoint=after.bone(5).localToWorld(new Vector3(...socket.boneLocalOffset));handSocketError=Math.max(handSocketError,expectedPoint.distanceTo(after.vertex(socket.surfaceVertex)));
  }
  for(let i=0;i<staff.length;i++){const point=after.vertex(staff[i]);handMotion=Math.max(handMotion,point.distanceTo(restStaff[i]));entireStaffRigidError=Math.max(entireStaffRigidError,point.distanceTo(after.bone(5).localToWorld(staffRestLocals[i].clone())));}
  spanError=Math.max(spanError,Math.abs(after.vertex(554945).distanceTo(after.vertex(651930))-restSpan));
  for(const v of footIds)footChange=Math.max(footChange,before.vertex(v).distanceTo(after.vertex(v)));
}
assert(handMotion>.01,'Intended hand/shoulder perturbation must actually move staff');assert(handSocketError<tolerance);assert(handSurfaceSocketError<tolerance,'Actual hand surface must follow intended attachment within float32 budget');assert(entireStaffRigidError<tolerance);assert(spanError<tolerance);assert.equal(footChange,0);
before.reset();after.reset();
const counterexamples=[];
function rejected(name,run){try{run();}catch(error){assert(error instanceof assert.AssertionError);counterexamples.push({name,rejected:true,reason:error.message});return;}throw new Error(`Counterexample ${name} wrongly passed`);}
rejected('Unfixed original rig: independent toe flex',()=>toeIndependence(before));
const js=after.mesh.geometry.attributes.skinIndex,ws=after.mesh.geometry.attributes.skinWeight,base=554945;
const oldJ=[js.getX(base),js.getY(base),js.getZ(base),js.getW(base)],oldW=[ws.getX(base),ws.getY(base),ws.getZ(base),ws.getW(base)];
js.setXYZW(base,9,17,0,0);ws.setXYZW(base,.512,.488,0,0);
rejected('Actual base-weight mutation: toe contamination restored',()=>toeIndependence(after));
js.setXYZW(base,...oldJ);ws.setXYZW(base,...oldW);after.reset();
const inverse=after.mesh.skeleton.boneInverses[targetJoint],savedInverse=inverse.clone();inverse.elements[12]+=.01;
rejected('Actual native IBM mutation: attachment bind shifted .01native',()=>{
  let error=0;for(const v of staff)error=Math.max(error,after.vertex(v).distanceTo(before.vertex(v)));assert(error<tolerance,`Native neutral bind error ${error} > ${tolerance}`);
});inverse.copy(savedInverse);after.reset();
const sampleStaff=[...new Set([554945,651930,...Array.from({length:2048},(_,i)=>staff[Math.floor(i*(staff.length-1)/2047)])])];
function curve(t) { const points=metadata.rootReference;let n=points.findIndex(p=>p.time>=t);if(n<0)n=points.length-1;if(n===0)return new Vector3(...points[0].referenceDisplacementNative);const a=points[n-1],b=points[n];return new Vector3(...a.referenceDisplacementNative).lerp(new Vector3(...b.referenceDisplacementNative),Math.max(0,Math.min(1,(t-a.time)/(b.time-a.time)))); }
const clips=[];
for(let c=0;c<repairedGltf.animations.length;c++) {
  before.reset();after.reset();const clip=repairedGltf.animations[c],mixers=[before,after].map((s)=>new AnimationMixer(s.gltf.scene));
  const actions=mixers.map((m,i)=>{const a=m.clipAction((i?repairedGltf:originalGltf).animations[c]).setLoop(LoopOnce,1);a.clampWhenFinished=true;a.play();return a;});
  const frames=clip.name==='Idle'?720:Math.max(216,Math.ceil(clip.duration*240));
  const windows=(metadata.contactWindows[clip.name]??[]).map(w=>({...w,first:null,maxSlipMeters:0,samples:0}));
  let maxFootChange=0,maxSpan=0,maxSocket=0,maxRigidSurfaceError=0;
  const restLocals=sampleStaff.map(v=>{after.reset();return after.bone(5).worldToLocal(after.vertex(v));});
  for(let f=0;f<=frames;f++) {
    const time=clip.duration*f/frames;mixers.forEach(m=>m.setTime(time));before.gltf.scene.updateMatrixWorld(true);after.gltf.scene.updateMatrixWorld(true);
    for(const v of footIds)maxFootChange=Math.max(maxFootChange,before.vertex(v).distanceTo(after.vertex(v)));
    maxSpan=Math.max(maxSpan,Math.abs(after.vertex(554945).distanceTo(after.vertex(651930))-restSpan));
    for(const socket of Object.values(provenance.policy.sockets))maxSocket=Math.max(maxSocket,after.bone(5).localToWorld(new Vector3(...socket.boneLocalOffset)).distanceTo(after.vertex(socket.surfaceVertex)));
    for(let i=0;i<sampleStaff.length;i++)maxRigidSurfaceError=Math.max(maxRigidSurfaceError,after.bone(5).localToWorld(restLocals[i].clone()).distanceTo(after.vertex(sampleStaff[i])));
    const offset=clip.name==='Idle'?new Vector3():curve(time);
    for(const w of windows)if(time>=w.start-1e-7&&time<=w.end+1e-7) {
      const positions=oldMeasurements.footLandmarks[w.foot].surfaceVertices.map(v=>after.vertex(v).add(offset));if(!w.first)w.first=positions.map(v=>v.clone());
      positions.forEach((v,i)=>{w.maxSlipMeters=Math.max(w.maxSlipMeters,v.distanceTo(w.first[i])*meters);});w.samples++;
    }
  }
  assert.equal(maxFootChange,0,`${clip.name} foot-contact surface changed`);assert(maxSpan<tolerance);assert(maxSocket<tolerance);assert(maxRigidSurfaceError<tolerance);
  assert(windows.every(w=>w.samples>0&&w.maxSlipMeters<=metadata.contactSlipBudgetMeters),`${clip.name} planted feet exceed source contact budget`);
  clips.push({name:clip.name,durationSeconds:clip.duration,frames:frames+1,staffSampleVertices:sampleStaff.length,footVertices:footIds.length,maxFootChangeNative:maxFootChange,maxStaffSpanChangeMeters:maxSpan*meters,maxSocketErrorMeters:maxSocket*meters,maxRigidStaffSurfaceErrorMeters:maxRigidSurfaceError*meters,contactWindows:windows.map(({first,...w})=>w)});
  actions.forEach(a=>a.stop());mixers.forEach((m,i)=>m.uncacheRoot((i?after:before).gltf.scene));
}
const report={rigRevision:provenance.rigRevision,sourceSha256:sourceHash,derivativeSha256:hash(derivative),originalAuthoredCanarySha256:hash(authoredBytes),originalCanaryUnchanged:true,nativeGLTFLoaderUsed:true,verificationPrerequisite:'Existing external sharp0.34.5 through authored loader; not declared npm-ci dependency.',preservation:{documentIdentical:true,binIdenticalOutsideExactStaffJointWeightEdits:true,bodyVerticesUntouched:after.position.count-staff.length},neutralPreExport:neutral,nativeLoaderAllVertexNeutral:{vertices:after.position.count,maxChangeNative:nativeNeutralChange},controlledPoses:{entireStaffVertices:staff.length,maxIndependentToeMotionMeters:toeMotion*meters,maxHandSocketErrorMeters:handSocketError*meters,maxStaffSpanChangeMeters:spanError*meters,maxStaffHandPoseMotionMeters:handMotion*meters,maxFootChangeNative:footChange},counterexamples,clips,contactSlipBudgetMeters:metadata.contactSlipBudgetMeters,staffRigidityBudgetMeters:tolerance*meters,anatomicalGripContact:{accepted:false,restSurfaceSeparationLowerBoundNative:.17594949901103973-.15529905259609222,restSurfaceSeparationLowerBoundMeters:(.17594949901103973-.15529905259609222)*meters,reason:'Disconnected immutable staff and hand/body surfaces; weights cannot close original geometry gap.'},productionAccepted:false,g6g10Waived:false,animationReady:false,providerSpend:0,browserLaunched:false};
Object.assign(report.controlledPoses,{maxActualHandSurfaceSocketErrorMeters:handSurfaceSocketError*meters,maxEntireStaffRigidSurfaceErrorMeters:entireStaffRigidError*meters});
await writeFile(new URL('verification-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
