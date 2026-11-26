import {createNaturalRingGrains} from './natural-ring-grains.js';
import {createScannedNaturalRingDebris} from './natural-ring-scanned.js';
import * as THREE from 'three';
import {NATURAL_RING,NATURAL_RING_SURFACE_LIGHT_GLSL,NATURAL_RING_PROTOTYPES,createNaturalRingQueryWorkspace} from '../natural-ring.js';
const vertex=/* glsl */`
in vec3 iRoot,iRow0,iRow1,iRow2;
uniform mat3 uBodyToWorld,uViewRotation;
uniform vec3 uAnchor,uAnchorRelative;
out vec3 vNormal,vPoint,vRelative;
void main(){
  vec3 offset=vec3(dot(iRow0,position),dot(iRow1,position),dot(iRow2,position));
  vNormal=vec3(dot(iRow0,normal),dot(iRow1,normal),dot(iRow2,normal));
  vPoint=uAnchor+iRoot+offset;
  vRelative=uAnchorRelative+uBodyToWorld*(iRoot+offset);
  gl_Position=projectionMatrix*vec4(uViewRotation*vRelative,1.);
}`;
const fragment=/* glsl */`
precision highp float;
in vec3 vNormal,vPoint,vRelative;
uniform vec3 uLight,uColor;
uniform float uRadius,uRingPhase;
${NATURAL_RING_SURFACE_LIGHT_GLSL}
out vec4 rockColor;
#define gl_FragColor rockColor
void main(){
  float fade=1.-smoothstep(${NATURAL_RING.fadeStart.toFixed(1)},${NATURAL_RING.fadeEnd.toFixed(1)},length(vRelative));
  float threshold=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453);
  if(fade<=threshold)discard;
  vec3 normal=normalize(vNormal);
  float sun=max(0.,dot(normal,uLight));
  float visibility=naturalRingSunTransmission(vPoint/uRadius);
  vec3 color=uColor*(.035+sun*visibility*1.05);
  rockColor=vec4(color,1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
/** Four shared closed prototypes, same instance transforms as the CPU field.
 * No new textures, render targets, shadow pass or animated positions.
 */
export function createNaturalRingDebris({field}={}){
  if(field&&!field.renderAssets&&field.prototypes!==NATURAL_RING_PROTOTYPES)throw new TypeError('Injected ring collision prototypes require matching render assets');
  const group=field?.renderAssets?createScannedNaturalRingDebris({field}):createPrimitiveNaturalRingDebris({field});
  if(!field)return group;
  const grains=createNaturalRingGrains({assets:field.renderAssets}),update=group.userData.update,clear=group.userData.clear,dispose=group.userData.dispose,snapshot=group.userData.snapshot;
  group.add(grains);group.userData.grains=grains;
  group.userData.update=frame=>{update(frame);grains.userData.update(frame);group.userData.stats.grainInstances=grains.userData.stats.instances;group.visible=group.visible||grains.visible;};
  group.userData.clear=()=>{clear();grains.userData.clear();group.userData.stats.grainInstances=0;};
  group.userData.snapshot=()=>({...snapshot(),grains:grains.userData.snapshot()});
  group.userData.dispose=()=>{dispose();grains.userData.dispose();group.userData.stats.grainInstances=0;};
  return group;
}
function createPrimitiveNaturalRingDebris({field}){
  const group=new THREE.Group();group.name='Natural ice-rock ring — STATIC_NO_ORBIT';group.visible=false;
  const meshes=[],cameraLocal=[0,0,0],anchor=[0,0,0],counts=new Uint16Array(4),frame=new THREE.Matrix3();
  let work=null,uniforms=null,bodyId=null,tileX=NaN,tileZ=NaN,lastRevision=-1,disposed=false;
  const stats={mode:NATURAL_RING.mode,instances:0,tiles:0,rebuilds:0,bodyId:null,revision:0,geometries:0,materials:0,disposed:false};
  group.userData.stats=stats;
  function allocate(){
    work=createNaturalRingQueryWorkspace(NATURAL_RING.visibleCapacity);
    uniforms={uBodyToWorld:{value:new THREE.Matrix3()},uViewRotation:{value:new THREE.Matrix3()},
      uAnchor:{value:new THREE.Vector3()},uAnchorRelative:{value:new THREE.Vector3()},uLight:{value:new THREE.Vector3()},uRadius:{value:1},uRingPhase:{value:0}};
    const colors=[0x777d83,0xb9c8cc,0x879397,0xd1d9d5];
    for(let type=0;type<4;type++){
      const prototype=NATURAL_RING_PROTOTYPES[type],positions=[],normals=[];
      for(const face of prototype.faces){
        const a=new THREE.Vector3().fromArray(prototype.vertices[face[0]]),b=new THREE.Vector3().fromArray(prototype.vertices[face[1]]),c=new THREE.Vector3().fromArray(prototype.vertices[face[2]]);
        const n=b.clone().sub(a).cross(c.clone().sub(a)).normalize();
        for(const index of face){positions.push(...prototype.vertices[index]);normals.push(n.x,n.y,n.z);}
      }
      const geometry=new THREE.InstancedBufferGeometry();
      geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
      for(const name of ['iRoot','iRow0','iRow1','iRow2'])geometry.setAttribute(name,new THREE.InstancedBufferAttribute(new Float32Array(NATURAL_RING.visibleCapacity*3),3).setUsage(THREE.DynamicDrawUsage));
      geometry.instanceCount=0;
      const material=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:vertex,fragmentShader:fragment,
        uniforms:{...uniforms,uColor:{value:new THREE.Color(colors[type])}},depthTest:true,depthWrite:true,transparent:false});
      const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;mesh.renderOrder=2;meshes.push(mesh);group.add(mesh);
    }
    stats.geometries=4;stats.materials=4;
  }
  function clear(){group.visible=false;stats.instances=0;stats.tiles=0;stats.bodyId=null;bodyId=null;tileX=NaN;tileZ=NaN;
    for(const mesh of meshes)mesh.geometry.instanceCount=0;
  }
  group.userData.clear=clear;
  group.userData.update=({body=null,bodies=null,camera,sectorIndex})=>{
    if(disposed)return;
    if(bodies!==null){
      body=null;let closest=Infinity;
      for(const candidate of bodies){
        if(candidate.kind!=='gas-giant'||!candidate.ringed||candidate.visibility<=0)continue;
        const f=candidate.frame,p=candidate.center;
        const x=-(f[0]*p[0]+f[3]*p[1]+f[6]*p[2]),y=-(f[1]*p[0]+f[4]*p[1]+f[7]*p[2]),z=-(f[2]*p[0]+f[5]*p[1]+f[8]*p[2]);
        const r=Math.hypot(x,z),horizontal=Math.max(candidate.radius*NATURAL_RING.inner-r,0,r-candidate.radius*NATURAL_RING.outer);
        const distance=Math.hypot(horizontal,Math.max(0,Math.abs(y)-NATURAL_RING.halfHeight));
        if(distance<closest){closest=distance;body=candidate;}
      }
    }
    if(!field||!body||body.kind!=='gas-giant'||!body.ringed){clear();return;}
    const f=body.frame,p=body.center;
    for(let axis=0;axis<3;axis++)cameraLocal[axis]=-(f[axis]*p[0]+f[3+axis]*p[1]+f[6+axis]*p[2]);
    const radial=Math.hypot(cameraLocal[0],cameraLocal[2]);
    if(Math.abs(cameraLocal[1])>NATURAL_RING.halfHeight+NATURAL_RING.fadeEnd
      ||radial<body.radius*NATURAL_RING.inner-NATURAL_RING.fadeEnd||radial>body.radius*NATURAL_RING.outer+NATURAL_RING.fadeEnd){clear();return;}
    if(!work)allocate();
    const x=Math.floor(cameraLocal[0]/NATURAL_RING.tile),z=Math.floor(cameraLocal[2]/NATURAL_RING.tile);
    if(body.id!==bodyId||x!==tileX||z!==tileZ||field.revision!==lastRevision){
      const records=field.visible(body,cameraLocal,sectorIndex,work);counts.fill(0);
      anchor[0]=(x+.5)*NATURAL_RING.tile;anchor[1]=0;anchor[2]=(z+.5)*NATURAL_RING.tile;
      for(const record of records){
        const g=meshes[record.prototype].geometry,at=counts[record.prototype]++*3;
        const root=g.attributes.iRoot.array;
        for(let axis=0;axis<3;axis++)root[at+axis]=record.localPosition[axis]-anchor[axis];
        for(let row=0;row<3;row++){const out=g.attributes[['iRow0','iRow1','iRow2'][row]].array;
          for(let axis=0;axis<3;axis++)out[at+axis]=record.localFrame[row*3+axis];}
      }
      for(let type=0;type<4;type++){
        const g=meshes[type].geometry;g.instanceCount=counts[type];
        for(const name of ['iRoot','iRow0','iRow1','iRow2'])g.attributes[name].needsUpdate=true;
      }
      bodyId=body.id;tileX=x;tileZ=z;lastRevision=field.revision;
      stats.instances=records.length;stats.tiles=work.tiles;stats.rebuilds++;stats.bodyId=bodyId;stats.revision=lastRevision;
    }
    uniforms.uAnchor.value.fromArray(anchor);
    frame.fromArray(f);uniforms.uBodyToWorld.value.copy(frame).transpose();
    uniforms.uViewRotation.value.setFromMatrix4(camera.matrixWorldInverse);
    // Subtract in double before float upload; near roots never cancel million-L GPU values.
    uniforms.uAnchorRelative.value.set(p[0]+f[0]*anchor[0]+f[1]*anchor[1]+f[2]*anchor[2],
      p[1]+f[3]*anchor[0]+f[4]*anchor[1]+f[5]*anchor[2],p[2]+f[6]*anchor[0]+f[7]*anchor[1]+f[8]*anchor[2]);
    uniforms.uLight.value.fromArray(body.light).normalize();uniforms.uRadius.value=body.radius;uniforms.uRingPhase.value=body.phase;
    group.visible=stats.instances>0;
  };
  group.userData.snapshot=()=>({mode:stats.mode,...stats,records:work?work.results.map(r=>({id:r.id,prototype:r.prototype,position:r.position.slice(),localPosition:r.localPosition.slice(),frame:r.frame.slice()})):[]});
  group.userData.dispose=()=>{
    if(disposed)return;clear();disposed=true;
    for(const mesh of meshes){mesh.geometry.dispose();mesh.material.dispose();}meshes.length=0;
    work=null;uniforms=null;stats.geometries=0;stats.materials=0;stats.disposed=true;group.clear();
  };
  return group;
}
