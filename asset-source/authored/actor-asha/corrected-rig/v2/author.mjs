import { readFile, writeFile } from 'node:fs/promises';
import { Vector3, Quaternion, Matrix4 } from 'three';
import { source, sourceSHA, sourceRevision, load, update, hash, pack, save } from './runtime.mjs';
const input=await source(),r=await load(input.bytes);
const contact=JSON.parse(await readFile(new URL('contacts.json',import.meta.url)));
if(contact.sourceSHA256!==sourceSHA)throw Error('Contacts are not corrected-source measurements');
const correctedFore=contact.paws.find(p=>p.id==='front-negative-X');
if(!correctedFore||correctedFore.influenceJoints.some(j=>j<21))throw Error('Blocked processing source: complete corrected forepaw still has legacy torso/head/opposite-limb influences; do not freeze torso to hide an independent-foreleg skin defect');
const nodes=input.doc.skins[0].joints,byNode=new Map(nodes.map((n,j)=>[n,r.bones[j]]));
const rest=new Map([...byNode].map(([n,b])=>[n,{position:b.position.clone(),rotation:b.quaternion.clone(),worldPosition:b.getWorldPosition(new Vector3()),worldRotation:b.getWorldQuaternion(new Quaternion())}]));
const depth=b=>b.parent?depth(b.parent)+1:0;
const pinned=[...new Set(contact.paws.flatMap(p=>p.influenceJoints))].filter(j=>j!==0).map(j=>nodes[j]).sort((a,b)=>depth(byNode.get(a))-depth(byNode.get(b)));
function smooth(x){return x*x*(3-2*x);}
function curve(t,keys){for(let i=1;i<keys.length;i++)if(t<=keys[i][0]){const [a,x]=keys[i-1],[b,y]=keys[i];return x+(y-x)*smooth(Math.max(0,(t-a)/(b-a)));}return keys.at(-1)[1];}
function reset(){for(const [n,b]of byNode){b.position.copy(rest.get(n).position);b.quaternion.copy(rest.get(n).rotation);}}
function moveWorld(n,delta){
  const b=byNode.get(n);r.scene.updateMatrixWorld(true);
  // Inverse linear parent transform, not normalized direction (retains exact source scale).
  const inverse=new Matrix4().copy(b.parent.matrixWorld).invert();
  const origin=new Vector3().applyMatrix4(inverse),end=delta.clone().applyMatrix4(inverse);
  b.position.add(end.sub(origin));
}
function rotateWorld(n,axis,angle){
  const b=byNode.get(n);r.scene.updateMatrixWorld(true);
  const parent=b.parent.getWorldQuaternion(new Quaternion()).invert();
  b.quaternion.premultiply(new Quaternion().setFromAxisAngle(axis.clone().applyQuaternion(parent),angle));
}
function pinSoles(strength){
  if(strength<=0)return;
  for(const n of pinned){
    const b=byNode.get(n),reference=rest.get(n);r.scene.updateMatrixWorld(true);
    const target=b.getWorldPosition(new Vector3()).lerp(reference.worldPosition,strength);
    b.position.copy(b.parent.worldToLocal(target));
    if(strength<1||b.getWorldQuaternion(new Quaternion()).angleTo(reference.worldRotation)>1e-7){
      const desired=b.getWorldQuaternion(new Quaternion()).slerp(reference.worldRotation,strength);
      b.quaternion.copy(b.parent.getWorldQuaternion(new Quaternion()).invert().multiply(desired));
    }
  }
  update(r);
}
const phases={anticipation:[0,.4],takeoff:[.4,.55],flight:[.55,1.08],landing:[1.08,1.16],recovery:[1.16,1.8]};
function pose(name,t){
  reset();
  let strength=1;
  if(name==='Idle'){
    const breathing=Math.sin(2*Math.PI*t/3.2);
    moveWorld(19,new Vector3(0,breathing*.0015,0));
    moveWorld(11,new Vector3(0,breathing*.002,breathing*.001));
    rotateWorld(3,new Vector3(1,0,0),breathing*.012);
    rotateWorld(2,new Vector3(0,1,0),breathing*.015);
  }else{
    const compress=curve(t,[[0,0],[.32,1],[.4,1],[.55,-.15],[.8,-.1],[1.08,0],[1.16,.15],[1.28,.8],[1.8,0]]);
    moveWorld(19,new Vector3(0,-compress*.028,-compress*.006));
    moveWorld(11,new Vector3(0,-compress*.008,compress*.006));
    // Upper/middle limb articulation during gather; contact owners remain fixed in world.
    moveWorld(15,new Vector3(0,compress*.008,compress*.012));
    moveWorld(9,new Vector3(0,-compress*.012,compress*.005));
    moveWorld(24,new Vector3(0,compress*.008,-compress*.01));
    moveWorld(18,new Vector3(0,compress*.004,compress*.006));
    rotateWorld(3,new Vector3(1,0,0),compress*.045);
    rotateWorld(2,new Vector3(1,0,0),compress*.08);
    const lift=curve(t,[[0,0],[.4,0],[.55,.065],[.8,.18],[1.08,.025],[1.16,0],[1.8,0]]);
    moveWorld(20,new Vector3(0,lift,0));
    const tuck=curve(t,[[0,0],[.4,0],[.6,1],[.82,1],[1.16,0],[1.8,0]]);
    for(const [n,a]of [[9,-.16],[8,.22],[16,.15],[15,-.23],[18,.13],[17,-.12],[23,-.12],[24,.25],[25,-.15]])rotateWorld(n,new Vector3(1,0,0),tuck*a);
    strength=curve(t,[[0,1],[.4,1],[.55,0],[1.08,0],[1.16,1],[1.8,1]]);
  }
  update(r);pinSoles(strength);
}
const doc=structuredClone(input.doc),data=[input.bin];let offset=input.bin.length;
function add(values,type){
  const bytes=Buffer.from(new Float32Array(values).buffer),bufferView=doc.bufferViews.length;
  doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:bytes.length});data.push(bytes);offset+=bytes.length;
  const width=type==='SCALAR'?1:type==='VEC3'?3:4,index=doc.accessors.length;
  doc.accessors.push({bufferView,componentType:5126,count:values.length/width,type,...(type==='SCALAR'?{min:[values[0]],max:[values.at(-1)]}:{})});return index;
}
const clips=[];
for(const [name,duration]of [['Idle',3.2],['Pounce',1.8]]){
  const count=Math.round(duration*120),keyTimes=new Set(Array.from({length:count+1},(_,i)=>Math.fround(duration*i/count)));
  // Persist phase boundaries as native Float32 time keys, not just sampling-grid neighbours.
  if(name==='Pounce')for(const t of [.32,.4,.55,.8,1.08,1.16,1.28])keyTimes.add(Math.fround(t));
  const times=[...keyTimes].sort((a,b)=>a-b);
  const tracks=new Map(nodes.map(n=>[n,{translation:[],rotation:[]} ]));
  for(let i=0;i<times.length;i++){pose(name,i===times.length-1?duration:times[i]);for(const [n,b]of byNode){tracks.get(n).translation.push(...b.position.toArray());tracks.get(n).rotation.push(...b.quaternion.toArray());}}
  const animation={name,samplers:[],channels:[],extras:{sourceRevision,sourceSHA256:sourceSHA,rootPolicy:'in-place horizontal; visual native Y lift retained',loop:name==='Idle',phases:name==='Pounce'?phases:undefined,authoring:'four-chain native keys; complete source-sole transform constraints'}};
  const time=add(times,'SCALAR');
  for(const [n,paths]of tracks)for(const [path,values]of Object.entries(paths)){
    const width=path==='rotation'?4:3;
    if(values.some(v=>!Number.isFinite(v)))throw Error('Nonfinite authored track');
    if(!values.some((v,i)=>Math.abs(v-values[i%width])>1e-9))continue;
    animation.channels.push({sampler:animation.samplers.length,target:{node:n,path}});
    animation.samplers.push({input:time,output:add(values,path==='rotation'?'VEC4':'VEC3'),interpolation:'LINEAR'});
  }
  clips.push(animation);
}
doc.animations=clips;doc.buffers[0].byteLength=offset;
const bin=Buffer.concat(data),bytes=pack(doc,bin);
const preserved=['nodes','skins','meshes','materials','images','textures','samplers'].every(k=>JSON.stringify(doc[k])===JSON.stringify(input.doc[k]))&&JSON.stringify(doc.accessors.slice(0,input.doc.accessors.length))===JSON.stringify(input.doc.accessors)&&JSON.stringify(doc.bufferViews.slice(0,input.doc.bufferViews.length))===JSON.stringify(input.doc.bufferViews)&&bin.subarray(0,input.bin.length).equals(input.bin);
if(!preserved)throw Error('Frozen repaired source changed');
await writeFile(new URL('model.glb',import.meta.url),bytes);
await save('provenance.json',{
  sourcePath:'asset-source/rig-derivatives/actor-asha/v2/model.glb',sourceRevision,sourceSHA256:sourceSHA,sourceBytes:input.bytes.length,
  originalTripoSourceSHA256:'081579ba678e764a53a6f7ad5ab707d8fd31463bf4527eb316c787a623ab8ba0',
  derivativeSHA256:hash(bytes),derivativeBytes:bytes.length,github100MiBHeadroom:104857600-bytes.length,
  repairedSourceNativeBinaryAndContractsPreserved:preserved,repairedJointOrder:doc.skins[0].joints,pinnedSoleOwnerNodes:pinned,
  clips:clips.map(c=>({name:c.name,channels:c.channels.length,keysPerChannel:doc.accessors[c.samplers[0].input].count,durationSeconds:doc.accessors[c.samplers[0].input].max[0]})),phases,
  rootPolicy:'in-place horizontal; visual root Y retained',authorSHA256:hash(await readFile(new URL('author.mjs',import.meta.url))),contactsSHA256:hash(await readFile(new URL('contacts.json',import.meta.url))),
  usage:null,providerSpend:0,renderAcceptance:null,releaseVerified:false,
});
console.log(JSON.stringify({derivativeSHA256:hash(bytes),bytes:bytes.length,preserved,pinned,clips:clips.map(c=>({name:c.name,channels:c.channels.length}))},null,2));