import { readFile } from 'node:fs/promises';
import { AnimationMixer, LoopOnce, LoopRepeat, Vector3 } from 'three';
import { source, loadNative, unpack, update, vertex, bounds, packet, sha } from './native-runtime.mjs';
const startedAt=new Date().toISOString(), input=await source(), bytes=await readFile(new URL('model.glb',import.meta.url));
const parsed=unpack(bytes), r=await loadNative(bytes);
if(!parsed.bin.subarray(0,input.bin.length).equals(input.bin))throw Error('Original native binary changed');
for(const key of ['nodes','skins','meshes','materials','images','textures','samplers'])if(JSON.stringify(parsed.doc[key])!==JSON.stringify(input.doc[key]))throw Error('Original native contract changed: '+key);
for(const key of ['accessors','bufferViews'])if(JSON.stringify(parsed.doc[key].slice(0,input.doc[key].length))!==JSON.stringify(input.doc[key]))throw Error('Original native storage changed: '+key);
const contacts=JSON.parse(await readFile(new URL('contact-markers.json',import.meta.url))).contacts;
const markerIds=contacts.flatMap(c=>c.markers.map(m=>m.vertex));
const ids=[...new Set([...markerIds,...Array.from({length:2048},(_,i)=>Math.floor(i*(r.mesh.geometry.attributes.position.count-1)/2047))])];
const restPoints=ids.map(i=>vertex(r,i).toArray()),root=r.bones[0],rootBind=root.position.clone();
const mixer=new AnimationMixer(r.scene);
function sample(clip,t,strip=false){
  const action=mixer.clipAction(clip);action.time=t;mixer.update(0);
  if(strip)root.position.copy(rootBind);update(r);
  return {time:t,root:root.getWorldPosition(new Vector3()).toArray(),points:ids.map(i=>vertex(r,i).toArray())};
}
function maxMovement(a,b){return Math.max(...a.map((p,i)=>Math.hypot(...p.map((v,k)=>v-b[i][k]))));}
function validateChannels(){
  for(const a of parsed.doc.animations)for(const c of a.channels){
    const s=a.samplers[c.sampler],t=parsed.doc.accessors[s.input],v=parsed.doc.accessors[s.output];
    if(s.interpolation!=='LINEAR'||t.type!=='SCALAR'||t.componentType!==5126||v.componentType!==5126||v.count!==t.count||!parsed.doc.skins[0].joints.includes(c.target.node)||!['rotation','translation'].includes(c.target.path))throw Error('Invalid native channel');
  }
  for(const clip of r.animations){
    if(!clip.validate()||clip.duration<=0)throw Error('Invalid loader animation');
    for(const track of clip.tracks){
      if([...track.values,...track.times].some(v=>!Number.isFinite(v))||track.times[0]!==0)throw Error('Non-finite animation values');
      for(let i=1;i<track.times.length;i++)if(track.times[i]<=track.times[i-1])throw Error('Non-increasing native times');
    }
  }
}
validateChannels();
const clipReports=[];
for(const clip of r.animations){
  mixer.stopAllAction();mixer.uncacheRoot(r.scene);
  const action=mixer.clipAction(clip);action.setLoop(LoopOnce,1);action.clampWhenFinished=true;action.play();action.paused=true;
  const first=sample(clip,0),samples=[],denseCount=Math.ceil(clip.duration*120);
  for(let i=0;i<=denseCount;i++)samples.push(sample(clip,clip.duration*i/denseCount));
  const windows=clip.name==='Idle'?[[0,clip.duration]]:[[0,.38],[1.16,clip.duration]];
  const pawMeasurements=contacts.map(contact=>({paw:contact.id,windows:windows.map(([start,end])=>{
    let maxHorizontalSlip=0,maxVerticalOffset=0,minWorldY=Infinity,maxWorldY=-Infinity,worstVertex=null,worstTime=null;
    for(const s of samples)if(s.time>=start-1e-8&&s.time<=end+1e-8)for(const m of contact.markers){
      const point=s.points[ids.indexOf(m.vertex)],horizontal=Math.hypot(point[0]-m.rest[0],point[2]-m.rest[2]);
      if(horizontal>maxHorizontalSlip){maxHorizontalSlip=horizontal;worstVertex=m.vertex;worstTime=s.time;}
      maxVerticalOffset=Math.max(maxVerticalOffset,Math.abs(point[1]-m.rest[1]));minWorldY=Math.min(minWorldY,point[1]);maxWorldY=Math.max(maxWorldY,point[1]);
    }
    return {start,end,maxHorizontalSlip,maxVerticalOffset,minWorldY,maxWorldY,worstVertex,worstTime};
  })}));
  const keyTimes=clip.name==='Idle'?[0,.8,1.6,2.4,clip.duration]:[0,.3,.45,.55,.8,1.08,1.16,1.28,clip.duration];
  const boundsSamples=keyTimes.map(t=>{
    const s=sample(clip,t);
    const paws=contacts.map(c=>({paw:c.id,minY:Math.min(...c.markers.map(m=>vertex(r,m.vertex).y)),maxY:Math.max(...c.markers.map(m=>vertex(r,m.vertex).y))}));
    return {time:t,root:s.root,deformedAllVertexBounds:bounds(r),paws};
  });
  const end=sample(clip,clip.duration),peak=sample(clip,clip.name==='Idle'?.8:.8);
  const motion=maxMovement(first.points,peak.points),closure=maxMovement(first.points,end.points);
  const stripped=clip.name==='Pounce'?sample(clip,.8,true):null;
  clipReports.push({name:clip.name,durationSeconds:clip.duration,channels:clip.tracks.length,denseSampleCount:samples.length,finiteSampledVertices:ids.length,skinMatricesFinite:true,maximumSampledDeformationFromStart:motion,loopOrRecoveryClosure:closure,rootHorizontalExcursion:Math.max(...samples.map(s=>Math.hypot(s.root[0]-first.root[0],s.root[2]-first.root[2]))),rootMinY:Math.min(...samples.map(s=>s.root[1])),rootMaxY:Math.max(...samples.map(s=>s.root[1])),pawMeasurements,boundsSamples,rootStripNegativeControl:stripped?{peakNativeRootY:peak.root[1],strippedRootY:stripped.root[1],lostVisualLift:peak.root[1]-stripped.root[1]}:null});
  // Full dense data supports resampling/review without making the summary a fabricated gate.
  await packet(clip.name.toLowerCase()+'-samples.json',{ids,samples:samples.map(s=>({time:s.time,root:s.root,contactPoints:s.points.slice(0,markerIds.length)}))});
}
mixer.stopAllAction();mixer.uncacheRoot(r.scene);update(r);
const rest=ids.map(i=>vertex(r,i).toArray()),restError=maxMovement(restPoints,rest);
r.scene.position.x=.05;update(r);
const injected=ids.map(i=>vertex(r,i).toArray());
const injectedSlip=maxMovement(rest,injected);
r.scene.position.x=0;update(r);
const controls={plantedRestPositiveControl:{maximumDisplacement:restError,detectorAccepts:restError<1e-6},injectedSlideNegativeControl:{injectedWorldX:.05,measuredDisplacement:injectedSlip,detectorRejects:injectedSlip>.01},noOpNegativeControl:{measuredDeformation:maxMovement(rest,rest),deformationDetectorRejects:maxMovement(rest,rest)<1e-5},authoredDeformationPositiveControl:clipReports.map(c=>({clip:c.name,measuredDeformation:c.maximumSampledDeformationFromStart,detectorAccepts:c.maximumSampledDeformationFromStart>1e-5}))};
if(!controls.plantedRestPositiveControl.detectorAccepts||!controls.injectedSlideNegativeControl.detectorRejects||!controls.noOpNegativeControl.deformationDetectorRejects||controls.authoredDeformationPositiveControl.some(c=>!c.detectorAccepts))throw Error('Blind measurement control');
const temporalPlayback=[];
for(const clip of r.animations){
  mixer.stopAllAction();mixer.uncacheRoot(r.scene);
  const action=mixer.clipAction(clip).reset();action.setLoop(clip.name==='Idle'?LoopRepeat:LoopOnce,clip.name==='Idle'?Infinity:1);action.clampWhenFinished=true;action.play();
  mixer.update(.1);update(r);const initial=ids.map(i=>vertex(r,i).toArray());
  if(clip.name==='Idle'){
    mixer.update(clip.duration);update(r);const next=ids.map(i=>vertex(r,i).toArray());
    const recurrenceError=maxMovement(initial,next);if(recurrenceError>1e-6)throw Error('Idle repeat recurrence failed');
    temporalPlayback.push({clip:clip.name,mode:'LoopRepeat',afterOneAdditionalCycleSeconds:action.time,recurrenceError});
  }else{
    mixer.update(clip.duration+1);update(r);
    const end=ids.map(i=>vertex(r,i).toArray()),recoveryError=maxMovement(restPoints,end);
    if(!action.paused||Math.abs(action.time-clip.duration)>1e-6||recoveryError>1e-6)throw Error('Pounce one-shot clamp/recovery failed');
    temporalPlayback.push({clip:clip.name,mode:'LoopOnce',endTime:action.time,clamped:action.paused,recoveryError});
  }
}
await packet('temporal-playback.json',{temporalPlayback,status:'BLOCKED_MISSING_INDEPENDENT_FORELEG',releaseVerified:false});
mixer.stopAllAction();mixer.uncacheRoot(r.scene);
const report={status:'BLOCKED_MISSING_INDEPENDENT_FORELEG',blockers:['Native negative-X foreleg shares front-torso influence and has no independent articulated chain. Custom quadruped rig/skin correction required; no constraint-pass or complete canary claimed.'],startedAt,finishedAt:new Date().toISOString(),sourceSHA256:sha(input.bytes),derivativeSHA256:sha(bytes),loader:'three@0.169.0 GLTFLoader.parseAsync',texturesDecoded:false,browserRenderMeasured:false,authoritativeExternalActorPose:'identity CPU scenario only; gameplay integration unmeasured',rootPolicy:'in-place horizontal; native visual root Y retained (no root stripping)',nativeSkinJoints:r.bones.length,vertices:r.mesh.geometry.attributes.position.count,triangles:r.mesh.geometry.index.count/3,sourceLOD:{lodCount:1,lowerLODs:null,optimizationMeasured:false,productionMemoryAndFrameTime:null},originalBinaryPrefixPreserved:parsed.bin.subarray(0,input.bin.length).equals(input.bin),nativeSkinAndHierarchyPreserved:JSON.stringify(parsed.doc.skins)===JSON.stringify(input.doc.skins)&&JSON.stringify(parsed.doc.nodes)===JSON.stringify(input.doc.nodes),controls,clips:clipReports,usage:null,releaseVerified:false,canaryComplete:false,constraintAcceptance:null,actualRenderReview:null};
await packet('canary-packet.json',report);
console.log(JSON.stringify({status:report.status,sourceSHA256:report.sourceSHA256,derivativeSHA256:report.derivativeSHA256,controls,clips:clipReports.map(c=>({name:c.name,duration:c.durationSeconds,channels:c.channels,samples:c.denseSampleCount,deformation:c.maximumSampledDeformationFromStart,closure:c.loopOrRecoveryClosure,rootHorizontal:c.rootHorizontalExcursion,rootY:[c.rootMinY,c.rootMaxY],paws:c.pawMeasurements,rootStripNegativeControl:c.rootStripNegativeControl})),canaryComplete:false,releaseVerified:false},null,2));
