import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { source, loadNative, vertex, unpack, sha } from '../../../authored/actor-asha/native-runtime.mjs';

// V2 preserves the immutable V1 rig and extends only the measured distal skin region.
const revision='asha-negativeX-foreleg-v2';
const input=await source(), runtime=await loadNative(input.bytes);
const v1Bytes=await readFile(new URL('../model.glb',import.meta.url));
const v1SHA='c93dcd4f8ef93de40093e2c5b89a5296e7afaa5b47f0ecab495c380f08578712';
assert.equal(sha(v1Bytes),v1SHA);const v1=unpack(v1Bytes);
const footprintBytes=await readFile(new URL('../../../authored/actor-asha/corrected-rig/contacts.json',import.meta.url));
const footprint=JSON.parse(footprintBytes);assert.equal(footprint.sourceSHA256,v1SHA);
const blockerBytes=await readFile(new URL('../../../authored/actor-asha/corrected-rig/processing-blocker.json',import.meta.url));
const blocker=JSON.parse(blockerBytes);assert.equal(blocker.sourceSHA256,v1SHA);
assert.equal(blocker.legacyMixedSoleCount,762);
const paws=footprint.paws.map(p=>({id:p.id,vertices:p.sole.map(m=>m.vertex)}));
assert.equal(paws.reduce((n,p)=>n+p.vertices.length,0),49814);
const fullSole=paws.find(p=>p.id==='front-negative-X').vertices;assert.equal(fullSole.length,13960);
assert.equal(new Set(paws.flatMap(p=>p.vertices)).size,49814);
const n=runtime.mesh.geometry.attributes.position.count, rest=new Float64Array(n*3), parent=new Int32Array(n).fill(-1), p=new Vector3(), seam=new Map();
const find=i=>{let root=i;while(parent[root]!==root)root=parent[root];while(i!==root){const next=parent[i];parent[i]=root;i=next;}return root;};
const join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
const lateral=y=>-.05-.015*Math.max(0,Math.min(1,(y-.08)/.06));
const anterior=y=>.49-.13*Math.max(0,Math.min(1,(y-.16)/.14));
let candidateCount=0;
for(let i=0;i<n;i++) {
  vertex(runtime,i,p);rest.set(p.toArray(),i*3);
  if(p.x<-.24||p.x>lateral(p.y)||p.y<0||p.y>=.30||p.z<.29||p.z>anterior(p.y))continue;
  parent[i]=i;candidateCount++;
  const a=runtime.mesh.geometry.attributes.position,key=[a.getX(i),a.getY(i),a.getZ(i)].map(v=>Math.round(v/1e-7)).join(',');
  if(seam.has(key))join(i,seam.get(key));else seam.set(key,i);
}
const ix=runtime.mesh.geometry.index;
for(let i=0;i<ix.count;i+=3) {
  const a=ix.getX(i),b=ix.getX(i+1),c=ix.getX(i+2);
  if(parent[a]>=0&&parent[b]>=0)join(a,b);if(parent[a]>=0&&parent[c]>=0)join(a,c);if(parent[b]>=0&&parent[c]>=0)join(b,c);
}
const component=find(791041), edited=[], selected=new Set(), bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
for(let i=0;i<n;i++)if(parent[i]>=0&&find(i)===component){edited.push(i);selected.add(i);for(let k=0;k<3;k++){bounds.min[k]=Math.min(bounds.min[k],rest[i*3+k]);bounds.max[k]=Math.max(bounds.max[k],rest[i*3+k]);}}
assert.equal(candidateCount,98507);assert.equal(edited.length,98507);
for(const i of fullSole)assert.ok(selected.has(i),'Complete actual fore sole must belong to connected authored region');
const doc=structuredClone(v1.doc), bin=v1.bin;
const viewBytes=i=>{const v=doc.bufferViews[i];return bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength);};
const joints=Buffer.from(viewBytes(3)),weights=Buffer.from(viewBytes(4));
const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
for(const i of edited) {
  const x=rest[i*3],y=rest[i*3+1],z=rest[i*3+2];
  let blend=1-smooth((y-.18)/.12);
  if(y>.14)blend*=smooth((-.065-x)/.025)*smooth((z-.29)/.035)*smooth((anterior(y)-z)/.035);
  const elbow=smooth((y-.10)/.12),wrist=1-smooth((y-.045)/.055);
  const rows=[[21,blend*elbow],[22,blend*(1-elbow)*(1-wrist)],[23,blend*(1-elbow)*wrist],[7,1-blend]];
  for(let k=0;k<4;k++){joints[i*4+k]=rows[k][0];weights.writeFloatLE(rows[k][1],i*16+k*4);}
}
for(const i of fullSole) {
  // All actual sole vertices are distal to .015, hence the chain rule must naturally give rigid wrist influence.
  assert.deepEqual([...joints.subarray(i*4,i*4+4)],[21,22,23,7]);
  assert.deepEqual([0,1,2,3].map(k=>weights.readFloatLE(i*16+k*4)),[0,0,1,0]);
}
const chunks=[];let offset=0;
for(let i=0;i<doc.bufferViews.length;i++) {
  const data=i===3?joints:i===4?weights:viewBytes(i),v=doc.bufferViews[i];
  const pad=(4-offset%4)%4;if(pad){chunks.push(Buffer.alloc(pad));offset+=pad;}
  v.byteOffset=offset;v.byteLength=data.length;chunks.push(data);offset+=data.length;
}
const padding=(4-offset%4)%4;if(padding)chunks.push(Buffer.alloc(padding));
const outputBin=Buffer.concat(chunks);doc.buffers[0].byteLength=outputBin.length;
doc.asset.extras={...doc.asset.extras,skinDerivativeRevision:revision,previousDerivativeSHA256:v1SHA,oldAnimationMeasurementsInvalidated:true};
const json=Buffer.from(JSON.stringify(doc)),j=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]),h=Buffer.alloc(20),bh=Buffer.alloc(8);
h.writeUInt32LE(0x46546c67,0);h.writeUInt32LE(2,4);h.writeUInt32LE(28+j.length+outputBin.length,8);h.writeUInt32LE(j.length,12);h.writeUInt32LE(0x4e4f534a,16);bh.writeUInt32LE(outputBin.length,0);bh.writeUInt32LE(0x004e4942,4);
const bytes=Buffer.concat([h,j,bh,outputBin]);assert.ok(bytes.length<100*1024*1024);
const ids=Buffer.alloc(edited.length*4);edited.forEach((i,k)=>ids.writeUInt32LE(i,k*4));
const packet=(file,data)=>writeFile(new URL(file,import.meta.url),JSON.stringify(data,null,2)+'\n');
await writeFile(new URL('model.glb',import.meta.url),bytes);
await writeFile(new URL('reweighted-vertices.uint32le',import.meta.url),ids);
await packet('contact-footprint.json',{sourceSHA256:sha(input.bytes),previousDerivativeSHA256:v1SHA,previousContactPacketSHA256:sha(footprintBytes),definition:'All49814 V1-native near-floor vertex IDs partitioned exactly once; geometry and vertex indices preserved, all V2 values remeasured',paws});
await packet('v1-coverage-blocker.json',{previousDerivativeSHA256:v1SHA,legacyMixedSoleCount:762,previousNarrowRegionExcludedVertices:1099,completeForeSoleVertices:13960,processingBlockerSourceSHA256:sha(blockerBytes),previousCanaryReceiptsInvalidated:true,repair:'Measured lowfoot lateral extension only; full13960sole naturally rigid new wrist23, not oldtorso7 workaround'});
await packet('region-design.json',{revision,sourceSHA256:sha(input.bytes),previousDerivativeSHA256:v1SHA,candidateCount,connectedVertexCount:edited.length,previousConnectedCount:95483,additionalConnectedVertices:3024,bounds,selection:{xMinimum:-.24,xMaximum:'-.05 - .015 * clamp((y - .08) / .06, 0, 1)',y:[0,.30],zMinimum:.29,zMaximum:'.49 - .13 * clamp((y - .16) / .14, 0, 1)',shoulderBlend:'unchanged V1 abovey.14'},soleSeed:791041,all13960ActualForeSoleCovered:true,newNodes:[23,24,25],newSkinJoints:[21,22,23],parentNode:10,parentSkinJoint:7,rigRestTransformsAndAll24IBMsInheritedUnchangedFromV1:true});
await packet('provenance.json',{revision,sourcePath:'asset-source/rigged/actor-asha/rig/model.glb',sourceSHA256:sha(input.bytes),previousDerivativePath:'asset-source/rig-derivatives/actor-asha/model.glb',previousDerivativeSHA256:v1SHA,derivativePath:'asset-source/rig-derivatives/actor-asha/v2/model.glb',derivativeSHA256:sha(bytes),derivativeByteLength:bytes.length,github100MiBHeadroomBytes:100*1024*1024-bytes.length,authoringSourceSHA256:sha(await readFile(new URL('author-rig.mjs',import.meta.url))),reweightedVertexCount:edited.length,reweightedVertexIndexSHA256:sha(ids),anatomyDesignSHA256:sha(await readFile(new URL('region-design.json',import.meta.url))),contactFootprintSHA256:sha(await readFile(new URL('contact-footprint.json',import.meta.url))),v1CoverageBlockerSHA256:sha(await readFile(new URL('v1-coverage-blocker.json',import.meta.url))),geometryOwner:'Tripo original source unchanged',original21JointOrderRestTRSAndIBMBytesPreserved:true,allV1CanaryMeasurementsInvalidated:true,canaryAnimationsIncluded:false,visualAcceptance:null,releaseVerified:false,artifactFrozenForCanaryAuthoring:false});
console.log(JSON.stringify({revision,derivativeSHA256:sha(bytes),bytes:bytes.length,connectedVertexCount:edited.length,completeForeSoleCount:fullSole.length,previousV1SHA256:sha(await readFile(new URL('../model.glb',import.meta.url)))},null,2));
