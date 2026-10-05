import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Texture, Vector3, Quaternion } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { source, loadNative, vertex, update, unpack, sha } from '../../authored/actor-asha/native-runtime.mjs';
const input=await source(), original=await loadNative(input.bytes);
const bytes=await readFile(new URL('model.glb',import.meta.url)), derivative=unpack(bytes);
const loader=new GLTFLoader();loader.register(()=>({name:'CPU_MEASUREMENT_TEXTURE_SKIP',loadTexture:()=>Promise.resolve(new Texture())}));
const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
gltf.scene.updateMatrixWorld(true);const meshes=[];gltf.scene.traverse(n=>{if(n.isSkinnedMesh)meshes.push(n);});
assert.equal(meshes.length,1);const r={...gltf,mesh:meshes[0],bones:meshes[0].skeleton.bones};assert.equal(r.bones.length,24);
const count=r.mesh.geometry.attributes.position.count, baseline=new Float64Array(count*3), repairedRest=new Float64Array(count*3);
const editedBytes=await readFile(new URL('reweighted-vertices.uint32le',import.meta.url));const edited=new Set();for(let i=0;i<editedBytes.length;i+=4)edited.add(editedBytes.readUInt32LE(i));
const report={schemaVersion:1,revision:'asha-negativeX-foreleg-v1',sourceSHA256:sha(input.bytes),derivativeSHA256:sha(bytes),cpuInstrument:'genuine Three.js GLTFLoader + SkinnedMesh.applyBoneTransform, textures deliberately not decoded',geometryBytes:{},matrixSpace:'native GLTFLoader world including original Armature/mesh bind transforms',vertexCount:count,reweightedVertexCount:edited.size};
const view=(d,b,i)=>{const v=d.bufferViews[i];return b.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength);};
for(let i=0;i<input.doc.bufferViews.length;i++)if(![3,4,9].includes(i)) {
  assert.deepEqual(view(input.doc,input.bin,i),view(derivative.doc,derivative.bin,i));
  report.geometryBytes[i]={sha256:sha(view(input.doc,input.bin,i)),byteLength:input.doc.bufferViews[i].byteLength,preserved:true};
}
assert.deepEqual(input.doc.materials,derivative.doc.materials);assert.deepEqual(input.doc.images,derivative.doc.images);assert.deepEqual(input.doc.textures,derivative.doc.textures);
assert.deepEqual(input.doc.skins[0].joints,derivative.doc.skins[0].joints.slice(0,21));
for(let i=0;i<input.doc.nodes.length;i++) {
  const old=structuredClone(input.doc.nodes[i]),now=structuredClone(derivative.doc.nodes[i]);
  if(i===10)now.children=now.children.filter(n=>n!==23);
  assert.deepEqual(old,now);
}
assert.deepEqual(view(input.doc,input.bin,9),view(derivative.doc,derivative.bin,9).subarray(0,21*64));
assert.equal(derivative.doc.bufferViews.length,input.doc.bufferViews.length);
const index=r.mesh.geometry.attributes.skinIndex,weight=r.mesh.geometry.attributes.skinWeight;
let maxSumError=0,outsideWeightByteDifference=0;
const oldJ=view(input.doc,input.bin,3),newJ=view(derivative.doc,derivative.bin,3),oldW=view(input.doc,input.bin,4),newW=view(derivative.doc,derivative.bin,4);
for(let i=0;i<count;i++) {
  let sum=0;for(let k=0;k<4;k++){const j=index.getComponent(i,k),w=weight.getComponent(i,k);assert.ok(Number.isInteger(j)&&j>=0&&j<24);assert.ok(Number.isFinite(w)&&w>=0&&w<=1);sum+=w;}
  maxSumError=Math.max(maxSumError,Math.abs(sum-1));
  if(!edited.has(i)){assert.deepEqual(oldJ.subarray(i*4,i*4+4),newJ.subarray(i*4,i*4+4));assert.deepEqual(oldW.subarray(i*16,i*16+16),newW.subarray(i*16,i*16+16));}
}
assert.ok(maxSumError<3e-7);
let sourceRestBindResidual=0,float32CoordinateDecodeResidual=0,maxRestResidual=0,maxRestVertex=null;
const a=new Vector3(),b=new Vector3(),ideal=new Vector3();
for(let i=0;i<count;i++) {
  vertex(original,i,a);vertex(r,i,b);baseline.set(a.toArray(),i*3);repairedRest.set(b.toArray(),i*3);
  // GLTFLoader binds this skin with identity bindMatrix; attached bindMatrixInverse cancels meshWorld.
  // Compare both surfaces in the SAME native-world bind space, not raw POSITION * meshWorld.
  ideal.fromBufferAttribute(original.mesh.geometry.attributes.position,i).applyMatrix4(original.mesh.bindMatrix).applyMatrix4(original.mesh.bindMatrixInverse).applyMatrix4(original.mesh.matrixWorld);
  sourceRestBindResidual=Math.max(sourceRestBindResidual,a.distanceTo(ideal));
  float32CoordinateDecodeResidual=Math.max(float32CoordinateDecodeResidual,Math.hypot(a.x-Math.fround(a.x),a.y-Math.fround(a.y),a.z-Math.fround(a.z)));
  const error=a.distanceTo(b);if(error>maxRestResidual){maxRestResidual=error;maxRestVertex=i;}
}
const tolerance=2*sourceRestBindResidual+8*float32CoordinateDecodeResidual;
assert.ok(maxRestResidual<=tolerance,'All-vertex native deformed rest must match input within measured float32 calibration');
report.restSurface={allVerticesMeasured:count,maxResidual:maxRestResidual,maxResidualVertex:maxRestVertex,tolerance,sourceNativeBindResidual:sourceRestBindResidual,float32WorldCoordinateRoundingResidual:float32CoordinateDecodeResidual,calibration:'2 * measured original all-vertex bind residual + 8 * measured float32 native-world coordinate rounding residual',pass:true};
report.skin={finiteNonnegativeNormalized:true,maxWeightSumError:maxSumError,jointIndicesValid:true,untouchedVertexCount:count-edited.size,outsideWeightByteDifference};
report.binds=r.bones.map((bone,j)=>{
  const ibm=r.mesh.skeleton.boneInverses[j],identity=bone.matrixWorld.clone().multiply(ibm);
  assert.ok(ibm.elements.every(Number.isFinite));assert.ok(Math.abs(ibm.determinant())>1e-8);
  const maxIdentityResidual=Math.max(...identity.elements.map((v,i)=>Math.abs(v-(i%5===0?1:0))));assert.ok(maxIdentityResidual<1e-6);
  return {skinJoint:j,gltfNode:derivative.doc.skins[0].joints[j],name:bone.name,restWorldPosition:bone.getWorldPosition(new Vector3()).toArray(),inverseBindMatrix:ibm.elements,maxIdentityResidual,originalIBMBytePreserved:j<21};
});
const groups={outsideReweightedRegion:{n:0,max:0},head:{n:0,max:0},neck:{n:0,max:0},chest:{n:0,max:0},intendedRegion:{n:0,max:0}};
const q=r.bones[23].quaternion.clone();r.bones[23].quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-.35));update(r);
const displacement=i=>{vertex(r,i,b);return b.distanceTo(a.fromArray(repairedRest,i*3));};
for(let i=0;i<count;i++) {
  const x=baseline[i*3],y=baseline[i*3+1],z=baseline[i*3+2],d=displacement(i);
  const memberships=[edited.has(i)?'intendedRegion':'outsideReweightedRegion'];
  if(y>=.38&&z>=.30)memberships.push('head');
  if(y>=.30&&z>=.20)memberships.push('neck');
  if(y>=.18&&((Math.abs(x)<=.05&&z>=.05&&z<=.29)||(x<-.065&&z<.29&&z>0)))memberships.push('chest');
  for(const name of memberships){groups[name].n++;groups[name].max=Math.max(groups[name].max,d);}
}
for(const name of ['outsideReweightedRegion','head','neck','chest']){assert.ok(groups[name].n>0);assert.equal(groups[name].max,0);}
assert.ok(groups.intendedRegion.max>.005);
const contacts=JSON.parse(await readFile(new URL('../../authored/actor-asha/contact-markers.json',import.meta.url))).contacts;
const measuredContacts=contacts.map(c=>({id:c.id,markers:c.markers.map(m=>({vertex:m.vertex,originalRest:Array.from(baseline.subarray(m.vertex*3,m.vertex*3+3)),derivativeRest:Array.from(repairedRest.subarray(m.vertex*3,m.vertex*3+3)),flexWorld:vertex(r,m.vertex,new Vector3()).toArray(),flexDisplacement:displacement(m.vertex)}))}));
for(const c of measuredContacts)for(const m of c.markers){if(c.id==='front-negative-X')assert.ok(m.flexDisplacement>.005&&m.flexDisplacement<.1);else assert.equal(m.flexDisplacement,0);}
report.independentNegativeXWristFlex={axis:'wrist local +X',radians:-.35,groups,actualSoleContacts:measuredContacts,pass:true};
r.bones[23].quaternion.copy(q);update(r);
const sole=contacts.find(c=>c.id==='front-negative-X').markers;
const plantedConstraint=()=>sole.every(m=>vertex(r,m.vertex,b).distanceTo(a.fromArray(baseline,m.vertex*3))<=tolerance);
assert.ok(plantedConstraint());
// Counterexamples are actual altered native runtime inputs, not fabricated packet values.
const originalIBM=r.mesh.skeleton.boneInverses[23].clone();r.mesh.skeleton.boneInverses[23].elements[12]+=.025;update(r);
const corruptedIBMContactPass=plantedConstraint();assert.equal(corruptedIBMContactPass,false);r.mesh.skeleton.boneInverses[23].copy(originalIBM);update(r);
const saved=sole.map(m=>({i:m.vertex,j:[0,1,2,3].map(k=>index.getComponent(m.vertex,k)),w:[0,1,2,3].map(k=>weight.getComponent(m.vertex,k))}));
for(const {i} of saved){index.setXYZW(i,7,0,0,0);weight.setXYZW(i,1,0,0,0);}
r.bones[23].quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-.35));update(r);
const corruptedWeightFlexPass=sole.every(m=>displacement(m.vertex)>.005);assert.equal(corruptedWeightFlexPass,false);
for(const s of saved){index.setXYZW(s.i,...s.j);weight.setXYZW(s.i,...s.w);}r.bones[23].quaternion.copy(q);update(r);
report.contactConstraints={scope:'actual native sole markers at planted rest + independently commanded -0.35rad wrist flex; not Idle/Pounce clip contact certification',plantedRestPass:true,positiveIndependentWristFlexPass:true,corruptedInverseBindTranslationNativeUnits:.025,corruptedIBMContactPass,corruptedWeightsAssignedNativeTorsoJoint:7,corruptedWeightFlexPass,originalNativeJointCount:original.bones.length,originalHasAddedWrist:original.bones.some(b=>b.name===r.bones[23].name)};
report.chainControl=[];
for(const joint of [21,22,23]) {
  const neutral=r.bones[joint].quaternion.clone();
  r.bones[joint].quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-.35));update(r);
  const maxima={outsideReweightedRegion:0,head:0,neck:0,chest:0,intendedRegion:0};
  for(let i=0;i<count;i++) {
    const x=baseline[i*3],y=baseline[i*3+1],z=baseline[i*3+2],d=displacement(i);
    const key=edited.has(i)?'intendedRegion':'outsideReweightedRegion';maxima[key]=Math.max(maxima[key],d);
    if(y>=.38&&z>=.30)maxima.head=Math.max(maxima.head,d);
    if(y>=.30&&z>=.20)maxima.neck=Math.max(maxima.neck,d);
    if(y>=.18&&((Math.abs(x)<=.05&&z>=.05&&z<=.29)||(x<-.065&&z<.29&&z>0)))maxima.chest=Math.max(maxima.chest,d);
  }
  for(const key of ['outsideReweightedRegion','head','neck','chest'])assert.equal(maxima[key],0);
  assert.ok(maxima.intendedRegion>.005);
  for(const c of contacts.filter(c=>c.id!=='front-negative-X'))for(const m of c.markers)assert.equal(displacement(m.vertex),0);
  report.chainControl.push({skinJoint:joint,node:derivative.doc.skins[0].joints[joint],localAxis:'+X',radians:-.35,allVerticesMeasured:count,maxDisplacement:maxima});
  r.bones[joint].quaternion.copy(neutral);update(r);
}
report.protectedSetDefinitions={head:'native rest y>=.38 and z>=.30',neck:'native rest y>=.30 and z>=.20',chest:'native rest y>=.18 and either abs(x)<=.05,z in [.05,.29] or x<-.065,z in (0,.29)',outsideReweightedRegion:'complement of hashed reweighted-vertices.uint32le'};
report.bufferPacking={singleGLB:true,liveBufferViewCount:derivative.doc.bufferViews.length,noDeadDuplicatedSkinBuffers:true,byteLength:bytes.length,github100MiBHeadroomBytes:100*1024*1024-bytes.length};
assert.ok(bytes.length<100*1024*1024);
report.geometryOwnership='Tripo original immutable source';report.oldAnimationMeasurementsInvalidated=true;report.visualDeformationQuality=null;report.textureQuality=null;report.productionGateStatus='PENDING_PARENT_VISUAL_REVIEW_AND_REBUILT_NATIVE_CANARY_CLIPS';report.releaseVerified=false;
report.measurementSourceSHA256=sha(await readFile(new URL('measure-rig.mjs',import.meta.url)));
report.contactMarkersSHA256=sha(await readFile(new URL('../../authored/actor-asha/contact-markers.json',import.meta.url)));
const packetBytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
await writeFile(new URL('measurement-packet.json',import.meta.url),packetBytes);
const provenance=JSON.parse(await readFile(new URL('provenance.json',import.meta.url)));
assert.equal(provenance.derivativeSHA256,sha(bytes));
assert.equal(provenance.authoringSourceSHA256,sha(await readFile(new URL('author-rig.mjs',import.meta.url))));
provenance.measurementPacketSHA256=sha(packetBytes);provenance.measurementSourceSHA256=report.measurementSourceSHA256;
provenance.numericRepairProof='ALL_VERTEX_NATIVE_REST_AND_CHAIN_CONTROL_POSITIVE_NEGATIVE_PROOF';
provenance.artifactFrozenForCanaryAuthoring=true;
await writeFile(new URL('provenance.json',import.meta.url),JSON.stringify(provenance,null,2)+'\n');
console.log(JSON.stringify({derivativeSHA256:report.derivativeSHA256,restSurface:report.restSurface,skin:report.skin,groups,contacts:measuredContacts.map(c=>({id:c.id,minimumFlexDisplacement:Math.min(...c.markers.map(m=>m.flexDisplacement)),maximumFlexDisplacement:Math.max(...c.markers.map(m=>m.flexDisplacement))})),negativeControls:report.contactConstraints,bufferPacking:report.bufferPacking},null,2));
