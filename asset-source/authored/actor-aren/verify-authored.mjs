import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { AnimationMixer, Vector3, Box3, LoopOnce, LoopRepeat } from 'three';
import { source, hash, unpack, load } from './inspect-anatomy.mjs';

const beganAt=new Date().toISOString();
const sourceBytes=await readFile(source),derivative=await readFile(new URL('aren-idle-lateral-dodge.glb',import.meta.url));
const a=unpack(sourceBytes),b=unpack(derivative),metadata=JSON.parse(await readFile(new URL('authoring.json',import.meta.url)));
assert.equal(hash(sourceBytes),'7e759a4607f530137dfe58d0dcffecefd697030bcce6fbc2134625051b068151');
assert(a.bin.equals(b.bin.subarray(0,a.bin.length)),'Entire original primitive/texture/skin BIN must remain byte identical');
for(const field of ['nodes','meshes','skins','materials','textures','images','samplers','scenes','scene'])assert.deepEqual(b.document[field],a.document[field],`${field} changed`);
assert.deepEqual(b.document.accessors.slice(0,a.document.accessors.length),a.document.accessors);
assert.deepEqual(b.document.bufferViews.slice(0,a.document.bufferViews.length),a.document.bufferViews);
const gltf=await load(derivative);let mesh;gltf.scene.traverse(n=>{if(n.isSkinnedMesh)mesh=n;});
const bones=mesh.skeleton.bones,joints=b.document.skins[0].joints,byNode=new Map(joints.map((id,i)=>[id,bones[i]]));
const originalPose=bones.map(b=>({p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone()}));
const pos=mesh.geometry.attributes.position,weights=mesh.geometry.attributes.skinWeight,indices=mesh.geometry.attributes.skinIndex;
function vertex(index){const p=new Vector3().fromBufferAttribute(pos,index);mesh.applyBoneTransform(index,p);return mesh.localToWorld(p);}
const skinData={invalidJointInfluences:0,nonfiniteWeights:0,maxWeightSumError:0,zeroWeightVertices:0};
const feet={left:[],right:[]},landmarkCandidates={freeHand:[],staffGrip:[],staffBase:[],staffTop:[]};
for(let i=0;i<pos.count;i++){
  const ws=[weights.getX(i),weights.getY(i),weights.getZ(i),weights.getW(i)],js=[indices.getX(i),indices.getY(i),indices.getZ(i),indices.getW(i)];
  const sum=ws.reduce((x,y)=>x+y,0);skinData.maxWeightSumError=Math.max(skinData.maxWeightSumError,Math.abs(sum-1));if(sum===0)skinData.zeroWeightVertices++;
  ws.forEach((w,j)=>{if(!Number.isFinite(w))skinData.nonfiniteWeights++;if(w>0&&(js[j]<0||js[j]>=18))skinData.invalidJointInfluences++;});
  const dominant=js[ws.indexOf(Math.max(...ws))],node=joints[dominant],p=vertex(i);
  if(p.y<.012 && [12,11,10,9].includes(node))feet.left.push(i);
  if(p.y<.012 && [16,15,14,13].includes(node))feet.right.push(i);
  if(node===2 && p.y<.5)landmarkCandidates.freeHand.push(i);
  if(node===5 && p.y<.45)landmarkCandidates.staffGrip.push(i);
  if(node===4 && p.y<.03)landmarkCandidates.staffBase.push(i);
  if(node===5 && p.y>.68 && p.z>.16)landmarkCandidates.staffTop.push(i);
}
assert.equal(skinData.invalidJointInfluences,0);assert.equal(skinData.nonfiniteWeights,0);assert.equal(skinData.zeroWeightVertices,0);assert(skinData.maxWeightSumError<.001);
const select=(array,count)=>Array.from({length:Math.min(count,array.length)},(_,i)=>array[Math.floor(i*(array.length-1)/Math.max(1,Math.min(count,array.length)-1))]);
const footSamples=Object.fromEntries(Object.entries(feet).map(([k,v])=>{assert(v.length>20);return[k,select(v,32)];}));
const landmarks={};
for(const [name,candidates] of Object.entries(landmarkCandidates)){
  assert(candidates.length,`No measured surface candidates for ${name}`);
  const centroid=candidates.reduce((s,i)=>s.add(vertex(i)),new Vector3()).divideScalar(candidates.length);
  const index=candidates.reduce((best,i)=>vertex(i).distanceToSquared(centroid)<vertex(best).distanceToSquared(centroid)?i:best,candidates[0]);
  const node=name==='freeHand'?2:name==='staffBase'?4:5,bone=byNode.get(node),point=vertex(index);
  landmarks[name]={node,boneName:bone.name,skinIndex:joints.indexOf(node),surfaceVertex:index,candidateVertices:candidates.length,measuredRestWorld:point.toArray(),boneLocalOffset:bone.worldToLocal(point.clone()).toArray(),qualification:'weighted surface landmark candidate; parent visual attachment review required'};
}
const regular=Array.from({length:2048},(_,i)=>Math.floor(i*(pos.count-1)/2047));
const samples=[...new Set([...regular,...footSamples.left,...footSamples.right,...Object.values(landmarks).map(v=>v.surfaceVertex)])];
const curve=t=>{const points=metadata.rootReference;let n=points.findIndex(v=>v.time>=t);if(n<0)n=points.length-1;if(n===0)return new Vector3(...points[0].referenceDisplacementNative);const x=points[n-1],y=points[n],alpha=Math.max(0,Math.min(1,(t-x.time)/(y.time-x.time)));return new Vector3(...x.referenceDisplacementNative).lerp(new Vector3(...y.referenceDisplacementNative),alpha);};
const clips=[];
for(const clip of gltf.animations){
  bones.forEach((bone,i)=>{bone.position.copy(originalPose[i].p);bone.quaternion.copy(originalPose[i].q);bone.scale.copy(originalPose[i].s);});gltf.scene.updateMatrixWorld(true);
  if(process.argv.includes(`--counterexample-static=${clip.name}`))for(const track of clip.tracks){const size=track.getValueSize();for(let i=size;i<track.values.length;i++)track.values[i]=track.values[i%size];}
  const mixer=new AnimationMixer(gltf.scene),action=mixer.clipAction(clip).setLoop(LoopOnce,1);action.clampWhenFinished=true;action.play();
  function at(t){mixer.setTime(t);gltf.scene.updateMatrixWorld(true);mesh.skeleton.update();return samples.map(vertex);}
  const initial=at(0),initialBones=bones.map(n=>n.matrixWorld.elements.slice()),initialRoot=byNode.get(17).getWorldPosition(new Vector3());
  const windows=metadata.contactWindows[clip.name].map(w=>({...w,first:null,measuredPlantPositionsNative:null,maxSlipMeters:0,sampleCount:0,minSoleHeightMeters:Infinity,maxSoleHeightMeters:-Infinity}));
  let maxDisplacement=0,changed=new Set(),changedBones=new Set();const bounds=new Box3(),trajectory=[];
  const socketErrorMeters=Object.fromEntries(Object.keys(landmarks).map(k=>[k,0]));
  const restStaffSpan=vertex(landmarks.staffTop.surfaceVertex).distanceTo(vertex(landmarks.staffBase.surfaceVertex));
  let maxStaffSpanChangeMeters=0,minStaffBaseHeightMeters=Infinity;
  const frames=clip.name==='Idle'?720:216;
  for(let f=0;f<=frames;f++){
    const t=clip.duration*f/frames,positions=at(t),offset=clip.name==='Idle'?new Vector3():curve(t);
    positions.forEach((p,i)=>{assert(p.toArray().every(Number.isFinite));bounds.expandByPoint(p);const d=p.distanceTo(initial[i]);maxDisplacement=Math.max(maxDisplacement,d);if(d>1e-7)changed.add(samples[i]);});
    bones.forEach((bone,i)=>{assert(bone.matrixWorld.elements.every(Number.isFinite));if(bone.matrixWorld.elements.some((v,j)=>Math.abs(v-initialBones[i][j])>1e-7))changedBones.add(i);});
    for(const [name,landmark] of Object.entries(landmarks)){
      const rigid=byNode.get(landmark.node).localToWorld(new Vector3(...landmark.boneLocalOffset));
      socketErrorMeters[name]=Math.max(socketErrorMeters[name],rigid.distanceTo(vertex(landmark.surfaceVertex))*metadata.metersPerNativeUnit);
    }
    const staffBase=vertex(landmarks.staffBase.surfaceVertex),staffTop=vertex(landmarks.staffTop.surfaceVertex);
    maxStaffSpanChangeMeters=Math.max(maxStaffSpanChangeMeters,Math.abs(staffTop.distanceTo(staffBase)-restStaffSpan)*metadata.metersPerNativeUnit);
    minStaffBaseHeightMeters=Math.min(minStaffBaseHeightMeters,staffBase.y*metadata.metersPerNativeUnit);
    for(const w of windows)if(t>=w.start-1e-7&&t<=w.end+1e-7){
      const positions=footSamples[w.foot].map(i=>vertex(i).add(offset));
      if(!w.first){w.first=positions.map(p=>p.clone());w.measuredPlantPositionsNative=positions.map(p=>p.toArray());}
      positions.forEach((p,i)=>{w.maxSlipMeters=Math.max(w.maxSlipMeters,p.distanceTo(w.first[i])*metadata.metersPerNativeUnit);w.minSoleHeightMeters=Math.min(w.minSoleHeightMeters,p.y*metadata.metersPerNativeUnit);w.maxSoleHeightMeters=Math.max(w.maxSoleHeightMeters,p.y*metadata.metersPerNativeUnit);});w.sampleCount++;
    }
    if(f%Math.max(1,Math.floor(frames/27))===0||f===frames){const root=byNode.get(17).getWorldPosition(new Vector3());trajectory.push({time:t,nativeRootWorld:root.toArray(),referenceWorldRoot:root.clone().add(offset).toArray(),referenceDisplacementMeters:offset.length()*metadata.metersPerNativeUnit,feet:Object.fromEntries(Object.entries(footSamples).map(([name,ids])=>[name,ids.reduce((s,i)=>s.add(vertex(i).add(offset)),new Vector3()).divideScalar(ids.length).toArray()]))});}
  }
  assert(changed.size>100 && maxDisplacement>.001,'Native clip must materially deform actual skin; static/no-op fails');
  const end=at(clip.duration),endpointError=Math.max(...end.map((p,i)=>p.distanceTo(initial[i])))*metadata.metersPerNativeUnit;
  assert(endpointError<.00001,`${clip.name} endpoints must close onto ready pose`);
  const rootEnd=byNode.get(17).getWorldPosition(new Vector3()),nativeNetRootMeters=rootEnd.clone().sub(initialRoot).multiplyScalar(metadata.metersPerNativeUnit);
  assert(Math.hypot(nativeNetRootMeters.x,nativeNetRootMeters.z)<1e-5,'In-place root must not double-drive capsule');
  assert(windows.every(w=>w.sampleCount && w.maxSlipMeters<=metadata.contactSlipBudgetMeters),'Measured planted soles exceed explicit contact-slip budget');
  const duration=clip.duration;at(duration*1.5);const held=samples.map(vertex);const heldError=Math.max(...held.map((p,i)=>p.distanceTo(end[i])));assert(heldError<1e-7,'One-shot clamp must retain end pose');
  action.stop();mixer.uncacheRoot(gltf.scene);
  let repeatError=null;if(clip.name==='Idle'){
    const repeatMixer=new AnimationMixer(gltf.scene),repeat=repeatMixer.clipAction(clip).setLoop(LoopRepeat,Infinity).play();repeatMixer.setTime(0.37);gltf.scene.updateMatrixWorld(true);const first=samples.map(vertex);repeatMixer.setTime(duration+0.37);gltf.scene.updateMatrixWorld(true);repeatError=Math.max(...samples.map((i,n)=>vertex(i).distanceTo(first[n])));assert(repeatError<1e-6);repeat.stop();repeatMixer.uncacheRoot(gltf.scene);
  }
  const channel=b.document.animations.find(c=>c.name===clip.name);assert(channel.channels.every(c=>joints.includes(c.target.node)));assert.equal(channel.channels.length,clip.tracks.length);
  for(const track of clip.tracks){
    const name=track.name.slice(0,track.name.lastIndexOf('.')),property=track.name.slice(track.name.lastIndexOf('.')+1);
    const bound=gltf.scene.getObjectByName(name);assert(bound&&bones.includes(bound)&&bound[property],`Unbound native channel ${track.name}`);
    assert([...track.times,...track.values].every(Number.isFinite));
  }
  clips.push({name:clip.name,durationSeconds:duration,channels:channel.channels.length,boundChannels:clip.tracks.length,allChannelsTargetNativeSkinJoints:true,changedBones:changedBones.size,sampledVertices:samples.length,changedSampleVertices:changed.size,maxSkinDisplacementNative:maxDisplacement,maxSkinDisplacementMeters:maxDisplacement*metadata.metersPerNativeUnit,finiteSamples:(frames+1)*samples.length,sampledBoundsNative:{min:bounds.min.toArray(),max:bounds.max.toArray()},endpointErrorMeters:endpointError,idleRepeatErrorNative:repeatError,oneShotHoldErrorNative:heldError,nativeNetRootMeters:nativeNetRootMeters.toArray(),contactWindows:windows.map(({first,...w})=>w),rootAndFootTrajectory:trajectory});
  Object.assign(clips.at(-1),{socketSurfaceToBoneErrorMeters:socketErrorMeters,staffSpanChangeMeters:maxStaffSpanChangeMeters,minimumStaffBaseHeightMeters:minStaffBaseHeightMeters,groundContactQualification:'sole slip is measured against actual starting sole positions; absolute floor placement and staff clearance require parent visual review'});
}
const report={beganAt,finishedAt:new Date().toISOString(),source:{bytes:sourceBytes.length,sha256:hash(sourceBytes)},derivative:{path:'asset-source/authored/actor-aren/aren-idle-lateral-dodge.glb',bytes:derivative.length,sha256:hash(derivative)},preservation:{originalBinBytes:a.bin.length,originalBinSha256:hash(a.bin),byteIdentical:true,primitiveUVMaterialJointOrderInverseBindWeightsPreserved:true,jointOrder:joints},skin:skinData,normalization:{measuredSourceHeight:1.7/metadata.metersPerNativeUnit,gameHeightMeters:1.7,scaleOnce:metadata.metersPerNativeUnit,authority:'parent game normalization, not provider real-world size'},rootMode:metadata.rootMode,contactSlipBudgetMeters:metadata.contactSlipBudgetMeters,footLandmarks:Object.fromEntries(Object.entries(footSamples).map(([name,ids])=>[name,{surfaceVertices:ids,regionCandidates:feet[name].length}])),socketLandmarks:landmarks,clips,browserLaunched:false,productionAccepted:false,providerSpend:0,unknownUsage:null,limitations:['CPU native GLTFLoader/mixer/skin evidence, not visual approval or GPU proof.','1.45m root reference is NOT a second actor movement driver. R04 continuous authoritative capsule movement/contact integration remains open; current engine instant displacement cannot preserve these contacts.','Coarse asymmetric provider arm/staff chain has no independent wrist or finger joint. Surface sockets require parent visual review.','Bounds are deterministic skinned vertex sample bounds, not exhaustive extrema or production deformation qualification.']};
for(const landmark of Object.values(landmarks)){
  const i=landmark.surfaceVertex;landmark.nativeSkinInfluences=[0,1,2,3].map(c=>({skinIndex:indices.array[i*4+c],node:joints[indices.array[i*4+c]],weight:weights.array[i*4+c]})).filter(v=>v.weight>0);
  landmark.preferredAttachment=landmark.node===4?'skinned-surface-vertex (not rigid bone socket)':'measured bone-local candidate; visual approval required';
}
await writeFile(new URL('measurements.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
await writeFile(new URL('manifest.json',import.meta.url),JSON.stringify({
  actor:'actor-aren',issue:23,scope:'R09 authored native Idle + LateralDodge canaries',
  status:'canary-only, parent visual review pending',productionAccepted:false,
  source:report.source,derivative:report.derivative,preservation:report.preservation,normalization:report.normalization,
  nativeClipNames:clips.map(c=>c.name),rootMode:metadata.rootMode,
  motionAuthority:'capsule simulation only; reference trajectory MUST NOT double-drive movement',
  gameplayProfile:{id:'quick_step_left',distanceMeters:1.45,actionTicks:15,recoveryTicks:12,ticksPerSecond:60},
  measuredClips:clips.map(c=>({name:c.name,channels:c.channels,durationSeconds:c.durationSeconds,skinDisplacementMeters:c.maxSkinDisplacementMeters,loopClosureMeters:c.endpointErrorMeters,maximumPlantedFootSlipMeters:Math.max(...c.contactWindows.map(w=>w.maxSlipMeters)),staffSpanChangeMeters:c.staffSpanChangeMeters,staffBaseRigidSocketErrorMeters:c.socketSurfaceToBoneErrorMeters.staffBase})),
  contactSlipBudgetMeters:metadata.contactSlipBudgetMeters,
  files:{anatomy:'anatomy.json',preKeyframePolicy:'anatomy-policy.json',authoring:'authoring.json',measurements:'measurements.json',authorScript:'author-clips.mjs',verifier:'verify-authored.mjs'},
  gates:{cpuNativeLoader:'measured',originalBytesPreserved:'measured',visualReview:'pending-parent',continuousCapsuleContact:'R04 open',production:'not-qualified'},
  anatomicalConstraints:['Lower staff surface vertex554945 is51.2% node4 staff and48.8% node13 right toe. Immutable source skin prevents independently rigid staff-base bone attachment. Use actual skinned-surface mapping or source-skin repair subject to approval; never relabel node4 as hand.'],
  providerCalls:0,providerSpend:0,unknownUsage:null,browserLaunched:false
},null,2)+'\n');
console.log(JSON.stringify({passed:true,derivative:report.derivative,clips:clips.map(c=>({name:c.name,duration:c.durationSeconds,channels:c.boundChannels,changedSkinVertices:c.changedSampleVertices,maxSkinDisplacementMeters:c.maxSkinDisplacementMeters,maxPlantedSlipMeters:Math.max(...c.contactWindows.map(w=>w.maxSlipMeters)),endpointErrorMeters:c.endpointErrorMeters,staffSpanChangeMeters:c.staffSpanChangeMeters,staffBaseRigidSocketErrorMeters:c.socketSurfaceToBoneErrorMeters.staffBase})),limitations:report.limitations},null,2));
