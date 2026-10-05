import { Vector3,Triangle } from 'three';
// Exact native triangle column queries. Grid only accelerates candidate lookup;
// barycentric intersections and closest points are computed on original triangles.
export function surfaceIndex(positions,triangles,{axis=2,cell=.002}={}){
 const axes=[0,1,2].filter(a=>a!==axis),grid=new Map(),key=(x,y)=>`${x},${y}`;
 for(let t=0;t<triangles.length;t++){const ids=triangles[t],xs=ids.map(v=>positions[3*v+axes[0]]),ys=ids.map(v=>positions[3*v+axes[1]]),minX=Math.floor(Math.min(...xs)/cell),maxX=Math.floor(Math.max(...xs)/cell),minY=Math.floor(Math.min(...ys)/cell),maxY=Math.floor(Math.max(...ys)/cell);for(let x=minX;x<=maxX;x++)for(let y=minY;y<=maxY;y++){const k=key(x,y);if(!grid.has(k))grid.set(k,[]);grid.get(k).push(t);}}
 const tri=new Triangle(),a=new Vector3(),b=new Vector3(),c=new Vector3(),closest=new Vector3();
 function query(point,{nearest=false,radius=2}={}){
  const q=point.toArray(),x=Math.floor(q[axes[0]]/cell),y=Math.floor(q[axes[1]]/cell),hits=[];
  for(const t of grid.get(key(x,y))??[]){const ids=triangles[t],A=ids.map(v=>positions[v*3+axes[0]]),B=ids.map(v=>positions[v*3+axes[1]]),den=(B[1]-B[2])*(A[0]-A[2])+(A[2]-A[1])*(B[0]-B[2]);if(Math.abs(den)<1e-16)continue;const u=((B[1]-B[2])*(q[axes[0]]-A[2])+(A[2]-A[1])*(q[axes[1]]-B[2]))/den,v=((B[2]-B[0])*(q[axes[0]]-A[2])+(A[0]-A[2])*(q[axes[1]]-B[2]))/den,w=1-u-v;if(u>=-1e-9&&v>=-1e-9&&w>=-1e-9)hits.push(u*positions[ids[0]*3+axis]+v*positions[ids[1]*3+axis]+w*positions[ids[2]*3+axis]);}
  hits.sort((a,b)=>a-b);const unique=hits.filter((h,i)=>i===0||Math.abs(h-hits[i-1])>1e-7),inside=unique.filter(h=>h>q[axis]+1e-8).length%2===1;
  let distance=Infinity,closestPoint=null,triangle=null;
  if(nearest){const seen=new Set();for(let dx=-radius;dx<=radius;dx++)for(let dy=-radius;dy<=radius;dy++)for(const t of grid.get(key(x+dx,y+dy))??[]){if(seen.has(t))continue;seen.add(t);const ids=triangles[t];a.fromArray(positions,ids[0]*3);b.fromArray(positions,ids[1]*3);c.fromArray(positions,ids[2]*3);tri.set(a,b,c);tri.closestPointToPoint(point,closest);const d=closest.distanceTo(point);if(d<distance){distance=d;closestPoint=closest.toArray();triangle=ids.slice();}}}
  else if(unique.length)distance=Math.min(...unique.map(h=>Math.abs(h-q[axis])));
  return {inside,distance,closestPoint,triangle,raySurfaceCrossings:unique.length};
 }
 function segmentHits(start,end,{ignoreVertices=[],tolerance=1e-7}={}){
  const A=start.toArray(),B=end.toArray(),min=axes.map(a=>Math.floor(Math.min(A[a],B[a])/cell)),max=axes.map(a=>Math.floor(Math.max(A[a],B[a])/cell)),candidates=new Set(),direction=end.clone().sub(start),result=[];
  for(let x=min[0];x<=max[0];x++)for(let y=min[1];y<=max[1];y++)for(const t of grid.get(key(x,y))??[])candidates.add(t);
  for(const t of candidates){const ids=triangles[t];if(ids.some(v=>ignoreVertices.includes(v)))continue;a.fromArray(positions,ids[0]*3);b.fromArray(positions,ids[1]*3);c.fromArray(positions,ids[2]*3);const e1=b.clone().sub(a),e2=c.clone().sub(a),h=direction.clone().cross(e2),den=e1.dot(h);if(Math.abs(den)<1e-15)continue;const s=start.clone().sub(a),u=s.dot(h)/den;if(u<=tolerance||u>=1-tolerance)continue;const q=s.clone().cross(e1),v=direction.dot(q)/den;if(v<=tolerance||u+v>=1-tolerance)continue;const alpha=e2.dot(q)/den;if(alpha>tolerance&&alpha<1-tolerance)result.push({triangle:ids.slice(),alpha,intersection:start.clone().addScaledVector(direction,alpha).toArray()});}
  return result;
 }
 return {query,segmentHits,triangleCount:triangles.length,cell,axis};
}
