import { writeFile } from 'node:fs/promises';
import { Vector3 } from 'three';
import { buildHandRig } from './hand-rig.mjs';
import { surfaceIndex } from './surface-index.mjs';
const rig=await buildHandRig(),index=surfaceIndex(rig.positions,rig.bodyTriangles),report={sourceSha256:rig.report.sourceSha256,measuredActualHandVertices:rig.hand.length,originalNode5Role:'Upstream forearm/hand influence; not wrist',pivots:rig.jointMap.map(j=>({...j,nativeSurfaceQuery:index.query(new Vector3(...j.neutralWorldPosition),{nearest:true,radius:4})})),productionAccepted:false};
report.allAuthoredPivotsInsideNativeHand=report.pivots.every(p=>p.nativeSurfaceQuery.inside);
await writeFile(new URL('pivot-anatomy-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({allAuthoredPivotsInsideNativeHand:report.allAuthoredPivotsInsideNativeHand,pivots:report.pivots.map(p=>({name:p.name,inside:p.nativeSurfaceQuery.inside,distanceToActualSurfaceNative:p.nativeSurfaceQuery.distance,world:p.neutralWorldPosition}))},null,2));
