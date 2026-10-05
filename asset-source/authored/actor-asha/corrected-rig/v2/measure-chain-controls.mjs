import { readFile } from 'node:fs/promises';
import { AnimationMixer, LoopOnce } from 'three';
import { source, sourceSHA, sourceRevision, load, unpack, pack, update, hash, save } from './runtime.mjs';
const input=await source(),bytes=await readFile(new URL('model.glb',import.meta.url)),parsed=unpack(bytes),base=await load(input.bytes);
const chains=[
  {id:'front-negative-X',nodes:[23,24,25]},
  {id:'front-positive-X',nodes:[9,8,7,6]},
  {id:'rear-negative-X',nodes:[16,15,14,13]},
  {id:'rear-positive-X',nodes:[18,17]},
];
const restByNode=new Map(input.doc.skins[0].joints.map((n,j)=>[n,base.bones[j].quaternion.clone().normalize()]));
async function sample(bytes){
  const r=await load(bytes),clip=r.animations.find(c=>c.name==='Pounce'),m=new AnimationMixer(r.scene),a=m.clipAction(clip).setLoop(LoopOnce,1);
  a.clampWhenFinished=true;a.play();a.paused=true;a.time=.8;m.update(0);update(r);
  const reports=chains.map(chain=>({id:chain.id,joints:chain.nodes.map(n=>{
    const j=input.doc.skins[0].joints.indexOf(n),b=r.bones[j],q=b.quaternion.clone().normalize(),rest=restByNode.get(n);
    const relative=q.multiply(rest.clone().invert());
    const delta=2*Math.atan2(Math.hypot(relative.x,relative.y,relative.z),Math.abs(relative.w));
    return {node:n,skinJoint:j,name:input.doc.nodes[n].name,localRotationDeltaRadians:delta};
  })}));m.stopAllAction();return reports;
}
const positive=await sample(bytes),doc=structuredClone(parsed.doc),set=new Set(chains.flatMap(c=>c.nodes));
for(const clip of doc.animations)clip.channels=clip.channels.filter(c=>!(c.target.path==='rotation'&&set.has(c.target.node)));
const negative=await sample(pack(doc,parsed.bin));
// Baseline is an actual inactive/native rest channel control, not invented bone aliases.
const noOpAllowance=Number.EPSILON*64;
const controls=positive.map((chain,i)=>({chain:chain.id,positiveJoints:chain.joints,inertJoints:negative[i].joints,positiveMaxLocalRotationRadians:Math.max(...chain.joints.map(j=>j.localRotationDeltaRadians)),inertMaxLocalRotationRadians:Math.max(...negative[i].joints.map(j=>j.localRotationDeltaRadians)),positiveMotionDetected:chain.joints.some(j=>j.localRotationDeltaRadians>noOpAllowance),inertMotionRejected:negative[i].joints.every(j=>j.localRotationDeltaRadians<=noOpAllowance)}));
const report={sourceRevision,sourceSHA256:sourceSHA,derivativeSHA256:hash(bytes),time:.8,coordinateEvidence:'Actual loaded four segmented leg chains, local quaternion changes exclude whole-root translation and parent/torso motion.',noOpAllowance:'64 * Number.EPSILON for normalized quaternion double-precision inactive-channel algebra, independent of positive motion',controls,allFourChainsDetected:controls.every(c=>c.positiveMotionDetected&&c.inertMotionRejected),renderAcceptance:null,releaseVerified:false};
await save('chain-articulation-controls.json',report);console.log(JSON.stringify(report,null,2));
if(!report.allFourChainsDetected)throw Error('Independent chain articulation control failed');