import * as THREE from 'three';
import {hashSeed} from '../random.js';
import {RING_HABITAT_RIVER_BANK_DISTANCE} from '../ring-habitat-field.js';
import {RING_HABITAT_ROCK_SLOPE_START,RING_HABITAT_MEADOW_PALETTES} from './ring-habitat-surface.js';
import {sampleRingHabitatTop as sampleTop} from '../ring-habitat-sampling.js';
import {createRingHabitatLatticeWorkspace,clearRingHabitatLatticeWorkspace,sampleCanonicalTop} from '../ring-habitat-regions.js';
import {RING_HABITAT_SHADOW_GLSL,createRingHabitatShadowUniforms} from './ring-habitat-shadow-receiver.js';

const CAPACITY=8192,PITCH=4,TILE_CELLS=4,RANGE=180,TAU=Math.PI*2;
export const RING_HABITAT_GROUNDCOVER_PREPARE_RADIUS_L=RANGE+TILE_CELLS*PITCH;
const VERTEX=/* glsl */`
in vec3 iRoot,iGroundNormal;
in vec3 iShape;
uniform mat3 uBodyToWorld,uViewRotation;
uniform vec3 uBodyCenter,uCameraLocal;
uniform float uPixelAngle;
out vec3 vBodyPoint,vNormal,vGroundNormal;
out float vCoverage,vHeight,vVariation;
void main(){
  vec3 up=iGroundNormal,right=normalize(cross(vec3(0.,1.,0.),up)),forward=cross(right,up);
  float c=cos(iShape.y),s=sin(iShape.y);
  vec2 blade=mat2(c,s,-s,c)*position.xz;
  vec3 offset=(right*blade.x+up*position.y+forward*blade.y)*iShape.x;
  vec2 n=mat2(c,s,-s,c)*normal.xz;
  vNormal=right*n.x+up*normal.y+forward*n.y;
  vBodyPoint=iRoot+offset;vGroundNormal=up;vHeight=position.y;vVariation=iShape.z;
  float distanceToRoot=length(iRoot-uCameraLocal);
  // A leaf's base is .24 times its height; use that approximate transverse
  // footprint, rather than the long silhouette, to retire subpixel dark specks.
  float widthPixels=iShape.x*.24/max(distanceToRoot*uPixelAngle,.0001);
  vCoverage=(1.-smoothstep(100.,150.,distanceToRoot))*smoothstep(.35,.85,widthPixels);
  vec3 relative=uBodyToWorld*iRoot+uBodyCenter+uBodyToWorld*offset;
  gl_Position=projectionMatrix*vec4(uViewRotation*relative,1.);
}`;
const FRAGMENT=/* glsl */`
precision highp float;
uniform vec3 uLight,uGrassLow,uGrassHigh;
in vec3 vBodyPoint,vNormal,vGroundNormal;
in float vCoverage,vHeight,vVariation;
out vec4 groundcoverColor;
#define gl_FragColor groundcoverColor
${RING_HABITAT_SHADOW_GLSL}
void main(){
  float threshold=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
  if(vCoverage<=threshold)discard;
  vec3 n=normalize(vNormal)*(gl_FrontFacing?1.:-1.);
  float visibility=habitatVegetationVisibility(vBodyPoint,normalize(vGroundNormal));
  vec3 albedo=mix(uGrassLow,uGrassHigh,vVariation)*(.70+.30*vHeight);
  float light=max(dot(n,uLight),0.)*visibility;
  groundcoverColor=vec4(albedo*(vec3(.17,.215,.24)+vec3(1.06,1.02,.94)*light),1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
function cellHash(x,y,seed,salt){
  let h=Math.imul(x^seed,0x9e3779b1)^Math.imul(y^salt,0x85ebca6b);
  h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);
  return ((h^(h>>>16))>>>0)/4294967296;
}
function createGeometry(){
  const positions=[];
  // Three crossed, tapered, bent leaves: six true triangles, fixed in body
  // space. This decorative microgeometry has no collision or wind simulation.
  for(let blade=0;blade<3;blade++){
    const a=blade*TAU/3,c=Math.cos(a),s=Math.sin(a);
    const x0=-.12,z0=0,x1=.12,z1=0,x2=.065,z2=.09,x3=.16,z3=.20;
    positions.push(x0*c-z0*s,0,x0*s+z0*c,x1*c-z1*s,0,x1*s+z1*c,x2*c-z2*s,.58,x2*s+z2*c);
    positions.push(x1*c-z1*s,0,x1*s+z1*c,x3*c-z3*s,1,x3*s+z3*c,x2*c-z2*s,.58,x2*s+z2*c);
  }
  const geometry=new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.computeVertexNormals();
  geometry.setAttribute('iRoot',new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY*3),3));
  geometry.setAttribute('iGroundNormal',new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY*3),3));
  geometry.setAttribute('iShape',new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY*3),3));
  geometry.instanceCount=0;return geometry;
}

/** Bounded body-anchored decorative grass on the retained physical top mesh.
 * Borrows the tree shadow receiver only; microgeometry casts no extra shadows.
 * Terrain and recipe data are immutable snapshots, replaced by their owner.
 */
export function createRingHabitatGroundcover({shadowUniforms,terrainRegistry=null}={}){
  const group=new THREE.Group();group.name='ring-habitat-groundcover';group.visible=false;
  const frame=new THREE.Matrix3(),cameraLocal=new THREE.Vector3();
  const point=new THREE.Vector3(),normal=new THREE.Vector3(),face=new THREE.Vector3();
  const bestPoint=new THREE.Vector3(),bestNormal=new THREE.Vector3(),bestFace=new THREE.Vector3();
  const river={distance:0,progressL:0,tangentX:0,tangentY:0};
  const info={rockCoverage:0},active=new Uint8Array(32),fieldActive=new Uint8Array(32),fieldLeases=new Array(32).fill(null),stats={rebuilds:0,instances:0};
  const uniforms={...(shadowUniforms??createRingHabitatShadowUniforms()),uBodyToWorld:{value:new THREE.Matrix3()},uViewRotation:{value:new THREE.Matrix3()},uBodyCenter:{value:new THREE.Vector3()},uCameraLocal:{value:cameraLocal},uLight:{value:new THREE.Vector3()},uPixelAngle:{value:0},uGrassLow:{value:new THREE.Vector3()},uGrassHigh:{value:new THREE.Vector3()}};
  let mesh=null,disposed=false,lastGroups=null,lastId,lastPhase,lastInner,lastDensity,lastCeiling,lastTileX,lastTileY;
  let lastTerrainRevision,retainedFields=0,latticeWork=null;
  group.userData.stats=stats;group.userData.mesh=null;group.userData.cameraLocal=cameraLocal;
  function releaseFields(){if(!retainedFields)return;clearRingHabitatLatticeWorkspace(latticeWork);for(let i=0;i<fieldLeases.length;i++){const lease=fieldLeases[i];if(lease){lease.release();fieldLeases[i]=null;}}retainedFields=0;}
  function clear(){releaseFields();group.visible=false;stats.instances=0;if(mesh)mesh.geometry.instanceCount=0;lastGroups=null;}
  group.userData.clear=clear;
  group.userData.update=({body=null,camera,viewportHeight,pixelRatio=1,climate=0})=>{
    if(disposed)return;
    const palette=RING_HABITAT_MEADOW_PALETTES[climate];
    uniforms.uGrassLow.value.fromArray(palette.low);uniforms.uGrassHigh.value.fromArray(palette.high);
    const canonicalTerrain=Boolean(body?.kind==='ring'&&body.habitat?.terrainRecipes?.length);
    const groups=body?.kind==='ring'?(canonicalTerrain?body.habitat.terrainRecipes:body.shape.terrainGroups):null,ecology=body?.habitat?.ecology;
    if(!groups?.length||!ecology||(body.visibility??1)<=0){clear();return;}
    const inner=body.shape.parts[0].innerRadius;
    frame.fromArray(body.frame);cameraLocal.fromArray(body.center).negate().applyMatrix3(frame);
    const radial=Math.hypot(cameraLocal.x,cameraLocal.z);
    if(Math.abs(inner-radial)>=3500){clear();return;}
    if(canonicalTerrain&&!terrainRegistry){clear();throw new TypeError('Canonical Halo groundcover requires its terrain registry');}
    if(canonicalTerrain&&!latticeWork)latticeWork=createRingHabitatLatticeWorkspace();
    const columns=Math.max(1,Math.round(TAU*inner/PITCH)),spacing=TAU*inner/columns;
    const tileX=Math.floor((Math.atan2(cameraLocal.z,cameraLocal.x)/TAU+.5)*columns/TILE_CELLS),tileY=Math.floor(cameraLocal.y/PITCH/TILE_CELLS);
    const terrainRevision=canonicalTerrain?terrainRegistry.revision:undefined;
    if(groups!==lastGroups||body.id!==lastId||body.phase!==lastPhase||inner!==lastInner||ecology.treeDensity!==lastDensity||ecology.forestCeiling!==lastCeiling||tileX!==lastTileX||tileY!==lastTileY||terrainRevision!==lastTerrainRevision){
      try{
      if(groups.length>active.length)throw new RangeError('Near groundcover supports the catalogue maximum of 32 terrain patches');
      const metadataChanged=groups!==lastGroups||body.id!==lastId||body.phase!==lastPhase||terrainRevision!==lastTerrainRevision;
      if(metadataChanged)releaseFields();
      let activeCount=0;fieldActive.fill(0);
      for(let i=0;i<groups.length;i++){
        const p=groups[i];
        if(canonicalTerrain){
          const angle=Math.atan2(cameraLocal.z,cameraLocal.x),phi=angle+Math.round(((p.minAngle+p.maxAngle)*.5-angle)/TAU)*TAU;
          const dx=Math.max(p.minAngle-phi,0,phi-p.maxAngle)*p.innerRadius,dy=Math.max(p.minY-cameraLocal.y,0,cameraLocal.y-p.maxY);
          if(Math.hypot(dx,dy)>RING_HABITAT_GROUNDCOVER_PREPARE_RADIUS_L)continue;
          active[activeCount++]=i;fieldActive[i]=1;
        }else if(p.topGrid&&Math.hypot(cameraLocal.x-p.center[0],cameraLocal.y-p.center[1],cameraLocal.z-p.center[2])<=p.radius+RANGE+3500)active[activeCount++]=i;
      }
      for(let i=0;i<fieldLeases.length;i++){
        if(!fieldActive[i]&&fieldLeases[i]){fieldLeases[i].release();fieldLeases[i]=null;retainedFields--;}
        else if(fieldActive[i]&&!fieldLeases[i]){fieldLeases[i]=terrainRegistry.acquireField(body,groups[i].siteIndex);retainedFields++;}
      }
      if(!mesh){
        mesh=new THREE.Mesh(createGeometry(),new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms,vertexShader:VERTEX,fragmentShader:FRAGMENT,side:THREE.DoubleSide}));
        mesh.frustumCulled=false;group.add(mesh);group.userData.mesh=mesh;
      }
      const geometry=mesh.geometry,roots=geometry.attributes.iRoot.array,normals=geometry.attributes.iGroundNormal.array,shapes=geometry.attributes.iShape.array;
      const seed=hashSeed(`${body.id}:${body.phase}:habitat-groundcover-v1`),steps=Math.ceil(RANGE/Math.min(spacing,PITCH));
      const centerColumn=tileX*TILE_CELLS+TILE_CELLS*.5,centerRow=tileY*TILE_CELLS+TILE_CELLS*.5;
      let count=0;
      candidates:for(let y=-steps;y<=steps;y++)for(let x=-steps;x<=steps;x++){
        const column=centerColumn+x,row=centerRow+y,wrapped=((column%columns)+columns)%columns;
        if(cellHash(wrapped,row,seed,31)>=ecology.treeDensity)continue;
        const cx=column+.5+(cellHash(wrapped,row,seed,53)-.5)*.9,cy=row+.5+(cellHash(wrapped,row,seed,79)-.5)*.9;
        if(((cx-centerColumn)*spacing)**2+((cy-centerRow)*PITCH)**2>RANGE*RANGE)continue;
        const angle=cx/columns*TAU-Math.PI,axis=cy*PITCH;
        let bestRadius=Infinity,rock=0,bestIndex=-1,bestX=0,bestY=0;
        for(let i=0;i<activeCount;i++){
          const patch=groups[active[i]];let sampled,sampleX=0,sampleY=0;
          if(canonicalTerrain){
            const phi=angle+Math.round(((patch.minAngle+patch.maxAngle)*.5-angle)/TAU)*TAU;
            sampleX=(phi-patch.minAngle)*patch.innerRadius;sampleY=axis-patch.minY;
            sampled=terrainRegistry.samplePreparedTop(body,patch.siteIndex,sampleX,sampleY,point,null,face,info)
              ||sampleCanonicalTop(fieldLeases[active[i]].field,sampleX,sampleY,point,null,face,info,latticeWork);
          }else sampled=sampleTop(patch,angle,axis,point,normal,face,info);
          if(!sampled)continue;
          const r=Math.hypot(point.x,point.z);
          if(r<bestRadius){bestRadius=r;bestPoint.copy(point);if(!canonicalTerrain)bestNormal.copy(normal);bestFace.copy(face);rock=info.rockCoverage;bestIndex=active[i];bestX=sampleX;bestY=sampleY;}
        }
        if(bestRadius===Infinity)continue;
        const altitude=inner-bestRadius,upright=-(bestFace.x*bestPoint.x+bestFace.z*bestPoint.z)/bestRadius;
        if(altitude<=12||altitude>=ecology.forestCeiling||upright<.90||rock>.02)continue;
        if(canonicalTerrain){
          const field=fieldLeases[bestIndex].field,patch=groups[bestIndex];
          if(field.sampleRiver?.(bestX,bestY,river)&&river.distance<RING_HABITAT_RIVER_BANK_DISTANCE)continue;
          if(!terrainRegistry.samplePreparedTop(body,patch.siteIndex,bestX,bestY,bestPoint,bestNormal,bestFace,info))sampleCanonicalTop(field,bestX,bestY,bestPoint,bestNormal,bestFace,info,latticeWork);
        }
        // Material exposure consumes the interpolated lighting normal, while
        // the retained triangle normal independently owns physical standing.
        const materialUpright=Math.max(0,Math.min(1,-(bestNormal.x*bestPoint.x+bestNormal.z*bestPoint.z)/bestRadius));
        const steepness=Math.sqrt(Math.max(0,1-materialUpright*materialUpright))/Math.max(materialUpright,.08);
        if(steepness>=RING_HABITAT_ROCK_SLOPE_START)continue;
        const at=count*3;bestPoint.toArray(roots,at);bestNormal.toArray(normals,at);
        shapes[at]=.35+.85*cellHash(wrapped,row,seed,97);shapes[at+1]=TAU*cellHash(wrapped,row,seed,127);shapes[at+2]=cellHash(wrapped,row,seed,151);
        if(++count===CAPACITY)break candidates;
      }
      geometry.instanceCount=count;stats.instances=count;stats.rebuilds++;
      geometry.attributes.iRoot.needsUpdate=true;geometry.attributes.iGroundNormal.needsUpdate=true;geometry.attributes.iShape.needsUpdate=true;
      lastGroups=groups;lastId=body.id;lastPhase=body.phase;lastInner=inner;lastDensity=ecology.treeDensity;lastCeiling=ecology.forestCeiling;lastTileX=tileX;lastTileY=tileY;lastTerrainRevision=terrainRevision;
      }catch(cause){clear();throw cause;}
    }
    if(!stats.instances){releaseFields();group.visible=false;return;}
    camera.updateWorldMatrix(true,false);
    uniforms.uBodyToWorld.value.copy(frame).transpose();uniforms.uBodyCenter.value.fromArray(body.center);
    uniforms.uViewRotation.value.setFromMatrix4(camera.matrixWorldInverse);uniforms.uLight.value.fromArray(body.light).normalize();
    uniforms.uPixelAngle.value=2/(camera.projectionMatrix.elements[5]*viewportHeight*pixelRatio);group.visible=true;
  };
  group.userData.dispose=()=>{
    if(disposed)return;disposed=true;clear();
    if(mesh){mesh.geometry.dispose();mesh.material.dispose();group.clear();mesh=null;group.userData.mesh=null;}terrainRegistry=null;latticeWork=null;
  };
  return group;
}
