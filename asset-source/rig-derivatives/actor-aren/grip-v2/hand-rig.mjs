import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Vector3,Quaternion,Matrix4 } from 'three';
import { inspectGrip } from './inspect-grip.mjs';
import { accessor,worlds } from '../inspect-region.mjs';
export const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*(3-2*x);};
export async function buildHandRig(){
 const anatomy=await inspectGrip(),design=JSON.parse(await readFile(new URL('hand-rig-design.json',import.meta.url))),doc=structuredClone(anatomy.document),bin=Buffer.from(anatomy.bin),originalWorld=worlds(doc),jointMap=[];
 function add(name,parent,position){const node=doc.nodes.length,parentWorld=worlds(doc)[parent],local=parentWorld.clone().invert().multiply(new Matrix4().makeTranslation(...position)),p=new Vector3(),q=new Quaternion(),s=new Vector3();local.decompose(p,q,s);doc.nodes.push({name,translation:p.toArray(),rotation:q.toArray(),scale:s.toArray()});doc.nodes[parent].children??=[];doc.nodes[parent].children.push(node);const skinIndex=doc.skins[0].joints.length;doc.skins[0].joints.push(node);jointMap.push({name,node,skinIndex,parent,neutralWorldPosition:position,neutralLocalRotation:q.toArray()});return node;}
 const wrist=add('aren_authored_wrist',5,design.authoredJoints.wrist.world),palm=add('aren_authored_palm',wrist,design.authoredJoints.palm.world);
 const digits=design.authoredJoints.digits.map((digit,i)=>{const root=add(`aren_authored_digit_${i+1}_proximal`,palm,digit.root.world),mid=add(`aren_authored_digit_${i+1}_intermediate`,root,digit.mid.world),tip=add(`aren_authored_digit_${i+1}_distal`,mid,digit.tip.world);return {...digit,rootNode:root,midNode:mid,tipNode:tip,rootSkin:doc.skins[0].joints.indexOf(root),midSkin:doc.skins[0].joints.indexOf(mid),tipSkin:doc.skins[0].joints.indexOf(tip)};});
 const thumbRoot=add('aren_authored_thumb_opposition',palm,design.authoredJoints.thumb.root),thumbMid=add('aren_authored_thumb_distal',thumbRoot,design.authoredJoints.thumb.mid);
 const world=worlds(doc),originalIBM=accessor(anatomy.document,anatomy.bin,anatomy.document.skins[0].inverseBindMatrices),inverseBind=new Float32Array(doc.skins[0].joints.length*16);inverseBind.set(originalIBM);
 for(let i=18;i<doc.skins[0].joints.length;i++)world[doc.skins[0].joints[i]].clone().invert().toArray(inverseBind,i*16);
 const primitive=doc.meshes[0].primitives[0],joints=accessor(doc,bin,primitive.attributes.JOINTS_0),weights=accessor(doc,bin,primitive.attributes.WEIGHTS_0),handSet=new Set(anatomy.hand),wristSkin=doc.skins[0].joints.indexOf(wrist),palmSkin=doc.skins[0].joints.indexOf(palm),thumbRootSkin=doc.skins[0].joints.indexOf(thumbRoot),thumbMidSkin=doc.skins[0].joints.indexOf(thumbMid);
 // Native topology/CPU morphology identifies real digit columns; interpolate
 // continuously through their actual measured root positions, not whole-arm labels.
 const tupleMap=new Map(),regionCounts={wristTransition:0,palm:0,digits:[0,0,0,0],thumb:0};
 for(const v of anatomy.hand){const [x,y,z]=new Vector3().fromArray(anatomy.positions,v*3).toArray(),seamKey=`${x},${y},${z}`;let tuple=tupleMap.get(seamKey);
  if(!tuple){const influences=new Map(),add=(index,weight)=>{if(weight>1e-10)influences.set(index,(influences.get(index)??0)+weight);};
   const wristBlend=smooth((.475-y)/.015),palmBlend=smooth((.465-y)/.015),distalShare=wristBlend*palmBlend;
   add(8,1-wristBlend);add(wristSkin,wristBlend*(1-palmBlend));
   const thumbBlend=smooth((x+.042)/.008)*smooth((.129-z)/.006)*smooth((y-.418)/.009)*smooth((.463-y)/.010);
   const thumbCurl=smooth((.452-y)/.015),thumbDistal=smooth((.442-y)/.012);add(palmSkin,distalShare*thumbBlend*(1-thumbCurl));add(thumbRootSkin,distalShare*thumbBlend*thumbCurl*(1-thumbDistal));add(thumbMidSkin,distalShare*thumbBlend*thumbCurl*thumbDistal);
   if(thumbBlend>.5)regionCounts.thumb++;
   const digitScores=[0,0,0,0];if(x<=digits[0].root.world[0])digitScores[0]=1;else if(x>=digits[3].root.world[0])digitScores[3]=1;else for(let i=0;i<3;i++)if(x>=digits[i].root.world[0]&&x<digits[i+1].root.world[0]){const blend=smooth((x-digits[i].root.world[0])/(digits[i+1].root.world[0]-digits[i].root.world[0]));digitScores[i]=1-blend;digitScores[i+1]=blend;}
   for(let i=0;i<digits.length;i++){const d=digits[i],share=distalShare*digitScores[i]*(1-thumbBlend),rootBlend=smooth((d.rootY+.005-y)/.012),midBlend=smooth((d.midY+.003-y)/.007),tipBlend=smooth((d.tipY+.003-y)/.006);add(palmSkin,share*(1-rootBlend));add(d.rootSkin,share*rootBlend*(1-midBlend));add(d.midSkin,share*rootBlend*midBlend*(1-tipBlend));add(d.tipSkin,share*rootBlend*midBlend*tipBlend);if(share>.5&&rootBlend>.5)regionCounts.digits[i]++;}
   if(wristBlend<1)regionCounts.wristTransition++;else regionCounts.palm++;
   const sorted=[...influences].sort((a,b)=>b[1]-a[1]).slice(0,4),total=sorted.reduce((sum,row)=>sum+row[1],0);tuple=Array.from({length:4},(_,s)=>sorted[s]?[sorted[s][0],sorted[s][1]/total]:[0,0]);tupleMap.set(seamKey,tuple);
  }
  tuple.forEach(([j,w],slot)=>{joints[v*4+slot]=j;weights[v*4+slot]=w;});
 }
 // New controls may only influence actual terminal hand and detached staff.
 const staffSet=new Set(anatomy.staff),sourceJoints=accessor(anatomy.document,anatomy.bin,primitive.attributes.JOINTS_0),sourceWeights=accessor(anatomy.document,anatomy.bin,primitive.attributes.WEIGHTS_0);
 for(let v=0;v<anatomy.positions.length/3;v++)if(!handSet.has(v)&&!staffSet.has(v)){for(let s=0;s<4;s++){assert.equal(joints[v*4+s],sourceJoints[v*4+s]);assert.equal(weights[v*4+s],sourceWeights[v*4+s]);}}
 const bindPose=jointMap.map(j=>({node:j.node,rotation:doc.nodes[j.node].rotation.slice()}));
 return {...anatomy,design,document:doc,bin,joints,weights,inverseBind,jointMap,wrist,palm,wristSkin,palmSkin,digits,thumbRoot,thumbMid,thumbRootSkin,thumbMidSkin,bindPose,regionCounts};
}
export function poseMatrices(rig,pose){
 const doc=structuredClone(rig.document);for(const bind of rig.bindPose)doc.nodes[bind.node].rotation=bind.rotation.slice();
 function rotate(node,axis,angle){const base=new Quaternion(...doc.nodes[node].rotation),q=new Quaternion().setFromAxisAngle(new Vector3(...axis),angle);doc.nodes[node].rotation=base.multiply(q).toArray();}
 rotate(rig.wrist,[0,0,1],pose.wrist??0);rotate(rig.palm,[0,0,1],pose.palm??0);
 rig.digits.forEach((d,i)=>{rotate(d.rootNode,[0,0,1],pose.abduction?.[i]??0);rotate(d.rootNode,[1,0,0],pose.proximal?.[i]??0);rotate(d.midNode,[1,0,0],pose.intermediate?.[i]??0);rotate(d.tipNode,[1,0,0],pose.distal?.[i]??0);});
 rotate(rig.thumbRoot,[0,0,1],pose.thumbSweep??0);rotate(rig.thumbRoot,[0,1,0],pose.thumbOpposition??0);rotate(rig.thumbRoot,[1,0,0],pose.thumbFlexion??0);rotate(rig.thumbMid,[1,0,0],pose.thumbDistal??0);
 const world=worlds(doc),matrices=doc.skins[0].joints.map((node,i)=>world[node].clone().multiply(new Matrix4().fromArray(rig.inverseBind,i*16)));return {document:doc,world,matrices};
}
export function point(rig,vertex,matrices,out=new Vector3()) {out.set(0,0,0);const p=new Vector3().fromArray(rig.positions,vertex*3);for(let s=0;s<4;s++)if(rig.weights[vertex*4+s])out.addScaledVector(p.clone().applyMatrix4(matrices[rig.joints[vertex*4+s]]),rig.weights[vertex*4+s]);return out;}
export function staffAlignment(rig,centerY,centerZ){const sourceHandle=new Vector3(-.0415,.435,.1993),target=new Vector3(-.05613913302928671,centerY,centerZ);return new Matrix4().makeTranslation(...target.toArray()).multiply(new Matrix4().makeRotationZ(-Math.PI/2)).multiply(new Matrix4().makeTranslation(...sourceHandle.clone().negate().toArray()));}
