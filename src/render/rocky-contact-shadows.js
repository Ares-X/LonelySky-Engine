import * as THREE from 'three';
export const ROCKY_CONTACT_SHADOW=Object.freeze({mapSize:2048,span:16384,snap:32,receiverInner:4096,receiverOuter:6144,fadeStart:24576,coverageMargin:2048,depthReach:65536,bias:1,maxRadius:1024});
export function createRockyContactShadowUniforms(){return {
  uRockyShadow:{value:null},uRockyShadowEnabled:{value:0},uRockyShadowMatrix:{value:new THREE.Matrix4()},
  uRockyShadowReceiver:{value:new THREE.Vector3()},uRockyShadowOrigin:{value:new THREE.Vector3()},uRockyShadowCamera:{value:new THREE.Vector3()},uRockyShadowLight:{value:new THREE.Vector3()},
  uRockyShadowRadius:{value:1},uRockyShadowOuterReach:{value:0},uRockyShadowReversed:{value:0},
};}
export const ROCKY_CONTACT_SHADOW_GLSL=/* glsl */`
uniform sampler2D uRockyShadow;
uniform float uRockyShadowEnabled,uRockyShadowRadius,uRockyShadowOuterReach,uRockyShadowReversed;
uniform mat4 uRockyShadowMatrix;
uniform vec3 uRockyShadowOrigin,uRockyShadowCamera,uRockyShadowLight,uRockyShadowReceiver;
float rockyContactVisibility(vec3 point){
  if(uRockyShadowEnabled<.5)return 1.;
  float cameraDistance=length(point-uRockyShadowCamera);
  float weight=1.-smoothstep(4096.,6144.,length(point-uRockyShadowReceiver));
  if(weight<=0.)return 1.;
  // Upper exit through the OUTER spherical shell bounds every possible caster.
  // The camera-distance triangle bound includes the largest centre-to-vertex
  // radius. Under full weight, all contributors are inside unfaded render range.
  float along=dot(point,uRockyShadowLight),rr=dot(point,point);
  float shell=uRockyShadowRadius+uRockyShadowOuterReach;
  float exitDistance=max(0.,-along+sqrt(max(0.,along*along+shell*shell-rr)));
  weight*=1.-smoothstep(22528.,24576.,cameraDistance+exitDistance+1024.);
  if(weight<=0.)return 1.;
  vec3 shadow=(uRockyShadowMatrix*vec4(point-uRockyShadowOrigin,1.)).xyz;
  if(any(lessThan(shadow,vec3(0.)))||any(greaterThan(shadow,vec3(1.))))return 1.;
  // The receiver crop stays >256 texels inside the map; fade at an unexpected
  // projection/depth edge as well, rather than clamp an out-of-coverage sample.
  float edge=min(min(shadow.x,1.-shadow.x),min(shadow.y,1.-shadow.y));
  weight*=smoothstep(0.,.015625,edge);
  float visibility=0.;
  for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
    float depth=texture2D(uRockyShadow,shadow.xy+vec2(float(x),float(y))/2048.).r;
    if(uRockyShadowReversed>.5)depth=1.-depth;
    visibility+=step(shadow.z-1./131071.,depth);
  }
  return mix(1.,visibility/9.,weight);
}
`;
const VERTEX=/* glsl */`
in vec3 iRoot,iRow0,iRow1,iRow2;
uniform mat4 uRockyShadowClip;
uniform float uRockyShadowReversed;
void main(){
  // Exact same body-local instance rows and borrowed positions as the main draw.
  vec3 offset=vec3(dot(iRow0,position),dot(iRow1,position),dot(iRow2,position));
  gl_Position=uRockyShadowClip*vec4(iRoot+offset,1.);
  if(uRockyShadowReversed>.5)gl_Position.z=(gl_Position.w-gl_Position.z)*.5;
}`;
const FRAGMENT=/* glsl */`precision highp float;out vec4 shadowColor;void main(){shadowColor=vec4(1.);}`;
/** One local depth owner. Main render geometries/attributes stay borrowed. */
export function createRockyContactShadows(){
  const uniforms=createRockyContactShadowUniforms(),scene=new THREE.Scene(),camera=new THREE.OrthographicCamera();
  const clip=new THREE.Matrix4(),bias=new THREE.Matrix4().set(.5,0,0,.5,0,.5,0,.5,0,0,.5,.5,0,0,0,1);
  const zero=new THREE.Vector3(),light=new THREE.Vector3(),cameraRelative=new THREE.Vector3();
  const clearColor=new THREE.Color(),viewport=new THREE.Vector4(),currentViewport=new THREE.Vector4(),scissor=new THREE.Vector4(),currentScissor=new THREE.Vector4();
  const casters=Array.from({length:8},()=>({mesh:null,geometry:null,count:-1,root:-1,row0:-1,row1:-1,row2:-1,position:-1}));
  const stats={renders:0,instances:0,draws:0,mapSize:2048,span:16384,texel:8,snap:32,bytes:0,bodyId:null,enabled:false,disposed:false};
  let target=null,material=null,disposed=false,valid=false,lastBody=null,tileX=NaN,tileY=NaN,lastReversed=-1;
  function clear(){
    uniforms.uRockyShadowEnabled.value=0;uniforms.uRockyShadow.value=null;valid=false;stats.instances=stats.draws=stats.bytes=0;stats.bodyId=null;stats.enabled=false;
    if(target){target.dispose();target=null;material.dispose();material=null;}
    scene.clear();for(const c of casters){c.mesh=c.geometry=null;c.count=c.root=c.row0=c.row1=c.row2=c.position=-1;}
    lastBody=null;tileX=tileY=NaN;lastReversed=-1;
  }
  function allocate(){
    const depth=new THREE.DepthTexture(2048,2048,THREE.UnsignedIntType);depth.minFilter=depth.magFilter=THREE.NearestFilter;depth.name='Local scanned rocky depth';
    target=new THREE.WebGLRenderTarget(2048,2048,{format:THREE.RedFormat,type:THREE.UnsignedByteType,internalFormat:'R8',minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,generateMipmaps:false,depthTexture:depth,stencilBuffer:false,samples:0});
    material=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:VERTEX,fragmentShader:FRAGMENT,uniforms:{uRockyShadowClip:{value:clip},uRockyShadowReversed:uniforms.uRockyShadowReversed},depthTest:true,depthWrite:true,colorWrite:false,side:THREE.DoubleSide});
    uniforms.uRockyShadow.value=depth;stats.bytes=2048*2048*5;
  }
  function prepare(renderer,rocky){
    if(disposed)return false;
    const state=rocky.userData.shadowState,sources=rocky.userData.shadowSources;
    if(!rocky.visible||!state.body||rocky.userData.stats.instances===0){clear();return false;}
    const body=state.body,reversed=Number(renderer.capabilities.reversedDepthBuffer);light.fromArray(body.light).normalize();
    let dirty=!valid||lastBody!==body.id||!light.equals(uniforms.uRockyShadowLight.value)||reversed!==lastReversed||!uniforms.uRockyShadowOrigin.value.equals(rocky.userData.batchUniforms.uAnchor.value);
    if(!target)allocate();let instances=0,draws=0;
    for(let i=0;i<8;i++){
      const c=casters[i],source=sources[i];if(!source){if(c.mesh)c.mesh.visible=false;continue;}
      const g=source.geometry,a=g.attributes;
      if(c.geometry!==g||c.count!==g.instanceCount||c.root!==a.iRoot.version||c.row0!==a.iRow0.version||c.row1!==a.iRow1.version||c.row2!==a.iRow2.version||c.position!==a.position.version)dirty=true;
      if(!c.mesh){c.mesh=new THREE.Mesh(g,material);c.mesh.frustumCulled=false;scene.add(c.mesh);}else c.mesh.geometry=g;
      c.geometry=g;c.count=g.instanceCount;c.root=a.iRoot.version;c.row0=a.iRow0.version;c.row1=a.iRow1.version;c.row2=a.iRow2.version;c.position=a.position.version;
      c.mesh.visible=g.instanceCount>0;instances+=g.instanceCount;if(g.instanceCount>0)draws++;
    }
    uniforms.uRockyShadowOrigin.value.copy(rocky.userData.batchUniforms.uAnchor.value);
    camera.position.copy(light).multiplyScalar(65536);camera.up.set(0,Math.abs(light.y)>.95?0:1,Math.abs(light.y)>.95?1:0);camera.lookAt(zero);camera.updateMatrixWorld(true);
    uniforms.uRockyShadowReceiver.value.fromArray(state.cameraLocal).normalize().multiplyScalar(body.radius);
    cameraRelative.copy(uniforms.uRockyShadowReceiver.value).sub(uniforms.uRockyShadowOrigin.value).applyMatrix4(camera.matrixWorldInverse);
    const x=Math.round(cameraRelative.x/32),y=Math.round(cameraRelative.y/32);if(x!==tileX||y!==tileY)dirty=true;
    uniforms.uRockyShadowCamera.value.fromArray(state.cameraLocal);uniforms.uRockyShadowRadius.value=body.radius;uniforms.uRockyShadowOuterReach.value=state.outerReach;
    if(!dirty)return false;
    clip.makeOrthographic(x*32-8192,x*32+8192,y*32+8192,y*32-8192,1,131072).multiply(camera.matrixWorldInverse);
    uniforms.uRockyShadowMatrix.value.multiplyMatrices(bias,clip);uniforms.uRockyShadowLight.value.copy(light);uniforms.uRockyShadowReversed.value=reversed;
    uniforms.uRockyShadowEnabled.value=0;valid=false;stats.enabled=false;
    const previousTarget=renderer.getRenderTarget(),cubeFace=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    const autoClear=renderer.autoClear,clearAlpha=renderer.getClearAlpha(),xrEnabled=renderer.xr.enabled;
    renderer.getClearColor(clearColor);renderer.getViewport(viewport);renderer.getScissor(scissor);renderer.getCurrentViewport(currentViewport);
    // Restore the last public producer: target/canvas default or explicit viewport.
    const pixelRatio=renderer.getPixelRatio();
    const targetViewportActive=previousTarget!==null?currentViewport.equals(previousTarget.viewport):
      currentViewport.x===Math.floor(viewport.x*pixelRatio)&&currentViewport.y===Math.floor(viewport.y*pixelRatio)&&
      currentViewport.z===Math.floor(viewport.z*pixelRatio)&&currentViewport.w===Math.floor(viewport.w*pixelRatio);
    const scissorTest=renderer.getScissorTest(),gl=renderer.getContext();currentScissor.fromArray(gl.getParameter(gl.SCISSOR_BOX));const currentScissorTest=gl.isEnabled(gl.SCISSOR_TEST);
    try{renderer.xr.enabled=false;renderer.autoClear=false;renderer.setClearColor(0,0);renderer.setRenderTarget(target);renderer.clear(true,true,false);renderer.render(scene,camera);stats.renders++;}
    finally{renderer.xr.enabled=xrEnabled;renderer.autoClear=autoClear;renderer.setClearColor(clearColor,clearAlpha);if(targetViewportActive)renderer.setViewport(viewport);renderer.setRenderTarget(previousTarget,cubeFace,mip);if(!targetViewportActive)renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);renderer.state.viewport(currentViewport);renderer.state.scissor(currentScissor);renderer.state.setScissorTest(currentScissorTest);}
    lastBody=body.id;tileX=x;tileY=y;lastReversed=reversed;valid=true;uniforms.uRockyShadowEnabled.value=1;stats.enabled=true;stats.bodyId=body.id;stats.instances=instances;stats.draws=draws;return true;
  }
  function dispose(){if(disposed)return;clear();disposed=true;stats.disposed=true;}
  return {uniforms,stats,prepare,clear,dispose};
}
