import { readFile, writeFile } from 'node:fs/promises';
import { Vector3, Quaternion, Matrix4, Bone } from 'three';
import { source, loadNative, vertex, sha } from '../../authored/actor-asha/native-runtime.mjs';

// Offline skin derivative only: provider geometry and the original 21 bind transforms are immutable.
const input = await source(), runtime = await loadNative(input.bytes);
const markersBytes = await readFile(new URL('../../authored/actor-asha/contact-markers.json', import.meta.url));
const contacts = JSON.parse(markersBytes).contacts;
const count = runtime.mesh.geometry.attributes.position.count, rest = new Float64Array(count * 3);
const p = new Vector3(), parent = new Int32Array(count).fill(-1), selected = new Uint8Array(count);
const find = i => { let root=i; while(parent[root]!==root)root=parent[root]; while(i!==root){const next=parent[i];parent[i]=root;i=next;}return root; };
const join = (a,b) => { const x=find(a),y=find(b); if(x!==y)parent[y]=x; };
const anterior = y => .49 - .13 * Math.max(0,Math.min(1,(y-.16)/.14));
const seam = new Map();
let candidateCount=0;
for(let i=0;i<count;i++) {
  vertex(runtime,i,p); rest.set(p.toArray(),i*3);
  if(p.x<-.24 || p.x>-.065 || p.y<0 || p.y>=.30 || p.z<.29 || p.z>anterior(p.y))continue;
  parent[i]=i; candidateCount++;
  const position=runtime.mesh.geometry.attributes.position;
  const key=[position.getX(i),position.getY(i),position.getZ(i)].map(v=>Math.round(v/1e-7)).join(',');
  if(seam.has(key))join(i,seam.get(key));else seam.set(key,i);
}
const index=runtime.mesh.geometry.index;
for(let i=0;i<index.count;i+=3) {
  const a=index.getX(i),b=index.getX(i+1),c=index.getX(i+2);
  if(parent[a]>=0&&parent[b]>=0)join(a,b);
  if(parent[a]>=0&&parent[c]>=0)join(a,c);
  if(parent[b]>=0&&parent[c]>=0)join(b,c);
}
const sole=contacts.find(c=>c.id==='front-negative-X'), seed=sole.markers[0].vertex;
if(parent[seed]<0)throw Error('Actual sole seed outside bounded selection');
const component=find(seed), bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]}, vertices=[];
for(let i=0;i<count;i++)if(parent[i]>=0&&find(i)===component){selected[i]=1;vertices.push(i);for(let k=0;k<3;k++){bounds.min[k]=Math.min(bounds.min[k],rest[i*3+k]);bounds.max[k]=Math.max(bounds.max[k],rest[i*3+k]);}}
if(sole.markers.some(m=>!selected[m.vertex]))throw Error('Topology component excludes an actual sole marker');
const slices=Array.from({length:15},()=>({n:0,sum:[0,0,0],min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]}));
for(const i of vertices){const b=slices[Math.floor(rest[i*3+1]/.02)];b.n++;for(let k=0;k<3;k++){const v=rest[i*3+k];b.sum[k]+=v;b.min[k]=Math.min(b.min[k],v);b.max[k]=Math.max(b.max[k],v);}}
const pivots=[[-.145,.285,.34],[-.15,.16,.36],[-.13,.06,.39]];
const terminal=[-.125,.02,.43];
const design={sourceSHA256:sha(input.bytes),contactMarkerSHA256:sha(markersBytes),coordinateSpace:'native GLTFLoader world, +Y up, head +Z; anatomical left/right unverified',parentNode:10,parentSkinJoint:7,newNodes:[23,24,25],newSkinJoints:[21,22,23],pivots,terminalDirectionTarget:terminal,candidateCount,connectedVertexCount:vertices.length,bounds,soleMarkersIncluded:sole.markers.map(m=>m.vertex),selection:{x:[-.24,-.065],y:[0,.30],zMinimum:.29,anteriorCutoff:'0.49 - 0.13 * clamp((y - 0.16) / 0.14, 0, 1)',connectivity:'native triangle edges among bounded vertices plus POSITION seams quantized at 1e-7 native units; only component containing actual sole791041',shoulderBlend:'smoothstep y .18 to .30; shoulder skin21 blending to original torso skin7; boundary smooth fade above y .14'},slices:slices.map((b,i)=>({y:[i*.02,(i+1)*.02],n:b.n,centroid:b.n?b.sum.map(v=>v/b.n):null,min:b.n?b.min:null,max:b.n?b.max:null})),matrixPolicy:'original 21 joint order, node rest TRS and IBM bytes preserved; new proper +Y-to-next quaternion world frames; localTRS from inverse parentWorld * desiredWorld; IBM = inverse actual new GLTFLoader-equivalent world matrix, serialized float32'};
await writeFile(new URL('region-design.json',import.meta.url),JSON.stringify(design,null,2)+'\n');
console.log(JSON.stringify({candidateCount,connectedVertexCount:vertices.length,bounds,...(!process.argv.includes('--export')?{slices:design.slices}:{})},null,2));
if(!process.argv.includes('--export'))process.exit(0);
const doc=structuredClone(input.doc), skin=doc.skins[0], primitive=doc.meshes[0].primitives[0];
const oldJoints=[...skin.joints];
const bones=[], parentBone=runtime.bones[7];
for(let k=0;k<3;k++) {
  const world=new Matrix4().compose(new Vector3(...pivots[k]),new Quaternion().setFromUnitVectors(new Vector3(0,1,0),new Vector3(...(pivots[k+1]??terminal)).sub(new Vector3(...pivots[k])).normalize()),new Vector3(1,1,1));
  const owner=k?bones[k-1]:parentBone, local=owner.matrixWorld.clone().invert().multiply(world);
  const bone=new Bone();local.decompose(bone.position,bone.quaternion,bone.scale);owner.add(bone);runtime.scene.updateMatrixWorld(true);bones.push(bone);
  doc.nodes.push({name:['asha_custom_negativeX_fore_shoulder','asha_custom_negativeX_fore_elbow','asha_custom_negativeX_fore_wrist'][k],translation:bone.position.toArray(),rotation:bone.quaternion.toArray(),scale:bone.scale.toArray(),...(k<2?{children:[24+k]}:{})});
  skin.joints.push(23+k);
}
doc.nodes[10].children.push(23);
const replacements=new Map();
const viewBytes=v=>input.bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength);
const joints=Buffer.from(viewBytes(input.doc.bufferViews[input.doc.accessors[primitive.attributes.JOINTS_0].bufferView]));
const weights=Buffer.from(viewBytes(input.doc.bufferViews[input.doc.accessors[primitive.attributes.WEIGHTS_0].bufferView]));
const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
const edited=[];
for(const i of vertices) {
  const x=rest[i*3], y=rest[i*3+1], z=rest[i*3+2];
  let blend=1-smooth((y-.18)/.12);
  if(y>.14)blend*=smooth((-.065-x)/.025)*smooth((z-.29)/.035)*smooth((anterior(y)-z)/.035);
  if(blend===0)continue;
  const elbow=smooth((y-.10)/.12), wrist=1-smooth((y-.045)/.055);
  const chain=[elbow,(1-elbow)*(1-wrist),(1-elbow)*wrist];
  const rows=[[21,blend*chain[0]],[22,blend*chain[1]],[23,blend*chain[2]],[7,1-blend]];
  for(let k=0;k<4;k++){joints[i*4+k]=rows[k][0];weights.writeFloatLE(rows[k][1],(i*4+k)*4);}edited.push(i);
}
const ibmAccessor=doc.accessors[skin.inverseBindMatrices],ibmView=ibmAccessor.bufferView;
const originalIBM=viewBytes(input.doc.bufferViews[ibmView]), ibm=Buffer.alloc(originalIBM.length+3*64);originalIBM.copy(ibm);
for(let k=0;k<3;k++)bones[k].matrixWorld.clone().invert().elements.forEach((v,c)=>ibm.writeFloatLE(v,originalIBM.length+k*64+c*4));
ibmAccessor.count=24;
replacements.set(doc.accessors[primitive.attributes.JOINTS_0].bufferView,joints);
replacements.set(doc.accessors[primitive.attributes.WEIGHTS_0].bufferView,weights);
replacements.set(ibmView,ibm);
// Rebuild the one BIN chunk from live views. Replacement buffers occupy the old view slots.
const chunks=[];let offset=0;
for(let i=0;i<doc.bufferViews.length;i++) {
  const v=doc.bufferViews[i],data=replacements.get(i)??viewBytes(input.doc.bufferViews[i]);
  const padding=(4-offset%4)%4;if(padding){chunks.push(Buffer.alloc(padding));offset+=padding;}
  v.byteOffset=offset;v.byteLength=data.length;chunks.push(data);offset+=data.length;
}
const padding=(4-offset%4)%4;if(padding)chunks.push(Buffer.alloc(padding));
const bin=Buffer.concat(chunks);doc.buffers[0].byteLength=bin.length;
doc.asset.extras={...doc.asset.extras,skinDerivativeRevision:'asha-negativeX-foreleg-v1',sourceSHA256:sha(input.bytes),oldAnimationMeasurementsInvalidated:true};
const json=Buffer.from(JSON.stringify(doc)),jsonPadding=Buffer.alloc((4-json.length%4)%4,32),j=Buffer.concat([json,jsonPadding]);
const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+j.length+bin.length,8);header.writeUInt32LE(j.length,12);header.writeUInt32LE(0x4e4f534a,16);
const bh=Buffer.alloc(8);bh.writeUInt32LE(bin.length,0);bh.writeUInt32LE(0x004e4942,4);
const bytes=Buffer.concat([header,j,bh,bin]);
if(bytes.length>=100*1024*1024)throw Error('GitHub 100MiB threshold exceeded');
await writeFile(new URL('model.glb',import.meta.url),bytes);
const indices=Buffer.alloc(edited.length*4);edited.forEach((v,k)=>indices.writeUInt32LE(v,k*4));await writeFile(new URL('reweighted-vertices.uint32le',import.meta.url),indices);
await writeFile(new URL('provenance.json',import.meta.url),JSON.stringify({revision:'asha-negativeX-foreleg-v1',sourcePath:'asset-source/rigged/actor-asha/rig/model.glb',sourceSHA256:sha(input.bytes),sourceByteLength:input.bytes.length,derivativePath:'asset-source/rig-derivatives/actor-asha/model.glb',derivativeSHA256:sha(bytes),derivativeByteLength:bytes.length,github100MiBHeadroomBytes:100*1024*1024-bytes.length,authoringSource:'author-rig.mjs',authoringSourceSHA256:sha(await readFile(new URL('author-rig.mjs',import.meta.url))),anatomyDesignSHA256:sha(await readFile(new URL('region-design.json',import.meta.url))),reweightedVertexCount:edited.length,reweightedVertexIndexSHA256:sha(indices),originalJointOrder:oldJoints,newJointOrder:skin.joints,originalNodeRestTransformsPreserved:true,originalInverseBindBytesSHA256:sha(originalIBM),geometryOwner:'Tripo original source, unchanged',customRigOwner:'offline derivative authoring',providerSpend:0,oldAnimationMeasurementsInvalidated:true,canaryAnimationsIncluded:false,visualAcceptance:null,releaseVerified:false},null,2)+'\n');
console.log('EXPORTED',sha(bytes),bytes.length,'reweighted',edited.length);
