import * as THREE from 'three';
import {RING_HABITAT_TREE_TRANSFORM_GLSL,RING_HABITAT_FOLIAGE_GLSL} from './ring-habitat-vegetation.js';
import {createRingHabitatShadowUniforms,RING_HABITAT_SHADOW_TRIANGLE_FETCH_GLSL} from './ring-habitat-shadow-receiver.js';

const NEAR_SPAN=512,NEAR_TILE=32;
// Terrain IDs identify the actual finite caster triangle. PCF receivers
// test that triangle, rather than extending its plane across texel boundaries.
const TERRAIN_VERTEX=/* glsl */`
uniform highp sampler2D uTerrainTriangles;
uniform int uTerrainTriangleWidth,uTerrainFirstVertex;
uniform mat3 uTriangleShadowLinear;
uniform vec3 uTriangleShadowOriginHi,uTriangleShadowOriginLo;
uniform float uVegetationShadowReversed;
flat out float vTerrainFaceId;
${RING_HABITAT_SHADOW_TRIANGLE_FETCH_GLSL}
void main(){
 int corner=uTerrainFirstVertex+gl_VertexID;
 vec4 encoded=habitatShadowIndexedVertex(uTerrainTriangles,uTerrainTriangleWidth,corner);
 vec3 relative=(encoded.xyz-uTriangleShadowOriginHi)+(habitatShadowResidual(encoded)-uTriangleShadowOriginLo);
 vTerrainFaceId=float(corner/3+1);
 gl_Position=vec4(uTriangleShadowLinear*relative,1.);
 if(uVegetationShadowReversed>.5)gl_Position.z=(gl_Position.w-gl_Position.z)*.5;
}`;
const TERRAIN_FRAGMENT=/* glsl */`
precision highp float;
out vec4 shadowColor;
flat in float vTerrainFaceId;
void main(){shadowColor=vec4(gl_FragCoord.z,vTerrainFaceId,0.,1.);}`;


const VERTEX=/* glsl */`
in vec3 iRoot,iShadowRoot;
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
  vec3 relative=iShadowRoot+habitatTreeOffset(position,iRoot,iShape);
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
  shadowColor=vec4(gl_FragCoord.z,0.,0.,1.);
}
`;

/** Two lazy fixed-size targets per active habitat: complete caster bounds and
 * a near crop fitted to the prepared visible close receiver footprint. Its
 * minimum512L span retains.25L texels at2048. The span/16 center snap is128
 * texels; unchanged guarded views reuse their projection and raster contents.
 * Both maps retain complete caster geometry and the same full depth interval.
 * Both draws borrow the current packed render LOD geometries and their owner-
 * supplied coverage/LOD intervals. The complete master is used ONLY for stable
 * projection bounds; invisible master trees never enter the caster scene.
 * Tree-transform and foliage-mask GLSL are shared; the static tree UV attribute
 * and all four foliage uniform records are borrowed from the same vegetation.
 * No copied anchors, separate alpha cutoff or alternate silhouettes are generated.
 * Casters are not culled by the viewing camera frustum.
 *
 * One view owner holds2 x (16MiB depth +32MiB RG32F),96MiB total;
 * implementation depth storage may vary. Explicit mapSize1024 costs24MiB
 * total and gives.5L minimum-span texels;2048 gives.25L minimum-span texels. No MSAA or
 * mipmaps. Colour stores nearest depth and its finite terrain triangle ID. clear() releases BOTH maps and the shared material.
 *
 * Call prepare BEFORE the main render after vegetation.update(). Its cameraLocal
 * is the owner's borrowed body-local Vector3, not a camera-following scene mesh.
 * Never install prepare in onBeforeRender: it performs separate renderer draws.
 */
export function createRingHabitatRegionShadows({mapSize=2048,uniforms=createRingHabitatShadowUniforms(mapSize)}={}){
  if(mapSize!==1024&&mapSize!==2048)throw new RangeError('Habitat shadow map size must be 1024 or 2048');
  uniforms.uVegetationShadowTexel.value.set(1/mapSize,1/mapSize);
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera();
  const farClip=new THREE.Matrix4(),nearClip=new THREE.Matrix4(),farTriangleClip=new THREE.Matrix4(),nearTriangleClip=new THREE.Matrix4(),triangleToRelative=new THREE.Matrix4(),inverseTriangleBasis=new THREE.Matrix3();
  const bias=new THREE.Matrix4().set(.5,0,0,.5,0,.5,0,.5,0,0,.5,.5,0,0,0,1);
  const zero=new THREE.Vector3(),extent=new THREE.Vector3(),light=new THREE.Vector3(),cameraRelative=new THREE.Vector3();
  const receiverLight=new THREE.Vector3(),projectedCamera=new THREE.Vector3(),clipOrigin=new THREE.Vector3(),clipInverse=new THREE.Matrix4();
  const receiverView=new THREE.Matrix3(),receiverViewToLight=new THREE.Matrix3(),receiverWorldToBody=new THREE.Matrix3(),receiverBodyToWorld=new THREE.Matrix3();
  const receiverLastPosition=new THREE.Vector3(Infinity,Infinity,Infinity),receiverLastRotation=new THREE.Quaternion(),receiverPoint=new THREE.Vector3(),receiverAB=new THREE.Vector3(),receiverAC=new THREE.Vector3(),receiverNormal=new THREE.Vector3(),receiverA=new THREE.Vector3(),receiverB=new THREE.Vector3(),receiverC=new THREE.Vector3(),receiverClosest=new THREE.Vector3(),receiverTriangle=new THREE.Triangle(receiverA,receiverB,receiverC);
  const receiverStack=new Int32Array(32),receiverBodyPlanes=new Float64Array(24);
  const clipA=new Float64Array(36),clipB=new Float64Array(36),receiverPlanes=new Float64Array([1,0,0,0,-1,0,0,0,0,1,0,0,0,-1,0,0,0,0,-1,0,0,0,1,0]);
  let receiverSpan=NEAR_SPAN,receiverFocusX=0,receiverFocusY=0,receiverDepth=NEAR_SPAN,receiverViewValid=false;
  let receiverMinX=Infinity,receiverMinY=Infinity,receiverMaxX=-Infinity,receiverMaxY=-Infinity,receiverTests=0,receiverBoundsTests=0;
  const receiverBoundsCenter=new THREE.Vector3(),receiverBoundsExtent=new THREE.Vector3();
  const farLinear=new THREE.Matrix3(),nearLinear=new THREE.Matrix3(),farOriginHi=new THREE.Vector3(),farOriginLo=new THREE.Vector3(),nearOriginHi=new THREE.Vector3(),nearOriginLo=new THREE.Vector3();
  function split(value,hi,lo){hi.set(Math.fround(value.x),Math.fround(value.y),Math.fround(value.z));lo.set(value.x-hi.x,value.y-hi.y,value.z-hi.z);}
  function updateReceiverAnchors(vegetation){
    receiverLight.copy(vegetation.userData.cameraLocal).sub(uniforms.uVegetationShadowTriangleOrigin.value).applyMatrix3(uniforms.uVegetationShadowTriangleBasis.value);
    split(receiverLight,uniforms.uVegetationShadowReceiverHi.value,uniforms.uVegetationShadowReceiverLo.value);
    projectedCamera.copy(vegetation.userData.cameraLocal).sub(uniforms.uVegetationShadowOrigin.value);
    uniforms.uVegetationShadowNearCameraProjected.value.copy(projectedCamera).applyMatrix4(uniforms.uVegetationShadowNearMatrix.value);
    uniforms.uVegetationShadowFarCameraProjected.value.copy(projectedCamera).applyMatrix4(uniforms.uVegetationShadowMatrix.value);
  }
  function clipRepresentation(matrix,linear,hi,lo){
    linear.setFromMatrix4(matrix);clipInverse.copy(matrix).invert();clipOrigin.set(0,0,0).applyMatrix4(clipInverse);split(clipOrigin,hi,lo);
  }
  const clearColor=new THREE.Color(),viewport=new THREE.Vector4(),currentViewport=new THREE.Vector4(),scissor=new THREE.Vector4(),currentScissor=new THREE.Vector4();
  const stats={renders:0,farRenders:0,nearRenders:0,instances:0,mapSize,nearSpan:NEAR_SPAN,nearTile:NEAR_TILE};
  let farTarget=null,nearTarget=null,material=null,disposed=false,valid=false;
  // The producer owns exactly the existing three render LODs. These records
  // retain only borrowed geometry references and observed upload versions.
  const casters=Array.from({length:3},()=>({mesh:null,geometry:null,rootVersion:-1,shapeVersion:-1,positionVersion:-1,coverageVersion:-1,count:-1,vertexRadius:0}));
  let previousGeometry=null,rootVersion=-1,shapeVersion=-1,positionVersion=-1,previousCount=-1,previousReversed=-1,maxVertexRadius=0;
  let nearTileX=NaN,nearTileY=NaN;
  let terrainSource=null,terrainRevision=-1;
  const terrainCasters=[];
  stats.terrainGroups=0;stats.terrainFaces=0;stats.terrainMaterialDisposals=0;
  stats.shadowWorldBias=.12;stats.terrainBounds=null;
  stats.receiverUpdates=0;stats.receiverTriangles=0;stats.receiverNearestTriangles=0;stats.receiverScanMs=0;stats.receiverIndexBytes=0;stats.receiverIndexMs=0;stats.receiverBoundsTests=0;
  function boundsDistance(c,p){return Math.hypot(Math.max(c.minX-p.x,0,p.x-c.maxX),Math.max(c.minY-p.y,0,p.y-c.maxY),Math.max(c.minZ-p.z,0,p.z-c.maxZ));}
  function sourceTriangle(caster,i){const g=caster.source.geometry,p=g.attributes.position,index=g.index,c=caster.center;let n=index?index.getX(i):i;receiverA.set(p.getX(n)+c.x,p.getY(n)+c.y,p.getZ(n)+c.z);n=index?index.getX(i+1):i+1;receiverB.set(p.getX(n)+c.x,p.getY(n)+c.y,p.getZ(n)+c.z);n=index?index.getX(i+2):i+2;receiverC.set(p.getX(n)+c.x,p.getY(n)+c.y,p.getZ(n)+c.z);}
  function fitReceivers(vegetation,force){
    const input=terrainSource.userData.receiverCamera,bodyFrame=terrainSource.userData.receiverBodyFrame;
    if(!input||!bodyFrame)throw new TypeError('Adaptive habitat shadow crop requires the authoritative receiver camera/body frame');
    const p=vegetation.userData.cameraLocal,rotation=input.quaternion;
    // Refit only after an existing128-texel tile translation, a footprint guard
    // rotation, or actual geometry/light change. Stable frames allocate nothing.
    const tile=receiverSpan/16,angle=Math.atan(receiverSpan*.025/Math.max(receiverDepth,1));
    if(receiverViewValid&&!force&&p.distanceToSquared(receiverLastPosition)<tile*tile&&rotation.angleTo(receiverLastRotation)<angle)return false;
    const started=performance.now();receiverLastPosition.copy(p);receiverLastRotation.copy(rotation);receiverViewValid=true;
    let nearest=Infinity,nearestTests=0;
    // Prepared physical regions own nearby altitude. If none exists, use the
    // same prepared display triangles, never a second analytic height surface.
    let physical=false;for(const c of terrainCasters)if(c.source.userData.canonicalMesh&&(c.source.geometry.index?c.source.geometry.index.count:c.source.geometry.attributes.position.count)>0){physical=true;break;}
    for(const c of terrainCasters){if(physical&&!c.source.userData.canonicalMesh)continue;if(boundsDistance(c,p)>nearest)continue;const g=c.source.geometry,canonical=c.source.userData.canonicalMesh,count=g.index?g.index.count:g.attributes.position.count;
      if(canonical){let top=0;receiverStack[top++]=0;while(top){const node=canonical.nodes[receiverStack[--top]],pad=c.floatPad,dx=Math.max(node.min[0]+c.center.x-pad-p.x,0,p.x-node.max[0]-c.center.x-pad),dy=Math.max(node.min[1]+c.center.y-pad-p.y,0,p.y-node.max[1]-c.center.y-pad),dz=Math.max(node.min[2]+c.center.z-pad-p.z,0,p.z-node.max[2]-c.center.z-pad);if(dx*dx+dy*dy+dz*dz>nearest*nearest)continue;
        if(node.count){for(let j=node.start;j<node.start+node.count;j++){sourceTriangle(c,canonical.triangleOrder[j]*3);receiverTriangle.closestPointToPoint(p,receiverClosest);nearest=Math.min(nearest,receiverClosest.distanceTo(p));nearestTests++;}}
        else{receiverStack[top++]=node.right;receiverStack[top++]=node.left;}
      }}else for(let i=0;i<count;i+=3){sourceTriangle(c,i);receiverTriangle.closestPointToPoint(p,receiverClosest);nearest=Math.min(nearest,receiverClosest.distanceTo(p));nearestTests++;}
    }
    if(!Number.isFinite(nearest))throw new Error('Prepared habitat receiver geometry contains no surface');
    // Eight nearest-surface distances cover the close receiver footprint. At
    // ground level the original512L crop remains the minimum precision tier.
    receiverDepth=Math.max(input.near,nearest*8);
    receiverWorldToBody.fromArray(bodyFrame);receiverBodyToWorld.copy(receiverWorldToBody).transpose();receiverView.setFromMatrix4(input.matrixWorldInverse).multiply(receiverBodyToWorld);receiverViewToLight.copy(receiverView).transpose().premultiply(uniforms.uVegetationShadowTriangleBasis.value);
    const tanY=1/input.projectionMatrix.elements[5],tanX=1/input.projectionMatrix.elements[0];
    receiverPlanes[2]=receiverPlanes[6]=-tanX;receiverPlanes[10]=receiverPlanes[14]=-tanY;receiverPlanes[19]=-input.near;receiverPlanes[23]=receiverDepth;
    const planeMatrix=receiverView.elements;for(let plane=0;plane<6;plane++){const i=plane*4,x=receiverPlanes[i],y=receiverPlanes[i+1],z=receiverPlanes[i+2];receiverBodyPlanes[i]=x*planeMatrix[0]+y*planeMatrix[1]+z*planeMatrix[2];receiverBodyPlanes[i+1]=x*planeMatrix[3]+y*planeMatrix[4]+z*planeMatrix[5];receiverBodyPlanes[i+2]=x*planeMatrix[6]+y*planeMatrix[7]+z*planeMatrix[8];receiverBodyPlanes[i+3]=receiverPlanes[i+3];}
    receiverMinX=receiverMinY=Infinity;receiverMaxX=receiverMaxY=-Infinity;receiverTests=receiverBoundsTests=0;
    for(const caster of terrainCasters){if(boundsDistance(caster,p)>receiverDepth*Math.sqrt(1+tanX*tanX+tanY*tanY))continue;const g=caster.source.geometry,count=g.index?g.index.count:g.attributes.position.count;
      const canonical=caster.source.userData.canonicalMesh;
      if(canonical){let top=0;receiverStack[top++]=0;while(top){const node=canonical.nodes[receiverStack[--top]];if(!receiverNodeVisible(node.min[0]+caster.center.x,node.min[1]+caster.center.y,node.min[2]+caster.center.z,node.max[0]+caster.center.x,node.max[1]+caster.center.y,node.max[2]+caster.center.z,caster.floatPad))continue;if(node.count){for(let j=node.start;j<node.start+node.count;j++)clipReceiverTriangle(caster,canonical.triangleOrder[j]*3);}else{receiverStack[top++]=node.right;receiverStack[top++]=node.left;}}}
      else{const blocks=caster.receiverBlocks;for(let block=0;block<blocks.length;block+=6){if(!receiverNodeVisible(blocks[block],blocks[block+1],blocks[block+2],blocks[block+3],blocks[block+4],blocks[block+5],0))continue;const start=block/6*64*3,end=Math.min(count,start+64*3);for(let i=start;i<end;i+=3)clipReceiverTriangle(caster,i);}}
    }
    const minX=receiverMinX,minY=receiverMinY,maxX=receiverMaxX,maxY=receiverMaxY,tests=receiverTests;stats.receiverBoundsTests=receiverBoundsTests;
    // A sky-only frustum has no surface to fit; retain the original camera crop.
    if(minX===Infinity){receiverSpan=NEAR_SPAN;receiverFocusX=cameraRelative.x;receiverFocusY=cameraRelative.y;}
    else{const extent=Math.max(maxX-minX,maxY-minY);receiverSpan=NEAR_SPAN*2**Math.max(0,Math.ceil(Math.log2(extent/(NEAR_SPAN*.75))));receiverFocusX=cameraRelative.x+(minX+maxX)*.5;receiverFocusY=cameraRelative.y+(minY+maxY)*.5;}
    stats.receiverUpdates++;stats.receiverTriangles=tests;stats.receiverNearestTriangles=nearestTests;stats.receiverScanMs=performance.now()-started;stats.receiverGroundDistance=nearest;stats.receiverDepth=receiverDepth;stats.receiverFootprintWidth=maxX-minX;stats.receiverFootprintHeight=maxY-minY;stats.nearSpan=receiverSpan;stats.nearTile=receiverSpan/16;stats.nearTexel=receiverSpan/mapSize;
    return true;
  }
  // Same prepared physical BVH, padded only for its actual Float32 upload.
  // A linear-plane support bound rejects only nodes wholly outside the exact
  // view frustum. Surviving leaves use unchanged F32 triangle clipping.
  function receiverNodeVisible(minX,minY,minZ,maxX,maxY,maxZ,pad){
    receiverBoundsTests++;receiverBoundsCenter.set((minX+maxX)*.5-receiverLastPosition.x,(minY+maxY)*.5-receiverLastPosition.y,(minZ+maxZ)*.5-receiverLastPosition.z);receiverBoundsExtent.set((maxX-minX)*.5+pad,(maxY-minY)*.5+pad,(maxZ-minZ)*.5+pad);for(let plane=0;plane<6;plane++){const i=plane*4,nx=receiverBodyPlanes[i],ny=receiverBodyPlanes[i+1],nz=receiverBodyPlanes[i+2];if(nx*receiverBoundsCenter.x+ny*receiverBoundsCenter.y+nz*receiverBoundsCenter.z+receiverBodyPlanes[i+3]+Math.abs(nx)*receiverBoundsExtent.x+Math.abs(ny)*receiverBoundsExtent.y+Math.abs(nz)*receiverBoundsExtent.z<0)return false;}
    return true;
  }
  function clipReceiverTriangle(caster,i){sourceTriangle(caster,i);receiverNormal.crossVectors(receiverAB.subVectors(receiverB,receiverA),receiverAC.subVectors(receiverC,receiverA));receiverPoint.subVectors(receiverLastPosition,receiverA);if(receiverNormal.dot(receiverPoint)<=0)return;receiverA.sub(receiverLastPosition).applyMatrix3(receiverView).toArray(clipA,0);receiverB.sub(receiverLastPosition).applyMatrix3(receiverView).toArray(clipA,3);receiverC.sub(receiverLastPosition).applyMatrix3(receiverView).toArray(clipA,6);let source=clipA,dest=clipB,n=3;receiverTests++;
        for(let plane=0;plane<6&&n;plane++){const o=plane*4,nx=receiverPlanes[o],ny=receiverPlanes[o+1],nz=receiverPlanes[o+2],d=receiverPlanes[o+3];let written=0,previous=(n-1)*3,px=source[previous],py=source[previous+1],pz=source[previous+2],pd=nx*px+ny*py+nz*pz+d;
          for(let k=0;k<n;k++){const j=k*3,x=source[j],y=source[j+1],z=source[j+2],distance=nx*x+ny*y+nz*z+d;if((distance>=0)!==(pd>=0)){const ratio=pd/(pd-distance),offset=written++*3;dest[offset]=px+(x-px)*ratio;dest[offset+1]=py+(y-py)*ratio;dest[offset+2]=pz+(z-pz)*ratio;}if(distance>=0){const offset=written++*3;dest[offset]=x;dest[offset+1]=y;dest[offset+2]=z;}px=x;py=y;pz=z;pd=distance;}
          n=written;const swap=source;source=dest;dest=swap;
        }
        for(let k=0;k<n;k++){receiverPoint.fromArray(source,k*3).applyMatrix3(receiverViewToLight);receiverMinX=Math.min(receiverMinX,receiverPoint.x);receiverMaxX=Math.max(receiverMaxX,receiverPoint.x);receiverMinY=Math.min(receiverMinY,receiverPoint.y);receiverMaxY=Math.max(receiverMaxY,receiverPoint.y);}
  }
  const clearTerrain=()=>{
    for(const caster of terrainCasters){scene.remove(caster.mesh);caster.mesh.material.dispose();caster.mesh.geometry.dispose();stats.terrainMaterialDisposals++;}
    terrainCasters.length=0;terrainRevision=-1;stats.terrainGroups=0;stats.terrainFaces=0;stats.terrainBounds=null;stats.receiverIndexBytes=0;
  };
  const setTerrainCasters=group=>{terrainSource=group;};
  const syncTerrain=()=>{
    const revision=terrainSource?terrainSource.userData.stats.builds:-1;
    if(revision===terrainRevision)return false;
    clearTerrain();terrainRevision=revision;
    if(terrainSource)for(const source of terrainSource.children){
      const geometry=source.geometry,position=geometry.attributes.position,center=source.material.uniforms.uHaloTileCenter.value;
      const localUniforms={uTriangleShadowLinear:{value:farLinear},uTriangleShadowOriginHi:{value:farOriginHi},uTriangleShadowOriginLo:{value:farOriginLo},uVegetationShadowReversed:uniforms.uVegetationShadowReversed,uTerrainTriangles:uniforms.uVegetationShadowTriangles,uTerrainTriangleWidth:uniforms.uVegetationShadowTriangleWidth,uTerrainFirstVertex:source.material.uniforms.uHaloFirstShadowVertex};
      const terrainMaterial=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:TERRAIN_VERTEX,fragmentShader:TERRAIN_FRAGMENT,uniforms:localUniforms,side:THREE.DoubleSide,depthTest:true,depthWrite:true,colorWrite:true});
      const pullGeometry=new THREE.BufferGeometry();pullGeometry.setDrawRange(0,geometry.index?geometry.index.count:position.count);const mesh=new THREE.Mesh(pullGeometry,terrainMaterial);mesh.name='Canonical terrain shadow caster';mesh.frustumCulled=false;
      let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
      for(let i=0;i<position.count;i++){const x=center.x+position.getX(i),y=center.y+position.getY(i),z=center.z+position.getZ(i);minX=Math.min(minX,x);minY=Math.min(minY,y);minZ=Math.min(minZ,z);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);maxZ=Math.max(maxZ,z);}
      const indexStarted=performance.now(),canonical=source.userData.canonicalMesh;let receiverBlocks=null,floatPad=0;
      if(canonical){for(let axis=0;axis<3;axis++){const magnitude=Math.max(Math.abs(canonical.nodes[0].min[axis]),Math.abs(canonical.nodes[0].max[axis]));if(magnitude>0)floatPad=Math.max(floatPad,2**(Math.floor(Math.log2(magnitude))-24));}}
      else{const index=geometry.index,count=index?index.count:position.count;receiverBlocks=new Float64Array(Math.ceil(count/(64*3))*6);for(let block=0;block<receiverBlocks.length;block+=6){receiverBlocks[block]=receiverBlocks[block+1]=receiverBlocks[block+2]=Infinity;receiverBlocks[block+3]=receiverBlocks[block+4]=receiverBlocks[block+5]=-Infinity;const start=block/6*64*3,end=Math.min(count,start+64*3);for(let k=start;k<end;k++){const vertex=index?index.getX(k):k,x=center.x+position.getX(vertex),y=center.y+position.getY(vertex),z=center.z+position.getZ(vertex);receiverBlocks[block]=Math.min(receiverBlocks[block],x);receiverBlocks[block+1]=Math.min(receiverBlocks[block+1],y);receiverBlocks[block+2]=Math.min(receiverBlocks[block+2],z);receiverBlocks[block+3]=Math.max(receiverBlocks[block+3],x);receiverBlocks[block+4]=Math.max(receiverBlocks[block+4],y);receiverBlocks[block+5]=Math.max(receiverBlocks[block+5],z);}}stats.receiverIndexBytes+=receiverBlocks.byteLength;}
      stats.receiverIndexMs+=performance.now()-indexStarted;
      terrainCasters.push({mesh,source,center,receiverBlocks,floatPad,minX,minY,minZ,maxX,maxY,maxZ});scene.add(mesh);stats.terrainGroups++;stats.terrainFaces+=(geometry.index?geometry.index.count:position.count)/3;
    }
    return true;
  };

  function clear(){
    uniforms.uVegetationShadowEnabled.value=0;valid=false;stats.instances=0;stats.mapBytes=0;clearTerrain();
    if(!farTarget)return;
    // Three's target disposal synchronously releases its attached DepthTexture.
    farTarget.dispose();nearTarget.dispose();material.dispose();scene.clear();
    farTarget=null;nearTarget=null;material=null;previousGeometry=null;
    for(const caster of casters){
      caster.mesh=null;caster.geometry=null;caster.vertexRadius=0;
      caster.rootVersion=caster.shapeVersion=caster.positionVersion=caster.coverageVersion=caster.count=-1;
    }
    rootVersion=shapeVersion=positionVersion=previousCount=previousReversed=-1;maxVertexRadius=0;
    nearTileX=nearTileY=NaN;receiverViewValid=false;
    uniforms.uVegetationShadow.value=null;uniforms.uVegetationShadowNear.value=null;
    uniforms.uVegetationShadowMatrix.value.identity();uniforms.uVegetationShadowNearMatrix.value.identity();
    uniforms.uVegetationShadowCameraRelative.value.set(0,0,0);
    uniforms.uVegetationShadowReceiverHi.value.set(0,0,0);uniforms.uVegetationShadowReceiverLo.value.set(0,0,0);
    uniforms.uVegetationShadowNearCameraProjected.value.set(0,0,0);uniforms.uVegetationShadowFarCameraProjected.value.set(0,0,0);
    uniforms.uVegetationShadowOrigin.value.set(0,0,0);uniforms.uVegetationShadowLight.value.set(0,0,0);
    uniforms.uVegetationShadowBias.value=0;uniforms.uVegetationShadowReversed.value=0;
  }
  function createTarget(name){
    const depth=new THREE.DepthTexture(mapSize,mapSize,THREE.UnsignedIntType);
    depth.minFilter=depth.magFilter=THREE.NearestFilter;depth.name=name;
    const target=new THREE.WebGLRenderTarget(mapSize,mapSize,{
      format:THREE.RGFormat,type:THREE.FloatType,internalFormat:'RG32F',
      minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,
      generateMipmaps:false,depthTexture:depth,stencilBuffer:false,samples:0,
    });
    target.texture.name=`${name} depth and finite triangle ID`;
    return target;
  }
  function allocate(foliageUniforms,renderer){
    if(!renderer.extensions.has('EXT_color_buffer_float'))throw new Error('Canonical terrain shadows require EXT_color_buffer_float; no fallback');
    farTarget=createTarget('Complete habitat vegetation depth');nearTarget=createTarget('Near habitat vegetation depth');
    material=new THREE.ShaderMaterial({
      glslVersion:THREE.GLSL3,vertexShader:VERTEX,fragmentShader:FRAGMENT,
      defines:foliageUniforms?.uHasHabitatFoliage.value?{HABITAT_FOLIAGE_MAP:1}:{},
      // Foliage records are constructor-owned by vegetation, including borrowed
      // textures and the game's atlas rectangle. Never clone or dispose them.
      uniforms:{...foliageUniforms,uShadowClip:{value:farClip},uVegetationShadowOrigin:uniforms.uVegetationShadowOrigin,uVegetationShadowReversed:uniforms.uVegetationShadowReversed,uShadowDitherOffset:{value:new THREE.Vector2()}},
      depthTest:true,depthWrite:true,colorWrite:true,side:THREE.DoubleSide,
    });
    uniforms.uVegetationShadow.value=farTarget.texture;uniforms.uVegetationShadowNear.value=nearTarget.texture;
    uniforms.uVegetationShadowTriangleAware.value=1;stats.mapColourFormat='RG32F';stats.mapBytes=mapSize*mapSize*(8+4)*2;
  }

  function prepare(renderer,vegetation,bodyLight){
    if(disposed)return false;
    const source=vegetation.userData.shadowMesh,sources=vegetation.userData.shadowCasters;
    const hasForest=Boolean(vegetation.visible&&source&&source.geometry.instanceCount>0),hasTerrain=Boolean(terrainSource&&terrainSource.children.length>0);
    if(!hasForest&&!hasTerrain){clear();return false;}
    let total=0;
    if(hasForest)for(let i=0;i<sources.length;i++)total+=sources[i].geometry.instanceCount;
    if(total===0&&!hasTerrain){clear();return false;}
    const geometry=hasForest?source.geometry:null,roots=geometry?geometry.attributes.iRoot:null,shapes=geometry?geometry.attributes.iShape:null,positions=geometry?geometry.attributes.position:null;
    const count=geometry?geometry.instanceCount:0,reversed=Number(renderer.capabilities.reversedDepthBuffer);
    light.fromArray(bodyLight).normalize();
    const geometryChanged=geometry!==previousGeometry||(positions!==null&&positions.version!==positionVersion);
    let casterChanged=false,verticesChanged=false;
    if(!farTarget)allocate(vegetation.userData.foliageUniforms,renderer);
    const terrainChanged=syncTerrain();
    for(let i=0;hasForest&&i<sources.length;i++){
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
    if(!hasForest)for(const caster of casters)if(caster.mesh){if(caster.mesh.visible)casterChanged=true;caster.mesh.visible=false;}
    const boundsChanged=terrainChanged||!valid||geometryChanged||verticesChanged||(roots?roots.version:-1)!==rootVersion||(shapes?shapes.version:-1)!==shapeVersion||count!==previousCount||!light.equals(uniforms.uVegetationShadowLight.value)||reversed!==previousReversed;
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
      for(const caster of terrainCasters){minX=Math.min(minX,caster.minX);minY=Math.min(minY,caster.minY);minZ=Math.min(minZ,caster.minZ);maxX=Math.max(maxX,caster.maxX);maxY=Math.max(maxY,caster.maxY);maxZ=Math.max(maxZ,caster.maxZ);}
      if(terrainCasters.length)stats.terrainBounds=[minX,minY,minZ,maxX,maxY,maxZ];
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
      uniforms.uVegetationShadowBias.value=uniforms.uVegetationShadowWorldBias.value/(camera.far-camera.near);
      stats.farSpanX=width*2;stats.farSpanY=height*2;stats.depthSpan=camera.far-camera.near;stats.farTexelX=width*2/mapSize;stats.farTexelY=height*2/mapSize;
    }
    uniforms.uVegetationShadowTriangleOffset.value.copy(uniforms.uVegetationShadowOrigin.value).sub(uniforms.uVegetationShadowTriangleOrigin.value);
    stats.triangleDataBytes=uniforms.uVegetationShadowTriangles.value?uniforms.uVegetationShadowTriangles.value.image.data.byteLength:0;
    uniforms.uVegetationShadowCameraRelative.value.copy(vegetation.userData.cameraLocal).sub(uniforms.uVegetationShadowOrigin.value);
    vegetation.userData.updateShadowAnchor(uniforms.uVegetationShadowOrigin.value);
    cameraRelative.copy(uniforms.uVegetationShadowCameraRelative.value).applyMatrix4(camera.matrixWorldInverse);
    const previousSpan=receiverSpan;fitReceivers(vegetation,boundsChanged);const nearTile=receiverSpan/16;
    const tileX=Math.round(receiverFocusX/nearTile),tileY=Math.round(receiverFocusY/nearTile);
    const nearChanged=farChanged||previousSpan!==receiverSpan||tileX!==nearTileX||tileY!==nearTileY;
    if(!nearChanged){updateReceiverAnchors(vegetation);return false;}
    const x=tileX*nearTile,y=tileY*nearTile,half=receiverSpan*.5;
    nearClip.makeOrthographic(x-half,x+half,y+half,y-half,camera.near,camera.far).multiply(camera.matrixWorldInverse);
    uniforms.uVegetationShadowNearMatrix.value.multiplyMatrices(bias,nearClip);
    // CPU F64 composition cancels the common light basis before upload.
    // No duplicated shadow position/face-ID vertex buffers are allocated.
    inverseTriangleBasis.copy(uniforms.uVegetationShadowTriangleBasis.value).transpose();triangleToRelative.setFromMatrix3(inverseTriangleBasis);triangleToRelative.setPosition(uniforms.uVegetationShadowTriangleOrigin.value.x-uniforms.uVegetationShadowOrigin.value.x,uniforms.uVegetationShadowTriangleOrigin.value.y-uniforms.uVegetationShadowOrigin.value.y,uniforms.uVegetationShadowTriangleOrigin.value.z-uniforms.uVegetationShadowOrigin.value.z);farTriangleClip.multiplyMatrices(farClip,triangleToRelative);nearTriangleClip.multiplyMatrices(nearClip,triangleToRelative);
    clipRepresentation(farTriangleClip,farLinear,farOriginHi,farOriginLo);
    clipRepresentation(nearTriangleClip,nearLinear,nearOriginHi,nearOriginLo);
    updateReceiverAnchors(vegetation);
    // A failed new draw must not expose a stale map with a changed projection.
    uniforms.uVegetationShadowEnabled.value=0;valid=false;
    const previousTarget=renderer.getRenderTarget(),cubeFace=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    const autoClear=renderer.autoClear,clearAlpha=renderer.getClearAlpha(),xrEnabled=renderer.xr.enabled;
    renderer.getClearColor(clearColor);renderer.getViewport(viewport);renderer.getScissor(scissor);renderer.getCurrentViewport(currentViewport);
    const scissorTest=renderer.getScissorTest(),gl=renderer.getContext();
    currentScissor.fromArray(gl.getParameter(gl.SCISSOR_BOX));const currentScissorTest=gl.isEnabled(gl.SCISSOR_TEST);
    try{
      renderer.xr.enabled=false;renderer.autoClear=false;renderer.setClearColor(reversed?0:0xff0000,0);
      if(farChanged){
        for(const caster of terrainCasters){const u=caster.mesh.material.uniforms;u.uTriangleShadowLinear.value=farLinear;u.uTriangleShadowOriginHi.value=farOriginHi;u.uTriangleShadowOriginLo.value=farOriginLo;}material.uniforms.uShadowClip.value=farClip;material.uniforms.uShadowDitherOffset.value.set(-mapSize*.5,-mapSize*.5);renderer.setRenderTarget(farTarget);
        renderer.clear(true,true,false);renderer.render(scene,camera);stats.farRenders++;stats.renders++;
      }
      for(const caster of terrainCasters){const u=caster.mesh.material.uniforms;u.uTriangleShadowLinear.value=nearLinear;u.uTriangleShadowOriginHi.value=nearOriginHi;u.uTriangleShadowOriginLo.value=nearOriginLo;}material.uniforms.uShadowClip.value=nearClip;material.uniforms.uShadowDitherOffset.value.set((x-half)*mapSize/receiverSpan,(y-half)*mapSize/receiverSpan);renderer.setRenderTarget(nearTarget);
      renderer.clear(true,true,false);renderer.render(scene,camera);stats.nearRenders++;stats.renders++;
    }finally{
      renderer.xr.enabled=xrEnabled;renderer.autoClear=autoClear;renderer.setClearColor(clearColor,clearAlpha);
      renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);
      renderer.setRenderTarget(previousTarget,cubeFace,mip);
      renderer.state.viewport(currentViewport);renderer.state.scissor(currentScissor);renderer.state.setScissorTest(currentScissorTest);
    }
    previousGeometry=geometry;rootVersion=roots?roots.version:-1;shapeVersion=shapes?shapes.version:-1;positionVersion=positions?positions.version:-1;
    previousCount=count;previousReversed=reversed;nearTileX=tileX;nearTileY=tileY;valid=true;
    uniforms.uVegetationShadowEnabled.value=1;stats.instances=total;
    return true;
  }
  function dispose(){if(disposed)return;disposed=true;clear();}
  return {uniforms,stats,prepare,clear,dispose,setTerrainCasters};
}
