import { readFile,writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { Vector3 } from 'three';
import { buildHandRig,poseMatrices,point,staffAlignment } from './hand-rig.mjs';
const rig=await buildHandRig(),candidate=JSON.parse(await readFile(new URL('candidate-grip-pose.json',import.meta.url))),p=candidate.fullHandMeasurement.parameters,posed=poseMatrices(rig,p.pose),neutral=poseMatrices(rig,{}),alignment=posed.world[rig.palm].clone().multiply(neutral.world[rig.palm].clone().invert()).multiply(staffAlignment(rig,p.centerY,p.centerZ));
const positions=new Float64Array(rig.positions),center=new Vector3(-.035,.44,.11);
for(const v of new Set(rig.bodyTriangles.flat()))point(rig,v,posed.matrices).toArray(positions,v*3);for(const v of rig.staff)new Vector3().fromArray(rig.positions,v*3).applyMatrix4(alignment).toArray(positions,v*3);
const width=1600,height=700,data=Buffer.alloc(width*height*4,255),depth=new Float64Array(width*height).fill(-Infinity),scale=5500;
const views=[{name:'Positive native z',x:new Vector3(1,0,0),y:new Vector3(0,1,0),z:new Vector3(0,0,1)},{name:'Negative native z',x:new Vector3(-1,0,0),y:new Vector3(0,1,0),z:new Vector3(0,0,-1)},{name:'Positive native x',x:new Vector3(0,0,-1),y:new Vector3(0,1,0),z:new Vector3(1,0,0)}];
for(let n=0;n<views.length;n++)for(const [triangles,isStaff] of [[rig.bodyTriangles,false],[rig.staffTriangles,true]])for(const tri of triangles){
 const view=views[n],points=tri.map(v=>new Vector3().fromArray(positions,v*3)),q=points.map(p=>{const local=p.clone().sub(center);return [n*530+265+local.dot(view.x)*scale,350-local.dot(view.y)*scale,local.dot(view.z)];});const [a,b,c]=q,area=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);if(Math.abs(area)<1e-12)continue;
 const normal=points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize(),shade=Math.floor(60+175*Math.abs(normal.dot(view.z)));
 const minX=Math.max(n*530,Math.floor(Math.min(a[0],b[0],c[0]))),maxX=Math.min(n*530+529,Math.ceil(Math.max(a[0],b[0],c[0]))),minY=Math.max(0,Math.floor(Math.min(a[1],b[1],c[1]))),maxY=Math.min(height-1,Math.ceil(Math.max(a[1],b[1],c[1])));
 for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){const u=((b[0]-x)*(c[1]-y)-(b[1]-y)*(c[0]-x))/area,v=((c[0]-x)*(a[1]-y)-(c[1]-y)*(a[0]-x))/area,w=1-u-v;if(u<0||v<0||w<0)continue;const z=u*a[2]+v*b[2]+w*c[2],pixel=y*width+x;if(z<=depth[pixel])continue;depth[pixel]=z;data[pixel*4]=isStaff?Math.min(255,shade+35):shade;data[pixel*4+1]=isStaff?Math.floor(shade*.65):shade;data[pixel*4+2]=isStaff?Math.floor(shade*.35):shade;}
}
await sharp(data,{raw:{width,height,channels:4}}).png().toFile(new URL('candidate-hand-staff-cpu.png',import.meta.url).pathname);
await writeFile(new URL('candidate-hand-staff-cpu.json',import.meta.url),JSON.stringify({instrument:'Untextured CPU native triangle/z-buffer views, grey originalhand and brown source-derivedstaff. Not GPU acceptance.',candidateParameters:p,contactExportAccepted:false,productionAccepted:false},null,2)+'\n');console.log(JSON.stringify({output:'candidate-hand-staff-cpu.png',candidateParameters:p,productionAccepted:false}));
