import { writeFile, readFile } from 'node:fs/promises';
import { Vector3, Box3 } from 'three';
import { source, loadNative, vertex, packet, sha } from './native-runtime.mjs';
const input=await source(),r=await loadNative(input.bytes);
const regions=[
  {id:'missing-foreleg-lower',bounds:{x:[-.24,-.07],y:[0,.20],z:[.18,.49]}},
  {id:'missing-foreleg-upper-candidate',bounds:{x:[-.24,-.07],y:[.20,.34],z:[.16,.49]}},
];
const reports=[];
for(const region of regions){
  const indices=[],box=new Box3(),mass=Array(r.bones.length).fill(0),p=new Vector3();
  for(let i=0;i<r.mesh.geometry.attributes.position.count;i++){
    vertex(r,i,p);
    if(!['x','y','z'].every(axis=>p[axis]>=region.bounds[axis][0]&&p[axis]<region.bounds[axis][1]))continue;
    indices.push(i);box.expandByPoint(p);
    for(let k=0;k<4;k++)mass[r.mesh.geometry.attributes.skinIndex.getComponent(i,k)]+=r.mesh.geometry.attributes.skinWeight.getComponent(i,k);
  }
  const data=Buffer.alloc(indices.length*4);indices.forEach((i,k)=>data.writeUInt32LE(i,k*4));
  const filename=region.id+'.uint32le';await writeFile(new URL(filename,import.meta.url),data);
  reports.push({id:region.id,selectionNativeWorldBounds:region.bounds,vertexIndexFile:filename,encoding:'Uint32 little-endian, native primitive POSITION accessor vertex index, not triangle indices',sha256:sha(data),vertexCount:indices.length,actualBounds:{min:box.min.toArray(),max:box.max.toArray()},influences:mass.map((m,j)=>({skinJoint:j,gltfNode:input.doc.skins[0].joints[j],originalName:input.doc.nodes[input.doc.skins[0].joints[j]].name,influenceMass:m,meanWeight:m/indices.length})).filter(j=>j.influenceMass>0).sort((a,b)=>b.influenceMass-a.influenceMass)});
}
const markers=JSON.parse(await readFile(new URL('contact-markers.json',import.meta.url))).contacts.find(c=>c.id==='front-negative-X');
await packet('custom-rig-handoff.json',{status:'BLOCKED_MISSING_INDEPENDENT_FORELEG',sourceSHA256:sha(input.bytes),sourcePositionAccessor:input.doc.meshes[0].primitives[0].attributes.POSITION,coordinates:'+Y up, head-side +Z; X side is geometric, animal left/right unverified',regions:reports,exactSoleMarkers:markers,sourceJointChainLimitation:{frontTorsoNodes:[12,11,10],frontTorsoSkinJoints:[5,6,7],headNodes:[5,4,3],segmentedPositiveXFrontNodes:[9,8,7,6],segmentedNegativeXRearNodes:[16,15,14,13],segmentedPositiveXRearNodes:[18,17],tailNodes:[2,1,0]},selectionWarning:'Regions are exact reproducible spatial candidate selections, NOT reviewed anatomical segmentation or ready-to-apply skin weights. Upper candidate includes neck/chest overlap; custom rig owner must inspect surface/topology and author genuine fourth limb chain and skin. No random bone aliases or substituted geometry.',reusableMeasurements:['anatomy-inspection.json: every original node/rest transform + native joint order + weighted region bounds','contact-markers.json: four actual sole sets and original JOINTS_0/WEIGHTS_0 coefficients','canary-packet.json: original-rig finite playback, contact-slip failure and native-root stripping negative control'],originalSourcePreserved:true,rigCorrected:false,releaseVerified:false});
console.log(JSON.stringify(reports.map(r=>({id:r.id,vertices:r.vertexCount,bounds:r.actualBounds,dominantInfluences:r.influences.slice(0,5)})),null,2));
