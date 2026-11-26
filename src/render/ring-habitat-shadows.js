import * as THREE from 'three';
import {RING_HABITAT_TREE_TRANSFORM_GLSL,RING_HABITAT_FOLIAGE_GLSL} from './ring-habitat-vegetation.js';
import {createRingHabitatShadowUniforms} from './ring-habitat-shadow-receiver.js';
export {RING_HABITAT_SHADOW_GLSL,createRingHabitatShadowUniforms} from './ring-habitat-shadow-receiver.js';

const NEAR_SPAN=512,NEAR_TILE=32;

const VERTEX=/* glsl */`
in vec3 iRoot;
in vec4 iShape;
in vec3 iShadowCoverage;
in vec3 treeUV;
flat out float vShadowCoverage,vShadowSeed;
flat out vec2 vShadowInterval;
out vec3 vTreeUV;
uniform vec3 uVegetationShadowOrigin;
uniform mat4 uShadowClip;
uniform float uVegetationShadowReversed;
${RING_HABITAT_TREE_TRANSFORM_GLSL}
void main(){
  vShadowCoverage=iShadowCoverage.x;vShadowInterval=iShadowCoverage.yz;vShadowSeed=iShape.w;
  vTreeUV=treeUV;
  vec3 relative=(iRoot-uVegetationShadowOrigin)+habitatTreeOffset(position,iRoot,iShape);
  gl_Position=uShadowClip*vec4(relative,1.);
  // EXT_clip_control uses [0,1] clip Z and GREATER depth. Receivers keep the
  // conventional projection and decode the sampled depth before comparison.
  if(uVegetationShadowReversed>.5)gl_Position.z=(gl_Position.w-gl_Position.z)*.5;
}`;
const FRAGMENT=/* glsl */`
precision highp float;
uniform vec2 uShadowDitherOffset;
flat in float vShadowCoverage,vShadowSeed;
flat in vec2 vShadowInterval;
in vec3 vTreeUV;
out vec4 shadowColor;
${RING_HABITAT_FOLIAGE_GLSL}
void main(){
  // The vegetation owner supplies BOTH decisions. Independent samples retain
  // overall coverage and complementary LOD intervals without multiplying them.
  if(vShadowCoverage<=0.||vShadowInterval.y<=vShadowInterval.x)discard;
  vec2 texel=floor(gl_FragCoord.xy+uShadowDitherOffset);
  float coverageSample=fract(sin(dot(texel,vec2(12.9898,78.233))+vShadowSeed*23.17)*43758.5453);
  float lodSample=fract(sin(dot(texel,vec2(39.346,11.135))+vShadowSeed*47.91)*47453.5453);
  if(coverageSample>=vShadowCoverage||lodSample<vShadowInterval.x||lodSample>=vShadowInterval.y)discard;
  if(!habitatFoliageMask(vTreeUV))discard;
  shadowColor=vec4(1.);
}
`;

/** Two lazy fixed-size targets per active near-forest slot: the complete master
 * forest and a 512-unit light-space crop centred on the camera. A 32-unit tile
 * snap is exactly 128 texels at 2048, so stable camera motion does not redraw or
 * move the projection. The original complete-forest shadow range is retained.
 * Both draws borrow the current packed render LOD geometries and their owner-
 * supplied coverage/LOD intervals. The complete master is used ONLY for stable
 * projection bounds; invisible master trees never enter the caster scene.
 * Tree-transform and foliage-mask GLSL are shared; the static tree UV attribute
 * and all four foliage uniform records are borrowed from the same vegetation.
 * No copied anchors, separate alpha cutoff or alternate silhouettes are generated.
 * Casters are not culled by the viewing camera frustum.
 *
 * Default budget: 2 x (16 MiB depth + 4 MiB R8), about 40 MiB/active slot;
 * implementation depth storage may vary. Explicit mapSize 1024 costs ~10 MiB
 * total and gives .5-unit near texels; 2048 gives .25-unit near texels. No MSAA,
 * mipmaps or colour writes. clear() releases BOTH maps and the shared material.
 *
 * Call prepare BEFORE the main render after vegetation.update(). Its cameraLocal
 * is the owner's borrowed body-local Vector3, not a camera-following scene mesh.
 * Never install prepare in onBeforeRender: it performs separate renderer draws.
 */
export function createRingHabitatShadows({mapSize=2048,uniforms=createRingHabitatShadowUniforms(mapSize)}={}){
  if(mapSize!==1024&&mapSize!==2048)throw new RangeError('Habitat shadow map size must be 1024 or 2048');
  uniforms.uVegetationShadowTexel.value.set(1/mapSize,1/mapSize);
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera();
  const farClip=new THREE.Matrix4(),nearClip=new THREE.Matrix4();
  const bias=new THREE.Matrix4().set(.5,0,0,.5,0,.5,0,.5,0,0,.5,.5,0,0,0,1);
  const zero=new THREE.Vector3(),extent=new THREE.Vector3(),light=new THREE.Vector3(),cameraRelative=new THREE.Vector3();
  const clearColor=new THREE.Color(),viewport=new THREE.Vector4(),currentViewport=new THREE.Vector4(),scissor=new THREE.Vector4(),currentScissor=new THREE.Vector4();
  const stats={renders:0,farRenders:0,nearRenders:0,instances:0,mapSize,nearSpan:NEAR_SPAN,nearTile:NEAR_TILE};
  let farTarget=null,nearTarget=null,material=null,disposed=false,valid=false;
  // The producer owns exactly the existing three render LODs. These records
  // retain only borrowed geometry references and observed upload versions.
  const casters=Array.from({length:3},()=>({mesh:null,geometry:null,rootVersion:-1,shapeVersion:-1,positionVersion:-1,coverageVersion:-1,count:-1,vertexRadius:0}));
  let previousGeometry=null,rootVersion=-1,shapeVersion=-1,positionVersion=-1,previousCount=-1,previousReversed=-1,maxVertexRadius=0;
  let nearTileX=NaN,nearTileY=NaN;

  function clear(){
    uniforms.uVegetationShadowEnabled.value=0;valid=false;stats.instances=0;
    if(!farTarget)return;
    // Three's target disposal synchronously releases its attached DepthTexture.
    farTarget.dispose();nearTarget.dispose();material.dispose();scene.clear();
    farTarget=null;nearTarget=null;material=null;previousGeometry=null;
    for(const caster of casters){
      caster.mesh=null;caster.geometry=null;caster.vertexRadius=0;
      caster.rootVersion=caster.shapeVersion=caster.positionVersion=caster.coverageVersion=caster.count=-1;
    }
    rootVersion=shapeVersion=positionVersion=previousCount=previousReversed=-1;maxVertexRadius=0;
    nearTileX=nearTileY=NaN;
    uniforms.uVegetationShadow.value=null;uniforms.uVegetationShadowNear.value=null;
    uniforms.uVegetationShadowMatrix.value.identity();uniforms.uVegetationShadowNearMatrix.value.identity();
    uniforms.uVegetationShadowOrigin.value.set(0,0,0);uniforms.uVegetationShadowLight.value.set(0,0,0);
    uniforms.uVegetationShadowBias.value=0;uniforms.uVegetationShadowReversed.value=0;
  }
  function createTarget(name){
    const depth=new THREE.DepthTexture(mapSize,mapSize,THREE.UnsignedIntType);
    depth.minFilter=depth.magFilter=THREE.NearestFilter;depth.name=name;
    const target=new THREE.WebGLRenderTarget(mapSize,mapSize,{
      format:THREE.RedFormat,type:THREE.UnsignedByteType,internalFormat:'R8',
      minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,
      generateMipmaps:false,depthTexture:depth,stencilBuffer:false,samples:0,
    });
    target.texture.name=`${name} unused R8 colour attachment`;
    return target;
  }
  function allocate(foliageUniforms){
    farTarget=createTarget('Complete habitat vegetation depth');nearTarget=createTarget('Near habitat vegetation depth');
    material=new THREE.ShaderMaterial({
      glslVersion:THREE.GLSL3,vertexShader:VERTEX,fragmentShader:FRAGMENT,
      defines:foliageUniforms?.uHasHabitatFoliage.value?{HABITAT_FOLIAGE_MAP:1}:{},
      // Foliage records are constructor-owned by vegetation, including borrowed
      // textures and the game's atlas rectangle. Never clone or dispose them.
      uniforms:{...foliageUniforms,uShadowClip:{value:farClip},uVegetationShadowOrigin:uniforms.uVegetationShadowOrigin,uVegetationShadowReversed:uniforms.uVegetationShadowReversed,uShadowDitherOffset:{value:new THREE.Vector2()}},
      depthTest:true,depthWrite:true,colorWrite:false,side:THREE.DoubleSide,
    });
    uniforms.uVegetationShadow.value=farTarget.depthTexture;uniforms.uVegetationShadowNear.value=nearTarget.depthTexture;
  }

  function prepare(renderer,vegetation,bodyLight){
    if(disposed)return false;
    const source=vegetation.userData.shadowMesh,sources=vegetation.userData.shadowCasters;
    if(!vegetation.visible||!source||source.geometry.instanceCount===0){clear();return false;}
    let total=0;
    for(let i=0;i<sources.length;i++)total+=sources[i].geometry.instanceCount;
    if(total===0){clear();return false;}
    const geometry=source.geometry,roots=geometry.attributes.iRoot,shapes=geometry.attributes.iShape,positions=geometry.attributes.position;
    const count=geometry.instanceCount,reversed=Number(renderer.capabilities.reversedDepthBuffer);
    light.fromArray(bodyLight).normalize();
    const geometryChanged=geometry!==previousGeometry||positions.version!==positionVersion;
    let casterChanged=false,verticesChanged=false;
    if(!farTarget)allocate(vegetation.userData.foliageUniforms);
    for(let i=0;i<sources.length;i++){
      const caster=casters[i],g=sources[i].geometry,a=g.attributes;
      const changedVertices=g!==caster.geometry||a.position.version!==caster.positionVersion;
      if(changedVertices){
        caster.vertexRadius=0;
        for(let j=0;j<a.position.count;j++)caster.vertexRadius=Math.max(caster.vertexRadius,Math.hypot(a.position.getX(j),a.position.getY(j),a.position.getZ(j)));
        verticesChanged=true;
      }
      if(changedVertices||a.iRoot.version!==caster.rootVersion||a.iShape.version!==caster.shapeVersion||a.iShadowCoverage.version!==caster.coverageVersion||g.instanceCount!==caster.count)casterChanged=true;
      if(!caster.mesh){caster.mesh=new THREE.Mesh(g,material);caster.mesh.frustumCulled=false;scene.add(caster.mesh);}
      else caster.mesh.geometry=g;
      caster.geometry=g;caster.positionVersion=a.position.version;caster.rootVersion=a.iRoot.version;caster.shapeVersion=a.iShape.version;
      caster.coverageVersion=a.iShadowCoverage.version;caster.count=g.instanceCount;
      caster.mesh.visible=g.instanceCount>0;
    }
    const boundsChanged=!valid||geometryChanged||verticesChanged||roots.version!==rootVersion||shapes.version!==shapeVersion||count!==previousCount||!light.equals(uniforms.uVegetationShadowLight.value)||reversed!==previousReversed;
    const farChanged=boundsChanged||casterChanged;
    if(boundsChanged){
      maxVertexRadius=0;
      for(let i=0;i<casters.length;i++)maxVertexRadius=Math.max(maxVertexRadius,casters[i].vertexRadius);
      let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity,maxTree=0;
      for(let i=0;i<count;i++){
        const x=roots.getX(i),y=roots.getY(i),z=roots.getZ(i);
        minX=Math.min(minX,x);minY=Math.min(minY,y);minZ=Math.min(minZ,z);
        maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);maxZ=Math.max(maxZ,z);
        maxTree=Math.max(maxTree,shapes.getX(i)*Math.max(1,shapes.getY(i))*maxVertexRadius);
      }
      uniforms.uVegetationShadowOrigin.value.set((minX+maxX)*.5,(minY+maxY)*.5,(minZ+maxZ)*.5);
      extent.set((maxX-minX)*.5+maxTree,(maxY-minY)*.5+maxTree,(maxZ-minZ)*.5+maxTree);
      const reach=extent.length()+1;
      camera.position.copy(light).multiplyScalar(reach);
      camera.up.set(0,Math.abs(light.y)>.95?0:1,Math.abs(light.y)>.95?1:0);
      camera.lookAt(zero);camera.updateMatrixWorld(true);
      const e=camera.matrixWorldInverse.elements;
      const width=Math.abs(e[0])*extent.x+Math.abs(e[4])*extent.y+Math.abs(e[8])*extent.z+1;
      const height=Math.abs(e[1])*extent.x+Math.abs(e[5])*extent.y+Math.abs(e[9])*extent.z+1;
      camera.near=.1;camera.far=reach*2+1;
      // Explicit conventional projection, independent of Three's reversed camera.
      farClip.makeOrthographic(-width,width,height,-height,camera.near,camera.far).multiply(camera.matrixWorldInverse);
      uniforms.uVegetationShadowMatrix.value.multiplyMatrices(bias,farClip);
      uniforms.uVegetationShadowLight.value.copy(light);uniforms.uVegetationShadowReversed.value=reversed;
      uniforms.uVegetationShadowBias.value=.12/(camera.far-camera.near);
    }
    cameraRelative.copy(vegetation.userData.cameraLocal).sub(uniforms.uVegetationShadowOrigin.value).applyMatrix4(camera.matrixWorldInverse);
    const tileX=Math.round(cameraRelative.x/NEAR_TILE),tileY=Math.round(cameraRelative.y/NEAR_TILE);
    const nearChanged=farChanged||tileX!==nearTileX||tileY!==nearTileY;
    if(!nearChanged)return false;
    const x=tileX*NEAR_TILE,y=tileY*NEAR_TILE,half=NEAR_SPAN*.5;
    nearClip.makeOrthographic(x-half,x+half,y+half,y-half,camera.near,camera.far).multiply(camera.matrixWorldInverse);
    uniforms.uVegetationShadowNearMatrix.value.multiplyMatrices(bias,nearClip);
    // A failed new draw must not expose a stale map with a changed projection.
    uniforms.uVegetationShadowEnabled.value=0;valid=false;
    const previousTarget=renderer.getRenderTarget(),cubeFace=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    const autoClear=renderer.autoClear,clearAlpha=renderer.getClearAlpha(),xrEnabled=renderer.xr.enabled;
    renderer.getClearColor(clearColor);renderer.getViewport(viewport);renderer.getScissor(scissor);renderer.getCurrentViewport(currentViewport);
    const scissorTest=renderer.getScissorTest(),gl=renderer.getContext();
    currentScissor.fromArray(gl.getParameter(gl.SCISSOR_BOX));const currentScissorTest=gl.isEnabled(gl.SCISSOR_TEST);
    try{
      renderer.xr.enabled=false;renderer.autoClear=false;renderer.setClearColor(0,0);
      if(farChanged){
        material.uniforms.uShadowClip.value=farClip;material.uniforms.uShadowDitherOffset.value.set(-mapSize*.5,-mapSize*.5);renderer.setRenderTarget(farTarget);
        renderer.clear(true,true,false);renderer.render(scene,camera);stats.farRenders++;stats.renders++;
      }
      material.uniforms.uShadowClip.value=nearClip;material.uniforms.uShadowDitherOffset.value.set((x-half)*mapSize/NEAR_SPAN,(y-half)*mapSize/NEAR_SPAN);renderer.setRenderTarget(nearTarget);
      renderer.clear(true,true,false);renderer.render(scene,camera);stats.nearRenders++;stats.renders++;
    }finally{
      renderer.xr.enabled=xrEnabled;renderer.autoClear=autoClear;renderer.setClearColor(clearColor,clearAlpha);
      renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);
      renderer.setRenderTarget(previousTarget,cubeFace,mip);
      renderer.state.viewport(currentViewport);renderer.state.scissor(currentScissor);renderer.state.setScissorTest(currentScissorTest);
    }
    previousGeometry=geometry;rootVersion=roots.version;shapeVersion=shapes.version;positionVersion=positions.version;
    previousCount=count;previousReversed=reversed;nearTileX=tileX;nearTileY=tileY;valid=true;
    uniforms.uVegetationShadowEnabled.value=1;stats.instances=total;
    return true;
  }
  function dispose(){if(disposed)return;disposed=true;clear();}
  return {uniforms,stats,prepare,clear,dispose};
}
