import {NATURAL_RING,NATURAL_RING_SURFACE_LIGHT_GLSL,createNaturalRingQueryWorkspace} from '../natural-ring.js';
import {configureScannedRockStandardMaterial,createScannedRockBatch} from './scanned-rock-batch.js';
export function configureNaturalRingStandardMaterial(material,uniforms){
  configureScannedRockStandardMaterial(material,uniforms,NATURAL_RING.fadeStart,NATURAL_RING.fadeEnd);
  applyRingLighting(material);
}
function applyRingLighting(material){
  const baseCompile=material.onBeforeCompile,baseKey=material.customProgramCacheKey();
  material.onBeforeCompile=shader=>{
    baseCompile(shader);
    shader.fragmentShader=shader.fragmentShader.replace('varying vec3 vRockPoint,vRockRelative;',
      `varying vec3 vRockPoint,vRockRelative;\nuniform float uRingPhase;\n${NATURAL_RING_SURFACE_LIGHT_GLSL}`);
    shader.fragmentShader=shader.fragmentShader.replace('directLight.color=vec3(1.05*PI)*(rockShadow ? .025 : 1.);',
      'directLight.color=vec3(1.05*PI)*naturalRingSunTransmission(vRockPoint/uRadius);');
  };
  material.customProgramCacheKey=()=>`${baseKey}:ring-single-scatter-v2`;
}
export function createScannedNaturalRingDebris({field}){
  let assets=field.renderAssets;
  const group=createScannedRockBatch({assets,capacity:648,fadeStart:NATURAL_RING.fadeStart,fadeEnd:NATURAL_RING.fadeEnd,name:'Natural scanned rock ring — STATIC_NO_ORBIT'});
  group.userData.batchUniforms.uRingPhase={value:0};
  for(const mesh of group.children)applyRingLighting(mesh.material);
  let work=createNaturalRingQueryWorkspace(648);const cameraLocal=[0,0,0],anchor=[0,0,0];
  let lastBody=null,lastX=NaN,lastZ=NaN,lastRevision=-1,disposed=false;
  const stats=group.userData.stats;Object.assign(stats,{mode:NATURAL_RING.mode,surface:'SCANNED_FINE_CCD',tiles:0,rebuilds:0,fineProjectedRadiusPixels:assets.fineProjectedRadiusPixels,fineTriangles:assets.metrics.fineTriangles,coarseTriangles:assets.metrics.coarseTriangles,bodyId:null});
  const batchClear=group.userData.clear,batchDispose=group.userData.dispose;
  function clear(){batchClear();stats.tiles=0;stats.bodyId=null;lastBody=null;}group.userData.clear=clear;
  group.userData.update=({body=null,bodies=null,camera,sectorIndex,viewportHeight,pixelRatio=1})=>{
    if(disposed)return;
    if(!(viewportHeight>0&&pixelRatio>0))throw new RangeError('Scanned ring LOD requires actual positive viewport height/pixel ratio');
    if(bodies!==null){body=null;let closest=Infinity;for(const candidate of bodies){if(candidate.kind!=='gas-giant'||!candidate.ringed||candidate.visibility<=0)continue;
      const f=candidate.frame,p=candidate.center,x=-(f[0]*p[0]+f[3]*p[1]+f[6]*p[2]),y=-(f[1]*p[0]+f[4]*p[1]+f[7]*p[2]),z=-(f[2]*p[0]+f[5]*p[1]+f[8]*p[2]);
      const r=Math.hypot(x,z),d=Math.hypot(Math.max(candidate.radius*NATURAL_RING.inner-r,0,r-candidate.radius*NATURAL_RING.outer),Math.max(0,Math.abs(y)-64));if(d<closest){closest=d;body=candidate;}}}
    if(!body||body.kind!=='gas-giant'||!body.ringed){clear();return;}
    const f=body.frame,p=body.center;for(let i=0;i<3;i++)cameraLocal[i]=-(f[i]*p[0]+f[3+i]*p[1]+f[6+i]*p[2]);
    const r=Math.hypot(cameraLocal[0],cameraLocal[2]);if(Math.abs(cameraLocal[1])>64+1800||r<body.radius*1.25-1800||r>body.radius*2.1+1800){clear();return;}
    const x=Math.floor(cameraLocal[0]/512),z=Math.floor(cameraLocal[2]/512),changed=body.id!==lastBody||x!==lastX||z!==lastZ||field.revision!==lastRevision;
    if(changed){field.visible(body,cameraLocal,sectorIndex,work);anchor[0]=(x+.5)*512;anchor[1]=0;anchor[2]=(z+.5)*512;lastBody=body.id;lastX=x;lastZ=z;lastRevision=field.revision;stats.rebuilds++;}
    group.userData.batchUniforms.uRingPhase.value=body.phase;
    group.userData.setViewport(viewportHeight,pixelRatio);
    group.userData.upload(work,camera,body,cameraLocal,anchor,changed);
    stats.instances=work.count;stats.tiles=work.tiles;stats.bodyId=body.id;
  };
  group.userData.snapshot=()=>({...stats,records:work?work.results.map(r=>({id:r.id,prototype:r.prototype,position:r.position.slice(),localPosition:r.localPosition.slice(),frame:r.frame.slice()})):[]});
  group.userData.dispose=()=>{if(disposed)return;clear();disposed=true;batchDispose();work=null;assets=null;};
  return group;
}
