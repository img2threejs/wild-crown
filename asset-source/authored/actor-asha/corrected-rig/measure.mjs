import { readFile } from 'node:fs/promises';
import { AnimationMixer, LoopOnce, LoopRepeat, Vector3, Box3 } from 'three';
import { source, sourceSHA, sourceRevision, load, unpack, update, vertex, hash, pack, save } from './runtime.mjs';
const startedAt=new Date().toISOString(),input=await source();
const bytes=await readFile(new URL('model.glb',import.meta.url)),parsed=unpack(bytes),r=await load(bytes),base=await load(input.bytes);
const contact=JSON.parse(await readFile(new URL('contacts.json',import.meta.url))),paws=contact.paws;
if(contact.sourceSHA256!==sourceSHA)throw Error('Wrong contact source');
if(paws.find(p=>p.id==='front-negative-X').influenceJoints.some(j=>j<21))throw Error('Blocked complete-forepaw source: legacy torso/head/opposite-limb skin influence; independent foreleg repair required before numerical canary acceptance');
if(!parsed.bin.subarray(0,input.bin.length).equals(input.bin))throw Error('Repaired native binary changed');
for(const key of ['nodes','skins','meshes','materials','images','textures','samplers'])if(JSON.stringify(parsed.doc[key])!==JSON.stringify(input.doc[key]))throw Error('Repaired native contract changed '+key);
for(const key of ['accessors','bufferViews'])if(JSON.stringify(parsed.doc[key].slice(0,input.doc[key].length))!==JSON.stringify(input.doc[key]))throw Error('Original corrected storage changed '+key);
if(r.animations.length!==2||r.animations.map(c=>c.name).join(',')!=='Idle,Pounce')throw Error('Wrong clip coverage');
for(const clip of r.animations){
  if(!clip.validate()||clip.duration<=0)throw Error('Invalid native loader clip');
  for(const track of clip.tracks){
    for(const value of track.values)if(!Number.isFinite(value))throw Error('Nonfinite native key');
    for(let i=0;i<track.times.length;i++)if(!Number.isFinite(track.times[i])||(i&&track.times[i]<=track.times[i-1]))throw Error('Invalid native time');
  }
}
for(const clip of parsed.doc.animations)for(const channel of clip.channels){
  const sampler=clip.samplers[channel.sampler],time=parsed.doc.accessors[sampler.input],value=parsed.doc.accessors[sampler.output];
  if(sampler.interpolation!=='LINEAR'||time.type!=='SCALAR'||time.componentType!==5126||value.componentType!==5126||time.count!==value.count||!parsed.doc.skins[0].joints.includes(channel.target.node))throw Error('Invalid persisted native channel');
  if(channel.target.path==='rotation'){
    const view=parsed.doc.bufferViews[value.bufferView],start=(view.byteOffset||0)+(value.byteOffset||0);
    for(let i=0;i<value.count;i++){let squared=0;for(let k=0;k<4;k++)squared+=parsed.bin.readFloatLE(start+(i*4+k)*4)**2;if(Math.abs(squared-1)>1e-6)throw Error('Nonunit quaternion');}
  }
}
const vertexCount=r.mesh.geometry.attributes.position.count;
const rest=new Float64Array(vertexCount*3),lookup=new Int32Array(vertexCount).fill(-1),markerRest=[],markerPaw=[];
for(let j=0;j<paws.length;j++)for(const m of paws[j].sole){if(lookup[m.vertex]!==-1)throw Error('Overlapping paw regions');lookup[m.vertex]=markerPaw.length;markerRest.push(...m.rest);markerPaw.push(j);}
const p=new Vector3(),raw=new Vector3();let bindResidual=0,worldFloat32RoundingResidual=0;
for(let i=0;i<vertexCount;i++){
  vertex(base,i,p);rest[i*3]=p.x;rest[i*3+1]=p.y;rest[i*3+2]=p.z;
  // Attached GLTFLoader bindMatrixInverse cancels meshWorld: same native bind space.
  raw.fromBufferAttribute(base.mesh.geometry.attributes.position,i).applyMatrix4(base.mesh.bindMatrix).applyMatrix4(base.mesh.bindMatrixInverse).applyMatrix4(base.mesh.matrixWorld);
  bindResidual=Math.max(bindResidual,p.distanceTo(raw));
  worldFloat32RoundingResidual=Math.max(worldFloat32RoundingResidual,Math.hypot(p.x-Math.fround(p.x),p.y-Math.fround(p.y),p.z-Math.fround(p.z)));
}
function scan(runtime,reference=rest){
  const box=new Box3(),pawStats=paws.map(c=>({paw:c.id,vertices:c.sole.length,maxHorizontalSlip:0,maxVerticalOffset:0,minY:Infinity,maxY:-Infinity,worstHorizontalVertex:null,worstVerticalVertex:null}));
  let maxDisplacement=0,maxNonRigidDisplacement=0,worstVertex=null;
  const root=runtime.bones[0].getWorldPosition(new Vector3()),baseRoot=base.bones[0].getWorldPosition(new Vector3());
  for(let i=0;i<vertexCount;i++){
    vertex(runtime,i,p);box.expandByPoint(p);
    const dx=p.x-reference[i*3],dy=p.y-reference[i*3+1],dz=p.z-reference[i*3+2],distance=Math.hypot(dx,dy,dz);
    if(distance>maxDisplacement){maxDisplacement=distance;worstVertex=i;}
    maxNonRigidDisplacement=Math.max(maxNonRigidDisplacement,Math.hypot(dx-(root.x-baseRoot.x),dy-(root.y-baseRoot.y),dz-(root.z-baseRoot.z)));
    const m=lookup[i];if(m<0)continue;
    const stats=pawStats[markerPaw[m]],h=Math.hypot(p.x-markerRest[m*3],p.z-markerRest[m*3+2]),v=Math.abs(p.y-markerRest[m*3+1]);
    if(h>stats.maxHorizontalSlip){stats.maxHorizontalSlip=h;stats.worstHorizontalVertex=i;}
    if(v>stats.maxVerticalOffset){stats.maxVerticalOffset=v;stats.worstVerticalVertex=i;}
    stats.minY=Math.min(stats.minY,p.y);stats.maxY=Math.max(stats.maxY,p.y);
  }
  return {root:root.toArray(),allVertexBounds:{min:box.min.toArray(),max:box.max.toArray()},maxDisplacement,maxNonRigidDisplacement,worstVertex,paws:pawStats,finiteVertices:vertexCount};
}
// Independent stationary animation serialization calibration: all 24 native rest TRS
// tracks pass through Float32 accessors + real GLTFLoader/mixer. No authored motion data.
function staticControl(){
  const doc=structuredClone(input.doc),parts=[input.bin];let offset=input.bin.length;
  function add(values,type){const data=Buffer.from(new Float32Array(values).buffer),view=doc.bufferViews.length,index=doc.accessors.length;doc.bufferViews.push({buffer:0,byteOffset:offset,byteLength:data.length});doc.accessors.push({bufferView:view,componentType:5126,count:values.length/(type==='SCALAR'?1:type==='VEC3'?3:4),type});offset+=data.length;parts.push(data);return index;}
  const time=add([0,1],'SCALAR'),animation={name:'stationary-calibration',channels:[],samplers:[]};
  for(let j=0;j<base.bones.length;j++)for(const [path,values]of [['translation',base.bones[j].position.toArray()],['rotation',base.bones[j].quaternion.toArray()]]){
    animation.channels.push({sampler:animation.samplers.length,target:{node:input.doc.skins[0].joints[j],path}});
    animation.samplers.push({input:time,output:add([...values,...values],path==='translation'?'VEC3':'VEC4'),interpolation:'LINEAR'});
  }
  doc.animations=[animation];doc.buffers[0].byteLength=offset;return pack(doc,Buffer.concat(parts));
}
const stationary=await load(staticControl()),stationaryMixer=new AnimationMixer(stationary.scene);
stationaryMixer.clipAction(stationary.animations[0]).play();stationaryMixer.update(.5);update(stationary);
const stationaryMeasurement=scan(stationary);
const calibratedContactAllowance=2*(bindResidual+stationaryMeasurement.maxDisplacement)+8*worldFloat32RoundingResidual;
const calibration={policy:'2 * (independently measured all-vertex corrected-source native bind residual + independently measured all-vertex stationary Float32 TRS serialization residual) + 8 * measured native-world Float32 coordinate rounding residual; fixed before motion measurement',bindResidual,stationaryFloat32AnimationResidual:stationaryMeasurement.maxDisplacement,worldFloat32RoundingResidual,calibratedContactAllowance,stationaryPaws:stationaryMeasurement.paws,selectedFromMotion:false};
stationaryMixer.stopAllAction();
const mixer=new AnimationMixer(r.scene),rootBind=r.bones[0].position.clone();
function start(clip){mixer.stopAllAction();mixer.uncacheRoot(r.scene);const action=mixer.clipAction(clip);action.reset().setLoop(LoopOnce,1);action.clampWhenFinished=true;action.play();action.paused=true;return action;}
function setTime(clip,time){mixer.clipAction(clip).time=time;mixer.update(0);update(r);}
const reports=[];
for(const clip of r.animations){
  start(clip);
  // Exact key and phase-boundary times plus non-key 240-Hz samples, never sparse bounds.
  const n=Math.round(clip.duration*240),times=new Set(Array.from({length:n+1},(_,i)=>clip.duration*i/n));
  for(const track of clip.tracks)for(const time of track.times)times.add(time);
  for(const time of clip.name==='Idle'?[]:[.32,.4,.55,.8,1.08,1.16,1.28])times.add(time);
  const ordered=[...times].sort((a,b)=>a-b),samples=[];
  for(const time of ordered){setTime(clip,time);samples.push({time,...scan(r)});}
  const windows=clip.name==='Idle'?[[0,clip.duration]]:[[0,.4],[1.16,clip.duration]];
  const contactWindows=windows.map(([start,end])=>({start,end,paws:paws.map(paw=>{
    const rows=samples.filter(s=>s.time>=start-1e-9&&s.time<=end+1e-9).map(s=>({...s.paws.find(p=>p.paw===paw.id),time:s.time}));
    const worstH=rows.reduce((a,b)=>a.maxHorizontalSlip>b.maxHorizontalSlip?a:b),worstV=rows.reduce((a,b)=>a.maxVerticalOffset>b.maxVerticalOffset?a:b);
    return {paw:paw.id,vertices:paw.sole.length,sampledTimes:rows.length,maxHorizontalSlip:worstH.maxHorizontalSlip,maxVerticalOffset:worstV.maxVerticalOffset,worstHorizontal:{time:worstH.time,vertex:worstH.worstHorizontalVertex},worstVertical:{time:worstV.time,vertex:worstV.worstVerticalVertex},withinIndependentNumericAllowance:worstH.maxHorizontalSlip<=calibratedContactAllowance&&worstV.maxVerticalOffset<=calibratedContactAllowance};
  })}));
  setTime(clip,0);const first=scan(r);const reference=new Float64Array(vertexCount*3);
  for(let i=0;i<vertexCount;i++){vertex(r,i,p);reference[i*3]=p.x;reference[i*3+1]=p.y;reference[i*3+2]=p.z;}
  setTime(clip,clip.duration);const closure=scan(r,reference).maxDisplacement;
  const peak=samples.reduce((a,b)=>a.maxDisplacement>b.maxDisplacement?a:b);
  const roots=samples.map(s=>s.root),rootHorizontal=Math.max(...roots.map(v=>Math.hypot(v[0]-first.root[0],v[2]-first.root[2])));
  let rootStripControl=null;
  if(clip.name==='Pounce'){
    setTime(clip,.8);const native=scan(r);r.bones[0].position.copy(rootBind);update(r);const stripped=scan(r);
    rootStripControl={time:.8,nativeRoot:native.root,strippedRoot:stripped.root,lostLift:native.root[1]-stripped.root[1],nativeAllVertexMinY:native.allVertexBounds.min[1],strippedAllVertexMinY:stripped.allVertexBounds.min[1],flightDetectorRejects:stripped.allVertexBounds.min[1]<=calibratedContactAllowance};
  }
  const finiteSamples=samples.length*vertexCount;
  const report={name:clip.name,durationSeconds:clip.duration,channels:clip.tracks.length,sampledTimes:samples.length,allVerticesEverySample:vertexCount,finiteVertexSamples:finiteSamples,soleVerticesEverySample:markerPaw.length,rootHorizontalExcursion:rootHorizontal,rootVerticalRange:[Math.min(...roots.map(v=>v[1])),Math.max(...roots.map(v=>v[1]))],maximumAllVertexDeformation:peak.maxDisplacement,maximumNonRigidDeformation:Math.max(...samples.map(s=>s.maxNonRigidDisplacement)),loopOrRecoveryClosureAllVertices:closure,contactWindows,rootStripControl};
  reports.push(report);await save(clip.name.toLowerCase()+'-samples.json',{sourceSHA256:sourceSHA,derivativeSHA256:hash(bytes),samples});
  console.log(JSON.stringify({clip:clip.name,samples:report.sampledTimes,allVerticesEverySample:vertexCount,contactWindows,closure,rootStripControl}));
}
// Serialized native no-op and contact-correction-inert negative controls. They are throwaway
// in-memory GLBs consumed by the actual loader, never substitute shipped animations.
function mutate(mode){
  const doc=structuredClone(parsed.doc),bin=Buffer.from(parsed.bin);
  if(mode==='no-op')for(const animation of doc.animations)for(const sampler of animation.samplers){
    const a=doc.accessors[sampler.output],view=doc.bufferViews[a.bufferView],width=a.type==='VEC4'?4:3,start=(view.byteOffset||0)+(a.byteOffset||0);
    for(let i=1;i<a.count;i++)bin.copy(bin,start+i*width*4,start,start+width*4);
  }
  if(mode==='contact-inert'){
    const nodeSet=new Set(paws.flatMap(p=>p.influenceJoints).map(j=>doc.skins[0].joints[j]));
    for(const animation of doc.animations)animation.channels=animation.channels.filter(c=>!(c.target.path==='translation'&&nodeSet.has(c.target.node)));
  }
  return pack(doc,bin);
}
async function control(mode,t){
  const runtime=await load(mutate(mode)),clip=runtime.animations.find(c=>c.name==='Pounce'),m=new AnimationMixer(runtime.scene);
  const a=m.clipAction(clip).setLoop(LoopOnce,1);a.clampWhenFinished=true;a.play();a.paused=true;
  a.time=t;m.update(0);update(runtime);const result=scan(runtime);m.stopAllAction();return result;
}
const noOpStart=await control('no-op',0),noOpPeak=await control('no-op',.8),contactInert=await control('contact-inert',.32);
base.scene.position.x=.025;update(base);const injected=scan(base);base.scene.position.x=0;update(base);
const controls={
  stationaryPositive:stationaryMeasurement.paws.every(p=>p.maxHorizontalSlip<=calibratedContactAllowance&&p.maxVerticalOffset<=calibratedContactAllowance),
  injectedSlide:{injectedX:.025,paws:injected.paws,rejected:injected.paws.every(p=>p.maxHorizontalSlip>calibratedContactAllowance)},
  noOp:{start:noOpStart.maxDisplacement,peak:noOpPeak.maxDisplacement,nonRigidPeak:noOpPeak.maxNonRigidDisplacement,motionDetectorRejects:noOpStart.maxNonRigidDisplacement<=calibratedContactAllowance&&noOpPeak.maxNonRigidDisplacement<=calibratedContactAllowance},
  contactCorrectionInert:{time:.32,paws:contactInert.paws,rejectedPaws:contactInert.paws.filter(p=>p.maxHorizontalSlip>calibratedContactAllowance||p.maxVerticalOffset>calibratedContactAllowance).map(p=>p.paw)},
  authoredMotionPositive:reports.map(c=>({clip:c.name,allVertexMotion:c.maximumAllVertexDeformation,nonRigidMotion:c.maximumNonRigidDeformation,detected:c.maximumNonRigidDeformation>calibratedContactAllowance})),
};
const temporal=[];
for(const clip of r.animations){
  mixer.stopAllAction();mixer.uncacheRoot(r.scene);const a=mixer.clipAction(clip).reset().setLoop(clip.name==='Idle'?LoopRepeat:LoopOnce,clip.name==='Idle'?Infinity:1);a.clampWhenFinished=true;a.play();mixer.update(.1);update(r);
  const initial=new Float64Array(vertexCount*3);for(let i=0;i<vertexCount;i++){vertex(r,i,p);initial[i*3]=p.x;initial[i*3+1]=p.y;initial[i*3+2]=p.z;}
  if(clip.name==='Idle'){mixer.update(clip.duration);update(r);temporal.push({clip:clip.name,mode:'LoopRepeat',phase:a.time,allVertexRecurrenceError:scan(r,initial).maxDisplacement});}
  else{mixer.update(clip.duration+1);update(r);temporal.push({clip:clip.name,mode:'LoopOnce',time:a.time,clamped:a.paused,allVertexRecoveryError:scan(r).maxDisplacement});}
}
const planted=reports.every(c=>c.contactWindows.every(w=>w.paws.length===4&&w.paws.every(p=>p.withinIndependentNumericAllowance)));
const controlSensitive=controls.stationaryPositive&&controls.injectedSlide.rejected&&controls.noOp.motionDetectorRejects&&controls.contactCorrectionInert.rejectedPaws.length===4&&controls.authoredMotionPositive.every(c=>c.detected)&&reports.find(c=>c.name==='Pounce').rootStripControl.flightDetectorRejects;
const body=JSON.parse(await readFile(new URL('body-phase-measurements.json',import.meta.url))),chains=JSON.parse(await readFile(new URL('chain-articulation-controls.json',import.meta.url)));
if([body,chains].some(e=>e.sourceSHA256!==sourceSHA||e.derivativeSHA256!==hash(bytes)))throw Error('Stale body or independent-chain evidence');
const idleBody=body.reports.find(c=>c.clip==='Idle').samples,pounceBody=body.reports.find(c=>c.clip==='Pounce').samples;
const phaseMotion={
  breathingTorsoPositiveAndNegative:Math.max(...idleBody.map(s=>s.torsoCentroidDeltaY))>calibratedContactAllowance&&Math.min(...idleBody.map(s=>s.torsoCentroidDeltaY))<-calibratedContactAllowance,
  subtleHeadSurfaceMotion:Math.max(...idleBody.map(s=>Math.abs(s.headCentroidDeltaY)))>calibratedContactAllowance,
  anticipationBodyCompression:pounceBody.find(s=>s.time===.32).torsoCentroidDeltaY<-calibratedContactAllowance,
  landingBodyCompression:pounceBody.find(s=>s.time===1.28).torsoCentroidDeltaY<-calibratedContactAllowance,
  bodyRecovery:Math.abs(pounceBody.at(-1).torsoCentroidDeltaY)<=calibratedContactAllowance,
  fourIndependentChains:chains.allFourChainsDetected,
};
const timeline=temporal.every(t=>t.clip==='Idle'?t.allVertexRecurrenceError<=calibratedContactAllowance:t.clamped&&t.time===reports.find(c=>c.name==='Pounce').durationSeconds&&t.allVertexRecoveryError<=calibratedContactAllowance)&&reports.every(c=>c.loopOrRecoveryClosureAllVertices<=calibratedContactAllowance);
const inPlace=reports.every(c=>c.rootHorizontalExcursion<=calibratedContactAllowance);
const numericalEvidence=planted&&controlSensitive&&timeline&&inPlace&&Object.values(phaseMotion).every(Boolean);
const packet={
  status:numericalEvidence?'FOUR_PAW_NUMERIC_CANARY_EVIDENCE':'NUMERIC_CANARY_FAILED',startedAt,finishedAt:new Date().toISOString(),sourceRevision,sourceSHA256:sourceSHA,derivativeSHA256:hash(bytes),derivativeBytes:bytes.length,
  loader:'three@0.169.0 genuine GLTFLoader.parseAsync + AnimationMixer + CPU SkinnedMesh.applyBoneTransform',allVertices:vertexCount,triangles:r.mesh.geometry.index.count/3,repairedSourcePreserved:true,contactSurfaceVertices:markerPaw.length,
  calibration,clips:reports,controls,temporal,phaseMotion,allFourPlantedNumerically:planted,measurementControlsSensitive:controlSensitive,timelineNumericallyValid:timeline,inPlaceHorizontalMeasured:inPlace,
  sourceSkinLimitations:'Complete negative-X fore toe patch includes legacy torso/head/opposite-limb mixed weights; every actual sole influence is constrained during plant. Numerical surface contact is NOT clean-skin/anatomical/visual qualification.',
  sourceLOD:{sourceMeshCount:1,lodCount:1,lowerLODs:null,productionMemoryAndFrameTime:null},rootPolicy:'in-place horizontal; visual native root Y retained; authoritative external actor pose (identity CPU scenario)',
  texturesDecoded:false,browserRenderMeasured:false,gameplayIntegrationMeasured:false,continuousMotionAndColliderAcceptance:null,AstraReview:null,parentRenderAcceptance:null,releaseVerified:false,usage:null,
};
await save('canary-packet.json',packet);
await save('evidence-index.json',{sourceRevision,sourceSHA256:sourceSHA,derivativeSHA256:hash(bytes),artifacts:await Promise.all(['runtime.mjs','inspect.mjs','author.mjs','measure.mjs','measure-chain-controls.mjs','measure-body-phases.mjs','anatomy.json','contacts.json','provenance.json','idle-samples.json','pounce-samples.json','chain-articulation-controls.json','body-phase-measurements.json','canary-packet.json'].map(async name=>({path:name,sha256:hash(await readFile(new URL(name,import.meta.url)))}))),AstraReview:null,parentRenderAcceptance:null,releaseVerified:false});
console.log(JSON.stringify({status:packet.status,calibration,clips:reports,controls,temporal},null,2));
if(!numericalEvidence)throw Error('Complete four-paw numerical canary or control failed; packet saved with measured failure, not accepted');
