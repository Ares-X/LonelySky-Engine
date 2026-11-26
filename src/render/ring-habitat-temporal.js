import * as THREE from 'three';
import {COSMIC_DEPTH_GLSL} from '../cosmic-structures.js';
import {COSMIC_WORLD_SCENE_DEPTH_GLSL} from './cosmic-scene-depth.js';

const MAX_SAMPLES=32,BYTES_PER_PIXEL=3*(8+16);
const RESOLVE_FRAGMENT=/* glsl */`
precision highp float;
precision highp int;
in vec3 worldRay;
layout(location=0) out vec4 temporalColor;
layout(location=1) out vec4 temporalMetadata;
uniform sampler2D uTemporalRaw,uTemporalRawMetadata,uTemporalPrevious,uTemporalPreviousMetadata;
uniform vec2 uTemporalResolution;
uniform float uTemporalValid,uTemporalStationary,uTemporalMaxSamples,uBodyRadius,uCameraNear;
uniform mat3 uBodyFrame,uTemporalPreviousBodyToView,uTemporalPreviousCameraToBody;
uniform vec3 uBodyOrigin,uTemporalPreviousOrigin;
uniform mat4 uTemporalPreviousProjection,uTemporalPreviousInverseProjection;
${COSMIC_DEPTH_GLSL}
${COSMIC_WORLD_SCENE_DEPTH_GLSL}
void main(){
  ivec2 pixel=ivec2(gl_FragCoord.xy),size=ivec2(uTemporalResolution);
  vec4 current=texelFetch(uTemporalRaw,pixel,0),meta=texelFetch(uTemporalRawMetadata,pixel,0);
  temporalColor=current;temporalMetadata=vec4(meta.xyz,step(.5,meta.w));
  // A zero stochastic result still has a valid integration interval. Empty
  // geometry, by contrast, cannot inherit a previous body's colour.
  if(meta.w<.5||uTemporalValid<.5)return;
  vec3 direction=normalize(worldRay),ray=uBodyFrame*direction,origin=uBodyOrigin;
  vec2 uv=gl_FragCoord.xy/uTemporalResolution;
  // With no camera/body change, every depth on this ray projects to the same
  // pixel. This also permits a valid zero-alpha sample with no centroid (0).
  if(uTemporalStationary<.5){
    if(meta.y<=0.)return;
    vec3 localPoint=origin+ray*(meta.y/uBodyRadius);
    vec3 oldView=uTemporalPreviousBodyToView*(localPoint-uTemporalPreviousOrigin)*uBodyRadius;
    float oldDistance=length(oldView);if(oldView.z>=0.||oldDistance<=0.)return;
    vec4 oldClip=uTemporalPreviousProjection*vec4(oldView*(cosmicDrawDistance(oldDistance)/oldDistance),1.);
    uv=oldClip.xy/oldClip.w*.5+.5;
  }
  vec2 halfPixel=.5/uTemporalResolution;
  if(any(lessThan(uv,halfPixel))||any(greaterThan(uv,vec2(1.)-halfPixel)))return;
  ivec2 oldPixel=ivec2(uv*uTemporalResolution);
  vec4 previousMeta=texelFetch(uTemporalPreviousMetadata,oldPixel,0);
  if(previousMeta.w<.5)return;
  // Recover the old pixel's actual body-local ray, rather than treating the
  // current pixel's representative point as the previous scattering point.
  vec2 oldNdc=(vec2(oldPixel)+.5)/uTemporalResolution*2.-1.;
  vec3 oldRay=uTemporalPreviousCameraToBody*normalize((uTemporalPreviousInverseProjection*vec4(oldNdc,1.,1.)).xyz);
  vec3 previousPoint=uTemporalPreviousOrigin+oldRay*(previousMeta.y/uBodyRadius);
  vec3 previousRelative=(previousPoint-origin)*uBodyRadius;
  float previousMean=dot(previousRelative,ray);
  float footprint=max(1.,meta.y*length(dFdx(ray))+meta.y*length(dFdy(ray)));
  float rayError=length(previousRelative-ray*previousMean);
  if(uTemporalStationary<.5&&(previousMean<=0.||rayError>max(100.,footprint*3.)))return;
  // A depth centroid describes a finite optical column, not an exact surface.
  // Reject large changes, allow sample variance within 8% / 150 world units.
  if(uTemporalStationary<.5&&abs(previousMean-meta.y)>max(150.,.08*max(previousMean,meta.y)))return;
  float opaque=sceneWorldPhysicalLimit(direction);
  // No tolerance through opaque depth: a newly foreground ship must never
  // receive an old cloud column. Rejecting the whole column is conservative.
  if(opaque<=meta.x||opaque<=previousMean)return;
  vec3 previousEntryPoint=uTemporalPreviousOrigin+oldRay*(previousMeta.x/uBodyRadius);
  float previousEntry=dot((previousEntryPoint-origin)*uBodyRadius,ray);
  // Entry is the first nonzero MC cell, not a stable geometric boundary.
  // The same stationary ray may select another cell while sampling one field;
  // retain those samples. A moving ray still needs the disocclusion check.
  if(uTemporalStationary<.5&&meta.x>uCameraNear*4.&&abs(previousEntry-meta.x)>max(100.,footprint*3.))return;
  vec4 previous=texture(uTemporalPrevious,uv);
  vec4 lower=vec4(1.e20),upper=vec4(-1.e20),sum=vec4(0.),sumSquares=vec4(0.);
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
    vec4 value=texelFetch(uTemporalRaw,clamp(pixel+ivec2(x,y),ivec2(0),size-1),0);
    lower=min(lower,value);upper=max(upper,value);sum+=value;sumSquares+=value*value;
  }
  vec4 mean=sum/9.,deviation=sqrt(max(sumSquares/9.-mean*mean,vec4(0.)));
  // A bounded neighbourhood/variance clip limits motion trails. When all nine
  // fresh MC samples are empty, retain an existing valid estimate: forcing it
  // to zero would keep precisely the bright/empty stochastic flicker we solve.
  if(uTemporalStationary<.5&&upper.a>.0001){
    lower=max(lower,mean-2.*deviation-vec4(.015));
    upper=min(upper,mean+2.*deviation+vec4(.015));
    previous=clamp(previous,lower,upper);
  }
  float count=min(previousMeta.w+1.,uTemporalMaxSamples),weight=1./count;
  temporalColor=mix(previous,current,weight);
  float meanDistance=meta.y>0.&&previousMean>0.?mix(previousMean,meta.y,weight):max(meta.y,previousMean);
  temporalMetadata=vec4(meta.x,meanDistance,opaque,count);
}`;

const PRESENT_FRAGMENT=/* glsl */`
precision highp float;
in vec3 worldRay;
out vec4 temporalColor;
uniform sampler2D uTemporalHistory,uTemporalMetadata;
uniform vec2 uTemporalResolution;
uniform mat4 projectionMatrix;
uniform mat3 uViewRotation;
${COSMIC_DEPTH_GLSL}
${COSMIC_WORLD_SCENE_DEPTH_GLSL}
void main(){
  ivec2 pixel=ivec2(gl_FragCoord.xy);
  vec4 meta=texelFetch(uTemporalMetadata,pixel,0),value=texelFetch(uTemporalHistory,pixel,0);
  if(meta.w<.5||value.a<=.00001)discard;
  vec3 direction=normalize(worldRay);
  float opaque=sceneWorldPhysicalLimit(direction);
  if(opaque<=meta.x||opaque<=meta.y)discard;
  vec3 viewPoint=uViewRotation*direction*cosmicDrawDistance(meta.x);
  vec4 clip=projectionMatrix*vec4(viewPoint,1.);
  #ifdef USE_REVERSED_DEPTH_BUFFER
    gl_FragDepth=clip.z/clip.w;
  #else
    gl_FragDepth=.5*clip.z/clip.w+.5;
  #endif
  temporalColor=vec4(value.rgb/max(value.a,.00001),value.a);
  #define gl_FragColor temporalColor
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  temporalColor.rgb*=temporalColor.a;
}`;

/** One group-owned optical reconstruction, never one history per ring body.
 * All three full drawing-buffer MRTs contain RGBA16F linear premultiplied light
 * and RGBA32F distances/count: 72 bytes/pixel attachment payload (115.2 MB
 * at 1600 x 1000, excluding driver overhead),
 * no depth/stencil/MSAA/mipmaps. Sample count saturates at 32, followed by a
 * 1/32 exponential mean; only these two history frames are retained.
 *
 * rawFragmentShader is the owner's canonical full-quality atmosphere shader;
 * outputs are (premultiplied radiance,alpha) and (entry,mean,opaqueLimit,valid).
 * Distances are physical world units; body coordinates are radius-normalized.
 * Valid denotes an integration interval even when the stochastic sample is 0.
 * This is finite optical reconstruction, not physical cloud/time state.
 *
 * Call supported/bind before the scene's material filtering, then prepare only
 * AFTER binding this frame's opaque scene depth and BEFORE volume drawing.
 * Never call prepare from onBeforeRender. Geometry is borrowed, not disposed.
 * clear releases every RT; bind on a new body, resize and a large camera jump
 * clear automatically. Normal motion uses previous body-local ray reprojection.
 */
export function createRingHabitatTemporal({geometry,vertexShader,rawFragmentShader}){
  const phase={value:0},resolution={value:new THREE.Vector2()},validUniform={value:0},stationaryUniform={value:0};
  const previousOrigin=new THREE.Vector3(),previousForward=new THREE.Vector3(),forward=new THREE.Vector3();
  const previousBodyToView=new THREE.Matrix3(),previousCameraToBody=new THREE.Matrix3(),cameraToBody=new THREE.Matrix3(),inverseFrame=new THREE.Matrix3();
  const previousProjection=new THREE.Matrix4(),previousInverseProjection=new THREE.Matrix4();
  const rawUniforms={},resolveUniforms={
    uTemporalRaw:{value:null},uTemporalRawMetadata:{value:null},uTemporalPrevious:{value:null},uTemporalPreviousMetadata:{value:null},
    uTemporalResolution:resolution,uTemporalValid:validUniform,uTemporalStationary:stationaryUniform,uTemporalMaxSamples:{value:MAX_SAMPLES},
    uTemporalPreviousOrigin:{value:previousOrigin},uTemporalPreviousBodyToView:{value:previousBodyToView},
    uTemporalPreviousCameraToBody:{value:previousCameraToBody},uTemporalPreviousProjection:{value:previousProjection},
    uTemporalPreviousInverseProjection:{value:previousInverseProjection},
  },presentationUniforms={uTemporalHistory:{value:null},uTemporalMetadata:{value:null},uTemporalResolution:resolution};
  const fullScreenBounds={value:new THREE.Vector4(-1,-1,1,1)};
  const rawMaterial=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms:rawUniforms,vertexShader,fragmentShader:rawFragmentShader,
    depthTest:false,depthWrite:false,blending:THREE.NoBlending,toneMapped:false});
  const resolveMaterial=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms:resolveUniforms,vertexShader,fragmentShader:RESOLVE_FRAGMENT,
    depthTest:false,depthWrite:false,blending:THREE.NoBlending,toneMapped:false});
  const material=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms:presentationUniforms,vertexShader,fragmentShader:PRESENT_FRAGMENT,
    transparent:true,premultipliedAlpha:true,depthTest:true,depthWrite:false,blending:THREE.NormalBlending});
  const rawScene=new THREE.Scene(),resolveScene=new THREE.Scene();
  const rawMesh=new THREE.Mesh(geometry,rawMaterial),resolveMesh=new THREE.Mesh(geometry,resolveMaterial);
  rawMesh.frustumCulled=resolveMesh.frustumCulled=false;rawScene.add(rawMesh);resolveScene.add(resolveMesh);
  // No scene/world transforms are consumed: canonical vertexShader expands the
  // borrowed [-1,1] quad directly into clip coordinates and camera rays.
  rawScene.matrixWorldAutoUpdate=resolveScene.matrixWorldAutoUpdate=false;
  const clearColor=new THREE.Color(),viewport=new THREE.Vector4(),scissor=new THREE.Vector4();
  const stats={status:'uninitialized',reason:null,frames:0,renders:0,historyFrames:0,resets:0,targets:0,resourceBytes:0,width:0,height:0,maxSamples:MAX_SAMPLES};
  let raw=null,historyA=null,historyB=null,read=null,write=null,boundUniforms=null,bodyKey=null,disposed=false,previousReversed=null;

  function supported(renderer){
    if(disposed){stats.status='disposed';stats.reason='disposed';return false;}
    if(!renderer.capabilities.isWebGL2){if(raw)clear();stats.status='unsupported';stats.reason='WebGL2 required';return false;}
    if(!renderer.extensions.has('EXT_color_buffer_float')){if(raw)clear();stats.status='unsupported';stats.reason='EXT_color_buffer_float required';return false;}
    stats.reason=null;if(stats.status==='uninitialized'||stats.status==='unsupported')stats.status='ready';return true;
  }
  function clear(){
    if(raw){raw.dispose();historyA.dispose();historyB.dispose();}
    raw=historyA=historyB=read=write=null;validUniform.value=0;phase.value=0;previousReversed=null;
    resolveUniforms.uTemporalRaw.value=resolveUniforms.uTemporalRawMetadata.value=null;
    resolveUniforms.uTemporalPrevious.value=resolveUniforms.uTemporalPreviousMetadata.value=null;
    presentationUniforms.uTemporalHistory.value=presentationUniforms.uTemporalMetadata.value=null;
    stats.targets=stats.resourceBytes=stats.width=stats.height=stats.historyFrames=0;stats.resets++;
    stats.status='ready';stats.reason=null;
  }
  function bind(uniforms,key){
    if(disposed)throw new Error('Cannot bind disposed habitat temporal reconstruction');
    if(key!==bodyKey){clear();bodyKey=key;}
    if(uniforms===boundUniforms)return;
    // Binding is a lifecycle boundary, not a per-frame clone. The values remain
    // references to the single body owner; no snapshots of body data are made.
    for(const name in uniforms){rawUniforms[name]=resolveUniforms[name]=presentationUniforms[name]=uniforms[name];}
    rawUniforms.uHabitatSampleIndex=phase;resolveUniforms.uScreenBounds=fullScreenBounds;
    boundUniforms=uniforms;
  }
  function createTarget(name,width,height){
    const target=new THREE.WebGLRenderTarget(width,height,{count:2,type:THREE.HalfFloatType,format:THREE.RGBAFormat,internalFormat:'RGBA16F',
      minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,generateMipmaps:false,depthBuffer:false,stencilBuffer:false,samples:0});
    const color=target.textures[0],metadata=target.textures[1];
    color.name=`${name} linear premultiplied radiance`;color.minFilter=color.magFilter=THREE.LinearFilter;
    metadata.name=`${name} physical distances and sample count`;metadata.type=THREE.FloatType;metadata.internalFormat='RGBA32F';
    return target;
  }
  function allocate(width,height){
    raw=createTarget('Habitat raw',width,height);historyA=createTarget('Habitat history A',width,height);historyB=createTarget('Habitat history B',width,height);
    read=historyA;write=historyB;resolution.value.set(width,height);
    resolveUniforms.uTemporalRaw.value=raw.textures[0];resolveUniforms.uTemporalRawMetadata.value=raw.textures[1];
    stats.targets=3;stats.resourceBytes=width*height*BYTES_PER_PIXEL;stats.width=width;stats.height=height;
  }
  function prepare(renderer,width,height,camera){
    if(!supported(renderer))return false;
    if(!boundUniforms)throw new Error('Bind a body before preparing habitat temporal reconstruction');
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw new RangeError('Habitat temporal size must be full integer drawing-buffer dimensions');
    const radius=boundUniforms.uBodyRadius.value,reversed=renderer.capabilities.reversedDepthBuffer;
    const origin=boundUniforms.uBodyOrigin.value;
    const rotation=boundUniforms.uCameraRotation.value.elements;forward.set(-rotation[6],-rotation[7],-rotation[8]);
    if(raw&&(raw.width!==width||raw.height!==height||previousReversed!==reversed
      ||(validUniform.value>0&&(origin.distanceToSquared(previousOrigin)*radius*radius>Math.pow(Math.max(2000.,radius*.002),2)||forward.dot(previousForward)<.5))))clear();
    if(!raw)allocate(width,height);
    cameraToBody.multiplyMatrices(boundUniforms.uBodyFrame.value,boundUniforms.uCameraRotation.value);
    stationaryUniform.value=validUniform.value>0&&origin.equals(previousOrigin)&&cameraToBody.equals(previousCameraToBody)&&camera.projectionMatrix.equals(previousProjection)?1:0;
    resolveUniforms.uTemporalPrevious.value=read.textures[0];resolveUniforms.uTemporalPreviousMetadata.value=read.textures[1];
    const target=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    const autoClear=renderer.autoClear,xr=renderer.xr.enabled,alpha=renderer.getClearAlpha();
    const scissorTest=renderer.getScissorTest();
    renderer.getClearColor(clearColor);renderer.getCurrentViewport(viewport);renderer.getScissor(scissor);
    // Three owns actual scissor state per target. Do not mutate its public
    // logical scissor/viewport settings or query GL into a fresh typed array.
    // This preserves the caller's active target scissor and camera viewport.
    let completed=false;
    try{
      renderer.autoClear=false;renderer.xr.enabled=false;renderer.setClearColor(0,0);
      renderer.setRenderTarget(raw);renderer.clear(true,false,false);renderer.render(rawScene,camera);stats.renders++;
      renderer.setRenderTarget(write);renderer.clear(true,false,false);renderer.render(resolveScene,camera);stats.renders++;
      completed=true;
    }finally{
      renderer.setClearColor(clearColor,alpha);renderer.autoClear=autoClear;renderer.xr.enabled=xr;
      renderer.setRenderTarget(target,face,mip);renderer.state.viewport(viewport);
      // Default framebuffer scissor is derived from the logical public value;
      // non-default target scissor belongs to target.scissor/scissorTest.
      if(!target){renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);}
      if(!completed){validUniform.value=0;presentationUniforms.uTemporalHistory.value=presentationUniforms.uTemporalMetadata.value=null;stats.historyFrames=0;stats.status='failed';}
    }
    const old=read;read=write;write=old;
    presentationUniforms.uTemporalHistory.value=read.textures[0];presentationUniforms.uTemporalMetadata.value=read.textures[1];
    previousOrigin.copy(origin);previousForward.copy(forward);previousProjection.copy(camera.projectionMatrix);previousInverseProjection.copy(boundUniforms.uInverseProjection.value);
    inverseFrame.copy(boundUniforms.uBodyFrame.value).invert();previousBodyToView.multiplyMatrices(boundUniforms.uViewRotation.value,inverseFrame);
    previousCameraToBody.copy(cameraToBody);
    previousReversed=reversed;validUniform.value=1;phase.value=(phase.value+1)%MAX_SAMPLES;
    stats.frames++;stats.historyFrames=Math.min(stats.historyFrames+1,MAX_SAMPLES);stats.status='active';return true;
  }
  function dispose(){
    if(disposed)return;clear();disposed=true;boundUniforms=null;bodyKey=null;
    rawScene.clear();resolveScene.clear();rawMesh.geometry=resolveMesh.geometry=null;rawMaterial.dispose();resolveMaterial.dispose();material.dispose();
    // Bound uniforms may contain borrowed depth/noise/terrain textures. Dispose
    // neither them nor the screen quad, and release the JS owner references.
    for(const name in rawUniforms)delete rawUniforms[name];
    for(const name in resolveUniforms)delete resolveUniforms[name];
    for(const name in presentationUniforms)delete presentationUniforms[name];
    stats.status='disposed';
  }
  return {material,supported,bind,prepare,clear,dispose,stats};
}
