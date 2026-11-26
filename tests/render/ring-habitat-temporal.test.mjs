import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {cosmicDrawDistance} from '../../src/cosmic-structures.js';
import {createRingHabitatTemporal} from '../../src/render/ring-habitat-temporal.js';

const VERTEX=`out vec3 worldRay;
uniform mat4 uInverseProjection;uniform mat3 uCameraRotation;uniform vec4 uScreenBounds;
void main(){vec2 p=mix(uScreenBounds.xy,uScreenBounds.zw,position.xy*.5+.5);worldRay=uCameraRotation*(uInverseProjection*vec4(p,1.,1.)).xyz;gl_Position=vec4(p,0.,1.);}`;
const RAW=`precision highp float;layout(location=0) out vec4 light;layout(location=1) out vec4 metadata;
void main(){light=vec4(.2,.3,.4,.5);metadata=vec4(10.,200.,1.e15,1.);}`;
function fixture(){
  const geometry=new THREE.PlaneGeometry(2,2),camera=new THREE.PerspectiveCamera(65,1.6,.5,220000);
  camera.rotation.set(.18,-.31,.07);camera.updateMatrixWorld(true);
  const uniforms={
    uBodyRadius:{value:900000},uBodyOrigin:{value:new THREE.Vector3(.13,-.02,.97)},
    uBodyFrame:{value:new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(.12,.64,-.25)))},
    uCameraRotation:{value:new THREE.Matrix3().setFromMatrix4(camera.matrixWorld)},
    uViewRotation:{value:new THREE.Matrix3().setFromMatrix4(camera.matrixWorldInverse)},
    uInverseProjection:{value:camera.projectionMatrixInverse.clone()},uCameraNear:{value:camera.near},
    uScreenBounds:{value:new THREE.Vector4(-.8,-.9,.9,.7)},uHabitatSampleIndex:{value:0},
    uSceneDepth:{value:new THREE.Texture()},uHasSceneDepth:{value:1},uDepthResolution:{value:new THREE.Vector2(1600,1000)},uCameraNearFar:{value:new THREE.Vector2(.5,220000)},
    uVisibility:{value:1},uDensity:{value:1},
  };
  const owner=createRingHabitatTemporal({geometry,vertexShader:VERTEX,rawFragmentShader:RAW});
  return {owner,geometry,camera,uniforms};
}

class RendererProbe{
  constructor(){
    this.capabilities={isWebGL2:true,reversedDepthBuffer:false};this.extensions={has:name=>name==='EXT_color_buffer_float'};
    this.xr={enabled:true};this.autoClear=true;this.target=null;this.face=2;this.mip=1;
    this.color=new THREE.Color(.2,.3,.4);this.alpha=.7;this.viewport=new THREE.Vector4(3,5,700,500);
    this.scissor=new THREE.Vector4(7,9,450,300);this.scissorTest=true;
    this.actualViewport=this.viewport.clone().multiplyScalar(2);this.actualScissor=this.scissor.clone().multiplyScalar(2);this.actualScissorTest=true;
    this.state={viewport:v=>this.actualViewport.copy(v)};this.draws=[];this.failAt=-1;this.onRender=null;
  }
  getRenderTarget(){return this.target;}
  getActiveCubeFace(){return this.face;}
  getActiveMipmapLevel(){return this.mip;}
  getClearColor(out){return out.copy(this.color);}
  getClearAlpha(){return this.alpha;}
  getCurrentViewport(out){return out.copy(this.actualViewport);}
  getScissor(out){return out.copy(this.scissor);}
  getScissorTest(){return this.scissorTest;}
  setScissor(value){this.scissor.copy(value);this.actualScissor.copy(value).multiplyScalar(2);}
  setScissorTest(value){this.scissorTest=value;this.actualScissorTest=value;}
  setClearColor(value,alpha){this.color.set(value);this.alpha=alpha;}
  setRenderTarget(target,face=0,mip=0){
    this.target=target;this.face=face;this.mip=mip;
    this.actualViewport.copy(target?target.viewport:this.viewport).multiplyScalar(target?1:2);
    this.actualScissor.copy(target?target.scissor:this.scissor).multiplyScalar(target?1:2);
    this.actualScissorTest=target?target.scissorTest:this.scissorTest;
  }
  clear(color,depth,stencil){assert.deepEqual([color,depth,stencil],[true,false,false]);}
  render(scene,camera){
    assert.equal(this.xr.enabled,false);assert.equal(this.autoClear,false);assert.equal(this.actualScissorTest,false);
    const mesh=scene.children[0],draw={scene,camera,target:this.target,mesh,phase:mesh.material.uniforms.uHabitatSampleIndex?.value};
    this.draws.push(draw);if(this.onRender)this.onRender(draw);
    if(this.draws.length===this.failAt)throw new Error('temporal draw failure');
  }
  snapshot(){return {target:this.target,face:this.face,mip:this.mip,color:this.color.toArray(),alpha:this.alpha,xr:this.xr.enabled,autoClear:this.autoClear,
    viewport:this.viewport.toArray(),scissor:this.scissor.toArray(),scissorTest:this.scissorTest,
    actualViewport:this.actualViewport.toArray(),actualScissor:this.actualScissor.toArray(),actualScissorTest:this.actualScissorTest};}
}
function targets(renderer){
  const raw=renderer.draws.at(-2).target,resolve=renderer.draws.at(-1),uniforms=resolve.mesh.material.uniforms;
  return [raw,resolve.target,uniforms.uTemporalPrevious.value];
}
function closeEnough(actual,expected,tolerance=1.e-9){assert.ok(actual.distanceTo(expected)<tolerance,`${actual.toArray()} != ${expected.toArray()}`);}

test('full-resolution reconstruction owns exactly three fixed MRTs, reuses every target and preserves phase-zero consumers',()=>{
  const {owner,geometry,camera,uniforms}=fixture(),renderer=new RendererProbe();
  let geometryDisposals=0,depthDisposals=0;geometry.addEventListener('dispose',()=>geometryDisposals++);uniforms.uSceneDepth.value.addEventListener('dispose',()=>depthDisposals++);
  try{
    assert.equal(owner.stats.targets,0);assert.equal(owner.supported(renderer),true);owner.bind(uniforms,'near-ring');
    const initial=renderer.snapshot();assert.equal(owner.prepare(renderer,1600,1000,camera),true);assert.deepEqual(renderer.snapshot(),initial);
    const [raw,output,oldTexture]=targets(renderer),resolve=renderer.draws.at(-1).mesh.material;
    assert.equal(raw.width,1600);assert.equal(raw.height,1000);assert.equal(output.width,1600);assert.equal(output.height,1000);
    for(const target of [raw,output]){
      assert.equal(target.textures.length,2);assert.equal(target.textures[0].type,THREE.HalfFloatType);assert.equal(target.textures[0].internalFormat,'RGBA16F');
      assert.equal(target.textures[1].type,THREE.FloatType);assert.equal(target.textures[1].internalFormat,'RGBA32F');
      assert.equal(target.textures[1].minFilter,THREE.NearestFilter);assert.equal(target.textures[0].generateMipmaps,false);
      assert.equal(target.depthBuffer,false);assert.equal(target.stencilBuffer,false);assert.equal(target.samples,0);
    }
    assert.equal(owner.stats.targets,3);assert.equal(owner.stats.resourceBytes,115200000);
    assert.equal(owner.material.uniforms.uTemporalHistory.value,output.textures[0]);assert.equal(owner.material.uniforms.uTemporalMetadata.value,output.textures[1]);
    assert.equal(owner.material.uniforms.uScreenBounds,uniforms.uScreenBounds);assert.deepEqual(resolve.uniforms.uScreenBounds.value.toArray(),[-1,-1,1,1]);
    assert.equal(owner.material.uniforms.uVisibility,uniforms.uVisibility);assert.equal(owner.material.uniforms.uSceneDepth,uniforms.uSceneDepth);
    assert.equal(owner.material.blending,THREE.NormalBlending);assert.equal(owner.material.premultipliedAlpha,true);assert.equal(owner.material.depthWrite,false);
    const previous=resolve.uniforms.uTemporalPrevious.value,phase=renderer.draws[0].mesh.material.uniforms.uHabitatSampleIndex;
    assert.notEqual(phase,uniforms.uHabitatSampleIndex);assert.equal(uniforms.uHabitatSampleIndex.value,0);
    for(let i=1;i<65;i++){
      owner.prepare(renderer,1600,1000,camera);
      assert.equal(renderer.draws.at(-2).target,raw);assert.ok(owner.material.uniforms.uTemporalHistory.value===output.textures[0]||owner.material.uniforms.uTemporalHistory.value===previous);
      assert.equal(renderer.draws.at(-2).phase,i%32);assert.equal(owner.stats.targets,3);assert.equal(owner.stats.resourceBytes,115200000);
    }
    assert.equal(owner.stats.historyFrames,32);assert.equal(oldTexture,previous);assert.equal(uniforms.uHabitatSampleIndex.value,0);
    assert.equal(renderer.draws[0].mesh.geometry,geometry);assert.equal(renderer.draws[1].mesh.geometry,geometry);
    let materialDisposals=0;for(const material of [owner.material,renderer.draws[0].mesh.material,resolve])material.addEventListener('dispose',()=>materialDisposals++);
    owner.dispose();owner.dispose();assert.equal(materialDisposals,3);assert.equal(geometryDisposals,0);assert.equal(depthDisposals,0);assert.equal(owner.stats.targets,0);
    assert.equal(owner.stats.status,'disposed');assert.equal(owner.supported(renderer),false);
  }finally{owner.dispose();geometry.dispose();uniforms.uSceneDepth.value.dispose();}
});

test('resize, selected body replacement, exit, reversed-depth change and camera jump release old histories',()=>{
  const {owner,geometry,camera,uniforms}=fixture(),renderer=new RendererProbe();
  try{
    owner.bind(uniforms,'ring-a');owner.prepare(renderer,160,100,camera);
    let disposed=0;
    // Both histories alternate into the observable output role; capture each
    // actual target once rather than assuming an internal array layout.
    const raw=renderer.draws.at(-2).target,first=renderer.draws.at(-1).target;
    owner.prepare(renderer,160,100,camera);const second=renderer.draws.at(-1).target;
    for(const target of [raw,first,second])target.addEventListener('dispose',()=>disposed++);
    owner.prepare(renderer,161,100,camera);assert.equal(disposed,3);assert.equal(owner.stats.resourceBytes,161*100*72);assert.equal(owner.stats.historyFrames,1);
    const previousRaw=renderer.draws.at(-2).target;previousRaw.addEventListener('dispose',()=>disposed++);
    owner.bind(uniforms,'ring-b');assert.equal(disposed,4);assert.equal(owner.stats.targets,0);assert.equal(owner.material.uniforms.uTemporalHistory.value,null);
    owner.prepare(renderer,161,100,camera);assert.equal(renderer.draws.at(-2).phase,0);
    const prior=renderer.draws.at(-2).target;uniforms.uBodyOrigin.value.x+=.02;
    owner.prepare(renderer,161,100,camera);assert.notEqual(renderer.draws.at(-2).target,prior);assert.equal(owner.stats.historyFrames,1);
    const beforeMotion=renderer.draws.at(-2).target;uniforms.uBodyOrigin.value.x+=.00001;
    owner.prepare(renderer,161,100,camera);assert.equal(renderer.draws.at(-2).target,beforeMotion);assert.equal(owner.stats.historyFrames,2);
    renderer.capabilities.reversedDepthBuffer=true;owner.prepare(renderer,161,100,camera);assert.notEqual(renderer.draws.at(-2).target,beforeMotion);assert.equal(owner.stats.historyFrames,1);
    const beforeTurn=renderer.draws.at(-2).target;uniforms.uCameraRotation.value.setFromMatrix4(new THREE.Matrix4().makeRotationY(Math.PI));
    owner.prepare(renderer,161,100,camera);assert.notEqual(renderer.draws.at(-2).target,beforeTurn);assert.equal(owner.stats.historyFrames,1);
    assert.equal(owner.stats.status,'active');
    owner.clear();assert.equal(owner.stats.targets,0);assert.equal(owner.stats.resourceBytes,0);assert.equal(owner.material.uniforms.uTemporalHistory.value,null);
    assert.equal(owner.stats.status,'ready','leaving the volume cannot report active accumulation without targets');assert.equal(owner.stats.historyFrames,0);assert.equal(owner.stats.reason,null);
    owner.prepare(renderer,161,100,camera);assert.equal(renderer.draws.at(-2).phase,0);
  }finally{owner.dispose();geometry.dispose();uniforms.uSceneDepth.value.dispose();}
});

test('unsupported float attachments are explicit and allocate no substitute targets',()=>{
  const {owner,geometry,camera,uniforms}=fixture(),renderer=new RendererProbe();
  try{
    owner.bind(uniforms,'ring');renderer.extensions.has=()=>false;
    assert.equal(owner.supported(renderer),false);assert.equal(owner.stats.status,'unsupported');assert.equal(owner.stats.reason,'EXT_color_buffer_float required');
    assert.equal(owner.prepare(renderer,1600,1000,camera),false);assert.equal(owner.stats.targets,0);assert.equal(renderer.draws.length,0);
    renderer.capabilities.isWebGL2=false;assert.equal(owner.supported(renderer),false);assert.equal(owner.stats.reason,'WebGL2 required');
  }finally{owner.dispose();geometry.dispose();uniforms.uSceneDepth.value.dispose();}
});

test('renderer exceptions restore target face/mip, clear, XR, rectangles and disable stale output',()=>{
  for(const offscreen of [false,true]){
    const {owner,geometry,camera,uniforms}=fixture(),renderer=new RendererProbe();
    const source=offscreen?new THREE.WebGLRenderTarget(320,200):null;
    if(source){source.viewport.set(2,3,300,170);source.scissor.set(10,20,100,90);source.scissorTest=true;renderer.setRenderTarget(source,3,2);renderer.actualViewport.set(4,6,250,140);}
    const before=renderer.snapshot();
    try{
      owner.bind(uniforms,'ring');renderer.failAt=2;
      assert.throws(()=>owner.prepare(renderer,1600,1000,camera),/temporal draw failure/);
      assert.deepEqual(renderer.snapshot(),before);assert.equal(owner.stats.historyFrames,0);assert.equal(owner.stats.status,'failed');assert.equal(owner.material.uniforms.uTemporalHistory.value,null);
      renderer.failAt=-1;let validOnRetry=-1;
      renderer.onRender=draw=>{if(draw.mesh.material.uniforms.uTemporalValid)validOnRetry=draw.mesh.material.uniforms.uTemporalValid.value;};
      assert.equal(owner.prepare(renderer,1600,1000,camera),true);assert.equal(validOnRetry,0);assert.equal(owner.stats.historyFrames,1);assert.deepEqual(renderer.snapshot(),before);
    }finally{owner.dispose();source?.dispose();geometry.dispose();uniforms.uSceneDepth.value.dispose();}
  }
});

test('saved body-local transforms reproject a physical point to its previous pixel without absolute world coordinates',()=>{
  const {owner,geometry,camera,uniforms}=fixture(),renderer=new RendererProbe();
  try{
    owner.bind(uniforms,'ring');const radius=uniforms.uBodyRadius.value;
    const oldOrigin=uniforms.uBodyOrigin.value.clone(),oldBodyFrame=uniforms.uBodyFrame.value.clone(),oldView=uniforms.uViewRotation.value.clone();
    const oldCenter=oldOrigin.clone().negate().applyMatrix3(oldBodyFrame.clone().invert()),oldProjection=camera.projectionMatrix.clone();
    const direction=new THREE.Vector3(.23,-.17,-1).normalize().applyMatrix3(uniforms.uCameraRotation.value);
    const point=direction.clone().applyMatrix3(oldBodyFrame).multiplyScalar(28000/radius).add(oldOrigin);
    owner.prepare(renderer,1600,1000,camera);
    uniforms.uBodyOrigin.value.x+=.00002;camera.rotation.y+=.003;camera.updateMatrixWorld(true);
    uniforms.uCameraRotation.value.setFromMatrix4(camera.matrixWorld);uniforms.uViewRotation.value.setFromMatrix4(camera.matrixWorldInverse);
    let checked=false;
    renderer.onRender=draw=>{
      const u=draw.mesh.material.uniforms;if(!u.uTemporalPreviousOrigin)return;
      closeEnough(u.uTemporalPreviousOrigin.value,oldOrigin);
      const previousView=point.clone().sub(u.uTemporalPreviousOrigin.value).applyMatrix3(u.uTemporalPreviousBodyToView.value).multiplyScalar(radius);
      const independentView=point.clone().applyMatrix3(oldBodyFrame.clone().invert()).add(oldCenter).multiplyScalar(radius).applyMatrix3(oldView);
      closeEnough(previousView,independentView,1.e-8);
      const clip=previousView.clone().multiplyScalar(cosmicDrawDistance(previousView.length())/previousView.length()).applyMatrix4(u.uTemporalPreviousProjection.value);
      const expected=independentView.clone().multiplyScalar(cosmicDrawDistance(independentView.length())/independentView.length()).applyMatrix4(oldProjection);
      closeEnough(clip,expected,1.e-10);
      const ndc=new THREE.Vector3(clip.x,clip.y,1),oldBodyRay=ndc.applyMatrix4(u.uTemporalPreviousInverseProjection.value).normalize().applyMatrix3(u.uTemporalPreviousCameraToBody.value);
      closeEnough(oldBodyRay,point.clone().sub(oldOrigin).normalize(),1.e-10);checked=true;
    };
    owner.prepare(renderer,1600,1000,camera);assert.equal(checked,true);assert.equal(owner.stats.historyFrames,2);
  }finally{owner.dispose();geometry.dispose();uniforms.uSceneDepth.value.dispose();}
});

test('stationary classification follows camera and body transforms, independent of stochastic entry, mean and foreground depth',()=>{
  const {owner,geometry,camera,uniforms}=fixture(),renderer=new RendererProbe();
  uniforms.uTestEntry={value:10};uniforms.uTestMean={value:500};
  const stationary=[];
  renderer.onRender=draw=>{const uniform=draw.mesh.material.uniforms.uTemporalStationary;if(uniform)stationary.push(uniform.value);};
  try{
    owner.bind(uniforms,'ring');owner.prepare(renderer,1600,1000,camera);
    uniforms.uTestEntry.value=250;owner.prepare(renderer,1600,1000,camera);
    uniforms.uTestMean.value=0;uniforms.uSceneDepth.value.needsUpdate=true;owner.prepare(renderer,1600,1000,camera);
    uniforms.uBodyOrigin.value.x+=1/uniforms.uBodyRadius.value;owner.prepare(renderer,1600,1000,camera);
    assert.deepEqual(stationary,[0,1,1,0]);
    assert.equal(owner.stats.historyFrames,4,'one-unit ordinary motion does not globally clear history');
  }finally{owner.dispose();geometry.dispose();uniforms.uSceneDepth.value.dispose();}
});
