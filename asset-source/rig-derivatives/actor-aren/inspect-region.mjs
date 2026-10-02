import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Matrix4, Vector3, Quaternion } from 'three';
export const source = new URL('../../rigged/actor-aren/rig/tripo-out/rig-3-1fc43928/model.glb', import.meta.url);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const sourceHash = '7e759a4607f530137dfe58d0dcffecefd697030bcce6fbc2134625051b068151';
export function unpack(bytes) {
  const end = 20 + bytes.readUInt32LE(12);
  return { document: JSON.parse(bytes.subarray(20, end).toString().trim()), bin: bytes.subarray(end + 8, end + 8 + bytes.readUInt32LE(end)) };
}
export function accessor(document, bin, index) {
  const a = document.accessors[index], view = document.bufferViews[a.bufferView];
  const types = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array };
  const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const Type = types[a.componentType];
  if (view.byteStride || a.sparse || !Type) throw new Error('Unsupported native accessor layout');
  return new Type(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0), a.count * sizes[a.type]);
}
export function worlds(document) {
  const result = [];
  function visit(id, parent) {
    const n = document.nodes[id];
    const m = n.matrix ? new Matrix4().fromArray(n.matrix) : new Matrix4().compose(new Vector3(...(n.translation ?? [0,0,0])), new Quaternion(...(n.rotation ?? [0,0,0,1])), new Vector3(...(n.scale ?? [1,1,1])));
    result[id] = parent.clone().multiply(m);
    for (const child of n.children ?? []) visit(child, result[id]);
  }
  for (const id of document.scenes[document.scene ?? 0].nodes) visit(id, new Matrix4());
  return result;
}
export function connectedComponents(position, indices) {
  const count = position.length / 3, parent = new Uint32Array(count);
  for (let i=0;i<count;i++) parent[i]=i;
  function root(i) { while(parent[i]!==i) { parent[i]=parent[parent[i]]; i=parent[i]; } return i; }
  function union(a,b) { a=root(a); b=root(b); if(a!==b)parent[b]=a; }
  // Exact POSITION welding bridges UV seams without changing original geometry.
  const welded = new Map();
  for(let i=0;i<count;i++) { const key=`${position[i*3]},${position[i*3+1]},${position[i*3+2]}`; const previous=welded.get(key); if(previous!==undefined)union(i,previous);else welded.set(key,i); }
  for(let i=0;i<indices.length;i+=3) { union(indices[i],indices[i+1]);union(indices[i],indices[i+2]); }
  const groups=new Map();
  for(let i=0;i<count;i++) { const id=root(i); if(!groups.has(id))groups.set(id,[]);groups.get(id).push(i); }
  return groups;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const bytes=await readFile(source),{document,bin}=unpack(bytes);
  if(hash(bytes)!==sourceHash)throw new Error('Immutable source hash changed');
  const primitive=document.meshes[0].primitives[0],position=accessor(document,bin,primitive.attributes.POSITION),indices=accessor(document,bin,primitive.indices);
  const groups=connectedComponents(position,indices), world=worlds(document);
  const measurements=JSON.parse(await readFile(new URL('../../authored/actor-aren/measurements.json',import.meta.url)));
  const components=[...groups.values()].map(vertices=>{
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for(const v of vertices)for(let axis=0;axis<3;axis++){min[axis]=Math.min(min[axis],position[3*v+axis]);max[axis]=Math.max(max[axis],position[3*v+axis]);}
    return {count:vertices.length,min,max,containsStaffBase:vertices.includes(554945),containsLandmarks:Object.fromEntries(Object.entries(measurements.socketLandmarks).map(([name,l])=>[name,vertices.includes(l.surfaceVertex)])),seed:vertices[0]};
  }).sort((a,b)=>b.count-a.count);
  const report={sourceSha256:hash(bytes),primitive,vertexCount:position.length/3,components:components.slice(0,30),componentCount:groups.size,landmarks:measurements.socketLandmarks,jointOrder:document.skins[0].joints,nodes:document.nodes.map((n,i)=>({id:i,...n,worldPosition:new Vector3().setFromMatrixPosition(world[i]).toArray()})),accessors:document.accessors};
  await writeFile(new URL('region-inspection.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
