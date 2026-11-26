import {ROCKY_SURFACE,createRockySurfaceQueryWorkspace} from '../rocky-surface.js';
import {createScannedRockBatch} from './scanned-rock-batch.js';
/** One nearest eligible view, not a collision subset. Field owns range/density. */
export function createScannedRockySurface({field,shadowUniforms=null}){
  const group=createScannedRockBatch({assets:field.renderAssets,capacity:ROCKY_SURFACE.visibleCapacity,fadeStart:ROCKY_SURFACE.fadeStart,fadeEnd:ROCKY_SURFACE.fadeEnd,name:'Static scanned sphere outcrops',lazy:true,shadowUniforms});
  let work=createRockySurfaceQueryWorkspace(ROCKY_SURFACE.visibleCapacity),lastBody=null,lastRevision=-1,lastIndex=-1,disposed=false;
  const cell=[NaN,NaN,NaN],cameraLocal=[0,0,0],anchor=[0,0,0],stats=group.userData.stats,batchClear=group.userData.clear,batchDispose=group.userData.dispose;
  Object.assign(stats,{cells:0,surfaceCells:0,rebuilds:0,bodyId:null,mode:ROCKY_SURFACE.mode});
  const shadowState={body:null,cameraLocal,outerReach:Math.max(...field.footings.map(p=>p.outerReach))};group.userData.shadowState=shadowState;
  function clear(){shadowState.body=null;batchClear();lastBody=null;stats.cells=stats.surfaceCells=0;stats.bodyId=null;work.count=0;work.results.length=0;}
  group.userData.clear=clear;
  group.userData.update=({body=null,bodies=null,camera,sectorIndex,viewportHeight,pixelRatio=1})=>{
    if(disposed)return;group.userData.setViewport(viewportHeight,pixelRatio);
    if(bodies!==null){body=null;let closest=Infinity;for(const b of bodies){if(b.kind!=='dark-world'||b.shape.type!=='sphere'||b.visibility<=0)continue;const d=Math.hypot(...b.center)-b.radius;if(d<closest){closest=d;body=b;}}}
    if(!body||body.kind!=='dark-world'||body.shape.type!=='sphere'||Math.abs(Math.hypot(...body.center)-body.radius)>ROCKY_SURFACE.fadeEnd+field.maxRootReach){clear();return;}
    const f=body.frame,p=body.center;let changed=body.id!==lastBody||field.revision!==lastRevision||sectorIndex!==lastIndex;
    for(let i=0;i<3;i++){cameraLocal[i]=-(f[i]*p[0]+f[3+i]*p[1]+f[6+i]*p[2]);const next=Math.floor(cameraLocal[i]/ROCKY_SURFACE.cell);if(next!==cell[i])changed=true;cell[i]=next;anchor[i]=(next+.5)*ROCKY_SURFACE.cell;}
    if(changed){field.visible(body,cameraLocal,sectorIndex,work);lastBody=body.id;lastRevision=field.revision;lastIndex=sectorIndex;stats.rebuilds++;}
    shadowState.body=body;group.userData.upload(work,camera,body,cameraLocal,anchor,changed);stats.cells=work.cells;stats.surfaceCells=work.surfaceCells;stats.bodyId=body.id;
  };
  group.userData.snapshot=()=>({...stats,records:work.results.map(r=>({id:r.id,prototype:r.prototype,position:r.position.slice(),localPosition:r.localPosition.slice(),root:r.root.slice(),frame:r.frame.slice()}))});
  group.userData.dispose=()=>{if(disposed)return;clear();disposed=true;batchDispose();work=null;};return group;
}
