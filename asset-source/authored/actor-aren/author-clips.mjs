import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Vector3, Quaternion, Matrix4 } from 'three';
import { source, hash, unpack, load } from './inspect-anatomy.mjs';

// This exporter appends animation accessors only. Original BIN bytes and every
// original accessor, bufferView, primitive, node, material and skin remain intact.
const bytes = await readFile(source), { document: original, bin } = unpack(bytes);
assert.equal(hash(bytes), '7e759a4607f530137dfe58d0dcffecefd697030bcce6fbc2134625051b068151');
const gltf = await load(bytes);
let mesh; gltf.scene.traverse(n => { if(n.isSkinnedMesh) mesh=n; });
const joints=original.skins[0].joints, bones=new Map(joints.map((id,i)=>[id,mesh.skeleton.bones[i]]));
const rest=new Map([...bones].map(([id,b])=>[id,{p:b.position.clone(),q:b.quaternion.clone(),s:b.scale.clone(),world:b.getWorldPosition(new Vector3()),worldQ:b.getWorldQuaternion(new Quaternion())}]));
const up=new Vector3(0,1,0);
const forward=rest.get(9).world.clone().sub(rest.get(10).world).add(rest.get(13).world.clone().sub(rest.get(14).world)); forward.y=0;forward.normalize();
const lateral=up.clone().cross(forward).normalize();
const anatomy=JSON.parse(await readFile(new URL('anatomy.json',import.meta.url)));
const height=anatomy.restBounds.max[1]-anatomy.restBounds.min[1];
const metersPerNativeUnit=1.7/height, travel=1.45/metersPerNativeUnit;
const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
const reference=t=>travel*smooth((t-2/60)/(12/60));
const reset=()=>{for(const [id,b] of bones){const r=rest.get(id);b.position.copy(r.p);b.quaternion.copy(r.q);b.scale.copy(r.s);}gltf.scene.updateMatrixWorld(true);};
function rotateWorld(id,axis,angle){
  const b=bones.get(id),parentQ=b.parent.getWorldQuaternion(new Quaternion());
  b.quaternion.copy(parentQ.clone().invert().multiply(new Quaternion().setFromAxisAngle(axis,angle)).multiply(rest.get(id).worldQ));
  gltf.scene.updateMatrixWorld(true);
}
function solveLeg(hipId,kneeId,ankleId,target){
  const hip=bones.get(hipId), knee=bones.get(kneeId),ankle=bones.get(ankleId);
  const h=hip.getWorldPosition(new Vector3()), a=rest.get(kneeId).world.distanceTo(rest.get(hipId).world),b=rest.get(ankleId).world.distanceTo(rest.get(kneeId).world);
  const delta=target.clone().sub(h),distance=delta.length();
  assert(distance<a+b+1e-6 && distance>Math.abs(a-b),`Foot target unreachable: hip${hipId} distance${distance} length${a+b}`);
  const axis=delta.normalize(),along=(a*a-b*b+distance*distance)/(2*distance);
  const bend=forward.clone().addScaledVector(axis,-forward.dot(axis)).normalize();
  const k=h.clone().addScaledVector(axis,along).addScaledVector(bend,Math.sqrt(Math.max(0,a*a-along*along)));
  function aim(node,child,point){
    const parentQ=node.parent.getWorldQuaternion(new Quaternion());
    const current=child.getWorldPosition(new Vector3()).sub(node.getWorldPosition(new Vector3())).normalize();
    const wanted=point.clone().sub(node.getWorldPosition(new Vector3())).normalize();
    node.quaternion.copy(parentQ.clone().invert().multiply(new Quaternion().setFromUnitVectors(current,wanted)).multiply(node.getWorldQuaternion(new Quaternion())));
    gltf.scene.updateMatrixWorld(true);
  }
  aim(hip,knee,k);aim(knee,ankle,target);
  ankle.quaternion.copy(ankle.parent.getWorldQuaternion(new Quaternion()).invert().multiply(rest.get(ankleId).worldQ));
  gltf.scene.updateMatrixWorld(true);
}
const poses=[], rootReference=[];
function pose(kind,t){
  reset();
  const isIdle=kind==='Idle', breath=isIdle?Math.sin(2*Math.PI*t/3):0;
  const anticipation=isIdle?0:Math.sin(Math.PI*Math.min(t/(2/60),1))*(t<=2/60?1:0);
  const flight=isIdle?0:Math.sin(Math.PI*Math.max(0,Math.min(1,(t-2/60)/(12/60))));
  const landing=isIdle?0:Math.sin(Math.PI*Math.max(0,Math.min(1,(t-14/60)/(7/60))));
  const rootDelta=lateral.clone().multiplyScalar(isIdle?.0035*breath:-.007*anticipation+.018*flight+.006*landing);
  rootDelta.y=isIdle?-.010-.0015*(1-Math.cos(2*Math.PI*t/3)):-.010-.012*anticipation+.010*flight-.012*landing;
  const root=bones.get(17),parentInverse=root.parent.matrixWorld.clone().invert();
  root.position.copy(rest.get(17).world.clone().add(rootDelta).applyMatrix4(parentInverse));
  gltf.scene.updateMatrixWorld(true);
  rotateWorld(8,lateral,isIdle?.008*breath:.055*anticipation-.065*flight+.035*landing);
  rotateWorld(7,forward,isIdle?.004*breath:-.045*flight+.025*landing);
  rotateWorld(1,lateral,isIdle?-.004*breath:.018*flight);
  // Keep asymmetric provider arm/staff articulation intact; counter chest lean
  // at its real shoulder, rather than inventing a missing wrist/hand joint.
  rotateWorld(6,lateral,isIdle?.003*breath:-.075*flight-.03*landing);
  const shoulder=bones.get(6),parentQ=shoulder.parent.getWorldQuaternion(new Quaternion());
  shoulder.quaternion.copy(parentQ.clone().invert().multiply(new Quaternion().setFromAxisAngle(forward,.06+.05*landing)).multiply(shoulder.getWorldQuaternion(new Quaternion())));
  gltf.scene.updateMatrixWorld(true);
  const curve=isIdle?0:reference(t);
  for(const [hip,knee,ankle,sign] of [[12,11,10,1],[16,15,14,-1]]){
    const target=rest.get(ankle).world.clone();
    if(!isIdle){
      // Both feet release for the short lateral hop. Lead lands at tick14;
      // trailing leg lands at tick15 and stays planted; lead settles17–21.
      const liftEnd=(sign===1?14:15)/60,progress=smooth((t-2/60)/(liftEnd-2/60));
      const spread=(sign===1?.032:0)*smooth(t/(14/60))*(1-smooth((t-17/60)/(4/60)));
      target.addScaledVector(lateral,travel*progress-curve+spread);
      target.y+=.044*Math.sin(Math.PI*Math.max(0,Math.min(1,(t-2/60)/(liftEnd-2/60))));
      if(sign===1)target.y+=.020*Math.sin(Math.PI*Math.max(0,Math.min(1,(t-17/60)/(4/60))));
    }
    solveLeg(hip,knee,ankle,target);
  }
  const sample={t,transforms:Object.fromEntries([...bones].map(([id,b])=>[id,{translation:b.position.toArray(),rotation:b.quaternion.toArray()}]))};
  if(!isIdle)rootReference.push({time:t,referenceDisplacementNative:lateral.clone().multiplyScalar(curve).toArray(),referenceDistanceMeters:curve*metersPerNativeUnit,verticalPresentationNative:rootDelta.y});
  return sample;
}
const definitions=[{name:'Idle',duration:3,frames:360,loop:true},{name:'LateralDodge',duration:27/60,frames:108,loop:false}];
for(const def of definitions){const samples=[];for(let f=0;f<=def.frames;f++){try{samples.push(pose(def.name,def.duration*f/def.frames));}catch(error){throw new Error(`${def.name} at ${def.duration*f/def.frames}: ${error.message}`);}}poses.push({...def,samples});}
const doc=structuredClone(original),chunks=[bin];let length=bin.length;
doc.animations=[];
function accessor(values,type){
  const pad=(4-length%4)%4;if(pad){chunks.push(Buffer.alloc(pad));length+=pad;}
  const data=Buffer.alloc(values.length*4);values.forEach((v,i)=>data.writeFloatLE(v,i*4));
  const view=doc.bufferViews.length;doc.bufferViews.push({buffer:0,byteOffset:length,byteLength:data.length});chunks.push(data);length+=data.length;
  const index=doc.accessors.length,components=type==='SCALAR'?1:type==='VEC3'?3:4;
  doc.accessors.push({bufferView:view,componentType:5126,count:values.length/components,type,...(type==='SCALAR'?{min:[Math.min(...values)],max:[Math.max(...values)]}:{})});return index;
}
for(const def of poses){
  const input=accessor(def.samples.map(s=>s.t),'SCALAR'),animation={name:def.name,samplers:[],channels:[],extras:{loop:def.loop,rootMode:'in-place-authoritative-capsule',actionProfile:def.loop?null:'quick_step_left',authoring:'offline anatomical IK; source skin and primitive bytes unchanged'}};
  for(const id of joints)for(const path of ['translation','rotation']){
    const values=def.samples.flatMap(s=>s.transforms[id][path]);
    const stride=path==='translation'?3:4;
    if(!values.some((v,i)=>Math.abs(v-values[i%stride])>1e-8))continue;
    const output=accessor(values,path==='translation'?'VEC3':'VEC4'),sampler=animation.samplers.length;
    animation.samplers.push({input,output,interpolation:'LINEAR'});animation.channels.push({sampler,target:{node:id,path}});
  }
  doc.animations.push(animation);
}
doc.buffers[0].byteLength=length;
const jsonBytes=Buffer.from(JSON.stringify(doc)),jsonPadding=(4-jsonBytes.length%4)%4,json=Buffer.concat([jsonBytes,Buffer.alloc(jsonPadding,32)]),binary=Buffer.concat(chunks),binPadding=(4-binary.length%4)%4,paddedBinary=Buffer.concat([binary,Buffer.alloc(binPadding)]);
const header=Buffer.alloc(12);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(12+8+json.length+8+paddedBinary.length,8);
const chunkHeader=(size,type)=>{const h=Buffer.alloc(8);h.writeUInt32LE(size);h.writeUInt32LE(type,4);return h;};
const result=Buffer.concat([header,chunkHeader(json.length,0x4e4f534a),json,chunkHeader(paddedBinary.length,0x004e4942),paddedBinary]);
await writeFile(new URL('aren-idle-lateral-dodge.glb',import.meta.url),result);
await writeFile(new URL('authoring.json',import.meta.url),JSON.stringify({
  sourceSha256:hash(bytes),derivativeSha256:hash(result),derivativeBytes:result.length,
  measuredSourceHeight:height,metersPerNativeUnit,gamePlayableHeightMeters:1.7,
  normalizationAuthority:'parent 1.70m game baseline; runtime parent applies scale exactly once; no native geometry/rest modification',
  forward:forward.toArray(),lateral:lateral.toArray(),up:up.toArray(),
  rootMode:'in-place-authoritative-capsule',referenceCurveIsNotMovementDriver:true,
  simulationAppliesDisplacementImmediately:true,continuousCapsuleContactIntegration:'R04 open',
  rootReference,clips:definitions,contactWindows:{
    Idle:[{foot:'left',start:0,end:3},{foot:'right',start:0,end:3}],
    LateralDodge:[{foot:'left',start:0,end:2/60},{foot:'right',start:0,end:2/60},
      {foot:'left',start:14/60,end:17/60},{foot:'right',start:15/60,end:27/60},
      {foot:'left',start:21/60,end:27/60}]
  },contactSlipBudgetMeters:.025,productionAccepted:false,providerSpend:0,unknownUsage:null
},null,2)+'\n');
console.log(JSON.stringify({sha256:hash(result),bytes:result.length,channels:doc.animations.map(a=>({name:a.name,channels:a.channels.length})),metersPerNativeUnit,forward:forward.toArray(),lateral:lateral.toArray()}));
