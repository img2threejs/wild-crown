import { describe, expect, it } from 'bun:test';
import { Matrix4, Object3D, Scene, Vector3 } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import type { WorldClockSnapshot } from '../../src/game/contracts.js';

const clock=(worldTick:number):WorldClockSnapshot=>({simulationTick:worldTick,worldTick,worldTimeSeconds:worldTick/60,timeScale:1,policy:'normal'});
function stage(){
  const root=new Object3D();let present=true;
  const effects=new StoryEffects({scene:new Scene(),resolveActorRoot:id=>id==='foe'&&present?root:undefined});
  return {root,effects,remove:()=>{present=false;}};
}
function cue(tick:number,patch:Partial<StoryCue>={}):StoryCue{
  return {instanceId:`contact:${tick}`,tick,worldTick:tick,worldTimeSeconds:tick/60,kind:'projectile-impact',phase:'hit',actorId:'aren',position:{x:1,y:1,z:0},to:{x:2,y:1,z:0},element:'umbral',contact:{kind:'solid',normal:{x:-1,y:0,z:0},surfaceId:'wall'},scopeId:'cut',...patch};
}
function pose(effects:StoryEffects,index=0){
  const matrix=new Matrix4();effects.residue.mesh.getMatrixAt(index,matrix);
  return {position:new Vector3().setFromMatrixPosition(matrix),normal:new Vector3(0,0,1).transformDirection(matrix)};
}

describe('persistent physical contact residue',()=>{
  it('places the plane on the supplied wall normal instead of rotating its wrong axis',()=>{
    const {effects}=stage();try{
      effects.emit(cue(60));effects.update(clock(60));
      const mark=pose(effects);
      expect(mark.normal.x).toBeCloseTo(-1,6);expect(mark.normal.y).toBeCloseTo(0,6);expect(mark.normal.z).toBeCloseTo(0,6);
      expect(mark.position.x).toBeCloseTo(.988,6);expect(mark.position.y).toBeCloseTo(1,6);
      effects.update(clock(180));expect(effects.residue.activeCount).toBe(1);
      effects.update(clock(360));expect(effects.residue.activeCount).toBe(0);
    }finally{effects.dispose();}
  });
  it('preserves sloped ground orientation and offsets along the normal rather than world Y',()=>{
    const {effects}=stage();try{
      const n=Math.SQRT1_2;effects.emit(cue(1,{contact:{kind:'ground',normal:{x:n,y:n,z:0}}}));
      const mark=pose(effects);expect(mark.normal.x).toBeCloseTo(n,6);expect(mark.normal.y).toBeCloseTo(n,6);
      expect(mark.position.x).toBeCloseTo(1+n*.012,6);expect(mark.position.y).toBeCloseTo(1+n*.012,6);
    }finally{effects.dispose();}
  });
  it('retains an actor contact through root translation and rotation, then removes it when the target disappears',()=>{
    const s=stage();try{
      s.effects.emit(cue(60,{kind:'hit',targetId:'foe',confirmedDamage:12,contact:{kind:'actor',normal:{x:1,y:0,z:0}}}));
      s.root.position.set(5,0,2);s.root.rotation.y=Math.PI/2;s.effects.update(clock(90));
      const mark=pose(s.effects);expect(mark.position.x).toBeCloseTo(5,6);expect(mark.position.y).toBeCloseTo(1,6);expect(mark.position.z).toBeCloseTo(.988,6);expect(mark.normal.z).toBeCloseTo(-1,6);
      s.remove();s.effects.update(clock(91));expect(s.effects.residue.activeCount).toBe(0);
    }finally{s.effects.dispose();}
  });
  it('requires real positive damage for actor marks and contact proof for environment marks',()=>{
    const {effects}=stage();try{
      effects.emit(cue(1,{contact:undefined}));
      effects.emit(cue(2,{kind:'hit',targetId:'foe',confirmedDamage:0,contact:{kind:'actor',normal:{x:1,y:0,z:0}}}));
      effects.emit(cue(3,{kind:'hit',targetId:'foe',contact:{kind:'actor',normal:{x:1,y:0,z:0}}}));
      expect(effects.residue.activeCount).toBe(0);
    }finally{effects.dispose();}
  });
  it('uses frozen world time and lets residue outlive the short impact cue',()=>{
    const {effects}=stage();try{
      effects.emit(cue(60,{kind:'hit',targetId:'foe',confirmedDamage:18,contact:{kind:'actor',normal:{x:1,y:0,z:0}}}));
      for(let i=0;i<90;i++)effects.update(clock(60));
      expect(effects.residue.activeCount).toBe(1);
      effects.update(clock(130));expect(effects.residue.activeCount).toBe(1);
      effects.update(clock(180));expect(effects.residue.activeCount).toBe(0);
    }finally{effects.dispose();}
  });
  it('cancels only the matching scope and clears all persistent state on unload',()=>{
    const {effects}=stage();try{
      effects.emit(cue(1));effects.emit(cue(2,{scopeId:'other'}));
      effects.cancelScope('cut','interrupt');expect(effects.residue.activeCount).toBe(1);
      effects.cancelAll('unload');expect(effects.residue.activeCount).toBe(0);expect(effects.residue.mesh.visible).toBe(false);
    }finally{effects.dispose();}
  });
  it('keeps repeated contacts bounded and immediately reduces the existing pool when reduced effects is selected',()=>{
    const {effects}=stage();try{
      for(let i=0;i<60;i++){effects.emit(cue(i,{scopeId:`owner:${i}`}));effects.update(clock(i));}
      expect(effects.residue.activeCount).toBeLessThanOrEqual(28);
      effects.setReducedEffects(true);expect(effects.residue.activeCount).toBeLessThanOrEqual(8);
      for(let i=60;i<100;i++){effects.emit(cue(i,{scopeId:`owner:${i}`}));effects.update(clock(i));}
      expect(effects.residue.activeCount).toBeLessThanOrEqual(8);
      effects.cancelAll('unload');expect(effects.residue.activeCount).toBe(0);
    }finally{effects.dispose();}
  });
});
