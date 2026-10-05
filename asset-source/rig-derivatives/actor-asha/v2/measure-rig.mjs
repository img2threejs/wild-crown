import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Texture, Vector3, Quaternion, Box3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { source, loadNative, vertex, update, unpack, sha } from '../../../authored/actor-asha/native-runtime.mjs';
const input=await source(),original=await loadNative(input.bytes);
const bytes=await readFile(new URL('model.glb',import.meta.url)),output=unpack(bytes);
const v1Bytes=await readFile(new URL('../model.glb',import.meta.url)),v1=unpack(v1Bytes);
assert.equal(sha(v1Bytes),'c93dcd4f8ef93de40093e2c5b89a5296e7afaa5b47f0ecab495c380f08578712');
const loader=new GLTFLoader();loader.register(()=>({name:'CPU_MEASUREMENT_TEXTURE_SKIP',loadTexture:()=>Promise.resolve(new Texture())}));
const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
gltf.scene.updateMatrixWorld(true);const meshes=[];gltf.scene.traverse(n=>{if(n.isSkinnedMesh)meshes.push(n);});assert.equal(meshes.length,1);
const r={...gltf,mesh:meshes[0],bones:meshes[0].skeleton.bones};assert.equal(r.bones.length,24);
const view=(g,i)=>{const v=g.doc.bufferViews[i];return g.bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength);};
const preservedViews=[];
for(let i=0;i<input.doc.bufferViews.length;i++)if(![3,4,9].includes(i)){assert.deepEqual(view(input,i),view(output,i));preservedViews.push({view:i,bytes:input.doc.bufferViews[i].byteLength,sha256:sha(view(output,i))});}
assert.deepEqual(input.doc.materials,output.doc.materials);assert.deepEqual(input.doc.images,output.doc.images);assert.deepEqual(input.doc.textures,output.doc.textures);
assert.deepEqual(input.doc.skins[0].joints,output.doc.skins[0].joints.slice(0,21));
assert.deepEqual(v1.doc.nodes,output.doc.nodes);assert.deepEqual(v1.doc.skins,output.doc.skins);
assert.deepEqual(view(input,9),view(output,9).subarray(0,21*64));assert.deepEqual(view(v1,9),view(output,9));
for(let i=0;i<input.doc.nodes.length;i++){const now=structuredClone(output.doc.nodes[i]);if(i===10)now.children=now.children.filter(n=>n!==23);assert.deepEqual(input.doc.nodes[i],now);}
assert.equal(output.doc.bufferViews.length,10);
let end=0;for(const v of output.doc.bufferViews){assert.equal(v.byteOffset%4,0);assert.ok(v.byteOffset>=end);end=v.byteOffset+v.byteLength;}assert.equal((end+3)&~3,output.doc.buffers[0].byteLength);
const count=r.mesh.geometry.attributes.position.count;assert.equal(count,989606);
const footprintBytes=await readFile(new URL('contact-footprint.json',import.meta.url)),footprint=JSON.parse(footprintBytes);
const paws=footprint.paws,fullSole=paws.find(p=>p.id==='front-negative-X').vertices;
const pawByVertex=new Map();for(const paw of paws)for(const i of paw.vertices){assert.ok(!pawByVertex.has(i));pawByVertex.set(i,paw.id);}
assert.equal(pawByVertex.size,49814);assert.equal(fullSole.length,13960);
const editedBytes=await readFile(new URL('reweighted-vertices.uint32le',import.meta.url)),edited=new Set();for(let i=0;i<editedBytes.length;i+=4)edited.add(editedBytes.readUInt32LE(i));assert.equal(edited.size,98507);
const index=r.mesh.geometry.attributes.skinIndex,weight=r.mesh.geometry.attributes.skinWeight;
let maxWeightSumError=0;
for(let i=0;i<count;i++) {
  let sum=0;for(let k=0;k<4;k++){const j=index.getComponent(i,k),w=weight.getComponent(i,k);assert.ok(Number.isInteger(j)&&j>=0&&j<24);assert.ok(Number.isFinite(w)&&w>=0&&w<=1);sum+=w;}maxWeightSumError=Math.max(maxWeightSumError,Math.abs(sum-1));
  if(!edited.has(i)){assert.deepEqual(view(input,3).subarray(i*4,i*4+4),view(output,3).subarray(i*4,i*4+4));assert.deepEqual(view(input,4).subarray(i*16,i*16+16),view(output,4).subarray(i*16,i*16+16));}
}
assert.ok(maxWeightSumError<3e-7);
for(const i of fullSole){assert.ok(edited.has(i));for(let k=0;k<4;k++)if(weight.getComponent(i,k)>0)assert.equal(index.getComponent(i,k),23);assert.equal(weight.getComponent(i,2),1);}
const baseline=new Float64Array(count*3),rest=new Float64Array(count*3),a=new Vector3(),b=new Vector3(),ideal=new Vector3(),restBox=new Box3();
let sourceBindResidual=0,float32CoordinateResidual=0,maxRestResidual=0,maxRestVertex=null;
const freshPartition=paws.map(p=>({id:p.id,vertices:[]}));let nearFloor=0;
const regionFor=p=>p.z>.18?(p.x<.015?'front-negative-X':'front-positive-X'):p.z<0&&p.x<-.10?'rear-negative-X':p.x>-.025&&p.x<.11&&p.z<-.12?'rear-positive-X':null;
const protectedSets={outside:new Set(),head:new Set(),neck:new Set(),chest:new Set()};
for(let i=0;i<count;i++) {
  vertex(original,i,a);vertex(r,i,b);baseline.set(a.toArray(),i*3);rest.set(b.toArray(),i*3);restBox.expandByPoint(b);
  ideal.fromBufferAttribute(original.mesh.geometry.attributes.position,i).applyMatrix4(original.mesh.bindMatrix).applyMatrix4(original.mesh.bindMatrixInverse).applyMatrix4(original.mesh.matrixWorld);
  sourceBindResidual=Math.max(sourceBindResidual,a.distanceTo(ideal));float32CoordinateResidual=Math.max(float32CoordinateResidual,Math.hypot(a.x-Math.fround(a.x),a.y-Math.fround(a.y),a.z-Math.fround(a.z)));
  const d=a.distanceTo(b);if(d>maxRestResidual){maxRestResidual=d;maxRestVertex=i;}
  if(!edited.has(i))protectedSets.outside.add(i);
  if(a.y>=.38&&a.z>=.30)protectedSets.head.add(i);
  if(a.y>=.30&&a.z>=.20)protectedSets.neck.add(i);
  if(a.y>=.18&&((Math.abs(a.x)<=.05&&a.z>=.05&&a.z<=.29)||(a.x<-.065&&a.z<.29&&a.z>0)))protectedSets.chest.add(i);
  if(b.y<.015){nearFloor++;const id=regionFor(b);assert.ok(id,'Every actual near-floor vertex must classify into exactly one paw');freshPartition.find(p=>p.id===id).vertices.push(i);}
}
assert.equal(nearFloor,49814);for(const paw of paws)assert.deepEqual(freshPartition.find(p=>p.id===paw.id).vertices,[...paw.vertices].sort((a,b)=>a-b));
const tolerance=2*sourceBindResidual+8*float32CoordinateResidual;assert.ok(maxRestResidual<=tolerance);
const ibms=r.bones.map((bone,j)=>{const ibm=r.mesh.skeleton.boneInverses[j];assert.ok(ibm.elements.every(Number.isFinite));assert.ok(Math.abs(ibm.determinant())>1e-8);const residual=Math.max(...bone.matrixWorld.clone().multiply(ibm).elements.map((v,k)=>Math.abs(v-(k%5===0?1:0))));assert.ok(residual<1e-6);return {skinJoint:j,node:output.doc.skins[0].joints[j],name:bone.name,worldRestPosition:bone.getWorldPosition(new Vector3()).toArray(),inverseBindMatrix:[...ibm.elements],identityResidual:residual};});
const displacement=i=>vertex(r,i,b).distanceTo(a.fromArray(rest,i*3));
const chainControls=[];let wristPose;
for(const j of [21,22,23]) {
  const q=r.bones[j].quaternion.clone();r.bones[j].quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-.35));update(r);
  const protectedMovement={};for(const [name,set]of Object.entries(protectedSets)){let max=0;for(const i of set)max=Math.max(max,displacement(i));assert.equal(max,0);protectedMovement[name]={count:set.size,max};}
  let regionMax=0;for(const i of edited)regionMax=Math.max(regionMax,displacement(i));assert.ok(regionMax>.005);
  const soleContacts=paws.map(paw=>{let min=Infinity,max=0,restError=0;for(const i of paw.vertices){const d=displacement(i);min=Math.min(min,d);max=Math.max(max,d);restError=Math.max(restError,new Vector3().fromArray(rest,i*3).distanceTo(new Vector3().fromArray(baseline,i*3)));}if(paw.id!=='front-negative-X')assert.equal(max,0);else assert.ok(min>.005);assert.ok(restError<=tolerance);return {id:paw.id,count:paw.vertices.length,minimumArticulationDisplacement:min,maximumArticulationDisplacement:max,maximumNeutralSourceContactResidual:restError};});
  if(j===23){wristPose=Buffer.alloc(49814*9*8);let row=0;for(const paw of paws)for(const i of paw.vertices){const values=[...baseline.subarray(i*3,i*3+3),...rest.subarray(i*3,i*3+3),...vertex(r,i,new Vector3()).toArray()];for(let k=0;k<9;k++)wristPose.writeDoubleLE(values[k],row*72+k*8);row++;}}
  chainControls.push({skinJoint:j,node:output.doc.skins[0].joints[j],radians:-.35,axis:'local+X',allVerticesMeasured:count,protectedMovement,intendedRegionMaxDisplacement:regionMax,fullSoleContacts:soleContacts});
  r.bones[j].quaternion.copy(q);update(r);
}
const plantedResiduals=()=>fullSole.map(i=>vertex(r,i,b).distanceTo(a.fromArray(baseline,i*3)));
const positiveResiduals=plantedResiduals();assert.ok(positiveResiduals.every(d=>d<=tolerance));
const ibm=r.mesh.skeleton.boneInverses[23],savedIBM=ibm.clone();ibm.elements[12]+=.025;update(r);
const badIBMResiduals=plantedResiduals(),badIBMPass=badIBMResiduals.every(d=>d<=tolerance);assert.equal(badIBMPass,false);assert.ok(badIBMResiduals.every(d=>d>tolerance));ibm.copy(savedIBM);update(r);
const saved=fullSole.map(i=>({i,j:[0,1,2,3].map(k=>index.getComponent(i,k)),w:[0,1,2,3].map(k=>weight.getComponent(i,k))}));
for(const {i}of saved){index.setXYZW(i,7,0,0,0);weight.setXYZW(i,1,0,0,0);}
const wrist=r.bones[23],q=wrist.quaternion.clone();wrist.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1,0,0),-.35));update(r);
const badWeightMotion=fullSole.map(displacement),badWeightPass=badWeightMotion.every(d=>d>.005);assert.equal(badWeightPass,false);assert.ok(badWeightMotion.every(d=>d<.005));
for(const s of saved){index.setXYZW(s.i,...s.j);weight.setXYZW(s.i,...s.w);}wrist.quaternion.copy(q);update(r);
assert.ok(plantedResiduals().every(d=>d<=tolerance));
await writeFile(new URL('full-sole-rest-and-wrist-flex.float64le',import.meta.url),wristPose);
const hashSet=set=>{const bytes=Buffer.alloc(set.size*4);[...set].forEach((i,k)=>bytes.writeUInt32LE(i,k*4));return sha(bytes);};
const report={schemaVersion:2,revision:'asha-negativeX-foreleg-v2',sourceSHA256:sha(input.bytes),previousV1SHA256:sha(v1Bytes),derivativeSHA256:sha(bytes),instrument:'RealThreeGLTFLoader/SkinnedMesh.applyBoneTransform CPU; image decoding skipped',preservedGeometryViews:preservedViews,original21JointOrderTRSAndIBMBytesPreserved:true,allV1RigRestTransformsAnd24IBMsPreserved:true,skin:{all989606FiniteNormalizedWeightsAndIndicesChecked:true,maxWeightSumError,connectedReweightedCount:edited.size,untouchedSkinVertexCount:count-edited.size,all13960ForeSolePositiveInfluences:[23]},restSurface:{allVerticesMeasured:count,maxResidual:maxRestResidual,maxResidualVertex:maxRestVertex,tolerance,sourceBindResidual,float32CoordinateResidual,calibration:'2*immutableinput nativebind residual+8*immutableinput float32nativeworld rounding residual; ideal=POSITION*bindMatrix*bindMatrixInverse*meshWorld',actualDeformedBounds:{min:restBox.min.toArray(),max:restBox.max.toArray()}},ibms,nearFloor:{definition:'actualV2nativeworldY<.015; fullspatial pawpartition, no omitted or duplicatevertices',actualVertexCount:nearFloor,referenceVertexCount:49814,freshPartitionMatchesAllReferenceIDs:true,pawCounts:freshPartition.map(p=>({id:p.id,count:p.vertices.length,vertexSetSHA256:hashSet(new Set(p.vertices))}))},protectedSets:Object.fromEntries(Object.entries(protectedSets).map(([name,set])=>[name,{count:set.size,vertexSetSHA256:hashSet(set)}])),chainControls,contactConstraints:{foreSoleVertexCount:fullSole.length,positivePlantedResidualMax:Math.max(...positiveResiduals),badIBMTranslation:.025,badIBMContactPass:badIBMPass,badIBMRejectedVertexCount:badIBMResiduals.filter(d=>d>tolerance).length,badIBMResidualMin:Math.min(...badIBMResiduals),badIBMResidualMax:Math.max(...badIBMResiduals),badWeightJoint:7,badWeightFlexPass:badWeightPass,badWeightRejectedVertexCount:badWeightMotion.filter(d=>d<.005).length,badWeightMotionMax:Math.max(...badWeightMotion)},fullSolePoseEvidence:{file:'full-sole-rest-and-wrist-flex.float64le',sha256:sha(wristPose),rowOrder:'contact-footprint.json pawsorder then verticesorder',encoding:'9littleendianFloat64perrow: immutableoriginalrestXYZ,V2neutralXYZ,V2wrist-.35radXYZ;72bytes/vertex',vertexCount:49814},packing:{bytes:bytes.length,liveViews:10,noDeadSkinBuffers:true,github100MiBHeadroom:100*1024*1024-bytes.length},measurementSourceSHA256:sha(await readFile(new URL('measure-rig.mjs',import.meta.url))),allV1CanaryReceiptsInvalidated:true,canaryContactQuality:null,visualDeformationQuality:null,releaseVerified:false,productionGateStatus:'PENDING_PARENT_VISUAL_AND_NEW_V2_NATIVE_CANARY'};
const packetBytes=Buffer.from(JSON.stringify(report,null,2)+'\n');await writeFile(new URL('measurement-packet.json',import.meta.url),packetBytes);
const provenance=JSON.parse(await readFile(new URL('provenance.json',import.meta.url)));assert.equal(provenance.derivativeSHA256,sha(bytes));assert.equal(provenance.authoringSourceSHA256,sha(await readFile(new URL('author-rig.mjs',import.meta.url))));
provenance.measurementPacketSHA256=sha(packetBytes);provenance.measurementSourceSHA256=report.measurementSourceSHA256;provenance.fullSolePoseEvidenceSHA256=sha(wristPose);provenance.artifactFrozenForCanaryAuthoring=true;provenance.numericProof='FULL13960FORE_SOLE_49814FOOTPRINT_ALL989606REST_ALLCHAIN_POSITIVE_NEGATIVE';
await writeFile(new URL('provenance.json',import.meta.url),JSON.stringify(provenance,null,2)+'\n');
assert.equal(sha(await readFile(new URL('../model.glb',import.meta.url))),report.previousV1SHA256);
console.log(JSON.stringify({revision:report.revision,sha256:report.derivativeSHA256,restSurface:report.restSurface,skin:report.skin,nearFloor:report.nearFloor,chainControls,contactConstraints:report.contactConstraints,packing:report.packing,v1Preserved:true},null,2));
