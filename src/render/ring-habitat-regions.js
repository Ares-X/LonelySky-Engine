import * as THREE from 'three';
import {COSMIC_BODY_INTERSECTIONS_GLSL,COSMIC_BODY_SURFACE_GLSL} from './distant-landmark.js';
import {ROCKY_CONTACT_SHADOW_GLSL} from './rocky-contact-shadows.js';
import {COSMIC_DEPTH_GLSL} from '../cosmic-structures.js';
import {HaloTerrainUnavailable} from '../ring-habitat-regions.js';
import {RING_HABITAT_FIELD_MAX_HEIGHT_L,RING_HABITAT_RIVER_BANK_DISTANCE} from '../ring-habitat-field.js';
import {createRingHabitatShadowUniforms} from './ring-habitat-shadow-receiver.js';
import {createRingHabitatRegionShadows} from './ring-habitat-regions-shadows.js';
import {createRingHabitatShadowTriangles} from './ring-habitat-shadow-triangles.js';

// Presentation LOD only. Collision and near raster borrow the registry's
// immutable16L triangles; no camera-dependent height enters physical state.
const FAR_STEP=512,NEAR_SPAN=2048,GUARD=256,MAX_NEAR_DISTANCE=6000;
// The previous 256L of lead travel could not cover the measured 0.4s tile
// transition at boost speed. Enter preparation earlier inside the same
// resident footprint; the strict guard and physical pages remain unchanged.
const PREPARE_MARGIN=NEAR_SPAN/2-GUARD/2;
// Display-only distance zones in scene L. They improve visible tessellation;
// they do not establish a strict2px surface-error bound or change physics.
const DETAIL_STEP=128,DETAIL_RADIUS=8000,MIDDLE_STEP=256,MIDDLE_RADIUS=16000;
const TAU=Math.PI*2;
export const RING_HABITAT_RENDER_LIMITS=Object.freeze({farStepL:FAR_STEP,nearSpanL:NEAR_SPAN,guardL:GUARD,maxGpuBytes:64*1024*1024,maxNearRegions:64});
const VERTEX=/* glsl */`
uniform vec3 uHaloTileCenter,uHaloTileCameraCenter;
uniform float uBodyRadius;
uniform mat3 uBodyFrame,uViewRotation;
in vec3 haloFaceNormal;
in float haloRockCoverage;
#ifdef HALO_RIVER
in vec4 haloRiver;
out vec4 haloRiverSample;
#endif
out vec3 haloBodyPoint,haloWorldPoint,haloMaterialNormal;
flat out vec3 haloGeometricNormal;
out float haloCoverage;
${COSMIC_DEPTH_GLSL}
void main(){
  haloBodyPoint=(uHaloTileCenter+position)/uBodyRadius;
  haloWorldPoint=uHaloTileCameraCenter+transpose(uBodyFrame)*position;
  haloMaterialNormal=normal;haloGeometricNormal=haloFaceNormal;haloCoverage=haloRockCoverage;
  #ifdef HALO_RIVER
  haloRiverSample=haloRiver;
  #endif
  float d=length(haloWorldPoint);
  gl_Position=projectionMatrix*vec4(uViewRotation*haloWorldPoint*(cosmicDrawDistance(d)/max(d,1.e-20)),1.);
}`;
const FRAGMENT=/* glsl */`
precision highp float;
precision highp int;
uniform mat3 uViewRotation;
uniform mat4 projectionMatrix;
in vec3 haloBodyPoint,haloWorldPoint,haloMaterialNormal;
flat in vec3 haloGeometricNormal;
in float haloCoverage;
#ifdef HALO_RIVER
in vec4 haloRiverSample;
uniform vec4 uHaloRiverChart,uHaloRiverWindow;
#endif
out vec4 bodyColor;
#define gl_FragColor bodyColor
${COSMIC_DEPTH_GLSL}
${COSMIC_BODY_INTERSECTIONS_GLSL}
#define ROCKY_CONTACT_SHADOW
${ROCKY_CONTACT_SHADOW_GLSL}
${COSMIC_BODY_SURFACE_GLSL}
void main(){
  float d=length(haloWorldPoint);vec3 direction=haloWorldPoint/max(d,1.e-20),ray=uBodyFrame*direction;
  ringTerrainHit=true;ringTerrainMaterialNormal=normalize(haloMaterialNormal);ringTerrainRockCoverage=haloCoverage;
  #ifdef HALO_RIVER
    vec2 radial=haloBodyPoint.xz, start=uHaloRiverChart.xy;
    float arc=atan(start.x*radial.y-start.y*radial.x,dot(start,radial))*uHaloRiverChart.w;
    vec2 chart=vec2(arc,haloBodyPoint.y*uBodyRadius-uHaloRiverChart.z);
    vec2 edge=min(chart-uHaloRiverWindow.xy,uHaloRiverWindow.zw-chart);
    float window=smoothstep(0.,320.,min(edge.x,edge.y));
    float aa=clamp(fwidth(haloRiverSample.x),.07,.30);
    const float bank=${RING_HABITAT_RIVER_BANK_DISTANCE.toFixed(1)};
    ringRiverCoverage=window*(1.-smoothstep(bank-aa,bank+aa,haloRiverSample.x));
    ringRiverSample=haloRiverSample;
  #endif
  vec3 color=ringSurface(haloBodyPoint,haloGeometricNormal,ray,d/uBodyRadius);
  bodyColor=vec4(color,uVisibility);
  // Linear near triangles retain hardware coverage/depth. Only remote visual
  // LOD uses the same monotone draw-distance map as the analytic core.
  gl_FragDepth=gl_FragCoord.z;
  if(d>160000.){vec4 clip=projectionMatrix*vec4(uViewRotation*direction*cosmicDrawDistance(d),1.);
    #ifdef USE_REVERSED_DEPTH_BUFFER
      gl_FragDepth=clip.z/clip.w;
    #else
      gl_FragDepth=.5*clip.z/clip.w+.5;
    #endif
  }
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const INDEXED_VERTEX=/* glsl */`
uniform vec3 uHaloTileCenter,uHaloTileCameraCenter;
uniform float uBodyRadius;
uniform mat3 uBodyFrame,uViewRotation;
out vec3 haloBodyPoint,haloWorldPoint,haloMaterialNormal;
out vec3 haloTrianglePoint;
out float haloCoverage;
${COSMIC_DEPTH_GLSL}
void main(){
  haloBodyPoint=(uHaloTileCenter+position)/uBodyRadius;
  haloWorldPoint=uHaloTileCameraCenter+transpose(uBodyFrame)*position;
  haloMaterialNormal=normal;haloTrianglePoint=position;haloCoverage=0.;
  float d=length(haloWorldPoint);
  gl_Position=projectionMatrix*vec4(uViewRotation*haloWorldPoint*(cosmicDrawDistance(d)/max(d,1.e-20)),1.);
}`;
const INDEXED_FRAGMENT=/* glsl */`
precision highp float;
precision highp int;
uniform mat3 uViewRotation;
uniform mat4 projectionMatrix;
in vec3 haloBodyPoint,haloWorldPoint,haloMaterialNormal;
in vec3 haloTrianglePoint;
in float haloCoverage;
out vec4 bodyColor;
#define gl_FragColor bodyColor
${COSMIC_DEPTH_GLSL}
${COSMIC_BODY_INTERSECTIONS_GLSL}
#define ROCKY_CONTACT_SHADOW
${ROCKY_CONTACT_SHADOW_GLSL}
${COSMIC_BODY_SURFACE_GLSL}
void main(){
  float d=length(haloWorldPoint);vec3 direction=haloWorldPoint/max(d,1.e-20),ray=uBodyFrame*direction;
  vec3 haloGeometricNormal=normalize(cross(dFdx(haloTrianglePoint),dFdy(haloTrianglePoint)));
  ringTerrainHit=true;ringTerrainMaterialNormal=normalize(haloMaterialNormal);ringTerrainRockCoverage=haloCoverage;
  vec3 color=ringSurface(haloBodyPoint,haloGeometricNormal,ray,d/uBodyRadius);
  bodyColor=vec4(color,uVisibility);
  // Linear near triangles retain hardware coverage/depth. Only remote visual
  // LOD uses the same monotone draw-distance map as the analytic core.
  gl_FragDepth=gl_FragCoord.z;
  if(d>160000.){vec4 clip=projectionMatrix*vec4(uViewRotation*direction*cosmicDrawDistance(d),1.);
    #ifdef USE_REVERSED_DEPTH_BUFFER
      gl_FragDepth=clip.z/clip.w;
    #else
      gl_FragDepth=.5*clip.z/clip.w+.5;
    #endif
  }
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const DEPTH_FRAGMENT=/* glsl */`
precision highp float;
uniform mat3 uViewRotation;
uniform mat4 projectionMatrix;
in vec3 haloWorldPoint;
out vec4 depthColor;
${COSMIC_DEPTH_GLSL}
void main(){float d=length(haloWorldPoint);gl_FragDepth=gl_FragCoord.z;
 if(d>160000.){vec4 clip=projectionMatrix*vec4(uViewRotation*haloWorldPoint*(cosmicDrawDistance(d)/d),1.);
 #ifdef USE_REVERSED_DEPTH_BUFFER
 gl_FragDepth=clip.z/clip.w;
 #else
 gl_FragDepth=.5*clip.z/clip.w+.5;
 #endif
 }depthColor=vec4(0.);}`;

function createRiverSamples(patch,field){
  if(!field?.sampleRiver)return null;
  const {columns,rows,latticeStepL:step}=patch.topGrid,b=patch.chartBounds;
  const samples=new Float32Array(columns*rows*4),out={distance:0,progressL:0,tangentX:0,tangentY:0};
  let hasWater=false;
  for(let y=0,i=0;y<rows;y++)for(let x=0;x<columns;x++,i+=4){
    const active=field.sampleRiver(Math.min(b.minX+x*step,b.maxX),Math.min(b.minY+y*step,b.maxY),out);
    samples[i]=active?out.distance:2;
    if(active){
      samples[i+1]=out.progressL;samples[i+2]=out.tangentX;samples[i+3]=out.tangentY;
      if(out.distance<RING_HABITAT_RIVER_BANK_DISTANCE+.30)hasWater=true;
    }
  }
  return hasWater?samples:null;
}
function createNonIndexedTriangleGeometry(patch,firstFace,riverField){
  const samples=createRiverSamples(patch,riverField),river=samples?new Float32Array(patch.faces.length*12):null;
  const count=patch.faces.length*3,p=new Float32Array(count*3),n=new Float32Array(count*3),flat=new Float32Array(count*3),kind=new Float32Array(count),ids=new Float32Array(count);let at=0;
  for(let j=0;j<patch.faces.length;j++){
    const f=patch.faces[j],a=patch.vertices[f[0]],b=patch.vertices[f[1]],c=patch.vertices[f[2]],ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2],nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,size=Math.hypot(nx,ny,nz);
    for(let k=0;k<3;k++,at++){const i=f[k],q=patch.vertices[i],s=patch.normals[i],o=at*3;for(let axis=0;axis<3;axis++){p[o+axis]=q[axis];n[o+axis]=s[axis];}flat[o]=nx/size;flat[o+1]=ny/size;flat[o+2]=nz/size;kind[at]=patch.surfaceKinds?patch.surfaceKinds[i]:0;ids[at]=firstFace+j;
      if(river){
        const target=at*4,source=i*4;
        if(j<patch.topFaces)for(let k=0;k<4;k++)river[target+k]=samples[source+k];
        else river[target]=2;
      }
    }
  }
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(p,3));g.setAttribute('normal',new THREE.BufferAttribute(n,3));g.setAttribute('haloFaceNormal',new THREE.BufferAttribute(flat,3));g.setAttribute('haloRockCoverage',new THREE.BufferAttribute(kind,1));g.setAttribute('haloShadowFaceId',new THREE.BufferAttribute(ids,1));
  if(river)g.setAttribute('haloRiver',new THREE.BufferAttribute(river,4));
  return g;
}

// Near river samples are render-only attributes on the borrowed triangles.
// Closed near meshes retain the original positions, normals and face order.
export function createRingHabitatTriangleGeometry(patch,firstFace=1,riverField=null){
 if(patch.topGrid)return createNonIndexedTriangleGeometry(patch,firstFace,riverField);
 const count=patch.vertices.length,positions=new Float32Array(count*3),normals=new Float32Array(count*3),Index=count<=65535?Uint16Array:Uint32Array,indices=new Index(patch.faces.length*3);
 for(let i=0;i<count;i++){const p=patch.vertices[i],n=patch.normals[i];for(let k=0;k<3;k++){positions[i*3+k]=p[k];normals[i*3+k]=n[k];}if(patch.surfaceKinds&&patch.surfaceKinds[i]!==0)throw Error('Indexed natural far field contains engineered-rock coverage');}
 for(let i=0;i<patch.faces.length;i++)for(let k=0;k<3;k++)indices[i*3+k]=patch.faces[i][k];
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(positions,3));g.setAttribute('normal',new THREE.BufferAttribute(normals,3));g.setIndex(new THREE.BufferAttribute(indices,1));return g;
}

function geometryBytes(g){let n=g.index?g.index.array.byteLength:0;for(const key in g.attributes)n+=g.attributes[key].array.byteLength;return n;}
function planFarCells(field,near,step,focus){
  const width=field.bounds.maxX,height=field.bounds.maxY,cells=[],adaptive=focus!==null&&step===FAR_STEP;
  function visit(x,y,size){
    if(x>=width||y>=height)return;
    const x1=Math.min(x+size,width),y1=Math.min(y+size,height);
    if(near&&x>=near.minX&&x1<=near.maxX&&y>=near.minY&&y1<=near.maxY)return;
    if(adaptive){
      const distance=Math.hypot(Math.max(x-focus.x,0,focus.x-x1),Math.max(y-focus.y,0,focus.y-y1));
      const target=distance<=DETAIL_RADIUS?DETAIL_STEP:distance<=MIDDLE_RADIUS?MIDDLE_STEP:FAR_STEP;
      if(size>target){const half=size/2;visit(x,y,half);visit(x+half,y,half);visit(x,y+half,half);visit(x+half,y+half,half);return;}
    }
    cells.push({x,y,x1,y1,size,edges:[size,size,size,size]});
  }
  for(let y=0;y<height;y+=step)for(let x=0;x<width;x+=step)visit(x,y,step);
  if(adaptive){
    const columns=Math.ceil(width/DETAIL_STEP),rows=Math.ceil(height/DETAIL_STEP),index=new Int32Array(columns*rows).fill(-1);
    for(let i=0;i<cells.length;i++){const c=cells[i];for(let y=c.y/DETAIL_STEP;y<Math.ceil(c.y1/DETAIL_STEP);y++)for(let x=c.x/DETAIL_STEP;x<Math.ceil(c.x1/DETAIL_STEP);x++)index[y*columns+x]=i;}
    function neighborSize(x,y,size){if(x<0||x>=columns||y<0||y>=rows)return size;const i=index[y*columns+x];return i<0?size:cells[i].size;}
    for(const c of cells){
      const x0=c.x/DETAIL_STEP,x1=Math.ceil(c.x1/DETAIL_STEP),y0=c.y/DETAIL_STEP,y1=Math.ceil(c.y1/DETAIL_STEP);
      for(let x=x0;x<x1;x++){c.edges[0]=Math.min(c.edges[0],neighborSize(x,y0-1,c.size));c.edges[2]=Math.min(c.edges[2],neighborSize(x,y1,c.size));}
      for(let y=y0;y<y1;y++){c.edges[3]=Math.min(c.edges[3],neighborSize(x0-1,y,c.size));c.edges[1]=Math.min(c.edges[1],neighborSize(x1,y,c.size));}
    }
  }
  if(near)for(const c of cells){
    if(c.y===near.maxY&&c.x<near.maxX&&c.x1>near.minX)c.edges[0]=16;
    if(c.x1===near.minX&&c.y<near.maxY&&c.y1>near.minY)c.edges[1]=16;
    if(c.y1===near.minY&&c.x<near.maxX&&c.x1>near.minX)c.edges[2]=16;
    if(c.x===near.maxX&&c.y<near.maxY&&c.y1>near.minY)c.edges[3]=16;
  }
  return cells;
}

/** Uniform remote LOD and nearby display refinement share one mesh builder.
 * Conforming edge fans join128/256/512L cells and every16L physical boundary
 * sample, including a final shortened cell. No height blending or old roof.
 */
export function createRingHabitatFarPatch(field,near=null,step=FAR_STEP,focus=null){
  const cells=planFarCells(field,near,step,focus),w=field.bounds.maxX,h=field.bounds.maxY,center=[0,0,0],point=[0,0,0],normal=[0,0,0];field.position(w/2,h/2,center);
  const vertices=[],normals=[],faces=[],coordinates=[],canonicalBoundary=[],lookup=new Map();
  function vertex(x,y,exact=false){
    const key=x+','+y;let i=lookup.get(key);if(i!==undefined){if(exact)canonicalBoundary[i]=true;return i;}
    i=vertices.length;lookup.set(key,i);field.position(x,y,point);vertices.push([point[0]-center[0],point[1]-center[1],point[2]-center[2]]);normals.push([0,0,0]);coordinates.push([x,y]);canonicalBoundary.push(exact);return i;
  }
  function edge(loop,ax,ay,bx,by,stride){
    const exact=stride===16;loop.push(vertex(ax,ay,exact));vertex(bx,by,exact);
    const horizontal=ay===by,a=horizontal?ax:ay,b=horizontal?bx:by;
    if(b>a){for(let v=(Math.floor(a/stride)+1)*stride;v<b;v+=stride)loop.push(vertex(horizontal?v:ax,horizontal?ay:v,exact));}
    else{for(let v=(Math.ceil(a/stride)-1)*stride;v>b;v-=stride)loop.push(vertex(horizontal?v:ax,horizontal?ay:v,exact));}
  }
  for(const c of cells){
    const {x,y,x1,y1,size,edges:e}=c;
    if(e[0]===size&&e[1]===size&&e[2]===size&&e[3]===size){const a=vertex(x,y),b=vertex(x1,y),c=vertex(x,y1),d=vertex(x1,y1);faces.push([a,b,c],[b,d,c]);}
    else{const loop=[],mid=vertex((x+x1)/2,(y+y1)/2);edge(loop,x,y,x1,y,e[0]);edge(loop,x1,y,x1,y1,e[1]);edge(loop,x1,y1,x,y1,e[2]);edge(loop,x,y1,x,y,e[3]);for(let i=0;i<loop.length;i++)faces.push([mid,loop[i],loop[(i+1)%loop.length]]);}
  }
  for(const face of faces){
    const a=vertices[face[0]],b=vertices[face[1]],c=vertices[face[2]],ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2],nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    for(const i of face){normals[i][0]+=nx;normals[i][1]+=ny;normals[i][2]+=nz;}
  }
  let radius=0;
  for(let i=0;i<vertices.length;i++){
    const n=normals[i],length=Math.hypot(...n);n[0]/=length;n[1]/=length;n[2]/=length;
    if(canonicalBoundary[i]){field.normal(coordinates[i][0],coordinates[i][1],normal);n[0]=normal[0];n[1]=normal[1];n[2]=normal[2];}
    radius=Math.max(radius,Math.hypot(...vertices[i]));
  }
  return {center,radius,vertices,normals,faces};
}
function cameraLocal(body,out){const c=body.center,f=body.frame;out[0]=-(f[0]*c[0]+f[3]*c[1]+f[6]*c[2]);out[1]=-(f[1]*c[0]+f[4]*c[1]+f[7]*c[2]);out[2]=-(f[2]*c[0]+f[5]*c[1]+f[8]*c[2]);}
function chart(recipe,p,out){let a=Math.atan2(p[2],p[0]);a+=Math.round(((recipe.minAngle+recipe.maxAngle)*.5-a)/TAU)*TAU;out[0]=(a-recipe.minAngle)*recipe.innerRadius;out[1]=p[1]-recipe.minY;}
function farStep(body,pixelAngle){const distance=Math.max(0,Math.hypot(body.center[0],body.center[1],body.center[2])-body.radius*1.5);let step=FAR_STEP;while(step<32768&&step*2<=2*distance*pixelAngle)step*=2;return step;}
function pixelAngle(frame){return 2/(frame.camera.projectionMatrix.elements[5]*frame.viewportHeight*(frame.pixelRatio??1));}
function insideNear(near,x,y,width,height,margin=GUARD){return x>=near.minX+(near.minX===0?0:margin)&&x<=near.maxX-(near.maxX===width?0:margin)&&y>=near.minY+(near.minY===0?0:margin)&&y<=near.maxY-(near.maxY===height?0:margin);}

/** One view-owned GPU/cache owner. prepareTerrain is the sole asynchronous
 * creation boundary; update never starts jobs and rejects unprepared frames.
 * All leases survive until replacement is committed or clear/dispose releases
 * them. A failed/cancelled preparation preserves the previous committed view.
 */
export function createRingHabitatRegionRenderer({terrainRegistry,targetOwnsScissor=false,habitatMapDefines={}}={}){
  if(!terrainRegistry||typeof terrainRegistry.prepareField!=='function'||typeof terrainRegistry.prepareRegions!=='function')throw new TypeError('Canonical habitat renderer needs a world terrain registry');
  const owner=new THREE.Group();owner.name='Canonical habitat regions';owner.visible=false;
  const shadowUniforms=createRingHabitatShadowUniforms();shadowUniforms.uVegetationShadowTriangleAware.value=1;
  const shadows=createRingHabitatRegionShadows({uniforms:shadowUniforms}),triangles=createRingHabitatShadowTriangles({uniforms:shadowUniforms}),shadowEntries=[],shadowSource={children:[],userData:{stats:{builds:0}}};shadows.setTerrainCasters(shadowSource);
  const far=new Map(),nearEntries=[],depthScene=new THREE.Scene(),local=[0,0,0],uv=[0,0],selection={body:null,recipe:null,distance:Infinity};
  // Terrain positions are already relative to the observer in the vertex
  // shader, so the regular scene-graph bounds cannot cull these meshes.
  // Draw-distance compression preserves eye rays and all four side planes.
  const eyeCenter=new THREE.Vector3(),eyeDirection=new THREE.Matrix3();
  const sideLimits=new Float64Array(8);
  let projection=null;
  function updateVisibilityCone(camera){
    if(!camera){projection=null;return;}
    eyeDirection.setFromMatrix4(camera.matrixWorldInverse);
    projection=camera.projectionMatrix.elements;
    const x=projection[0],y=projection[5],dx=projection[8],dy=projection[9];
    sideLimits[0]=1+dx;sideLimits[1]=1-dx;
    sideLimits[2]=1+dy;sideLimits[3]=1-dy;
    sideLimits[4]=Math.hypot(x,sideLimits[0]);sideLimits[5]=Math.hypot(x,sideLimits[1]);
    sideLimits[6]=Math.hypot(y,sideLimits[2]);sideLimits[7]=Math.hypot(y,sideLimits[3]);
  }
  function tileInView(center,radius){
    if(!projection)return true;
    eyeCenter.copy(center).applyMatrix3(eyeDirection);
    const {x,y,z}=eyeCenter;
    const sx=projection[0]*x,sy=projection[5]*y;
    // The few-centimetre allowance covers float32 raster rounding at body
    // scales. It does not enlarge physical or shadow geometry.
    const extent=radius+.25;
    return z<=extent
      && sx+sideLimits[0]*z<=sideLimits[4]*extent && -sx+sideLimits[1]*z<=sideLimits[5]*extent
      && sy+sideLimits[2]*z<=sideLimits[6]*extent && -sy+sideLimits[3]*z<=sideLimits[7]*extent;
  }
  const riverUniforms={uHaloRiverTime:{value:0},uHaloRiverChart:{value:new THREE.Vector4()},uHaloRiverWindow:{value:new THREE.Vector4()}};
  const depthUniforms={uHaloNearDepth:{value:null},uHaloNearDepthEnabled:{value:0},uHaloNearDepthSize:{value:new THREE.Vector2(1,1)},uHaloNearDepthCamera:{value:new THREE.Vector2(.5,220000)}};
  const stats={farBodies:0,farFaces:0,nearRegions:0,nearFaces:0,gpuBytes:0,builds:0,preparationDiscards:0,ready:false,depthRenders:0,disposed:false};
  const plannedNear={bodyId:null,siteIndex:0,minX:0,minY:0,maxX:0,maxY:0};
  let near=null,shadowBodyId=null,regionLease=null,disposed=false,generation=0,revision=-1,depthTarget=null,depthWidth=0,depthHeight=0;
  const color=new THREE.Color(),viewport=new THREE.Vector4(),scissor=new THREE.Vector4(),currentViewport=new THREE.Vector4(),currentScissor=new THREE.Vector4();
  function select(frame){selection.body=selection.recipe=null;selection.distance=Infinity;const bodies=frame.bodies;const count=bodies?bodies.length:Number(!!frame.body);for(let i=0;i<count;i++){const body=bodies?bodies[i]:frame.body;if((body.visibility??1)<=0||body.kind!=='ring'||!body.habitat?.terrainRecipes)continue;cameraLocal(body,local);const radial=Math.hypot(local[0],local[2]);for(const recipe of body.habitat.terrainRecipes){chart(recipe,local,uv);const w=(recipe.maxAngle-recipe.minAngle)*recipe.innerRadius,h=recipe.maxY-recipe.minY,dx=Math.max(0,-uv[0],uv[0]-w),dy=Math.max(0,-uv[1],uv[1]-h),dr=Math.max(0,Math.abs(radial-recipe.innerRadius)-RING_HABITAT_FIELD_MAX_HEIGHT_L),d=Math.hypot(dx,dy,dr);if(d<selection.distance){selection.body=body;selection.recipe=recipe;selection.distance=d;}}}return selection;}
  function ready(frame,farView=far,nearView=near,shadowId=shadowBodyId,viewRevision=revision){if(disposed||viewRevision!==terrainRegistry.revision)return false;const bodies=frame.bodies,count=bodies?bodies.length:Number(!!frame.body);let rings=0;for(let i=0;i<count;i++){const b=bodies?bodies[i]:frame.body;if((b.visibility??1)<=0||b.kind!=='ring'||!b.habitat?.terrainRecipes)continue;rings++;const cached=farView.get(b.id);if(!cached||cached.recipes!==b.habitat.terrainRecipes||cached.step>farStep(b,pixelAngle(frame)))return false;}if(rings!==farView.size)return false;const s=select(frame);if(shadowId!==(s.body?s.body.id:null))return false;if(!s.body)return nearView===null;if(s.distance>=MAX_NEAR_DISTANCE){const cached=farView.get(s.body.id);if(cached.focusPosition){cameraLocal(s.body,local);if(Math.hypot(local[0]-cached.focusPosition[0],local[1]-cached.focusPosition[1],local[2]-cached.focusPosition[2])>FAR_STEP)return false;}return nearView===null;}if(!nearView||nearView.bodyId!==s.body.id||nearView.siteIndex!==s.recipe.siteIndex)return false;cameraLocal(s.body,local);chart(s.recipe,local,uv);const width=(s.recipe.maxAngle-s.recipe.minAngle)*s.recipe.innerRadius,height=s.recipe.maxY-s.recipe.minY;return insideNear(nearView,Math.max(0,Math.min(width,uv[0])),Math.max(0,Math.min(height,uv[1])),width,height);}
  function planNear(body,recipe,out){
    cameraLocal(body,local);chart(recipe,local,uv);
    const w=(recipe.maxAngle-recipe.minAngle)*recipe.innerRadius,h=recipe.maxY-recipe.minY,cx=Math.floor(Math.max(0,Math.min(w,uv[0]))/FAR_STEP)*FAR_STEP+FAR_STEP*.5,cy=Math.floor(Math.max(0,Math.min(h,uv[1]))/FAR_STEP)*FAR_STEP+FAR_STEP*.5;
    out.bodyId=body.id;out.siteIndex=recipe.siteIndex;
    out.minX=Math.max(0,Math.floor((cx-NEAR_SPAN*.5)/FAR_STEP)*FAR_STEP);out.minY=Math.max(0,Math.floor((cy-NEAR_SPAN*.5)/FAR_STEP)*FAR_STEP);
    out.maxX=Math.min(w,Math.floor((cx-NEAR_SPAN*.5)/FAR_STEP)*FAR_STEP+NEAR_SPAN);out.maxY=Math.min(h,Math.floor((cy-NEAR_SPAN*.5)/FAR_STEP)*FAR_STEP+NEAR_SPAN);
    return out;
  }
  function preparationNeeded(frame){
    if(!ready(frame))return true;
    const s=select(frame);if(!s.body||s.distance>=MAX_NEAR_DISTANCE)return false;
    cameraLocal(s.body,local);chart(s.recipe,local,uv);
    const width=(s.recipe.maxAngle-s.recipe.minAngle)*s.recipe.innerRadius,height=s.recipe.maxY-s.recipe.minY;
    if(insideNear(near,Math.max(0,Math.min(width,uv[0])),Math.max(0,Math.min(height,uv[1])),width,height,PREPARE_MARGIN))return false;
    planNear(s.body,s.recipe,plannedNear);
    return plannedNear.minX!==near.minX||plannedNear.maxX!==near.maxX||plannedNear.minY!==near.minY||plannedNear.maxY!==near.maxY;
  }
  function disposeEntry(e){e.mesh.userData.canonicalMesh=null;owner.remove(e.mesh);depthScene.remove(e.depth);e.mesh.geometry.dispose();e.mesh.material.dispose();e.depth.material.dispose();}
  function makeEntry(patch,kind,siteIndex,riverField=null){
    const geometry=createRingHabitatTriangleGeometry(patch,1,riverField),hasRiver=geometry.hasAttribute('haloRiver');
    const u={uHaloTileCenter:{value:new THREE.Vector3().fromArray(patch.center)},uHaloTileCameraCenter:{value:new THREE.Vector3()},uHaloFirstShadowVertex:{value:0}};
    if(hasRiver)Object.assign(u,riverUniforms);
    const material=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms:u,defines:hasRiver?{...habitatMapDefines,HALO_RIVER:1}:habitatMapDefines,vertexShader:geometry.index?INDEXED_VERTEX:VERTEX,fragmentShader:geometry.index?INDEXED_FRAGMENT:FRAGMENT,side:THREE.FrontSide,depthTest:true,depthWrite:true});
    const depthMaterial=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms:u,vertexShader:geometry.index?INDEXED_VERTEX:VERTEX,fragmentShader:DEPTH_FRAGMENT,side:THREE.FrontSide,depthTest:true,depthWrite:true,colorWrite:false});
    const mesh=new THREE.Mesh(geometry,material),depth=new THREE.Mesh(geometry,depthMaterial);mesh.frustumCulled=depth.frustumCulled=false;mesh.renderOrder=2;mesh.name=kind;
    return {mesh,depth,uniforms:u,center:patch.center,radius:patch.radius,siteIndex,kind,bytes:geometryBytes(geometry),faces:patch.faces.length};
  }
  async function prepareTerrain(frame){shadowSource.userData.receiverCamera=frame.camera;if(disposed)throw new Error('Habitat renderer disposed');if(!preparationNeeded(frame))return true;// Preparation crosses awaits; the embedding world's frame and centres are
    // reusable live outputs. Snapshot this cold-boundary input before yielding.
    const liveFrame=frame,input=frame.bodies??(frame.body?[frame.body]:[]),snapshots=input.map(b=>({...b,center:b.center.slice(),frame:b.frame.slice()}));frame={bodies:snapshots,sectorIndex:frame.sectorIndex,signal:frame.signal,pixelAngle:pixelAngle(frame)};
    const token=++generation,terrainRevision=terrainRegistry.revision,signal=frame.signal,newFar=new Map(),made=[],addresses=[],s=select(frame);let nextNear=null,nextLease=null;const nextShadowId=s.body?s.body.id:null,selectedBody=s.distance<MAX_NEAR_DISTANCE?s.body:null,selectedRecipe=s.recipe;
    const check=()=>{if(disposed||token!==generation||terrainRevision!==terrainRegistry.revision||signal?.aborted)throw new DOMException('Habitat rendering preparation cancelled','AbortError');};
    try{check();if(selectedBody){nextNear=planNear(selectedBody,selectedRecipe,{});
      for(let y=nextNear.minY;y<nextNear.maxY;y+=256)for(let x=nextNear.minX;x<nextNear.maxX;x+=256)addresses.push({siteIndex:nextNear.siteIndex,tileX:x/256,tileY:y/256});if(addresses.length>64)throw new HaloTerrainUnavailable('halo-render-region-budget','Canonical near view exceeds64 regions');nextLease=await terrainRegistry.prepareRegions(selectedBody,addresses,{signal});check();}
      const bodies=frame.bodies,count=bodies?bodies.length:Number(!!frame.body);let totalBytes=0;
      for(let i=0;i<count;i++){const body=bodies?bodies[i]:frame.body;if((body.visibility??1)<=0||body.kind!=='ring'||!body.habitat?.terrainRecipes)continue;const previous=far.get(body.id),entries=[],step=farStep(body,frame.pixelAngle),focused=body.id===nextShadowId&&step===FAR_STEP;
        const focusPosition=focused?[0,0,0]:null;if(focused)cameraLocal(body,focusPosition);
        for(const recipe of body.habitat.terrainRecipes){check();let focus=null,lodKey='';if(focused){chart(recipe,focusPosition,uv);const w=(recipe.maxAngle-recipe.minAngle)*recipe.innerRadius,h=recipe.maxY-recipe.minY,d=Math.hypot(Math.max(0,-uv[0],uv[0]-w),Math.max(0,-uv[1],uv[1]-h));if(d<=MIDDLE_RADIUS){focus={x:uv[0],y:uv[1]};lodKey=Math.floor(focus.x/FAR_STEP)+','+Math.floor(focus.y/FAR_STEP);}}const hole=nextNear&&nextNear.bodyId===body.id&&nextNear.siteIndex===recipe.siteIndex?nextNear:null,oldHole=near&&near.bodyId===body.id&&near.siteIndex===recipe.siteIndex?near:null;let entry=previous?.recipes===body.habitat.terrainRecipes&&previous.step===step?previous.entries.find(e=>e.siteIndex===recipe.siteIndex):null;
          if(!entry||entry.lodKey!==lodKey||JSON.stringify(hole)!==JSON.stringify(oldHole)){const fieldLease=await terrainRegistry.prepareField(body,recipe.siteIndex,{signal});try{check();entry=makeEntry(createRingHabitatFarPatch(fieldLease.field,hole,step,focus),'Habitat field visual LOD',recipe.siteIndex);entry.lodKey=lodKey;made.push(entry);}finally{fieldLease.release();}}
          entries.push(entry);totalBytes+=entry.bytes;
        }newFar.set(body.id,{recipes:body.habitat.terrainRecipes,entries,step,focusPosition});
      }
      const newNear=[];
      if(nextLease){
        const fieldLease=await terrainRegistry.prepareField(selectedBody,selectedRecipe.siteIndex,{signal});
        try{
          check();
          for(const region of nextLease.regions){
            let e=nearEntries.find(e=>e.mesh.userData.regionId===region.id&&e.mesh.userData.canonicalMesh===region.mesh);
            if(!e){
              e=makeEntry(region.mesh,'Canonical physical habitat region',region.siteIndex,fieldLease.field);
              e.mesh.userData.canonicalMesh=region.mesh;e.mesh.userData.regionId=region.id;made.push(e);
            }
            newNear.push(e);totalBytes+=e.bytes;
          }
        }finally{fieldLease.release();}
      }
      if(totalBytes>RING_HABITAT_RENDER_LIMITS.maxGpuBytes)throw new HaloTerrainUnavailable('halo-render-byte-budget','Complete canonical terrain view exceeds64MiB geometry budget');check();
      // A background view can move while its cold regions are being built.
      // Commit only a plan covering that live view; retain the old meshes otherwise.
      if(!ready(liveFrame,newFar,nextNear,nextShadowId,terrainRegistry.revision)){
        for(const e of made)disposeEntry(e);nextLease?.release();nextLease=null;stats.preparationDiscards++;return false;
      }
      const retained=new Set();for(const value of newFar.values())for(const e of value.entries)retained.add(e);for(const e of newNear)retained.add(e);for(const value of far.values())for(const e of value.entries)if(!retained.has(e))disposeEntry(e);for(const e of nearEntries)if(!retained.has(e))disposeEntry(e);nearEntries.length=0;
      far.clear();for(const [id,value] of newFar){far.set(id,value);for(const e of value.entries){owner.add(e.mesh);depthScene.add(e.depth);}}for(const e of newNear){nearEntries.push(e);owner.add(e.mesh);depthScene.add(e.depth);}if(regionLease)regionLease.release();regionLease=nextLease;nextLease=null;near=nextNear;shadowBodyId=nextShadowId;revision=terrainRegistry.revision;stats.gpuBytes=totalBytes;stats.farBodies=far.size;stats.nearRegions=newNear.length;stats.nearFaces=0;stats.farFaces=0;for(const e of nearEntries)stats.nearFaces+=e.faces;for(const v of far.values())for(const e of v.entries)stats.farFaces+=e.faces;stats.builds++;shadowSource.children.length=0;shadowEntries.length=0;let firstFace=1;
      if(shadowBodyId){const selected=newFar.get(shadowBodyId);for(const e of selected.entries){shadowEntries.push(e);shadowSource.children.push(e.mesh);}for(const e of nearEntries){shadowEntries.push(e);shadowSource.children.push(e.mesh);}for(const e of shadowEntries){e.uniforms.uHaloFirstShadowVertex.value=(firstFace-1)*3;const ids=e.mesh.geometry.attributes.haloShadowFaceId;if(ids){for(let i=0;i<ids.count;i++)ids.array[i]=firstFace+Math.floor(i/3);ids.needsUpdate=true;}firstFace+=e.faces;}}
      if(nextNear){
        const angle=selectedRecipe.minAngle;
        riverUniforms.uHaloRiverChart.value.set(Math.cos(angle),Math.sin(angle),selectedRecipe.minY,selectedRecipe.innerRadius);
        riverUniforms.uHaloRiverWindow.value.set(nextNear.minX,nextNear.minY,nextNear.maxX,nextNear.maxY);
      }
      shadowSource.userData.receiverBodyFrame=selectedBody?selectedBody.frame:(s.body?s.body.frame:null);shadowSource.userData.stats.builds=stats.builds;stats.ready=true;return true;
    }catch(error){for(const e of made)disposeEntry(e);if(nextLease)nextLease.release();if(token===generation)stats.ready=ready(liveFrame);throw error;}}
  function bindEntry(e,body,uniforms){if(e.mesh.material.uniforms.uBodyRadius!==uniforms.uBodyRadius){Object.assign(e.uniforms,uniforms);e.mesh.material.needsUpdate=e.depth.material.needsUpdate=true;}const f=body.frame,c=body.center,p=e.center;e.uniforms.uHaloTileCameraCenter.value.set(c[0]+f[0]*p[0]+f[1]*p[1]+f[2]*p[2],c[1]+f[3]*p[0]+f[4]*p[1]+f[5]*p[2],c[2]+f[6]*p[0]+f[7]*p[1]+f[8]*p[2]);const partial=uniforms.uVisibility.value<1;if(e.mesh.material.transparent!==partial){e.mesh.material.transparent=partial;e.mesh.material.depthWrite=!partial;e.mesh.material.needsUpdate=true;}e.mesh.renderOrder=partial?-Math.hypot(body.center[0],body.center[1],body.center[2]):2;e.mesh.visible=tileInView(e.uniforms.uHaloTileCameraCenter.value,e.radius);e.depth.visible=e.mesh.visible&&!partial;}
  owner.userData.beginFrame=(celestialTime=0,camera=null)=>{updateVisibilityCone(camera);riverUniforms.uHaloRiverTime.value=celestialTime%128;owner.visible=false;depthUniforms.uHaloNearDepthEnabled.value=0;for(const value of far.values())for(const e of value.entries)e.mesh.visible=e.depth.visible=false;for(const e of nearEntries)e.mesh.visible=e.depth.visible=false;};
  owner.userData.updateBody=(body,uniforms)=>{if(body.id===shadowBodyId)shadowSource.userData.receiverBodyFrame=body.frame;const value=far.get(body.id);if(!value)return;for(const e of value.entries)bindEntry(e,body,uniforms);if(near?.bodyId===body.id)for(const e of nearEntries)bindEntry(e,body,uniforms);if(shadowBodyId===body.id)triangles.update(shadowEntries,body.light,stats.builds);owner.visible=true;};
  owner.userData.prepareTerrain=prepareTerrain;owner.userData.terrainReady=frame=>ready(frame);owner.userData.terrainPreparationNeeded=preparationNeeded;owner.userData.depthUniforms=depthUniforms;owner.userData.shadowUniforms=shadowUniforms;owner.userData.shadowStats=shadows.stats;owner.userData.triangleStats=triangles.stats;owner.userData.prepareShadows=(renderer,vegetation,light)=>shadows.prepare(renderer,vegetation,light);owner.userData.clearShadows=()=>shadows.clear();owner.userData.stats=stats;
  owner.userData.getShadowBodyId=()=>shadowBodyId;
  owner.userData.clear=()=>{shadowSource.userData.receiverCamera=null;shadowSource.userData.receiverBodyFrame=null;generation++;shadows.clear();triangles.clear();shadowEntries.length=0;shadowSource.children.length=0;shadowSource.userData.stats.builds=0;for(const value of far.values())for(const e of value.entries)disposeEntry(e);for(const e of nearEntries)disposeEntry(e);far.clear();nearEntries.length=0;if(regionLease)regionLease.release();regionLease=null;near=null;shadowBodyId=null;revision=-1;owner.visible=false;stats.ready=false;stats.gpuBytes=stats.nearRegions=stats.nearFaces=stats.farFaces=stats.farBodies=0;depthUniforms.uHaloNearDepthEnabled.value=0;};
  owner.userData.prepareDepth=(renderer,camera)=>{
    shadowSource.userData.receiverCamera=camera;
    if(!owner.visible)return;
    const {x:width,y:height}=renderer.getDrawingBufferSize(depthUniforms.uHaloNearDepthSize.value);
    if(!depthTarget||width!==depthWidth||height!==depthHeight){
      if(depthTarget)depthTarget.dispose();
      depthTarget=new THREE.WebGLRenderTarget(width,height,{
        depthTexture:new THREE.DepthTexture(width,height,THREE.UnsignedIntType),
        stencilBuffer:false,samples:0,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,
      });
      depthWidth=width;depthHeight=height;
      depthUniforms.uHaloNearDepth.value=depthTarget.depthTexture;
    }
    const target=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    const auto=renderer.autoClear,alpha=renderer.getClearAlpha(),xr=renderer.xr.enabled;
    renderer.getClearColor(color);renderer.getViewport(viewport);renderer.getScissor(scissor);renderer.getCurrentViewport(currentViewport);
    const test=renderer.getScissorTest();
    // The normal game composer owns scissor through setRenderTarget. That
    // call restores its state without the GPU round trip of a raw GL query.
    // Standalone callers may have applied a separate device scissor.
    let currentTest;
    if(!targetOwnsScissor){
      const gl=renderer.getContext();
      currentScissor.fromArray(gl.getParameter(gl.SCISSOR_BOX));
      currentTest=gl.isEnabled(gl.SCISSOR_TEST);
    }
    depthUniforms.uHaloNearDepthEnabled.value=0;
    try{
      renderer.xr.enabled=false;renderer.autoClear=false;renderer.setRenderTarget(depthTarget);
      renderer.clear(true,true,false);renderer.render(depthScene,camera);
      depthUniforms.uHaloNearDepthCamera.value.set(camera.near,camera.far);
      depthUniforms.uHaloNearDepthEnabled.value=1;stats.depthRenders++;
    }finally{
      renderer.xr.enabled=xr;renderer.autoClear=auto;renderer.setClearColor(color,alpha);
      renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(test);
      renderer.setRenderTarget(target,face,mip);renderer.state.viewport(currentViewport);
      if(!targetOwnsScissor){
        renderer.state.scissor(currentScissor);renderer.state.setScissorTest(currentTest);
      }
    }
  };
  owner.userData.invalidateGpuCaches=()=>{shadows.clear();triangles.clear();depthUniforms.uHaloNearDepthEnabled.value=0;if(depthTarget){depthTarget.dispose();depthTarget=null;depthWidth=depthHeight=0;}};
  owner.userData.dispose=()=>{if(disposed)return;owner.userData.clear();owner.userData.invalidateGpuCaches();shadows.dispose();triangles.dispose();disposed=true;stats.disposed=true;};return owner;
}
