import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Texture, Vector3, Box3 } from 'three';
export const sourcePath=new URL('../../../rig-derivatives/actor-asha/model.glb',import.meta.url);
export const sourceSHA='c93dcd4f8ef93de40093e2c5b89a5296e7afaa5b47f0ecab495c380f08578712';
export const sourceRevision='asha-negativeX-foreleg-v1';
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function unpack(bytes){
  if(bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw Error('Invalid GLB header');
  const length=bytes.readUInt32LE(12);
  if(bytes.readUInt32LE(16)!==0x4e4f534a||bytes.readUInt32LE(24+length)!==0x004e4942)throw Error('Invalid GLB chunks');
  return {doc:JSON.parse(bytes.subarray(20,20+length)),bin:bytes.subarray(28+length)};
}
export async function source(){
  const bytes=await readFile(sourcePath);
  if(bytes.length!==99519388||hash(bytes)!==sourceSHA)throw Error('Frozen corrected-rig source mismatch');
  return {bytes,...unpack(bytes)};
}
export async function load(bytes){
  const loader=new GLTFLoader();
  // CPU skin/animation measurement only: no image decoding, no fake rendered acceptance.
  loader.register(()=>({name:'CPU_MEASUREMENT_NO_TEXTURE_DECODE',loadTexture:()=>Promise.resolve(new Texture())}));
  const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
  const meshes=[];gltf.scene.traverse(o=>{if(o.isSkinnedMesh)meshes.push(o);});
  if(meshes.length!==1||meshes[0].skeleton.bones.length!==24)throw Error('Unexpected corrected native skin');
  const r={...gltf,mesh:meshes[0],bones:meshes[0].skeleton.bones};update(r);return r;
}
export function update(r){
  r.scene.updateMatrixWorld(true);r.mesh.skeleton.update();
  for(const value of r.mesh.skeleton.boneMatrices)if(!Number.isFinite(value))throw Error('Nonfinite skin matrix');
}
export function vertex(r,i,p=new Vector3()){
  p.fromBufferAttribute(r.mesh.geometry.attributes.position,i);r.mesh.applyBoneTransform(i,p);p.applyMatrix4(r.mesh.matrixWorld);
  if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Number.isFinite(p.z))throw Error('Nonfinite skinned position');return p;
}
export function bounds(r){
  const box=new Box3(),p=new Vector3();for(let i=0;i<r.mesh.geometry.attributes.position.count;i++)box.expandByPoint(vertex(r,i,p));
  return {min:box.min.toArray(),max:box.max.toArray()};
}
export async function save(name,data){await writeFile(new URL(name,import.meta.url),JSON.stringify(data,null,2)+'\n');}
export function pack(doc,bin){
  let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  if(bin.length%4)throw Error('Unaligned binary');
  const header=Buffer.alloc(20),binHeader=Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
  binHeader.writeUInt32LE(bin.length,0);binHeader.writeUInt32LE(0x004e4942,4);return Buffer.concat([header,json,binHeader,bin]);
}
export const pawRegions=[
  {id:'front-negative-X',contains:p=>p.x<.015&&p.z>.18},
  {id:'front-positive-X',contains:p=>p.x>=.015&&p.z>.18},
  {id:'rear-negative-X',contains:p=>p.x<-.10&&p.z<0},
  {id:'rear-positive-X',contains:p=>p.x>-.025&&p.x<.11&&p.z<-.12},
];
export function contacts(r){
  const result=pawRegions.map(p=>({id:p.id,sole:[],influenceJoints:new Set()})),p=new Vector3();
  let nearFloor=0,classified=0;
  for(let i=0;i<r.mesh.geometry.attributes.position.count;i++){
    vertex(r,i,p);if(p.y>=.015)continue;
    nearFloor++;
    for(let region=0;region<pawRegions.length;region++)if(pawRegions[region].contains(p)){
      classified++;
      const joints=[],weights=[];
      for(let k=0;k<4;k++){const j=r.mesh.geometry.attributes.skinIndex.getComponent(i,k),w=r.mesh.geometry.attributes.skinWeight.getComponent(i,k);joints.push(j);weights.push(w);if(w>0)result[region].influenceJoints.add(j);}
      result[region].sole.push({vertex:i,rest:p.toArray(),joints,weights});
    }
  }
  if(nearFloor!==classified)throw Error('Native near-floor partition incomplete/overlapping: '+classified+'/'+nearFloor);
  return result.map(c=>({...c,influenceJoints:[...c.influenceJoints].sort((a,b)=>a-b)}));
}
