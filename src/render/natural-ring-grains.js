import * as THREE from 'three';
import {hashSeed,randomFromSeed} from '../random.js';
import {NATURAL_RING,NATURAL_RING_GRAIN_LOD,naturalRingVisualSigma,NATURAL_RING_SURFACE_LIGHT_GLSL} from '../natural-ring.js';

/** Static optical microstructure only: no collision/orbital bodies. Cauchy's
 * convex-body projection identity gives mean area = surface area/4 = sqrt(3)r².
 * A finite iid binomial population approximates the ensemble optical column;
 * it is not a raywise equality with the former continuous medium. */
const meanArea=Math.sqrt(3)*80,maximumTau=1.30*1.82*1.45;
export const NATURAL_RING_GRAINS=Object.freeze({tile:256,diameter:7,tiles:49,
  ...NATURAL_RING_GRAIN_LOD,maxRadius:15,centerHalfHeight:64,
  physicalHalfHeight:79,meanProjectedArea:meanArea,maximumNormalTau:maximumTau,
  capacity:Math.ceil(.95*maximumTau*256**2/meanArea),trianglesPerGrain:8});
const mediumStartPixels=24,mediumFullPixels=48,mediumCandidatePadding=.01;
function smooth(a,b,x){let v=Math.max(0,Math.min(1,(x-a)/(b-a)));return v*v*(3-2*v);}
export function naturalRingGrainWeight(distance){return NATURAL_RING_GRAINS.share*(1-smooth(NATURAL_RING_GRAINS.fadeStart,NATURAL_RING_GRAINS.fadeEnd,distance));}
/** Visual optical LOD only. Uniform local scale makes the orthographic
 * projected cross-section follow the medium's retained share. This does not
 * evolve physical bodies or establish raywise continuum/finite-grain equality. */
export function naturalRingGrainScale(distance){return Math.sqrt(naturalRingGrainWeight(distance)/NATURAL_RING_GRAINS.share);}
// Inverse of the normalized quartic envelope CDF. A fixed bracket has no
// rejection-loop cost/tail; 20 steps bound vertical inverse error to 0.000123L.
function heightSample(u){let lo=-1,hi=1;for(let i=0;i<20;i++){
  const v=(lo+hi)*.5,cdf=.5+15/16*(v-2*v*v*v/3+v*v*v*v*v/5);
  if(cdf<u)lo=v;else hi=v;
}return (lo+hi)*32;}
/** Bounded deterministic cell producer. write receives tile-local x/z and a
 * unit quaternion; no record objects/arrays are created per accepted grain. */
export function populateNaturalRingGrainTile(body,ix,iz,write,out){
  const config=NATURAL_RING_GRAINS,random=randomFromSeed(hashSeed(`${body.id}:${body.phase}:optical-grains-v1:${ix},${iz}`));
  let count=0,projectedArea=0,targetTau=0;
  for(let slot=0;slot<config.capacity;slot++){
    const x=random()*256,z=random()*256,yRoll=random(),radius=random()<.5?4:12,accept=random();
    const tau=naturalRingVisualSigma(ix*256+x,0,iz*256+z,body.radius,body.phase)*1024/15;
    targetTau+=tau/config.capacity;
    const probability=config.share*tau*256**2/(config.capacity*meanArea);
    if(probability>1+1e-12)throw new RangeError('Ring visual sigma exceeded the declared grain population bound');
    if(accept>=probability)continue;
    const u=random(),a=random()*Math.PI*2,b=random()*Math.PI*2;
    const qx=Math.sqrt(1-u)*Math.sin(a),qy=Math.sqrt(1-u)*Math.cos(a),qz=Math.sqrt(u)*Math.sin(b),qw=Math.sqrt(u)*Math.cos(b);
    const ice=.55+.35*random();
    write(count++,x,heightSample(yRoll),z,radius,qx,qy,qz,qw,ice*.94,ice,Math.min(1,ice*1.04),slot);
    projectedArea+=Math.sqrt(3)*radius*radius;
  }
  out.count=count;out.normalTauEstimate=projectedArea/256**2;out.targetNormalTauEstimate=config.share*targetTau;return out;
}
// Grain-local physical-L joint relief. This perturbs material normals only;
// the frozen shape, projected area, sigma allocation and silhouette do not move.
export const NATURAL_RING_ICE_RELIEF_GLSL=/* glsl */`
float ringIceHash(float cell){
  float p=fract(cell*.1031);p*=p+33.33;p*=p+p;return fract(p);
}
vec3 ringIceJointSlope(vec3 point,vec3 dx,vec3 dy,vec3 axis,float spacing,float height){
  float coordinate=dot(point,axis)/spacing,cell=floor(coordinate),local=fract(coordinate);
  float left=ringIceHash(cell),right=ringIceHash(cell+1.);
  float joint=.35+.30*ringIceHash(cell+17.17);
  float pixelSpan=(abs(dot(axis,dx))+abs(dot(axis,dy)))/spacing;
  // Broaden a resolved joint over its projected pixel span; unresolved cells
  // lose their slope rather than retaining a screen-space sparkle direction.
  float width=min(max(.44,1.5*pixelSpan),2.*min(joint,1.-joint));
  float t=clamp((local-joint+.5*width)/width,0.,1.);
  float keep=1.-smoothstep(.4,.8,pixelSpan);
  float slope=height*(right-left)*6.*t*(1.-t)/(width*spacing);
  return axis*(slope*keep);
}
vec3 ringIceReliefNormal(vec3 point,vec3 viewPoint,vec3 surfaceNormal,float faceDirection){
  vec3 dx=dFdx(point),dy=dFdy(point);
  vec3 gradient=ringIceJointSlope(point,dx,dy,vec3(.9128709,.3651484,.1825742),2.6,.52)
    +ringIceJointSlope(point,dx,dy,vec3(-.3577709,.8944272,.2683282),3.7,.33)
    +ringIceJointSlope(point,dx,dy,vec3(.1616904,-.5659165,.8084521),5.1,.21);
  // Bounded authored slope: <.65 (33 degrees) before the surface projection.
  gradient*=inversesqrt(1.+dot(gradient,gradient)/(.65*.65));
  vec2 heightDerivative=vec2(dot(gradient,dx),dot(gradient,dy));
  vec3 viewDx=dFdx(viewPoint),viewDy=dFdy(viewPoint);
  vec3 r1=cross(viewDy,surfaceNormal),r2=cross(surfaceNormal,viewDx);
  float determinant=dot(viewDx,r1)*faceDirection;
  vec3 surfaceGradient=sign(determinant)*(heightDerivative.x*r1+heightDerivative.y*r2);
  // Unnormalized view derivatives keep height and position in the same L units.
  return normalize(abs(determinant)*surfaceNormal-surfaceGradient);
}
`;
function makeMaterial(common,tileUniforms,source,medium=false){
  const material=source?source.clone():new THREE.MeshStandardMaterial({color:0xffffff,roughness:.74,metalness:0,flatShading:true});
  // Ice albedo shares the body's tint with the continuum. The convex proxy
  // has unrelated/strongly stretched atlas UVs, so it cannot use the scan's
  // baked tangent normals. Medium normals fade in with its actual geometry.
  material.map=null;material.vertexColors=false;material.roughness=.74;
  if(!medium)material.normalMap=null;
  material.alphaToCoverage=false;
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,common,tileUniforms);
    shader.vertexShader=`uniform vec3 uTileRoot,uTileRelative;uniform mat3 uBodyToWorld,uViewRotation;
      uniform float uFocalPixels,uSupportUnit;varying vec3 vRingPoint,vRingRelative,vIcePoint;varying float vGrainPixels,vRingMorph,vGrainKeep;
      ${medium?'attribute vec3 coarsePosition,coarseNormal;':''}\n`+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <beginnormal_vertex>',`
      vec3 grainCenter=uTileRelative+uBodyToWorld*instanceMatrix[3].xyz;
      float grainScale=length(instanceMatrix[0].xyz);
      float grainRadius=grainScale*uSupportUnit;
      float grainDepth=-(uViewRotation*grainCenter).z;
      float grainKeep=1.-smoothstep(${NATURAL_RING_GRAINS.fadeStart.toFixed(1)},${NATURAL_RING_GRAINS.fadeEnd.toFixed(1)},length(grainCenter));
      float grainAreaScale=sqrt(grainKeep);vGrainKeep=grainKeep;
      vGrainPixels=uFocalPixels*grainRadius/max(grainDepth-grainRadius,.000001);
      float grainMorph=smoothstep(${mediumStartPixels.toFixed(1)},${mediumFullPixels.toFixed(1)},vGrainPixels);vRingMorph=grainMorph;
      #include <beginnormal_vertex>
      ${medium?'objectNormal=mix(coarseNormal,normal,grainMorph);':''}`);
    // A subdivided coarse face must retain the raster's linear normal field.
    // Normalizing its barycentric samples here would bend that field again.
    if(medium)shader.vertexShader=shader.vertexShader.replace('#include <normal_vertex>',
      THREE.ShaderChunk.normal_vertex.replace('vNormal = normalize( transformedNormal );','vNormal = transformedNormal;'));
    shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      ${medium?'transformed=mix(coarsePosition,position,grainMorph);':''}
      // Optical area LOD: shrink the local shape, never its centre.
      // Three's project_vertex consumes the same transformed position once.
      transformed*=grainAreaScale;
      // No million-L coordinate cancellation and no extra random-stream draws.
      float icePhase=fract(dot(vec3(instanceMatrix[0].x,instanceMatrix[1].y,instanceMatrix[2].z),vec3(.1031,.11369,.13787)));
      vIcePoint=transformed*grainScale+icePhase*vec3(43.7,71.3,91.1);
      vec3 grainLocal=(instanceMatrix*vec4(transformed,1.)).xyz;
      vRingPoint=uTileRoot+grainLocal;vRingRelative=uTileRelative+uBodyToWorld*grainLocal;`);
    shader.fragmentShader=`uniform vec3 uLight,uIceTint;uniform mat3 uBodyToWorld,uViewRotation;uniform float uRadius,uRingPhase,uHasMedium;
      varying vec3 vRingPoint,vRingRelative,vIcePoint;varying float vGrainPixels,vRingMorph,vGrainKeep;\n${NATURAL_RING_SURFACE_LIGHT_GLSL}\n${NATURAL_RING_ICE_RELIEF_GLSL}\n`+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
      ${medium?`if(vGrainPixels<${mediumStartPixels.toFixed(1)})discard;`:`if(uHasMedium>.5&&vGrainPixels>=${mediumStartPixels.toFixed(1)})discard;`}
      if(vGrainKeep<=0.)discard;`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
      // Dust inclusions form discontinuous seams in the ice. The optical
      // occupancy and the shared planetary/ring shadow ray remain unchanged.
      float jointCoordinate=dot(vIcePoint,vec3(.9128709,.3651484,.1825742))/2.6;
      float jointCell=floor(jointCoordinate),jointWidth=fwidth(jointCoordinate);
      float jointCenter=.35+.30*ringIceHash(jointCell+17.17);
      float jointDistance=abs(fract(jointCoordinate)-jointCenter);
      float inclusion=(1.-smoothstep(.035,.13+.5*jointWidth,jointDistance))
        *(1.-smoothstep(.18,.52,jointWidth))*ringIceHash(jointCell+41.7);
      diffuseColor.rgb*=mix(vec3(1.),vec3(.44,.35,.29),inclusion);
      diffuseColor.rgb*=uIceTint*naturalRingArtTint(length(vRingPoint.xz)/uRadius,uRingPhase,(abs(dFdx(length(vRingPoint.xz)))+abs(dFdy(length(vRingPoint.xz))))/uRadius);`);
    shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>',`#include <roughnessmap_fragment>
      roughnessFactor=mix(.55, .90, inclusion);`);
    const normalMaps=medium?THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;','mapN.xy *= normalScale * vRingMorph;'):THREE.ShaderChunk.normal_fragment_maps;
    shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>',normalMaps+
      '\nnormal=ringIceReliefNormal(vIcePoint,-vViewPosition,normal,faceDirection);');
    shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>',`
      vec3 geometryPosition=-vViewPosition,geometryNormal=normal;
      vec3 geometryViewDir=isOrthographic?vec3(0.,0.,1.):normalize(vViewPosition),geometryClearcoatNormal=vec3(0.);
      material.dfg=texture2D(dfgLUT,vec2(material.roughness,saturate(dot(geometryNormal,geometryViewDir)))).rg;
      float grainEss=material.dfg.x+material.dfg.y;
      material.multiScatteringCompensation=1.+material.specularColorBlended*(1./grainEss-1.);
      IncidentLight directLight;directLight.direction=normalize(uViewRotation*uBodyToWorld*uLight);
      directLight.color=vec3(1.05*PI)*naturalRingSunTransmission(vRingPoint/uRadius);directLight.visible=true;
      RE_Direct(directLight,geometryPosition,geometryNormal,geometryViewDir,geometryClearcoatNormal,material,reflectedLight);
      vec3 iblIrradiance=vec3(0.),irradiance=vec3(.035*PI),radiance=vec3(0.),clearcoatRadiance=vec3(0.);
    `);
  };
  material.customProgramCacheKey=()=> medium?'ring-art-medium-v2:ice-joints-v2':'ring-art-coarse-v2:ice-joints-v2';return material;
}
function surfaceArea(geometry){
  const p=geometry.attributes.position,index=geometry.index,a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3();
  let area=0;const count=index?index.count:p.count;
  for(let i=0;i<count;i+=3){a.fromBufferAttribute(p,index?index.getX(i):i);b.fromBufferAttribute(p,index?index.getX(i+1):i+1);c.fromBufferAttribute(p,index?index.getX(i+2):i+2);area+=ab.subVectors(b,a).cross(ac.subVectors(c,a)).length()*.5;}
  return area;
}
function outerRadius(geometry){const p=geometry.attributes.position;let r=0;for(let i=0;i<p.count;i++)r=Math.max(r,Math.hypot(p.getX(i),p.getY(i),p.getZ(i)));return r;}
/** Creation-only common subdivision of the original medium surface and the
 * coarse face cones. Each output triangle belongs to one original medium
 * triangle and one coarse face, preserving both endpoint surfaces/normal fields.
 * No source geometry is changed; the caller owns this unuploaded medium clone. */
function coarseProjection(coarse,medium){
  const p=coarse.attributes.position,sourceNormals=coarse.attributes.normal,index=coarse.index,count=index?index.count:p.count;
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),normal=new THREE.Vector3(),ab=new THREE.Vector3(),ac=new THREE.Vector3();
  const point=new THREE.Vector3(),bary=new THREE.Vector3(),n0=new THREE.Vector3(),n1=new THREE.Vector3(),n2=new THREE.Vector3(),cones=[new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3()];
  const names=['position',...Object.keys(medium.attributes).filter(name=>name!=='position')],attributes=names.map(name=>medium.attributes[name]),offsets=[],output=names.map(()=>[]),projected=[],normals=[];
  let stride=0;for(const attribute of attributes){offsets.push(stride);stride+=attribute.itemSize;}
  // A triangle clipped by three half spaces has at most six vertices.
  let input=new Float64Array(6*stride),scratch=new Float64Array(6*stride);
  const sourceIndex=medium.index,sourceCount=sourceIndex?sourceIndex.count:medium.attributes.position.count;
  for(let face=0;face<count;face+=3){
    const ia=index?index.getX(face):face,ib=index?index.getX(face+1):face+1,ic=index?index.getX(face+2):face+2;
    a.fromBufferAttribute(p,ia);b.fromBufferAttribute(p,ib);c.fromBufferAttribute(p,ic);
    normal.copy(ab.subVectors(b,a).cross(ac.subVectors(c,a))).normalize();let distance=normal.dot(a);
    if(distance<0){normal.negate();distance=-distance;}if(!(distance>0))throw new RangeError('Coarse grain hull must contain its normalization origin');
    cones[0].crossVectors(a,b).normalize();if(cones[0].dot(c)<0)cones[0].negate();
    cones[1].crossVectors(b,c).normalize();if(cones[1].dot(a)<0)cones[1].negate();
    cones[2].crossVectors(c,a).normalize();if(cones[2].dot(b)<0)cones[2].negate();
    n0.fromBufferAttribute(sourceNormals,ia).normalize();n1.fromBufferAttribute(sourceNormals,ib).normalize();n2.fromBufferAttribute(sourceNormals,ic).normalize();
    for(let triangle=0;triangle<sourceCount;triangle+=3){
      for(let corner=0;corner<3;corner++){
        const vertex=sourceIndex?sourceIndex.getX(triangle+corner):triangle+corner;
        for(let attribute=0;attribute<attributes.length;attribute++){
          const source=attributes[attribute];for(let component=0;component<source.itemSize;component++)input[corner*stride+offsets[attribute]+component]=source.array[vertex*source.itemSize+component];
        }
      }
      let vertices=3;
      for(const plane of cones){
        let written=0,previous=(vertices-1)*stride,previousDistance=plane.x*input[previous]+plane.y*input[previous+1]+plane.z*input[previous+2];
        for(let vertex=0;vertex<vertices;vertex++){
          const at=vertex*stride,d=plane.x*input[at]+plane.y*input[at+1]+plane.z*input[at+2];
          if((d>=0)!==(previousDistance>=0)){
            const t=previousDistance/(previousDistance-d);
            // Skip only an endpoint that is already retained as inside. A
            // crossing can round to the outside endpoint at t=0/1 as well.
            if((previousDistance>=0&&t>0)||(d>=0&&t<1)){for(let component=0;component<stride;component++)scratch[written*stride+component]=input[previous+component]+(input[at+component]-input[previous+component])*t;written++;}
          }
          if(d>=0){for(let component=0;component<stride;component++)scratch[written*stride+component]=input[at+component];written++;}
          previous=at;previousDistance=d;
        }
        const swap=input;input=scratch;scratch=swap;vertices=written;if(vertices<3)break;
      }
      for(let triangle=1;triangle+1<vertices;triangle++){
        point.fromArray(input,0);ab.fromArray(input,triangle*stride).sub(point);ac.fromArray(input,(triangle+1)*stride).sub(point);
        if(ab.cross(ac).lengthSq()===0)continue;
        for(let corner=0;corner<3;corner++){
          const at=(corner===0?0:triangle+corner-1)*stride;
          for(let attribute=0;attribute<attributes.length;attribute++)for(let component=0;component<attributes[attribute].itemSize;component++)output[attribute].push(input[at+offsets[attribute]+component]);
          point.fromArray(input,at);point.multiplyScalar(distance/normal.dot(point));THREE.Triangle.getBarycoord(point,a,b,c,bary);
          projected.push(point.x,point.y,point.z);
          normals.push(n0.x*bary.x+n1.x*bary.y+n2.x*bary.z,n0.y*bary.x+n1.y*bary.y+n2.y*bary.z,n0.z*bary.x+n1.z*bary.y+n2.z*bary.z);
        }
      }
    }
  }
  medium.setIndex(null);for(let attribute=0;attribute<attributes.length;attribute++)medium.setAttribute(names[attribute],new THREE.Float32BufferAttribute(output[attribute],attributes[attribute].itemSize));
  medium.setAttribute('coarsePosition',new THREE.Float32BufferAttribute(projected,3));medium.setAttribute('coarseNormal',new THREE.Float32BufferAttribute(normals,3));
}
export function createNaturalRingGrains({assets=null}={}){
  const config=NATURAL_RING_GRAINS,group=new THREE.Group();group.name='Resolved static optical ice grains';group.visible=false;
  const cameraLocal=[0,0,0],bodyToWorld=new THREE.Matrix3(),rotation=new THREE.Matrix4(),orientation=new THREE.Quaternion();
  const position=new THREE.Vector3(),quaternion=new THREE.Quaternion(),scale=new THREE.Vector3(),matrix=new THREE.Matrix4(),color=new THREE.Color();
  const slots=new Array(config.tiles),common={uBodyToWorld:{value:bodyToWorld},uViewRotation:{value:new THREE.Matrix3()},uLight:{value:new THREE.Vector3()},uIceTint:{value:new THREE.Vector3()},uRadius:{value:1},uRingPhase:{value:0},
    uFocalPixels:{value:0},uSupportUnit:{value:1},uHasMedium:{value:0}};
  const lastCamera=new Float64Array(16),lastProjection=new Float64Array(16),lastCenter=new Float64Array(3),lastFrame=new Float64Array(9);
  let geometry=null,mediumGeometry=null,mediumMesh=null,mediumUniforms=null,keys=null,lastBody=null,disposed=false,allocated=false,lastPhase=NaN,lastRadius=NaN,trianglesPerGrain=8,mediumTriangles=0,lastHeight=0,lastRatio=0;
  const stats={mode:'STATIC_OPTICAL_NO_COLLISION',bodyId:null,instances:0,triangles:0,tiles:0,tileBuilds:0,
    capacityPerTile:config.capacity,maximumTriangles:config.capacity*49*8,centerHalfHeight:64,physicalHalfHeight:config.physicalHalfHeight,meanProjectedArea:meanArea,instanceBytes:0,share:config.share,fadeStart:config.fadeStart,fadeEnd:config.fadeEnd,
    mediumInstances:0,morphInstances:0,mediumStartPixels,mediumFullPixels,mediumTrianglesPerGrain:0,mediumUploads:0,selectionUpdates:0,lastMediumUploadBytes:0,
    normalTauEstimate:0,targetNormalTauEstimate:0,disposed:false};
  group.userData.stats=stats;

  function allocate(){
    let sourceMaterial=null;
    if(assets){
      const source=assets.get?assets.get(0):{coarse:assets.coarse[0],medium:assets.medium?.[0],material:assets.material};
      geometry=source.coarse.clone();sourceMaterial=source.material;
      const area=surfaceArea(geometry),areaScale=Math.sqrt(4*Math.sqrt(3)/area);
      if(!(area>0&&Number.isFinite(area)))throw new RangeError('Scanned grain hull has no finite projected area');
      geometry.scale(areaScale,areaScale,areaScale);
      if(source.medium){mediumGeometry=source.medium.clone();mediumGeometry.scale(areaScale,areaScale,areaScale);coarseProjection(geometry,mediumGeometry);}
      common.uSupportUnit.value=Math.max(outerRadius(geometry),mediumGeometry?outerRadius(mediumGeometry):0);
      if(common.uSupportUnit.value*12>config.maxRadius)throw new RangeError('Scanned grain LOD exceeds the shared support contract');
      trianglesPerGrain=(geometry.index?geometry.index.count:geometry.attributes.position.count)/3;
    }else geometry=new THREE.OctahedronGeometry(1,0);
    stats.trianglesPerGrain=trianglesPerGrain;
    for(let i=0;i<slots.length;i++){
      const uniforms={uTileRoot:{value:new THREE.Vector3()},uTileRelative:{value:new THREE.Vector3()}},material=makeMaterial(common,uniforms,sourceMaterial);
      const mesh=new THREE.InstancedMesh(geometry,material,config.capacity);mesh.count=0;mesh.visible=false;mesh.renderOrder=2;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(config.capacity*3),3).setUsage(THREE.DynamicDrawUsage);
      mesh.boundingSphere=new THREE.Sphere(new THREE.Vector3(128,0,128),Math.hypot(128,128,64)+config.maxRadius);
      const slot={mesh,uniforms,x:NaN,z:NaN,count:0,normalTauEstimate:0,targetNormalTauEstimate:0,write:null};
      slot.write=(at,x,y,z,r,qx,qy,qz,qw,red,green,blue)=>{position.set(x,y,z);quaternion.set(qx,qy,qz,qw);scale.setScalar(r);matrix.compose(position,quaternion,scale);mesh.setMatrixAt(at,matrix);color.setRGB(red,green,blue);mesh.setColorAt(at,color);};
      slots[i]=slot;group.add(mesh);
    }
    if(mediumGeometry){
      mediumUniforms={uTileRoot:{value:new THREE.Vector3()},uTileRelative:{value:new THREE.Vector3()}};
      mediumMesh=new THREE.InstancedMesh(mediumGeometry,makeMaterial(common,mediumUniforms,sourceMaterial,true),config.tiles*config.capacity);
      mediumMesh.name='Selected scanned medium grains';mediumMesh.count=0;mediumMesh.visible=false;mediumMesh.renderOrder=2;mediumMesh.frustumCulled=false;
      mediumMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mediumMesh.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(config.tiles*config.capacity*3),3).setUsage(THREE.DynamicDrawUsage);
      keys=new Uint32Array(config.tiles*config.capacity);keys.fill(0xffffffff);group.add(mediumMesh);common.uHasMedium.value=1;
      mediumTriangles=(mediumGeometry.index?mediumGeometry.index.count:mediumGeometry.attributes.position.count)/3;stats.mediumTrianglesPerGrain=mediumTriangles;
    }
    allocated=true;stats.instanceBytes=config.tiles*config.capacity*19*4*(mediumMesh?2:1)+(keys?keys.byteLength:0);
    stats.maximumTriangles=config.tiles*config.capacity*(trianglesPerGrain+mediumTriangles);
  }
  function releaseResources(){
    for(let i=0;i<slots.length;i++){const slot=slots[i];if(!slot)continue;
      slot.mesh.dispose();slot.mesh.material.dispose();slot.mesh.material.map=null;slot.mesh.material.normalMap=null;slot.mesh.instanceColor=null;slots[i]=null;
    }
    if(mediumMesh){mediumMesh.dispose();mediumMesh.material.dispose();mediumMesh.material.map=null;mediumMesh.material.normalMap=null;mediumMesh.instanceColor=null;}
    geometry?.dispose();mediumGeometry?.dispose();geometry=mediumGeometry=mediumMesh=keys=null;group.clear();allocated=false;stats.instanceBytes=0;
  }
  function clear(){
    group.visible=false;lastBody=null;stats.bodyId=null;stats.instances=stats.triangles=stats.tiles=stats.mediumInstances=stats.morphInstances=0;
    stats.normalTauEstimate=stats.targetNormalTauEstimate=0;stats.lastMediumUploadBytes=0;
    if(allocated){for(const slot of slots){slot.x=slot.z=NaN;slot.mesh.count=0;slot.mesh.visible=false;}if(mediumMesh){mediumMesh.count=0;mediumMesh.visible=false;}}
  }
  group.userData.clear=clear;
  group.userData.update=({body=null,bodies=null,camera,viewportHeight,pixelRatio=1})=>{
    if(disposed)return;
    if(bodies!==null){let closest=Infinity;body=null;for(const candidate of bodies){
      if(candidate.kind!=='gas-giant'||!candidate.ringed||candidate.visibility<=0)continue;
      const f=candidate.frame,p=candidate.center,x=-(f[0]*p[0]+f[3]*p[1]+f[6]*p[2]),y=-(f[1]*p[0]+f[4]*p[1]+f[7]*p[2]),z=-(f[2]*p[0]+f[5]*p[1]+f[8]*p[2]);
      const r=Math.hypot(x,z),d=Math.hypot(Math.max(candidate.radius*1.25-r,0,r-candidate.radius*2.1),Math.max(0,Math.abs(y)-config.physicalHalfHeight));if(d<closest){closest=d;body=candidate;}
    }}
    if(!body||body.kind!=='gas-giant'||!body.ringed){clear();return;}
    const f=body.frame,p=body.center;
    for(let axis=0;axis<3;axis++)cameraLocal[axis]=-(f[axis]*p[0]+f[axis+3]*p[1]+f[axis+6]*p[2]);
    const radial=Math.hypot(cameraLocal[0],cameraLocal[2]);
    if(Math.abs(cameraLocal[1])>config.physicalHalfHeight+config.fadeEnd||radial<body.radius*NATURAL_RING.inner-config.fadeEnd-config.maxRadius||radial>body.radius*NATURAL_RING.outer+config.fadeEnd+config.maxRadius){clear();return;}
    if(!allocated){try{allocate();}catch(error){releaseResources();throw error;}}
    let dirty=false;
    if(body.id!==lastBody||body.phase!==lastPhase||body.radius!==lastRadius){for(const slot of slots)slot.x=slot.z=NaN;lastBody=body.id;lastPhase=body.phase;lastRadius=body.radius;dirty=true;}
    bodyToWorld.fromArray(f).transpose();rotation.setFromMatrix3(bodyToWorld);orientation.setFromRotationMatrix(rotation);
    common.uViewRotation.value.setFromMatrix4(camera.matrixWorldInverse);common.uLight.value.fromArray(body.light).normalize();common.uIceTint.value.fromArray(body.tint);common.uRadius.value=body.radius;common.uRingPhase.value=body.phase;
    const cx=Math.floor(cameraLocal[0]/256),cz=Math.floor(cameraLocal[2]/256),cw=camera.matrixWorld.elements;
    let instances=0,tau=0,targetTau=0;
    for(let iz=cz-3;iz<=cz+3;iz++)for(let ix=cx-3;ix<=cx+3;ix++){
      const index=((ix%7)+7)%7+((iz%7)+7)%7*7,slot=slots[index],mesh=slot.mesh;
      if(slot.x!==ix||slot.z!==iz){populateNaturalRingGrainTile(body,ix,iz,slot.write,slot);slot.x=ix;slot.z=iz;mesh.count=slot.count;mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;stats.tileBuilds++;dirty=true;}
      const x=ix*256,z=iz*256,wx=p[0]+f[0]*x+f[2]*z,wy=p[1]+f[3]*x+f[5]*z,wz=p[2]+f[6]*x+f[8]*z;
      slot.uniforms.uTileRoot.value.set(x,0,z);slot.uniforms.uTileRelative.value.set(wx,wy,wz);
      mesh.position.set(cw[12]+wx,cw[13]+wy,cw[14]+wz);mesh.quaternion.copy(orientation);mesh.updateMatrix();mesh.visible=slot.count>0;
      instances+=slot.count;tau+=slot.normalTauEstimate;targetTau+=slot.targetNormalTauEstimate;
    }
    stats.lastMediumUploadBytes=0;
    if(mediumMesh){
      if(!(viewportHeight>0&&pixelRatio>0))throw new RangeError('Medium grain LOD requires actual viewport dimensions');
      const view=camera.matrixWorldInverse.elements,projection=camera.projectionMatrix.elements;
      for(let i=0;i<16;i++){if(lastCamera[i]!==view[i]||lastProjection[i]!==projection[i])dirty=true;lastCamera[i]=view[i];lastProjection[i]=projection[i];}
      for(let i=0;i<3;i++){if(lastCenter[i]!==p[i])dirty=true;lastCenter[i]=p[i];}for(let i=0;i<9;i++){if(lastFrame[i]!==f[i])dirty=true;lastFrame[i]=f[i];}
      if(lastHeight!==viewportHeight||lastRatio!==pixelRatio)dirty=true;lastHeight=viewportHeight;lastRatio=pixelRatio;
      const focal=viewportHeight*pixelRatio*projection[5]*.5;common.uFocalPixels.value=focal;
      const anchorX=(cx+.5)*256,anchorZ=(cz+.5)*256,ax=p[0]+f[0]*anchorX+f[2]*anchorZ,ay=p[1]+f[3]*anchorX+f[5]*anchorZ,az=p[2]+f[6]*anchorX+f[8]*anchorZ;
      mediumUniforms.uTileRoot.value.set(anchorX,0,anchorZ);mediumUniforms.uTileRelative.value.set(ax,ay,az);mediumMesh.position.set(cw[12]+ax,cw[13]+ay,cw[14]+az);mediumMesh.quaternion.copy(orientation);mediumMesh.updateMatrix();
      if(dirty){
        stats.selectionUpdates++;let count=0,morph=0,changed=stats.tileBuilds!==stats.selectionTileBuilds;
        const tanV=1/projection[5],tanH=1/projection[0],cosV=1/Math.sqrt(1+tanV*tanV),cosH=1/Math.sqrt(1+tanH*tanH),sinV=tanV*cosV,sinH=tanH*cosH,bw=bodyToWorld.elements,vr=common.uViewRotation.value.elements;
        for(let slotIndex=0;slotIndex<slots.length;slotIndex++){
          const slot=slots[slotIndex],data=slot.mesh.instanceMatrix.array,root=slot.uniforms.uTileRelative.value;
          for(let at=0;at<slot.count;at++){
            const base=at*16,x=data[base+12],y=data[base+13],z=data[base+14],wx=root.x+bw[0]*x+bw[3]*y+bw[6]*z,wy=root.y+bw[1]*x+bw[4]*y+bw[7]*z,wz=root.z+bw[2]*x+bw[5]*y+bw[8]*z;
            const r=Math.hypot(data[base],data[base+1],data[base+2])*common.uSupportUnit.value;
            if(wx*wx+wy*wy+wz*wz>(config.fadeEnd+r)**2)continue;
            const vx=vr[0]*wx+vr[3]*wy+vr[6]*wz,vy=vr[1]*wx+vr[4]*wy+vr[7]*wz,depth=-(vr[2]*wx+vr[5]*wy+vr[8]*wz);
            if(depth+r<=camera.near||Math.abs(vx)*cosH-depth*sinH>r||Math.abs(vy)*cosV-depth*sinV>r)continue;
            // CPU broad phase includes 0.01px around the float32 shader
            // boundary. Both shader paths then use exclusive >=24/<24 tests.
            const pixels=focal*r/Math.max(depth-r,.000001);if(pixels<mediumStartPixels-mediumCandidatePadding)continue;
            const key=slotIndex*config.capacity+at;if(keys[count]!==key)changed=true;keys[count++]=key;if(pixels<mediumFullPixels)morph++;
          }
        }
        if(count!==mediumMesh.count)changed=true;
        if(changed){
          const dest=mediumMesh.instanceMatrix.array,destColors=mediumMesh.instanceColor.array;
          for(let at=0;at<count;at++){
            const key=keys[at],slot=slots[Math.floor(key/config.capacity)],particle=key%config.capacity,source=slot.mesh.instanceMatrix.array,colors=slot.mesh.instanceColor.array;
            for(let k=0;k<16;k++)dest[at*16+k]=source[particle*16+k];
            dest[at*16+12]+=slot.x*256-anchorX;dest[at*16+14]+=slot.z*256-anchorZ;
            for(let k=0;k<3;k++)destColors[at*3+k]=colors[particle*3+k];
          }
          mediumMesh.count=count;mediumMesh.instanceMatrix.needsUpdate=true;mediumMesh.instanceColor.needsUpdate=true;stats.mediumUploads++;stats.lastMediumUploadBytes=count*19*4;
        }
        stats.mediumInstances=count;stats.morphInstances=morph;stats.selectionTileBuilds=stats.tileBuilds;
      }
      mediumMesh.visible=mediumMesh.count>0;
    }
    stats.bodyId=body.id;stats.instances=instances;stats.coarseResolvedInstances=instances-stats.mediumInstances;stats.triangles=instances*trianglesPerGrain+stats.mediumInstances*mediumTriangles;stats.tiles=49;
    stats.normalTauEstimate=tau/49;stats.targetNormalTauEstimate=targetTau/49;group.visible=instances>0;
  };
  group.userData.snapshot=()=>({...stats});
  group.userData.dispose=()=>{
    if(disposed)return;clear();disposed=true;
    releaseResources();assets=null;stats.disposed=true;
  };
  return group;
}
