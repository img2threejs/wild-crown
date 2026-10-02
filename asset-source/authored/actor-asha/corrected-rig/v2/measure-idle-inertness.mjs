import { readFile } from 'node:fs/promises';
import { AnimationMixer, LoopRepeat, Vector3 } from 'three';
import { source, sourceSHA, sourceRevision, load, unpack, pack, vertex, update, hash, save } from './runtime.mjs';
await source();
const bytes=await readFile(new URL('model.glb',import.meta.url)),parsed=unpack(bytes),doc=structuredClone(parsed.doc),bin=Buffer.from(parsed.bin);
const idle=doc.animations.find(c=>c.name==='Idle');
for(const sampler of idle.samplers){
  const accessor=doc.accessors[sampler.output],view=doc.bufferViews[accessor.bufferView],width=accessor.type==='VEC4'?4:3,start=(view.byteOffset||0)+(accessor.byteOffset||0);
  for(let i=1;i<accessor.count;i++)bin.copy(bin,start+i*width*4,start,start+width*4);
}
async function motion(model){
  const r=await load(model),clip=r.animations.find(c=>c.name==='Idle'),m=new AnimationMixer(r.scene),a=m.clipAction(clip).setLoop(LoopRepeat,Infinity);
  a.play();a.paused=true;a.time=0;m.update(0);update(r);
  const count=r.mesh.geometry.attributes.position.count,first=new Float64Array(count*3),p=new Vector3();
  for(let i=0;i<count;i++){vertex(r,i,p);first[i*3]=p.x;first[i*3+1]=p.y;first[i*3+2]=p.z;}
  a.time=.8;m.update(0);update(r);let maximum=0;
  for(let i=0;i<count;i++){vertex(r,i,p);maximum=Math.max(maximum,Math.hypot(p.x-first[i*3],p.y-first[i*3+1],p.z-first[i*3+2]));}
  m.stopAllAction();return {vertices:count,maximum};
}
const positive=await motion(bytes),inert=await motion(pack(doc,bin));
const packet=JSON.parse(await readFile(new URL('canary-packet.json',import.meta.url)));
if(packet.sourceSHA256!==sourceSHA||packet.derivativeSHA256!==hash(bytes))throw Error('Stale canary calibration');
const report={sourceRevision,sourceSHA256:sourceSHA,derivativeSHA256:hash(bytes),clip:'Idle',nativeSamplerControl:'Every Idle output accessor serialized constant to its first sample in a throwaway in-memory GLB, then real GLTFLoader/AnimationMixer/CPU skin measured at0/.8.',positive,inert,independentlyMeasuredAllowance:packet.calibration.calibratedContactAllowance,positiveDetected:positive.maximum>packet.calibration.calibratedContactAllowance,inertRejected:inert.maximum===0,renderAcceptance:null,releaseVerified:false};
await save('idle-inertness-control.json',report);
if(!report.positiveDetected||!report.inertRejected)throw Error('Idle all-vertex native inertness control failed');
const index=JSON.parse(await readFile(new URL('evidence-index.json',import.meta.url)));
for(const name of ['measure-idle-inertness.mjs','idle-inertness-control.json']){
  const entry={path:name,sha256:hash(await readFile(new URL(name,import.meta.url)))};
  const prior=index.artifacts.findIndex(a=>a.path===name);if(prior<0)index.artifacts.push(entry);else index.artifacts[prior]=entry;
}
await save('evidence-index.json',index);
console.log(JSON.stringify(report,null,2));
