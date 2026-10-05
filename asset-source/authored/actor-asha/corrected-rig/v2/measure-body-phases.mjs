import { readFile } from 'node:fs/promises';
import { AnimationMixer, LoopOnce, Vector3, Box3 } from 'three';
import { source, sourceSHA, sourceRevision, load, update, vertex, hash, save } from './runtime.mjs';
const input=await source(),bytes=await readFile(new URL('model.glb',import.meta.url)),base=await load(input.bytes),r=await load(bytes),mixer=new AnimationMixer(r.scene),p=new Vector3();
const torso=[],head=[];
for(let i=0;i<base.mesh.geometry.attributes.position.count;i++){
  vertex(base,i,p);let j=-1,w=-1;for(let k=0;k<4;k++){const weight=base.mesh.geometry.attributes.skinWeight.getComponent(i,k);if(weight>w){w=weight;j=base.mesh.geometry.attributes.skinIndex.getComponent(i,k);}}
  if(w>=.5&&[1,5,6,7].includes(j)&&p.y>.23&&p.z>-.28&&p.z<.18)torso.push(i);
  if(w>=.5&&j===10&&p.y>.32&&p.z>.20)head.push(i);
}
function surface(runtime,ids){
  const box=new Box3(),sum=new Vector3();for(const i of ids){vertex(runtime,i,p);box.expandByPoint(p);sum.add(p);}
  return {vertices:ids.length,centroid:sum.divideScalar(ids.length).toArray(),bounds:{min:box.min.toArray(),max:box.max.toArray()}};
}
const rest={torso:surface(base,torso),head:surface(base,head)},reports=[];
for(const clip of r.animations){
  mixer.stopAllAction();mixer.uncacheRoot(r.scene);const a=mixer.clipAction(clip).setLoop(LoopOnce,1);a.clampWhenFinished=true;a.play();a.paused=true;
  const times=clip.name==='Idle'?[0,.8,1.6,2.4,clip.duration]:[0,.32,.4,.55,.8,1.08,1.16,1.28,clip.duration];
  const samples=times.map(time=>{a.time=time;mixer.update(0);update(r);const t=surface(r,torso),h=surface(r,head);return {time,torso:t,head:h,torsoCentroidDeltaY:t.centroid[1]-rest.torso.centroid[1],headCentroidDeltaY:h.centroid[1]-rest.head.centroid[1],nativeRootLocal:r.bones[0].position.toArray()};});
  reports.push({clip:clip.name,samples});
}
const report={sourceRevision,sourceSHA256:sourceSHA,derivativeSHA256:hash(bytes),surfaceSelections:{torso:'all source skinned vertices dominant >=.5 skin joint1/5/6/7 with Y>.23 and -.28<Z<.18',head:'all source skinned vertices dominant >=.5 terminal head-region skin joint10, Y>.32, Z>.20'},rest,reports,meaning:'Actual CPU-deformed torso/head regions, not root-only movement or semantic clip names. Source anatomy remains subject to parent visual review.',renderAcceptance:null,releaseVerified:false};
await save('body-phase-measurements.json',report);
console.log(JSON.stringify({restCounts:{torso:torso.length,head:head.length},reports:reports.map(r=>({clip:r.clip,samples:r.samples.map(s=>({time:s.time,torsoDeltaY:s.torsoCentroidDeltaY,headDeltaY:s.headCentroidDeltaY,root:s.nativeRootLocal}))}))},null,2));