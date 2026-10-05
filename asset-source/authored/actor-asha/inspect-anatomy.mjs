import { Vector3, Box3 } from 'three';
import { source, loadNative, vertex, bounds, packet } from './native-runtime.mjs';
const input = await source(), r = await loadNative(input.bytes);
const position = r.mesh.geometry.attributes.position, joints = r.mesh.geometry.attributes.skinIndex, weights = r.mesh.geometry.attributes.skinWeight;
const stats = r.bones.map(() => ({ mass: 0, centroid: new Vector3(), box: new Box3(), dominantVertices: 0 }));
const p = new Vector3();
for (let i = 0; i < position.count; i++) {
  vertex(r, i, p);
  let strongest = -1, maximum = -1;
  for (let c = 0; c < 4; c++) {
    const j = joints.getComponent(i, c), w = weights.getComponent(i, c);
    stats[j].mass += w; stats[j].centroid.addScaledVector(p, w);
    if (w > maximum) { maximum = w; strongest = j; }
  }
  if (maximum >= .5) { stats[strongest].box.expandByPoint(p); stats[strongest].dominantVertices++; }
}
const report = {
  sourceSHA256: input.bytes.length && (await import('./native-runtime.mjs')).sha(input.bytes),
  vertices: position.count, triangles: r.mesh.geometry.index.count / 3, deformedRestBounds: bounds(r),
  nodes: input.doc.nodes.map((n, index) => ({ index, ...n })),
  skinJointOrder: input.doc.skins[0].joints,
  joints: r.bones.map((b, j) => ({ joint: j, node: input.doc.skins[0].joints[j], name: b.name, parent: b.parent.name, world: b.getWorldPosition(new Vector3()).toArray(), localTranslation: b.position.toArray(), localRotation: b.quaternion.toArray(), localScale: b.scale.toArray(), weightedCentroid: stats[j].centroid.divideScalar(stats[j].mass).toArray(), influenceMass: stats[j].mass, dominantVertices: stats[j].dominantVertices, dominantBounds: { min: stats[j].box.min.toArray(), max: stats[j].box.max.toArray() } })),
  renderMeasured: false, texturesDecoded: false, releaseVerified: false,
};
await packet('anatomy-inspection.json', report);
console.log(JSON.stringify({ bounds: report.deformedRestBounds, vertices: report.vertices, triangles: report.triangles, joints: report.joints.map(j => ({ joint:j.joint,node:j.node,name:j.name,parent:j.parent,world:j.world,centroid:j.weightedCentroid,bounds:j.dominantBounds })) }, null, 2));
