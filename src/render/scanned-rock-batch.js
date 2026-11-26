import {ROCKY_CONTACT_SHADOW_GLSL} from './rocky-contact-shadows.js';
import * as THREE from 'three';
const ROWS=['iRow0','iRow1','iRow2'],ATTRS=['iRoot',...ROWS];
export function configureScannedRockStandardMaterial(material,uniforms,fadeStart,fadeEnd,shadowUniforms=null){
  const procedural=material.userData.proceduralMineral===true;
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,uniforms);if(shadowUniforms)Object.assign(shader.uniforms,shadowUniforms);
    shader.vertexShader=`attribute vec3 iRoot,iRow0,iRow1,iRow2;
      uniform mat3 uBodyToWorld,uViewRotation;uniform vec3 uAnchor,uAnchorRelative;
      varying vec3 vRockPoint,vRockRelative;\n`+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace('#include <defaultnormal_vertex>',`vec3 transformedNormal=uViewRotation*uBodyToWorld*vec3(dot(iRow0,objectNormal),dot(iRow1,objectNormal),dot(iRow2,objectNormal));
      #ifdef FLIP_SIDED
        transformedNormal=-transformedNormal;
      #endif`);
    shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`vec3 rockOffset=vec3(dot(iRow0,transformed),dot(iRow1,transformed),dot(iRow2,transformed));
      vRockPoint=uAnchor+iRoot+rockOffset;vRockRelative=uAnchorRelative+uBodyToWorld*(iRoot+rockOffset);
      vec4 mvPosition=vec4(uViewRotation*vRockRelative,1.);gl_Position=projectionMatrix*mvPosition;`);
    shader.vertexShader=shader.vertexShader.replace('#include <worldpos_vertex>','vec4 worldPosition=vec4(cameraPosition+vRockRelative,1.);');
    shader.fragmentShader=(shadowUniforms?ROCKY_CONTACT_SHADOW_GLSL:'')+`uniform mat3 uBodyToWorld,uViewRotation;uniform vec3 uLight;uniform float uRadius;
      varying vec3 vRockPoint,vRockRelative;\n`+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
      float rockFade=1.-smoothstep(${fadeStart.toFixed(1)},${fadeEnd.toFixed(1)},length(vRockRelative));
      if(rockFade<=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453))discard;`);
    if(procedural){
      const varyings='varying vec3 vRockSurface; varying float vMineral;';
      shader.vertexShader=varyings+'\n'+shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
        vRockSurface=position;
        vec3 tile=floor(uAnchor+iRoot);
        vMineral=fract(sin(dot(tile,vec3(29.79,51.34,69.11)))*43758.5453);
      `);
      shader.fragmentShader=varyings+'\n'+shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        vec3 q=vRockSurface;
        float pixel=max(length(dFdx(q)),length(dFdy(q)));
        float seam=sin(q.x*.91+q.y*1.74+q.z*.37+1.3*sin(q.z*.53))*cos(q.z*.74-q.y*.21);
        float stratum=smoothstep(-.31,.72,seam)*(1.-smoothstep(.24,.79,pixel));
        float grain=sin(q.x*8.41+q.z*5.66)*sin(q.y*7.69-q.x*3.01+sin(q.z*2.78));
        grain*=1.-smoothstep(.033,.15,pixel);
        vec3 shale=mix(vec3(.081,.076,.068),vec3(.18,.135,.087),vMineral);
        vec3 feldspar=mix(vec3(.24,.22,.187),vec3(.165,.179,.184),vMineral);
        diffuseColor.rgb*=mix(shale,feldspar,.24+.35*stratum)*(1.+.14*grain);
      `);
    }
    shader.fragmentShader=shader.fragmentShader.replace('#include <lights_fragment_begin>',`
      vec3 geometryPosition=-vViewPosition,geometryNormal=normal;
      vec3 geometryViewDir=isOrthographic?vec3(0.,0.,1.):normalize(vViewPosition);
      vec3 geometryClearcoatNormal=vec3(0.);
      material.dfg=texture2D(dfgLUT,vec2(material.roughness,saturate(dot(geometryNormal,geometryViewDir)))).rg;
      float rockEss=material.dfg.x+material.dfg.y;
      material.multiScatteringCompensation=1.+material.specularColorBlended*(1./rockEss-1.);
      IncidentLight directLight;directLight.direction=normalize(uViewRotation*uBodyToWorld*uLight);
      bool rockShadow=dot(vRockPoint,uLight)<0.&&length(cross(vRockPoint,uLight))<uRadius;
      directLight.color=vec3(1.05*PI)*(rockShadow ? .025 : 1.)${shadowUniforms?'*rockyContactVisibility(vRockPoint)':''};directLight.visible=true;
      RE_Direct(directLight,geometryPosition,geometryNormal,geometryViewDir,geometryClearcoatNormal,material,reflectedLight);
      vec3 iblIrradiance=vec3(0.),irradiance=vec3(.035*PI),radiance=vec3(0.),clearcoatRadiance=vec3(0.);
    `);
  };
  material.customProgramCacheKey=()=> `scanned-rock-pbr-v1:${fadeStart}:${fadeEnd}${shadowUniforms?':contact':''}${procedural?':procedural-mineral':''}`;
}
/** Borrowed geometry/material payloads; one bounded view owns instance wrappers. */
export function createScannedRockBatch({assets,capacity,fadeStart,fadeEnd,name,lazy=false,shadowUniforms=null}){
  const group=new THREE.Group();group.name=name;group.visible=false;
  const meshes=new Array(8).fill(null),queues=Array.from({length:8},()=>new Int32Array(capacity)),counts=new Uint16Array(8),matrix=new THREE.Matrix3();
  const uniforms={uBodyToWorld:{value:new THREE.Matrix3()},uViewRotation:{value:new THREE.Matrix3()},uAnchor:{value:new THREE.Vector3()},uAnchorRelative:{value:new THREE.Vector3()},uLight:{value:new THREE.Vector3()},uRadius:{value:1}};
  const stats={instances:0,fineInstances:0,coarseInstances:0,bufferUploads:0,geometries:0,materials:0,disposed:false};let disposed=false,focalHeight=1;
  function ensure(type){if(meshes[type*2])return;const data=assets.get?assets.get(type):{fine:assets.fine[type],coarse:assets.coarse[type],material:assets.material};
    for(let lod=0;lod<2;lod++){const source=lod===0?data.fine:data.coarse,geometry=new THREE.InstancedBufferGeometry();
      for(const name of Object.keys(source.attributes)){const a=source.attributes[name];geometry.setAttribute(name,new THREE.BufferAttribute(a.array,a.itemSize,a.normalized));}
      if(source.index)geometry.setIndex(new THREE.BufferAttribute(source.index.array,1));
      for(const name of ATTRS)geometry.setAttribute(name,new THREE.InstancedBufferAttribute(new Float32Array(capacity*3),3).setUsage(THREE.DynamicDrawUsage));
      geometry.instanceCount=0;const material=data.material.clone();configureScannedRockStandardMaterial(material,uniforms,fadeStart,fadeEnd,shadowUniforms);
      const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;mesh.renderOrder=2;mesh.visible=false;mesh.name=lod===0?'Exact scanned fine':'Sampled convex display approximation';meshes[type*2+lod]=mesh;group.add(mesh);stats.geometries++;stats.materials++;
    }
  }
  if(!lazy)for(let type=0;type<4;type++)ensure(type);
  group.userData.stats=stats;group.userData.shadowSources=meshes;group.userData.batchUniforms=uniforms;
  group.userData.clear=()=>{group.visible=false;stats.instances=stats.fineInstances=stats.coarseInstances=0;for(const mesh of meshes)if(mesh){mesh.geometry.instanceCount=0;mesh.visible=false;}};
  group.userData.upload=(work,camera,body,cameraLocal,anchor,changed)=>{
    if(disposed)return;const focal=focalHeight*camera.projectionMatrix.elements[5]*.5;counts.fill(0);let dirty=changed?255:0,fine=0;
    for(let i=0;i<work.count;i++){const r=work.records[i],root=r.localPosition,d=Math.hypot(root[0]-cameraLocal[0],root[1]-cameraLocal[1],root[2]-cameraLocal[2]);
      const projected=d<=r.boundsRadius?Infinity:focal*r.boundsRadius/Math.sqrt((d-r.boundsRadius)*(d+r.boundsRadius));
      const lod=projected>=assets.fineProjectedRadiusPixels?0:1,bucket=r.prototype*2+lod,at=counts[bucket]++;if(queues[bucket][at]!==i)dirty|=1<<bucket;queues[bucket][at]=i;if(lod===0)fine++;
    }
    for(let type=0;type<4;type++)if(counts[type*2]+counts[type*2+1])ensure(type);
    for(let bucket=0;bucket<8;bucket++){const mesh=meshes[bucket];if(!mesh)continue;const g=mesh.geometry,count=counts[bucket];if(count!==g.instanceCount)dirty|=1<<bucket;
      if(dirty&(1<<bucket)){for(let j=0;j<count;j++){const r=work.records[queues[bucket][j]],root=g.attributes.iRoot.array;
        for(let axis=0;axis<3;axis++)root[j*3+axis]=r.localPosition[axis]-anchor[axis];
        for(let row=0;row<3;row++){const out=g.attributes[ROWS[row]].array;for(let axis=0;axis<3;axis++)out[j*3+axis]=r.localFrame[row*3+axis];}}
        for(const name of ATTRS)g.attributes[name].needsUpdate=true;stats.bufferUploads++;}
      g.instanceCount=count;mesh.visible=count>0;
    }
    const f=body.frame,p=body.center;uniforms.uAnchor.value.fromArray(anchor);matrix.fromArray(f);uniforms.uBodyToWorld.value.copy(matrix).transpose();uniforms.uViewRotation.value.setFromMatrix4(camera.matrixWorldInverse);
    uniforms.uAnchorRelative.value.set(p[0]+f[0]*anchor[0]+f[1]*anchor[1]+f[2]*anchor[2],p[1]+f[3]*anchor[0]+f[4]*anchor[1]+f[5]*anchor[2],p[2]+f[6]*anchor[0]+f[7]*anchor[1]+f[8]*anchor[2]);
    uniforms.uLight.value.fromArray(body.light);uniforms.uRadius.value=body.radius;stats.instances=work.count;stats.fineInstances=fine;stats.coarseInstances=work.count-fine;group.visible=work.count>0;
  };
  group.userData.setViewport=(height,ratio)=>{if(!(height>0&&ratio>0))throw new RangeError('Scanned LOD requires actual positive viewport');focalHeight=height*ratio;};
  group.userData.dispose=()=>{if(disposed)return;group.userData.clear();disposed=true;for(const mesh of meshes)if(mesh){mesh.geometry.dispose();mesh.material.dispose();mesh.material.map=mesh.material.normalMap=mesh.material.roughnessMap=mesh.material.metalnessMap=null;}meshes.fill(null);queues.length=0;assets=null;stats.geometries=stats.materials=0;stats.disposed=true;group.clear();};
  return group;
}
