/**
 * Pose-harmony metrics, measured identically on the reference game's recorded skeleton (REA capture of the Walden Three.js build) and on our
 * heroes. Frames are `{ t, bones: { Name: [right, up, forward] } }` in the actor's body frame (metres). The numbers describe how a strike is
 * staged: coil of the shoulders against the hips before the swing (`sepTravel`), forward lean at contact, how suddenly the hand accelerates
 * (`riseFrames`) and stops (`stopFrames`), and the peak-to-windup speed ratio that makes the strike read as a strike.
 */
export const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
export const len=(a)=>Math.hypot(a[0],a[1],a[2]);
export const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const deg=180/Math.PI;
/** frames: [{t, bones:{Name:[r,u,f]}, tip?}] already in the body-local frame (x right, y up, z forward of the actor facing). */
export function analyse(frames, {end='RightHand', fps=60}={}) {
  const dt=1/fps, n=frames.length, sp=[];
  for(let i=0;i<n;i++){const a=frames[Math.max(0,i-1)].bones[end],b=frames[Math.min(n-1,i+1)].bones[end];sp.push(len(sub(b,a))/((Math.min(n-1,i+1)-Math.max(0,i-1))*dt));}
  let peak=0,pi=0;sp.forEach((s,i)=>{if(s>peak){peak=s;pi=i;}});
  const before=sp.slice(0,pi), windupMean=before.length?before.reduce((a,b)=>a+b,0)/before.length:0;
  // frames from the peak until speed falls below 15% of the peak (how crisply the swing stops)
  let stop=0;for(let i=pi;i<n&&sp[i]>0.15*peak;i++)stop++;
  // frames before the peak above 25% of the peak (how sudden the whip is)
  let rise=0;for(let i=pi;i>=0&&sp[i]>0.25*peak;i--)rise++;
  const yaw=(l,r,i)=>{const a=frames[i].bones[l],b=frames[i].bones[r];return Math.atan2(b[0]-a[0],-(b[2]-a[2]))*deg;}; // 0 = line across the body facing forward (right minus left along +x)
  const sep=[];for(let i=0;i<n;i++)sep.push(yaw('LeftShoulder','RightShoulder',i)-yaw('LeftUpLeg','RightUpLeg',i));
  // Coil = how far the shoulder line sits from where it is at contact, at its worst before contact (magnitude), and which way (sign of sep(windup) - sep(contact)).
  let coilExt=0;for(let i=0;i<=pi;i++)if(Math.abs(sep[i]-sep[pi])>Math.abs(coilExt))coilExt=sep[i]-sep[pi];
  const sepTravel=Math.abs(coilExt),sepSign=coilExt===0?0:Math.sign(coilExt),sepAt=sep[pi];
  const lean=(i)=>{const h=frames[i].bones.Hips,nk=frames[i].bones.Neck;return Math.atan2(nk[2]-h[2],nk[1]-h[1])*deg;}; // + = leaning forward
  const hips0=frames[0].bones.Hips,hipsPk=frames[pi].bones.Hips;
  const elbow=(i,side)=>{const s=frames[i].bones[side+'Arm'],e=frames[i].bones[side+'ForeArm'],h=frames[i].bones[side+'Hand'];const a=sub(s,e),b=sub(h,e);return Math.acos(Math.max(-1,Math.min(1,dot(a,b)/(len(a)*len(b)))))*deg;};
  const footFwd=Math.max(frames[pi].bones.LeftFoot[2],frames[pi].bones.RightFoot[2])-Math.min(frames[pi].bones.LeftFoot[2],frames[pi].bones.RightFoot[2]);
  const reach=len(sub(frames[pi].bones[end],frames[pi].bones.Spine2));
  return {frames:n,peakFrame:pi,peakSpeed:+peak.toFixed(2),windupMeanSpeed:+windupMean.toFixed(2),peakToWindup:+(peak/Math.max(windupMean,1e-6)).toFixed(1),riseFrames:rise,stopFrames:stop,
    sepAtPeak:+sepAt.toFixed(1),sepTravel:+sepTravel.toFixed(1),sepSign,
    leanAtStart:+lean(0).toFixed(1),leanAtPeak:+lean(pi).toFixed(1),hipsLungeForward:+(hipsPk[2]-hips0[2]).toFixed(3),hipsLateral:+(hipsPk[0]-hips0[0]).toFixed(3),
    elbowAtPeak:+elbow(pi,end.startsWith('Right')?'Right':'Left').toFixed(0),stanceLengthAtPeak:+footFwd.toFixed(3),handReachFromChest:+reach.toFixed(3)};
}
export function localise(frame){ // Walden world -> local (right, up, forward)
  const s=Math.sin(frame.yaw),c=Math.cos(frame.yaw),o=frame.pos;const out={};
  const L=(p)=>{const d=[p[0]-o[0],p[1]-o[1],p[2]-o[2]];return [d[0]*(-c)+d[2]*s,d[1],d[0]*s+d[2]*c];};
  for(const[k,v] of Object.entries(frame.bones))out[k]=L(v);
  return {t:frame.t,bones:out,tip:frame.tip?L(frame.tip):undefined,state:frame.state,id:frame.id,phase:frame.phase};
}
