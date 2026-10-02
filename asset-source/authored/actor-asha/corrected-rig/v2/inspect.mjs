import { Vector3 } from 'three';
import { source, sourceSHA, sourceRevision, load, bounds, contacts, save } from './runtime.mjs';
const input=await source(),r=await load(input.bytes),paws=contacts(r);
const soleCount=paws.reduce((sum,p)=>sum+p.sole.length,0);
if(soleCount!==49814||paws.map(p=>p.sole.length).join(',')!=='13960,14241,10826,10787')throw Error('Unexpected complete source footprint');
const fore=paws[0];
if(fore.influenceJoints.some(j=>j!==23))throw Error('Full corrected fore sole is not genuinely wrist-owned');
const report={
  sourceSHA256:sourceSHA,sourceRevision,nativeSourceBytes:input.bytes.length,
  nativeJoints:24,vertices:r.mesh.geometry.attributes.position.count,triangles:r.mesh.geometry.index.count/3,
  restAllVertexBounds:bounds(r),gltfNodes:input.doc.nodes,skin:input.doc.skins[0],
  joints:r.bones.map((b,i)=>({
    skinJoint:i,node:input.doc.skins[0].joints[i],originalName:input.doc.nodes[input.doc.skins[0].joints[i]].name,
    loaderName:b.name,parent:b.parent.name,world:b.getWorldPosition(new Vector3()).toArray(),
    localTranslation:b.position.toArray(),localRotation:b.quaternion.toArray(),localScale:b.scale.toArray(),
    inverseBindMatrix:r.mesh.skeleton.boneInverses[i].toArray(),
  })),
  completeNearFloorCoverage:{vertices:soleCount,unclassified:0,overlapping:0},
  pawRegions:paws.map(c=>({id:c.id,soleCount:c.sole.length,influenceJoints:c.influenceJoints,soleMinY:Math.min(...c.sole.map(s=>s.rest[1])),soleMaxY:Math.max(...c.sole.map(s=>s.rest[1]))})),
  parentProcessingSourceConfirmed:true,renderAcceptance:null,releaseVerified:false,
};
await save('anatomy.json',report);
await save('contacts.json',{
  sourceSHA256:sourceSHA,sourceRevision,units:'native units; meter scale unverified',
  surfaceDefinition:'Every actual source-skinned surface vertex Y<.015, exactly one of the four recorded spatial regions. No narrowed markers, prior captures or bone endpoint proxies.',
  spatialRegions:{frontNegativeX:'X<.015,Z>.18',frontPositiveX:'X>=.015,Z>.18',rearNegativeX:'X<-.10,Z<0',rearPositiveX:'-.025<X<.11,Z<-.12'},
  completeNearFloorVertices:soleCount,unclassified:0,overlapping:0,paws,
});
console.log(JSON.stringify({sourceSHA256:sourceSHA,bounds:report.restAllVertexBounds,newJoints:report.joints.slice(21),paws:report.pawRegions,completeNearFloorVertices:soleCount},null,2));
