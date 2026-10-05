import { readFile,writeFile } from 'node:fs/promises';
import { Vector3 } from 'three';
import { buildHandRig,poseMatrices,point,staffAlignment } from './hand-rig.mjs';
import { surfaceIndex } from './surface-index.mjs';
const rig=await buildHandRig(),surface=surfaceIndex(rig.positions,rig.staffTriangles),neutral=poseMatrices(rig,{});
const opposedThumbSurface=surfaceIndex(rig.positions,rig.staffTriangles.filter(ids=>ids.reduce((sum,v)=>sum+rig.positions[v*3],0)/3>-.039));
const opposedDigitSurface=surfaceIndex(rig.positions,rig.staffTriangles.filter(ids=>ids.reduce((sum,v)=>sum+rig.positions[v*3],0)/3<-.046));
const previousCandidate=JSON.parse(await readFile(new URL('candidate-grip-pose.json',import.meta.url)));
const samples=[...new Set([...rig.hand.filter((v,i)=>i%24===0),...(previousCandidate.fullHandMeasurement.penetratingVertices??[])])];
function group(v){let slot=0;for(let s=1;s<4;s++)if(rig.weights[v*4+s]>rig.weights[v*4+slot])slot=s;const j=rig.joints[v*4+slot];if(j===rig.thumbRootSkin||j===rig.thumbMidSkin)return 4;for(let d=0;d<4;d++)if([rig.digits[d].rootSkin,rig.digits[d].midSkin,rig.digits[d].tipSkin].includes(j))return d;return -1;}
const prior=previousCandidate.fullHandMeasurement.parameters;
if(process.argv.includes('--continue')&&!prior.pose.intermediate)throw new Error('Older two-phalange candidate cannot seed the anatomical three-phalange solver');
const vars=process.argv.includes('--continue')?[prior.centerY,prior.centerZ,...prior.pose.proximal,...prior.pose.intermediate,...prior.pose.distal,...prior.pose.abduction,prior.pose.thumbSweep,prior.pose.thumbOpposition,prior.pose.thumbFlexion,prior.pose.thumbDistal]:[.434,.128,.4,.4,.4,.4,.3,.3,.3,.3,.2,.2,.2,.2,0,0,0,0,0,.8,.2,0];
const bounds=[[.395,.456],[.07,.145],...[0,1,2,3].map(()=>[0,1]),...[0,1,2,3].map(()=>[0,.85]),...[0,1,2,3].map(()=>[0,.7]),...[0,1,2,3].map(()=>[-.25,.25]),[-.7,.7],[-1.2,1.2],[-.7,.85],[-.5,.6]];
function parameters(values){return {centerY:values[0],centerZ:values[1],pose:{wrist:Math.PI/6,palm:0,proximal:values.slice(2,6),intermediate:values.slice(6,10),distal:values.slice(10,14),abduction:values.slice(14,18),thumbSweep:values[18],thumbOpposition:values[19],thumbFlexion:values[20],thumbDistal:values[21]}};}
function measure(values,ids=samples,{precise=false}={}){
 const p=parameters(values),posed=poseMatrices(rig,p.pose),palmDelta=posed.world[rig.palm].clone().multiply(neutral.world[rig.palm].clone().invert()),alignment=staffAlignment(rig,p.centerY,p.centerZ),inverse=alignment.clone().invert().multiply(palmDelta.clone().invert());
 const contact=[0,1,2,3,4].map(()=>({distance:Infinity})),penetratingVertices=[];let penetrationSum=0,insideCount=0,maxPenetration=0;
 for(const v of ids){const world=point(rig,v,posed.matrices),q=world.clone().applyMatrix4(inverse),coarse=surface.query(q),g=group(v),result=precise||coarse.inside||coarse.distance<.003||g===4?surface.query(q,{nearest:true,radius:g===4?12:2}):coarse;
  if(result.inside&&result.distance>1e-6){insideCount++;penetratingVertices.push(v);const depth=Number.isFinite(result.distance)?result.distance:.004;penetrationSum+=depth*depth;maxPenetration=Math.max(maxPenetration,depth);}
  const contactResult=g===4?opposedThumbSurface.query(q,{nearest:true,radius:16}):g>=0?opposedDigitSurface.query(q,{nearest:true,radius:8}):result;
  if(g>=0&&contactResult.distance<contact[g].distance)contact[g]={distance:contactResult.distance,vertex:v,staffSurfacePoint:contactResult.closestPoint,staffTriangle:contactResult.triangle,worldPoint:world.toArray(),sourceStaffFramePoint:q.toArray()};
 }
 let contactPenalty=0;for(const c of contact)contactPenalty+=(Number.isFinite(c.distance)?c.distance:.1)**2;
 const score=penetrationSum*10000+contactPenalty;
 return {score,parameters:p,sampledHandVertices:ids.length,insideCount,penetratingVertices,maxPenetrationNative:maxPenetration,contacts:contact};
}
let current=measure(vars);const trajectory=[{phase:'initial',...current}];
const steps=[{spatial:.003,angular:.2},{spatial:.001,angular:.1},{spatial:.0003,angular:.04},{spatial:.0001,angular:.01},{spatial:.00003,angular:.003}];
for(let phase=0;phase<steps.length;phase++)for(let cycle=0;cycle<4;cycle++){
 let changed=false;
 for(let v=0;v<vars.length;v++){
  const step=v<2?steps[phase].spatial:steps[phase].angular;let best=current,bestValue=vars[v];
  for(const sign of [-1,1]){const trial=vars.slice();trial[v]=Math.max(bounds[v][0],Math.min(bounds[v][1],trial[v]+sign*step));const m=measure(trial);if(m.score<best.score){best=m;bestValue=trial[v];}}
  if(bestValue!==vars[v]){vars[v]=bestValue;current=best;changed=true;}
 }
 trajectory.push({phase,cycle,...current});if(!changed)break;
}
const full=measure(vars,rig.hand,{precise:true});
await writeFile(new URL('candidate-grip-pose.json',import.meta.url),JSON.stringify({poseSchemaVersion:2,handRigDesign:'hand-rig-design.json',appendedJointMap:rig.jointMap,trajectory,fullHandMeasurement:full,acceptedForExport:false,limitations:['Hand vertices vs genuine source staff triangles only; full triangle intersections and hand self/body tearing must still pass.','No source GLB is exported from optimization. Authored pose is not provider truth or anatomical/production approval.']},null,2)+'\n');
console.log(JSON.stringify({initial:trajectory[0],lastSampled:current,fullHand:full},null,2));
