import { Matrix3,Vector3 } from 'three';
import { accessor } from '../inspect-region.mjs';
import { pack } from '../author-rig.mjs';
import { load } from '../../../authored/actor-aren/inspect-anatomy.mjs';
import { staffAlignment } from './hand-rig.mjs';
// Construct bytes in memory only. Source freezing is a separate guarded operation.
export function rigBytes(rig,{staffParameters=null}={}){
 const doc=structuredClone(rig.document),bin=Buffer.from(rig.bin),primitive=doc.meshes[0].primitives[0];
 if(staffParameters){const alignment=staffAlignment(rig,staffParameters.centerY,staffParameters.centerZ),normalMatrix=new Matrix3().getNormalMatrix(alignment),position=accessor(doc,bin,primitive.attributes.POSITION),normal=accessor(doc,bin,primitive.attributes.NORMAL),joints=accessor(doc,bin,primitive.attributes.JOINTS_0),weights=accessor(doc,bin,primitive.attributes.WEIGHTS_0);
  for(const v of rig.staff){new Vector3().fromArray(position,v*3).applyMatrix4(alignment).toArray(position,v*3);new Vector3().fromArray(normal,v*3).applyMatrix3(normalMatrix).normalize().toArray(normal,v*3);for(let s=0;s<4;s++){joints[v*4+s]=s===0?rig.palmSkin:0;weights[v*4+s]=s===0?1:0;}}
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let v=0;v<position.length/3;v++)for(let a=0;a<3;a++){min[a]=Math.min(min[a],position[v*3+a]);max[a]=Math.max(max[a],position[v*3+a]);}doc.accessors[primitive.attributes.POSITION].min=min;doc.accessors[primitive.attributes.POSITION].max=max;
 }
 const inverseBytes=Buffer.from(rig.inverseBind.buffer,rig.inverseBind.byteOffset,rig.inverseBind.byteLength),view=doc.bufferViews.length;doc.bufferViews.push({buffer:0,byteOffset:bin.length,byteLength:inverseBytes.length});const index=doc.accessors.length;doc.accessors.push({bufferView:view,byteOffset:0,componentType:5126,count:rig.inverseBind.length/16,type:'MAT4'});doc.skins[0].inverseBindMatrices=index;doc.buffers[0].byteLength=bin.length+inverseBytes.length;
 return pack(doc,Buffer.concat([bin,inverseBytes]));
}
export async function nativeRig(rig,options){const bytes=rigBytes(rig,options),gltf=await load(bytes);let mesh;gltf.scene.traverse(n=>{if(n.isSkinnedMesh)mesh=n;});if(!mesh)throw new Error('Native loader did not produce actual anatomical SkinnedMesh');return {bytes,gltf,mesh};}
export function applyGripPose(rig,native,pose){const {mesh,gltf}=native,joints=rig.document.skins[0].joints,bone=node=>mesh.skeleton.bones[joints.indexOf(node)];for(const bind of rig.bindPose)bone(bind.node).quaternion.fromArray(bind.rotation);
 const rotate=(node,axis,angle)=>{const half=angle/2,s=Math.sin(half);bone(node).quaternion.multiply(bone(node).quaternion.clone().set(axis[0]*s,axis[1]*s,axis[2]*s,Math.cos(half)));};
 rotate(rig.wrist,[0,0,1],pose.wrist??0);rotate(rig.palm,[0,0,1],pose.palm??0);rig.digits.forEach((d,i)=>{rotate(d.rootNode,[0,0,1],pose.abduction?.[i]??0);rotate(d.rootNode,[1,0,0],pose.proximal?.[i]??0);rotate(d.midNode,[1,0,0],pose.intermediate?.[i]??0);rotate(d.tipNode,[1,0,0],pose.distal?.[i]??0);});rotate(rig.thumbRoot,[0,0,1],pose.thumbSweep??0);rotate(rig.thumbRoot,[0,1,0],pose.thumbOpposition??0);rotate(rig.thumbRoot,[1,0,0],pose.thumbFlexion??0);rotate(rig.thumbMid,[1,0,0],pose.thumbDistal??0);gltf.scene.updateMatrixWorld(true);mesh.skeleton.update();
}
