import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { Vector3, Box3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const source = new URL('../../rigged/actor-aren/rig/tripo-out/rig-3-1fc43928/model.glb', import.meta.url);
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function unpack(bytes) {
  const length = bytes.readUInt32LE(12), offset = 20 + length;
  return { document: JSON.parse(bytes.subarray(20, offset).toString().trim()), bin: bytes.subarray(offset + 8, offset + 8 + bytes.readUInt32LE(offset)) };
}
export async function load(bytes) {
  globalThis.self = globalThis;
  globalThis.ProgressEvent ??= class { constructor(type, values) { this.type = type; Object.assign(this, values); } };
  globalThis.createImageBitmap = async blob => {
    const { data, info } = await sharp(Buffer.from(await blob.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, close() {} };
  };
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  gltf.scene.updateMatrixWorld(true);
  return gltf;
}
export async function inspect() {
  const bytes = await readFile(source);
  assert.equal(bytes.length, 96501240);
  assert.equal(hash(bytes), '7e759a4607f530137dfe58d0dcffecefd697030bcce6fbc2134625051b068151');
  const { document } = unpack(bytes), gltf = await load(bytes);
  let mesh; gltf.scene.traverse(n => { if(n.isSkinnedMesh) mesh = n; });
  assert(mesh && mesh.skeleton.bones.length === 18);
  const joints = document.skins[0].joints;
  const stats = mesh.skeleton.bones.map(() => ({ count: 0, sum: new Vector3(), bounds: new Box3() }));
  const pos = mesh.geometry.attributes.position, weights = mesh.geometry.attributes.skinWeight, indices = mesh.geometry.attributes.skinIndex;
  for(let v = 0; v < pos.count; v++) {
    const ws = [weights.getX(v),weights.getY(v),weights.getZ(v),weights.getW(v)], js = [indices.getX(v),indices.getY(v),indices.getZ(v),indices.getW(v)];
    const dominant = ws.indexOf(Math.max(...ws));
    if(ws[dominant] < .5) continue;
    const p = new Vector3().fromBufferAttribute(pos,v); mesh.applyBoneTransform(v,p); mesh.localToWorld(p);
    const stat = stats[js[dominant]]; stat.count++; stat.sum.add(p); stat.bounds.expandByPoint(p);
  }
  const report = {
    source: { path: 'asset-source/rigged/actor-aren/rig/tripo-out/rig-3-1fc43928/model.glb', bytes:bytes.length,sha256:hash(bytes) },
    jointOrder:joints,
    joints: mesh.skeleton.bones.map((b,i)=>({ skinIndex:i,node:joints[i],name:b.name,parent:b.parent.name,restLocalTranslation:b.position.toArray(),restLocalRotation:b.quaternion.toArray(),restLocalScale:b.scale.toArray(),restWorldPosition:b.getWorldPosition(new Vector3()).toArray(),dominantVertices:stats[i].count,dominantCentroid:stats[i].count?stats[i].sum.divideScalar(stats[i].count).toArray():null,dominantBounds:stats[i].count?{min:stats[i].bounds.min.toArray(),max:stats[i].bounds.max.toArray()}:null })),
    restBounds:new Box3().setFromObject(gltf.scene).toArray?.() ?? (()=>{const b=new Box3().setFromObject(gltf.scene);return {min:b.min.toArray(),max:b.max.toArray()};})(),
    browserLaunched:false, productionAccepted:false
  };
  await writeFile(new URL('anatomy.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
if(process.argv[1] === new URL(import.meta.url).pathname) await inspect();
