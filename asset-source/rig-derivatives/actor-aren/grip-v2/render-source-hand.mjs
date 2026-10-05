import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { Vector3 } from 'three';
import { inspectGrip } from './inspect-grip.mjs';
const {positions,bodyTriangles}=await inspectGrip();
const width=1600,height=600,data=Buffer.alloc(width*height*4,255),depth=new Float64Array(width*height).fill(-Infinity),scale=6000;
const views=[{name:'Native positive-z side',x:new Vector3(1,0,0),y:new Vector3(0,1,0),z:new Vector3(0,0,1)},{name:'Native negative-z side',x:new Vector3(-1,0,0),y:new Vector3(0,1,0),z:new Vector3(0,0,-1)},{name:'Native positive-x side',x:new Vector3(0,0,-1),y:new Vector3(0,1,0),z:new Vector3(1,0,0)}];
const center=new Vector3(-.056,.435,.129),light=new Vector3(.3,.5,1).normalize();
for(let n=0;n<views.length;n++)for(const tri of bodyTriangles){
 const view=views[n],points=tri.map(v=>new Vector3().fromArray(positions,v*3)),projected=points.map(p=>{const local=p.clone().sub(center);return [n*530+265+local.dot(view.x)*scale,300-local.dot(view.y)*scale,local.dot(view.z)];});
 const [a,b,c]=projected,area=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);if(Math.abs(area)<1e-12)continue;
 const normal=points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize(),shade=Math.floor(70+170*Math.abs(normal.dot(view.z.clone().add(light).normalize())));
 const minX=Math.max(n*530,Math.floor(Math.min(a[0],b[0],c[0]))),maxX=Math.min(n*530+529,Math.ceil(Math.max(a[0],b[0],c[0]))),minY=Math.max(0,Math.floor(Math.min(a[1],b[1],c[1]))),maxY=Math.min(height-1,Math.ceil(Math.max(a[1],b[1],c[1])));
 for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
  const u=((b[0]-x)*(c[1]-y)-(b[1]-y)*(c[0]-x))/area,v=((c[0]-x)*(a[1]-y)-(c[1]-y)*(a[0]-x))/area,w=1-u-v;if(u<0||v<0||w<0)continue;
  const z=u*a[2]+v*b[2]+w*c[2],pixel=y*width+x;if(z<=depth[pixel])continue;depth[pixel]=z;data[pixel*4]=shade;data[pixel*4+1]=shade;data[pixel*4+2]=shade;
 }
}
await sharp(data,{raw:{width,height,channels:4}}).png().toFile(new URL('source-hand-cpu-inspection.png',import.meta.url).pathname);
await writeFile(new URL('source-hand-cpu-inspection.json',import.meta.url),JSON.stringify({kind:'Orthographic CPU triangle/z-buffer geometry instrument; untextured, no GPU/production anatomy acceptance',views:views.map(v=>v.name),scalePixelsPerNativeUnit:scale,originalHandGeometryOnly:true,productionAccepted:false,externalSharpPrerequisite:'Existing sharp0.34.5; not npm-ci declared dependency'},null,2)+'\n');
console.log(JSON.stringify({output:'source-hand-cpu-inspection.png',views:views.map(v=>v.name),triangles:bodyTriangles.length,productionAccepted:false}));
