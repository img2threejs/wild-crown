import { writeFile } from 'node:fs/promises';
import { Vector3, Quaternion, Matrix4 } from 'three';
import { source, loadNative, vertex, update, packet, sha } from './native-runtime.mjs';
const input = await source(), r = await loadNative(input.bytes);
const byNode = new Map(input.doc.skins[0].joints.map((n, j) => [n, r.bones[j]]));
const rest = new Map([...byNode].map(([n, b]) => [n, { p:b.position.clone(), q:b.quaternion.clone() }]));
const regions = [
  { id:'front-negative-X', test:p => p.x < -.07 && p.z > .18 },
  { id:'front-positive-X', test:p => p.x > .015 && p.z > .20 },
  { id:'rear-negative-X', test:p => p.x < -.10 && p.z < 0 },
  { id:'rear-positive-X', test:p => p.x > -.025 && p.x < .11 && p.z < -.12 },
];
const candidates = regions.map(() => []), p = new Vector3();
for (let i=0; i<r.mesh.geometry.attributes.position.count; i++) {
  vertex(r,i,p);
  for(let j=0;j<regions.length;j++) if(regions[j].test(p) && p.y < .015) candidates[j].push({i,p:p.toArray()});
}
// Lowest actual surface points spread over the sole (not four coincident aliases).
const contacts = regions.map((region,j) => {
  const sorted=candidates[j].sort((a,b)=>a.p[1]-b.p[1]);
  const chosen=[];
  for(const c of sorted) if(chosen.every(v=>Math.hypot(c.p[0]-v.p[0],c.p[2]-v.p[2])>.006)) { chosen.push(c); if(chosen.length===8) break; }
  if(chosen.length!==8) throw Error('Insufficient native sole markers '+region.id);
  return {id:region.id,candidateCount:sorted.length,markers:chosen.map(c=>({vertex:c.i,rest:c.p,joints:Array.from({length:4},(_,k)=>r.mesh.geometry.attributes.skinIndex.getComponent(c.i,k)),weights:Array.from({length:4},(_,k)=>r.mesh.geometry.attributes.skinWeight.getComponent(c.i,k))}))};
});
await packet('contact-markers.json',{coordinateUnits:'native units (meter scale unknown)',contacts});
// Do not synthesize independence by moving front torso to pin the missing fourth leg.
// This derivative is BLOCKED anatomical diagnostic material, not a constraint-pass canary.
const markers=contacts.filter(c=>c.id!=='front-negative-X').flatMap(c=>c.markers);
const correctionNodes=[6,7,8,9,13,14,15,16,17,18];
function reset(){for(const [n,b] of byNode){b.position.copy(rest.get(n).p);b.quaternion.copy(rest.get(n).q);}}
function worldRotate(n,axis,angle){
  const b=byNode.get(n);r.scene.updateMatrixWorld(true);
  const parentQ=b.parent.getWorldQuaternion(new Quaternion());
  const localAxis=axis.clone().applyQuaternion(parentQ.invert());
  b.quaternion.premultiply(new Quaternion().setFromAxisAngle(localAxis,angle));
}
function smooth(t){return t*t*(3-2*t);}
function curve(t,keys){
  for(let i=1;i<keys.length;i++)if(t<=keys[i][0]){const [a,x]=keys[i-1],[b,y]=keys[i];return x+(y-x)*smooth((t-a)/(b-a));}
  return keys.at(-1)[1];
}
const phases={anticipation:[0,.38],takeoff:[.38,.55],flight:[.55,1.08],landing:[1.08,1.28],recovery:[1.28,1.8]};
function pose(name,t){
  reset();
  if(name==='Idle'){
    const breath=Math.sin(2*Math.PI*t/3.2), head=Math.sin(2*Math.PI*t/3.2)*.018;
    worldRotate(19,new Vector3(1,0,0),breath*.008);
    worldRotate(11,new Vector3(1,0,0),breath*.008);
    worldRotate(5,new Vector3(1,0,0),head);
    worldRotate(2,new Vector3(0,1,0),breath*.012);
  }else{
    const y=curve(t,[[0,0],[.3,-.028],[.38,-.026],[.55,.07],[.8,.19],[1.08,.025],[1.16,0],[1.28,-.022],[1.8,0]]);
    // Native root parent is identity in world axes; no authored horizontal root travel.
    byNode.get(20).position.y+=y;
    const compress=curve(t,[[0,0],[.3,1],[.38,1],[.55,-.35],[.8,-.2],[1.08,0],[1.28,.8],[1.8,0]]);
    worldRotate(19,new Vector3(1,0,0),compress*.07);
    worldRotate(12,new Vector3(1,0,0),-compress*.09);
    worldRotate(5,new Vector3(1,0,0),compress*.07);
    const tuck=curve(t,[[0,0],[.38,0],[.58,1],[.8,1],[1.08,0],[1.8,0]]);
    for(const [n,a] of [[9,-.16],[8,.22],[16,.15],[15,-.23],[18,.13],[17,-.12],[2,.08]])worldRotate(n,new Vector3(1,0,0),tuck*a);
  }
  update(r);
}
function solve(a,b){
  const n=b.length, rows=a.map((row,i)=>[...row,b[i]]);
  for(let i=0;i<n;i++){
    let pivot=i;for(let j=i+1;j<n;j++)if(Math.abs(rows[j][i])>Math.abs(rows[pivot][i]))pivot=j;
    [rows[i],rows[pivot]]=[rows[pivot],rows[i]];
    const d=rows[i][i];if(Math.abs(d)<1e-15)throw Error('Singular contact fit');
    for(let k=i;k<=n;k++)rows[i][k]/=d;
    for(let j=0;j<n;j++)if(j!==i){const f=rows[j][i];for(let k=i;k<=n;k++)rows[j][k]-=f*rows[i][k];}
  }return rows.map(row=>row[n]);
}
function constrain(strength=1){
  const baseline=markers.map(m=>vertex(r,m.vertex).toArray()), columns=[];
  // Exact affine derivatives of hierarchical local translations in world coordinates.
  for(const n of correctionNodes)for(let axis=0;axis<3;axis++){
    const b=byNode.get(n), inv=new Matrix4().copy(b.parent.matrixWorld).invert();
    const dir=new Vector3().setComponent(axis,1).transformDirection(inv);
    // World-oriented probe: near-unit native parent scale is included in measured derivatives.
    b.position.addScaledVector(dir,.001);update(r);
    columns.push(markers.flatMap((m,j)=>vertex(r,m.vertex).toArray().map((v,k)=>(v-baseline[j][k])/.001)));
    b.position.addScaledVector(dir,-.001);update(r);
  }
  const error=markers.flatMap((m,j)=>m.rest.map((v,k)=>v-baseline[j][k]));
  const n=columns.length, matrix=columns.map((col,i)=>columns.map((other,j)=>col.reduce((s,v,k)=>s+v*other[k],0)+(i===j?1e-5:0)));
  const rhs=columns.map(col=>col.reduce((s,v,k)=>s+v*error[k],0));
  const result=solve(matrix,rhs);
  for(let j=0;j<correctionNodes.length;j++){
    const b=byNode.get(correctionNodes[j]), inv=new Matrix4().copy(b.parent.matrixWorld).invert();
    for(let axis=0;axis<3;axis++)b.position.addScaledVector(new Vector3().setComponent(axis,1).transformDirection(inv),result[j*3+axis]*strength);
    update(r);
  }
}
const doc=structuredClone(input.doc), binary=[input.bin], animations=[];
let offset=input.bin.length;
function addAccessor(values,type){
  const data=Buffer.from(new Float32Array(values).buffer), view=doc.bufferViews.length;
  doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:data.length});binary.push(data);offset+=data.length;
  const width=type==='SCALAR'?1:type==='VEC3'?3:4,index=doc.accessors.length;
  doc.accessors.push({bufferView:view,componentType:5126,count:values.length/width,type,...(type==='SCALAR'?{min:[values[0]],max:[values.at(-1)]}:{})});return index;
}
for(const [name,duration] of [['Idle',3.2],['Pounce',1.8]]){
  const steps=Math.round(duration*60),times=Array.from({length:steps+1},(_,i)=>i*duration/steps);
  const tracks=new Map([...byNode].map(([n])=>[n,{translation:[],rotation:[]}]));
  for(const t of times){
    pose(name,t);
    const contactStrength=name==='Idle'?1:curve(t,[[0,1],[.45,1],[.55,0],[1.08,0],[1.16,1],[1.8,1]]);
    if(contactStrength>0)constrain(contactStrength);
    for(const [n,b]of byNode){tracks.get(n).translation.push(...b.position.toArray());tracks.get(n).rotation.push(...b.quaternion.toArray());}
  }
  const animation={name,samplers:[],channels:[],extras:{author:'offline native Asha canary',loop:name==='Idle',rootPolicy:'in-place-horizontal; native visual Y retained',phases:name==='Pounce'?phases:undefined}};
  const inputIndex=addAccessor(times,'SCALAR');
  for(const [n,paths]of tracks)for(const [path,values]of Object.entries(paths)){
    const width=path==='rotation'?4:3;
    if(values.some(v=>!Number.isFinite(v)))throw Error('Non-finite authored values');
    // Only genuine animated channels; omit unchanged rest channels, not bind fallbacks.
    if(!values.some((v,i)=>Math.abs(v-values[i%width])>1e-7))continue;
    animation.channels.push({sampler:animation.samplers.length,target:{node:n,path}});
    animation.samplers.push({input:inputIndex,output:addAccessor(values,path==='rotation'?'VEC4':'VEC3'),interpolation:'LINEAR'});
  }
  animations.push(animation);
}
doc.animations=animations;doc.buffers[0].byteLength=offset;
let json=Buffer.from(JSON.stringify(doc));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
const bin=Buffer.concat(binary), header=Buffer.alloc(20), binHeader=Buffer.alloc(8);
header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+bin.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);
binHeader.writeUInt32LE(bin.length,0);binHeader.writeUInt32LE(0x004e4942,4);
const derivative=Buffer.concat([header,json,binHeader,bin]);
await writeFile(new URL('model.glb',import.meta.url),derivative);
await packet('authorship.json',{
  status:'BLOCKED_MISSING_INDEPENDENT_FORELEG', canaryComplete:false, constraintAcceptance:null,
  blocker:'No independent negative-X foreleg chain; derivative is diagnostic original-rig material only. Custom rig/skin correction required.',
  sourceSHA256:sha(input.bytes), derivativeSHA256:sha(derivative), sourceBytes:input.bytes.length, derivativeBytes:derivative.length,
  originalBinaryPrefixPreserved:bin.subarray(0,input.bin.length).equals(input.bin),
  nativeJointOrderPreserved:JSON.stringify(doc.skins)===JSON.stringify(input.doc.skins),
  nativeNodesMeshesMaterialsAccessorsPreserved:['nodes','meshes','materials','images','textures','samplers'].every(k=>JSON.stringify(doc[k])===JSON.stringify(input.doc[k]))&&JSON.stringify(doc.accessors.slice(0,input.doc.accessors.length))===JSON.stringify(input.doc.accessors)&&JSON.stringify(doc.bufferViews.slice(0,input.doc.bufferViews.length))===JSON.stringify(input.doc.bufferViews),
  clips:animations.map(a=>({name:a.name,channels:a.channels.length,samplesPerChannel:a.name==='Idle'?193:109})),phases,
  rootPolicy:'in-place horizontal; visual native root Y retained; authoritative external actor pose',providerSpends:0,usage:null,renderReview:null,releaseVerified:false,
});
console.log(JSON.stringify({derivativeSHA256:sha(derivative),bytes:derivative.length,clips:animations.map(a=>({name:a.name,channels:a.channels.length})),markers:contacts.map(c=>({id:c.id,vertices:c.markers.map(m=>m.vertex)}))},null,2));
