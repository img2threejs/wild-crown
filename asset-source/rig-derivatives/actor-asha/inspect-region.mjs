import { source, loadNative, vertex } from '../../authored/actor-asha/native-runtime.mjs';
import { Vector3 } from 'three';
const input = await source(), r = await loadNative(input.bytes), p = new Vector3();
const bins = Array.from({ length: 17 }, () => ({ n: 0, sum: [0,0,0], min: [Infinity,Infinity,Infinity], max: [-Infinity,-Infinity,-Infinity], zs: [] }));
for (let i=0; i<r.mesh.geometry.attributes.position.count; i++) {
  vertex(r,i,p);
  if (p.x < -.24 || p.x > -.07 || p.y < 0 || p.y >= .34 || p.z < .18 || p.z > .49) continue;
  const b=bins[Math.floor(p.y/.02)], a=p.toArray(); b.n++;
  for(let k=0;k<3;k++){b.sum[k]+=a[k];b.min[k]=Math.min(b.min[k],a[k]);b.max[k]=Math.max(b.max[k],a[k]);} b.zs.push(p.z);
}
console.log(JSON.stringify(bins.map((b,i)=>({y:[i*.02,(i+1)*.02],n:b.n,centroid:b.sum.map(v=>v/b.n),min:b.min,max:b.max,zQuantiles:b.zs.sort((a,b)=>a-b).filter((_,j,a)=>[0,Math.floor(a.length*.1),Math.floor(a.length*.5),Math.floor(a.length*.9),a.length-1].includes(j))})),null,2));
