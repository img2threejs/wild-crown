import * as THREE from 'three';
import { COLLISION_BOUNDS, FIXED_STEP, MAX_CATCH_UP_STEPS, createState, InputController, routeProgress, stepSimulation } from './simulation';
import { LAB_COPY } from './config/labCopy';
import './style.css';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Application mount is missing.');

if (!['/lab', '/lab/'].includes(window.location.pathname)) {
  root.innerHTML = `<main class="entry-screen"><div class="entry-art" aria-hidden="true"></div><section class="entry-copy"><p class="eyebrow">WILD CROWN / THE BROKEN PACT</p><h1>Every path<br>leaves a mark.</h1><p class="entry-description">An authored journey through a living world. This independent game entry opens the current movement-development experience.</p><a class="primary-link" href="/lab">Enter Movement Lab <span aria-hidden="true">↗</span></a><p class="entry-note">FIRST PACT · DEVELOPMENT GREYBOX</p></section><div class="entry-footer">A WILD CROWN DEVELOPMENT BUILD <span>NOT FINAL ART</span></div></main>`;
} else startLab(root);

function startLab(app: HTMLElement): void {
  app.innerHTML = `<main class="lab-shell">
    <div class="scene" id="scene" tabindex="0" role="application" aria-label="First Pact movement laboratory. Click Start to focus movement controls."></div>
    <header class="topbar"><a class="wordmark" href="/" aria-label="Wild Crown game entry"><span class="wordmark-mark">✳</span><span>WILD CROWN<small>THE BROKEN PACT</small></span></a><div class="build-tag"><span class="live-dot"></span>${LAB_COPY.status}</div></header>
    <section class="lab-title"><p>${LAB_COPY.chapter}</p><h1>${LAB_COPY.mode}</h1><div class="title-rule"></div></section>
    <aside class="route-card"><span class="route-kicker">THE FIRST PACT</span><div class="route-line"><span class="route-start">${LAB_COPY.routeStart}</span><span class="route-dash"></span><span class="route-end">${LAB_COPY.destination}</span></div><div class="progress-track"><i id="progressFill"></i><b id="progressDot"></b></div><div class="landmark-copy"><span id="landmark">THE RIBBON’S EDGE</span><span id="progressText">0% · 0 m</span></div></aside>
    <section class="control-dock" aria-label="Movement controls"><div class="control-row"><button id="startButton" class="button-primary">Start <span>↗</span></button><button id="pauseButton" class="button-secondary" disabled>Pause</button><button id="resetButton" class="button-quiet">Reset</button><button id="debugButton" class="button-quiet" aria-pressed="false">Debug <span class="toggle-indicator"></span></button></div><div class="controls-hint"><span class="keycap">W</span><span class="keycap">A</span><span class="keycap">S</span><span class="keycap">D</span><span class="hint-copy">or arrows to move <i>·</i> left stick</span></div></section>
    <div class="pause-overlay" id="pauseOverlay" hidden><div class="pause-mark">Ⅱ</div><p class="eyebrow">THE PATH CAN WAIT</p><h2 id="pauseTitle">Paused</h2><p id="pauseMessage">Take a breath. The living ribbon will be here.</p><button id="resumeButton" class="button-primary">Resume <span>↗</span></button></div>
    <div class="debug-panel" id="debugPanel" hidden><div class="debug-heading">MOVEMENT TELEMETRY <span>R01</span></div><div id="debugContent"></div></div>
    <div class="location-stamp">GREENWAKE <span>·</span> BORDER OF THE WILD</div><div class="scene-vignette" aria-hidden="true"></div>
  </main>`;
  const sceneElement = app.querySelector<HTMLDivElement>('#scene')!;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.setSize(sceneElement.clientWidth, sceneElement.clientHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  renderer.domElement.className = 'game-canvas'; sceneElement.appendChild(renderer.domElement);
  const world = new THREE.Scene(); world.background = new THREE.Color('#172522'); world.fog = new THREE.FogExp2('#172522', 0.018);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);
  world.add(new THREE.HemisphereLight('#ccebd6', '#26362f', 2));
  const sun = new THREE.DirectionalLight('#ffe3ae', 3.3); sun.position.set(-9,18,7); sun.castShadow = true; sun.shadow.mapSize.set(1024,1024); sun.shadow.camera.left=-25; sun.shadow.camera.right=25; sun.shadow.camera.top=25; sun.shadow.camera.bottom=-25; world.add(sun);
  const fill = new THREE.DirectionalLight('#90c9bd',1.25); fill.position.set(12,8,-16); world.add(fill);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(70,80),new THREE.MeshStandardMaterial({color:'#31423a',roughness:1})); floor.rotation.x=-Math.PI/2; floor.position.set(0,-.09,-8); floor.receiveShadow=true; world.add(floor);
  const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(7.8,43),new THREE.MeshStandardMaterial({color:'#77875b',roughness:.95})); ribbon.rotation.x=-Math.PI/2; ribbon.position.set(0,-.035,-8.5); ribbon.receiveShadow=true; world.add(ribbon);
  const bands = new THREE.Group(); world.add(bands); const bandMaterial=new THREE.MeshStandardMaterial({color:'#b2a273',roughness:.9,transparent:true,opacity:.72});
  for(let z=10;z>=-23;z-=4.6){const band=new THREE.Mesh(new THREE.PlaneGeometry(7.1,.07),bandMaterial);band.rotation.x=-Math.PI/2;band.position.set(0,.012,z);bands.add(band);}
  const arena=new THREE.Mesh(new THREE.CircleGeometry(10,64),new THREE.MeshStandardMaterial({color:'#53654d',roughness:.98}));arena.rotation.x=-Math.PI/2;arena.position.set(0,-.02,-25);arena.receiveShadow=true;world.add(arena);
  const ring=new THREE.Mesh(new THREE.TorusGeometry(8.3,.16,8,80),new THREE.MeshStandardMaterial({color:'#c8b17a',emissive:'#55452b',roughness:.7}));ring.rotation.x=Math.PI/2;ring.position.set(0,.06,-25);world.add(ring);
  function box(name:string,x:number,z:number,w:number,d:number,h:number,color:string):void{const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshStandardMaterial({color,roughness:.94}));mesh.name=name;mesh.position.set(x,h/2,z);mesh.castShadow=true;mesh.receiveShadow=true;world.add(mesh);}
  box('RIBBON WALL',0,-14.52,11.6,.55,2.5,'#687063'); box('WEST WALL END',-5.52,-12.5,.55,4.6,2.5,'#687063'); box('EAST WALL END',5.52,-12.5,.55,4.6,2.5,'#687063');
  box('WEST STONE',-2.12,-4.98,1.15,1.25,1.6,'#7f765d'); box('EAST STONE',1.92,-9.75,1.15,1.3,1.9,'#786f58'); box('ENTRY GATE WEST',-4.25,6.42,7.1,.45,3.5,'#455c4e'); box('ENTRY GATE EAST',4.25,6.42,7.1,.45,3.5,'#455c4e');
  const marker=new THREE.Group();marker.position.set(0,0,-25);world.add(marker);const gold=new THREE.MeshStandardMaterial({color:'#d4bd7d',emissive:'#927b39',emissiveIntensity:.42,roughness:.4});
  const plinth=new THREE.Mesh(new THREE.CylinderGeometry(1.35,1.65,.42,8),new THREE.MeshStandardMaterial({color:'#4b5645',roughness:.82}));plinth.position.y=.18;plinth.castShadow=true;marker.add(plinth);
  const stem=new THREE.Mesh(new THREE.CylinderGeometry(.18,.28,2.55,7),gold);stem.position.y=1.55;stem.castShadow=true;marker.add(stem);const crown=new THREE.Mesh(new THREE.OctahedronGeometry(.66),gold);crown.position.y=3.05;crown.castShadow=true;marker.add(crown);const markerLight=new THREE.PointLight('#e5c878',5,12);markerLight.position.y=3.1;marker.add(markerLight);
  const foliage:THREE.Mesh[]=[];const trunkMaterial=new THREE.MeshStandardMaterial({color:'#53493b',roughness:1});
  function tree(x:number,z:number,scale:number,occludes=false):void{const group=new THREE.Group();group.position.set(x,0,z);group.scale.setScalar(scale);world.add(group);const trunk=new THREE.Mesh(new THREE.CylinderGeometry(.18,.36,3.1,7),trunkMaterial);trunk.position.y=1.55;trunk.castShadow=true;group.add(trunk);for(let i=0;i<4;i++){const mat=new THREE.MeshStandardMaterial({color:i%2?'#587055':'#6d805f',roughness:.96,transparent:true,opacity:.92,depthWrite:false,side:THREE.DoubleSide});const leaf=new THREE.Mesh(new THREE.IcosahedronGeometry(1.45-i*.13,1),mat);leaf.position.set(Math.sin(i*2.4)*.48,3+i*.78,Math.cos(i*2.4)*.42);leaf.scale.set(1.1,.86,1);leaf.castShadow=true;group.add(leaf);if(occludes)foliage.push(leaf);}}
  const trees:[number,number,number][]=[[-8,10,1.5],[8,11,1.7],[-8,1,1.25],[8,-2,1.5],[-9,-8,1.7],[9,-7,1.65],[-8,-18,1.7],[8,-19,1.5],[-11,-27,1.6],[11,-27,1.7],[-5,-34,1.4],[5,-34,1.5]];
  for(const [x,z,s] of trees)tree(x,z,s,Math.abs(x)<9&&z<3&&z>-20);
  const stakeA=new THREE.MeshStandardMaterial({color:'#d79b6a',emissive:'#572e1d',emissiveIntensity:.35});const stakeB=new THREE.MeshStandardMaterial({color:'#84b8a3',emissive:'#274a3e',emissiveIntensity:.36});
  for(const [x,z,mat] of [[-3.5,3,stakeA],[3.5,-1,stakeB],[-3.5,-8,stakeA],[3.5,-19,stakeB]] as const){const stake=new THREE.Mesh(new THREE.CylinderGeometry(.07,.1,1.7,6),mat);stake.position.set(x,.85,z);stake.castShadow=true;world.add(stake);const glow=new THREE.Mesh(new THREE.SphereGeometry(.18,10,8),mat);glow.position.set(x,1.72,z);world.add(glow);}
  const player=new THREE.Group();world.add(player);const proxy=new THREE.Mesh(new THREE.CapsuleGeometry(.36,.92,5,8),new THREE.MeshStandardMaterial({color:'#d4b080',roughness:.74}));proxy.position.y=.83;proxy.castShadow=true;player.add(proxy);
  const mantle=new THREE.Mesh(new THREE.ConeGeometry(.5,.84,6),new THREE.MeshStandardMaterial({color:'#8b5c47',roughness:.88}));mantle.position.set(0,.78,.13);mantle.rotation.x=Math.PI;mantle.castShadow=true;player.add(mantle);
  const head=new THREE.Mesh(new THREE.SphereGeometry(.27,12,10),new THREE.MeshStandardMaterial({color:'#d6b88d',roughness:.85}));head.position.set(0,1.48,-.03);head.castShadow=true;player.add(head);
  const facing=new THREE.Mesh(new THREE.ConeGeometry(.13,.28,6),new THREE.MeshStandardMaterial({color:'#e9d29a',emissive:'#80663b',emissiveIntensity:.4}));facing.position.set(0,1.35,-.31);facing.rotation.x=-Math.PI/2;player.add(facing);
  const footRing=new THREE.Mesh(new THREE.CircleGeometry(.66,28),new THREE.MeshBasicMaterial({color:'#ebd5a0',transparent:true,opacity:.23,depthWrite:false}));footRing.rotation.x=-Math.PI/2;footRing.position.y=.028;player.add(footRing);
  const input=new InputController(sceneElement);const state=createState();const cameraTarget=new THREE.Vector3();const desiredCameraPosition=new THREE.Vector3();const arenaCameraPosition=new THREE.Vector3(0,10,-12);const arenaLookTarget=new THREE.Vector3(0,.9,-25);const foliageWorldPosition=new THREE.Vector3();let cameraYaw=Math.atan2(8,10),arenaWeight=0,bfcacheRestores=0;let running=false,destroyed=false,debug=false,previousTime=0,accumulator=0,raf=0;
  const pauseOverlay=app.querySelector<HTMLDivElement>('#pauseOverlay')!;const pauseTitle=app.querySelector<HTMLHeadingElement>('#pauseTitle')!;const pauseMessage=app.querySelector<HTMLParagraphElement>('#pauseMessage')!;
  const startButton=app.querySelector<HTMLButtonElement>('#startButton')!;const pauseButton=app.querySelector<HTMLButtonElement>('#pauseButton')!;const resetButton=app.querySelector<HTMLButtonElement>('#resetButton')!;const resumeButton=app.querySelector<HTMLButtonElement>('#resumeButton')!;const debugButton=app.querySelector<HTMLButtonElement>('#debugButton')!;const debugPanel=app.querySelector<HTMLDivElement>('#debugPanel')!;const debugContent=app.querySelector<HTMLDivElement>('#debugContent')!;
  const progressFill=app.querySelector<HTMLElement>('#progressFill')!;const progressDot=app.querySelector<HTMLElement>('#progressDot')!;const progressText=app.querySelector<HTMLElement>('#progressText')!;const landmark=app.querySelector<HTMLElement>('#landmark')!;
  let previousPosition=state.position.clone();let previousHeading=state.heading;
  function pause(reason='user'):void{if(!running||destroyed)return;running=false;accumulator=0;input.clear();pauseButton.textContent='Resume';startButton.textContent='Resume';startButton.disabled=false;pauseTitle.textContent=reason==='hidden'?'Paused while away':'Paused';pauseMessage.textContent=reason==='hidden'?'Your place is saved. Resume when you are ready.':'Take a breath. The living ribbon will be here.';pauseOverlay.hidden=false;}
  function resume():void{if(destroyed)return;running=true;previousTime=performance.now()/1000;accumulator=0;pauseOverlay.hidden=true;pauseButton.textContent='Pause';pauseButton.disabled=false;startButton.textContent='Running';startButton.disabled=true;input.focus();}
  function reset():void{Object.assign(state,createState());previousPosition.copy(state.position);previousHeading=state.heading;player.position.set(0,0,12);player.rotation.y=Math.PI;cameraYaw=Math.atan2(8,10);accumulator=0;updateCamera(FIXED_STEP,true);if(running){previousTime=performance.now()/1000;input.focus();}landmark.textContent='THE RIBBON’S EDGE';progressFill.style.width='0%';progressDot.style.left='0%';progressText.textContent='0% · 0 m';}
  startButton.addEventListener('click',resume);resumeButton.addEventListener('click',resume);pauseButton.addEventListener('click',()=>running?pause():resume());resetButton.addEventListener('click',reset);
  debugButton.addEventListener('click',()=>{debug=!debug;debugButton.setAttribute('aria-pressed',String(debug));debugPanel.hidden=!debug;updateDebug();});
  app.querySelector<HTMLDivElement>('#scene')!.addEventListener('click',()=>{if(!running&&!pauseOverlay.hidden)resume();else if(running)input.focus();});
  const onKey=(event:KeyboardEvent):void=>{if(event.key==='Escape'){event.preventDefault();if(running)pause();else if(!pauseOverlay.hidden)resume();}};
  const onBlur=():void=>{if(running)pause('hidden');};const onVisibility=():void=>{if(document.hidden&&running)pause('hidden');};
  window.addEventListener('keydown',onKey);window.addEventListener('blur',onBlur);document.addEventListener('visibilitychange',onVisibility);
   const resize=new ResizeObserver(()=>{const width=sceneElement.clientWidth,height=sceneElement.clientHeight;if(!width||!height||destroyed)return;renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();});resize.observe(sceneElement);
  const helpers=COLLISION_BOUNDS.map((b,i)=>{const line=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(b.maxX-b.minX,2.5,b.maxZ-b.minZ)),new THREE.LineBasicMaterial({color:'#ff8274'}));line.position.set((b.minX+b.maxX)/2,1.25,(b.minZ+b.maxZ)/2);line.name='collision-bound-'+i;line.visible=false;world.add(line);return line;});
  function updateCamera(delta:number, snap=false):void{
    arenaWeight=THREE.MathUtils.smoothstep(-state.position.z,18,23);
    desiredCameraPosition.set(state.position.x+7.2,7.2,state.position.z+8.2).lerp(arenaCameraPosition,arenaWeight);
    cameraTarget.set(state.position.x,.9,state.position.z-4.5).lerp(arenaLookTarget,arenaWeight);
    if(snap)camera.position.copy(desiredCameraPosition);else camera.position.lerp(desiredCameraPosition,1-Math.exp(-delta*3.4));
    camera.lookAt(cameraTarget);
    cameraYaw=Math.atan2(camera.position.x-cameraTarget.x,camera.position.z-cameraTarget.z);
  }
  function updateDebug():void{
    if(!debug)return;
    const mode=arenaWeight>=1?'ARENA ANCHOR':arenaWeight>0?'CAMERA BLEND':'GUIDED FOLLOW';
    debugContent.innerHTML=`<div>CAMERA <b>${mode}</b></div><div>POSITION <b>${state.position.x.toFixed(2)} / 0.00 / ${state.position.z.toFixed(2)}</b></div><div>VELOCITY <b>${state.velocity.x.toFixed(2)} / ${state.velocity.z.toFixed(2)} m/s</b></div><div>CAMERA POS <b>${camera.position.x.toFixed(2)} / ${camera.position.y.toFixed(2)} / ${camera.position.z.toFixed(2)}</b></div><div>CAMERA TARGET <b>${cameraTarget.x.toFixed(2)} / ${cameraTarget.y.toFixed(2)} / ${cameraTarget.z.toFixed(2)}</b></div><div>RIBBON <b>x ±8 · z 13.5 to −30.5</b></div><div>COLLISION <b>${COLLISION_BOUNDS.length} authored bounds · capsule r 0.42</b></div>`;
  }
  function render(timeMs:number):void{if(destroyed)return;raf=requestAnimationFrame(render);const now=timeMs/1000;const frameDt=previousTime?Math.min(now-previousTime,FIXED_STEP*MAX_CATCH_UP_STEPS):0;previousTime=now;
    if(running){accumulator+=frameDt;let steps=0;while(accumulator>=FIXED_STEP&&steps<MAX_CATCH_UP_STEPS){previousPosition.copy(state.position);previousHeading=state.heading;stepSimulation(state,input.sample(cameraYaw),FIXED_STEP);accumulator-=FIXED_STEP;steps++;}if(steps===MAX_CATCH_UP_STEPS)accumulator=Math.min(accumulator,FIXED_STEP);}else accumulator=0;
    const alpha=running?accumulator/FIXED_STEP:1;player.position.lerpVectors(previousPosition,state.position,alpha);player.rotation.y=previousHeading+(state.heading-previousHeading)*alpha;
    const stride=Math.min(state.velocity.length()/4.15,1);proxy.rotation.z=running?Math.sin(now*11)*stride*.045:0;updateCamera(frameDt||FIXED_STEP);
    const progress=routeProgress(state);progressFill.style.width=progress*100+'%';progressDot.style.left=progress*100+'%';progressText.textContent=Math.round(progress*100)+'% · '+Math.max(0,Math.round((12-state.position.z)*.92))+' m';landmark.textContent=progress>.82?'ASHA’S CLEARING':progress>.42?'THE FAR RIBBON':'THE RIBBON’S EDGE';
    for(const leaf of foliage){leaf.getWorldPosition(foliageWorldPosition);const near=foliageWorldPosition.distanceTo(state.position)<6.3||foliageWorldPosition.distanceTo(camera.position)<8;(leaf.material as THREE.MeshStandardMaterial).opacity=near?.18:.92;}for(const helper of helpers)helper.visible=debug;updateDebug();renderer.render(world,camera);
  }
  function destroy():void{
    if(destroyed)return;
    destroyed=true;cancelAnimationFrame(raf);raf=0;resize.disconnect();input.dispose();
    window.removeEventListener('keydown',onKey);window.removeEventListener('blur',onBlur);window.removeEventListener('pagehide',onPageHide);window.removeEventListener('pageshow',onPageShow);
    document.removeEventListener('visibilitychange',onVisibility);
    world.traverse(object=>{if(object instanceof THREE.Mesh||object instanceof THREE.LineSegments){object.geometry.dispose();const materials=Array.isArray(object.material)?object.material:[object.material];materials.forEach(material=>material.dispose());}});
    renderer.dispose();renderer.domElement.remove();delete window.__wildCrownDebug;
  }
  function onPageHide(event:PageTransitionEvent):void{
    if(event.persisted){if(running)pause('hidden');cancelAnimationFrame(raf);raf=0;return;}
    destroy();
  }
  function onPageShow(event:PageTransitionEvent):void{
    if(!event.persisted||destroyed)return;
    bfcacheRestores++;accumulator=0;previousTime=performance.now()/1000;
    const width=sceneElement.clientWidth,height=sceneElement.clientHeight;
    if(width&&height){renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();}
    raf=requestAnimationFrame(render);
  }
  window.addEventListener('pagehide',onPageHide);window.addEventListener('pageshow',onPageShow);
  window.__wildCrownDebug=Object.freeze({getState:()=>Object.freeze({position:state.position.toArray(),velocity:state.velocity.toArray(),cameraPosition:camera.position.toArray(),cameraTarget:cameraTarget.toArray(),cameraMode:arenaWeight>=1?'arena-anchor':arenaWeight>0?'camera-blend':'guided-follow',progress:routeProgress(state),running,bfcacheRestores})});
  updateCamera(FIXED_STEP,true);renderer.render(world,camera);raf=requestAnimationFrame(render);
}

declare global {
  interface Window {
    __wildCrownDebug?: Readonly<{ getState: () => Readonly<{ position: number[]; velocity: number[]; cameraPosition: number[]; cameraTarget: number[]; cameraMode: 'guided-follow' | 'camera-blend' | 'arena-anchor'; progress: number; running: boolean; bfcacheRestores: number }> }>;
  }
}
