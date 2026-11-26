/** QA-only static artistic outcrops. Scene units L; no geology/orbit claim. */
import {hashSeed,randomFromSeed} from './random.js';
import {cosmicSolidsInBounds} from './cosmic-bodies.js';
import {SolidQueryFailure} from './solid-geometry.js';
export const ROCKY_SURFACE=Object.freeze({revision:1,mode:'STATIC_SPHERE_OUTCROPS',cell:8192,slots:2,radii:Object.freeze([96,256,576,1024]),buriedHeightFraction:.15,visibleCellCap:1000,visibleCapacity:2000,queryCells:729,queryCapacity:1458,cacheCells:768,minParentRadius:350000,maxParentRadius:1000000,fadeStart:24576,fadeEnd:32768});
const L=8192;
function record(){return {id:'',parentId:'',role:'rocky-surface-outcrop',mode:ROCKY_SURFACE.mode,position:[0,0,0],frame:new Array(9).fill(0),localPosition:[0,0,0],localFrame:new Array(9).fill(0),root:[0,0,0],boundsRadius:0,prototype:0,shape:null};}
export function createRockySurfaceQueryWorkspace(capacity=1458){if(!Number.isInteger(capacity)||capacity<1||capacity>2048)throw new RangeError('Invalid rocky result capacity');return {records:Array.from({length:capacity},record),results:[],localMin:[0,0,0],localMax:[0,0,0],cellMin:[0,0,0],cellMax:[0,0,0],count:0,cells:0,surfaceCells:0};}
function frame(n,yaw){const ref=Math.abs(n[1])<.9?[0,1,0]:[1,0,0];let t=[ref[1]*n[2]-ref[2]*n[1],ref[2]*n[0]-ref[0]*n[2],ref[0]*n[1]-ref[1]*n[0]],k=1/Math.hypot(...t);t=t.map(x=>x*k);const b=[t[1]*n[2]-t[2]*n[1],t[2]*n[0]-t[0]*n[2],t[0]*n[1]-t[1]*n[0]],c=Math.cos(yaw),s=Math.sin(yaw),u=t.map((x,i)=>x*c+b[i]*s),v=b.map((x,i)=>x*c-t[i]*s);return [u[0],n[0],v[0],u[1],n[1],v[1],u[2],n[2],v[2]];}
/** Pure cold descriptor: fixed slots, no searching/retries or camera dependence. */
export function rockySurfaceRoots(body,ix,iy,iz,seed,footings){
  const low=[ix,iy,iz],random=randomFromSeed(hashSeed(`${seed}:${body.id}:rocky-surface-v1:${ix},${iy},${iz}`)),out=[];
  for(let slot=0;slot<2;slot++){
    const raw=low.map(x=>(x+random())*L),length=Math.hypot(...raw),type=Math.floor(random()*4),yaw=random()*Math.PI*2;
    if(length===0)continue;const normal=raw.map(x=>x/length),root=normal.map(x=>x*body.radius);
    if(root.some((x,i)=>Math.floor(x/L)!==low[i]))continue;
    const radius=ROCKY_SURFACE.radii[type],position=root.map((x,i)=>x+footings[type].centerOffset*normal[i]);
    out.push({id:`${body.id}:rocky-surface-v1:${ix},${iy},${iz}:${slot}`,slot,cell:low.slice(),prototype:type,root,position,frame:frame(normal,yaw),radius,role:'rocky-surface-outcrop'});
  }return out;
}
function surfaceCell(R,x,y,z){let near=0,far=0;for(let axis=0;axis<3;axis++){const i=axis===0?x:axis===1?y:z,a=i*L,b=a+L,n=Math.max(a,0,-b),f=Math.max(Math.abs(a),Math.abs(b));near+=n*n;far+=f*f;}return near<=R*R&&far>=R*R;}
function localBounds(body,bounds,w){const f=body.frame,p=body.position;w.localMin.fill(Infinity);w.localMax.fill(-Infinity);for(let c=0;c<8;c++){const x=(c&1?bounds.max[0]:bounds.min[0])-p[0],y=(c&2?bounds.max[1]:bounds.min[1])-p[1],z=(c&4?bounds.max[2]:bounds.min[2])-p[2];for(let i=0;i<3;i++){const q=f[i]*x+f[3+i]*y+f[6+i]*z;w.localMin[i]=Math.min(w.localMin[i],q);w.localMax[i]=Math.max(w.localMax[i],q);}}}
function intersects(body,r,b){const f=body.frame,p=r.position;for(let i=0;i<3;i++){const v=body.position[i]+f[i*3]*p[0]+f[i*3+1]*p[1]+f[i*3+2]*p[2];if(v+r.radius<b.min[i]||v-r.radius>b.max[i])return false;}return true;}
function append(body,r,w){if(w.count===w.records.length)throw new SolidQueryFailure('rocky-result-capacity','Cannot return every rocky solid');const o=w.records[w.count];o.id=r.id;o.parentId=body.id;o.prototype=r.prototype;o.boundsRadius=r.radius;o.shape=r.shape;
  for(let i=0;i<3;i++){o.root[i]=r.root[i];o.localPosition[i]=r.position[i];o.position[i]=body.position[i]+body.frame[i*3]*r.position[0]+body.frame[i*3+1]*r.position[1]+body.frame[i*3+2]*r.position[2];}
  for(let i=0;i<9;i++)o.localFrame[i]=r.frame[i];for(let c=0;c<3;c++)for(let i=0;i<3;i++)o.frame[c*3+i]=r.frame[i]*body.frame[c*3]+r.frame[3+i]*body.frame[c*3+1]+r.frame[6+i]*body.frame[c*3+2];w.results[w.count++]=o;
}
function validBounds(b){if(!b||!Array.isArray(b.min)||!Array.isArray(b.max)||b.min.length!==3||b.max.length!==3)throw new TypeError('Rocky query requires finite ordered bounds');for(let i=0;i<3;i++)if(!Number.isFinite(b.min[i])||!Number.isFinite(b.max[i])||b.min[i]>b.max[i])throw new TypeError('Rocky query requires finite ordered bounds');}
export function createRockySurfaceField({seed,parentsInBounds=cosmicSolidsInBounds,catalogue,admitCell=null}={}){
  if(typeof seed!=='string'||typeof parentsInBounds!=='function'||typeof catalogue?.get!=='function')throw new TypeError('Rocky field needs seed, parent provider and prepared asset owner');
  if(!Array.isArray(catalogue.bounds)||catalogue.bounds.length!==4)throw new TypeError('Scanned fine Y bounds required before field publication');
  const footings=catalogue.bounds.map((b,i)=>{if(b.radius!==ROCKY_SURFACE.radii[i]||!Number.isFinite(b.minY)||!Number.isFinite(b.maxY)||b.maxY<=b.minY||Math.abs(b.minY)>b.radius||Math.abs(b.maxY)>b.radius)throw new RangeError('Invalid scanned fine Y bounds');
    const height=b.maxY-b.minY,centerOffset=-b.minY-ROCKY_SURFACE.buriedHeightFraction*height;return Object.freeze({radius:b.radius,minY:b.minY,maxY:b.maxY,height,centerOffset,rootReach:b.radius+Math.abs(centerOffset),outerReach:b.radius+centerOffset,innerReach:b.radius-centerOffset});});Object.freeze(footings);
  const E=Math.max(...footings.map(p=>p.rootReach)),outerReach=Math.max(...footings.map(p=>p.outerReach)),innerReach=Math.max(...footings.map(p=>p.innerReach));
  const parents=new Map(),queue=new Array(768),discoveryBounds={min:[0,0,0],max:[0,0,0]},options={sectorIndex:0,seed,bounds:discoveryBounds};let head=0,size=0,revision=0,disposed=false,discoveryIndex=null,discovery=[];
  const stats={cellsBuilt:0,cacheCells:0,cacheRecords:0,queries:0,lastCells:0,lastSurfaceCells:0,lastCount:0,disposed:false};
  function clear(){discoveryIndex=null;discovery=[];parents.clear();queue.fill(undefined);head=size=0;stats.cacheCells=stats.cacheRecords=0;revision++;}
  function getCell(body,x,y,z,index){let map=parents.get(body.id);if(!map){map=new Map();parents.set(body.id,map);}const key=((x+256)*512+y+256)*512+z+256,cached=map.get(key);if(cached)return cached.roots;
    const roots=rockySurfaceRoots(body,x,y,z,seed,footings);if(admitCell)admitCell(body,index,roots);
    for(const r of roots){const prototype=catalogue.get(r.prototype).prototype;r.shape=Object.freeze({type:'compound',parts:Object.freeze([]),terrainGroups:Object.freeze([prototype])});}
    const entry={map,key,bodyId:body.id,roots};
    if(size===768){const retired=queue[head];stats.cacheRecords-=retired.roots.length;retired.map.delete(retired.key);if(!retired.map.size&&retired.bodyId!==body.id)parents.delete(retired.bodyId);queue[head]=entry;head=(head+1)%768;}else queue[(head+size++)%768]=entry;
    map.set(key,entry);stats.cellsBuilt++;stats.cacheCells=size;stats.cacheRecords+=roots.length;return roots;
  }
  function enumerate(body,min,max,index,w,bounds,cellCap=729){const nx=max[0]-min[0]+1,ny=max[1]-min[1]+1,nz=max[2]-min[2]+1,n=nx*ny*nz;
    if(w.cells+n>cellCap)throw new SolidQueryFailure('rocky-cell-budget','Complete rocky query exceeds its declared candidate-cell cap; no partial result is valid');
    w.cells+=n;for(let x=min[0];x<=max[0];x++)for(let y=min[1];y<=max[1];y++)for(let z=min[2];z<=max[2];z++){
      if(!surfaceCell(body.radius,x,y,z))continue;w.surfaceCells++;
      for(const r of getCell(body,x,y,z,index))if(!bounds||intersects(body,r,bounds))append(body,r,w);
    }
  }
  function supported(body){return body.kind==='dark-world'&&body.shape.type==='sphere';}
  function parentRange(body){if(!Number.isFinite(body.radius)||body.radius<ROCKY_SURFACE.minParentRadius||body.radius>ROCKY_SURFACE.maxParentRadius)throw new SolidQueryFailure('rocky-parent-range','Rocky field supports the existing finite sphere radius range only');}
  function finish(w){w.results.length=w.count;stats.lastCells=w.cells;stats.lastSurfaceCells=w.surfaceCells;stats.lastCount=w.count;return w.results;}
  function findParents(index,bounds){
    let cached=true;for(let i=0;i<3;i++)if(bounds.min[i]<-40000||bounds.max[i]>40000)cached=false;
    if(cached&&index===discoveryIndex)return discovery;
    for(let i=0;i<3;i++){discoveryBounds.min[i]=(cached?-40000:bounds.min[i])-E;discoveryBounds.max[i]=(cached?40000:bounds.max[i])+E;}options.sectorIndex=index;
    const found=parentsInBounds(options);for(const body of found)if(supported(body))parentRange(body);if(cached){discoveryIndex=index;discovery=found;}return found;
  }
  function query(index,bounds,w){if(disposed)throw new Error('Rocky surface disposed');validBounds(bounds);w.count=w.cells=w.surfaceCells=0;stats.queries++;
    for(const body of findParents(index,bounds)){if(!supported(body))continue;localBounds(body,bounds,w);let near=0,far=0;
      for(let i=0;i<3;i++){const n=Math.max(w.localMin[i],0,-w.localMax[i]),f=Math.max(Math.abs(w.localMin[i]),Math.abs(w.localMax[i]));near+=n*n;far+=f*f;}
      if(near>(body.radius+outerReach)**2||far<(body.radius-innerReach)**2)continue;
      for(let i=0;i<3;i++){w.cellMin[i]=Math.floor((w.localMin[i]-E)/L);w.cellMax[i]=Math.floor((w.localMax[i]+E)/L);}enumerate(body,w.cellMin,w.cellMax,index,w,bounds);
    }return finish(w);
  }
  function visible(body,cameraLocal,index,w){if(disposed)throw new Error('Rocky surface disposed');w.count=w.cells=w.surfaceCells=0;if(supported(body)){parentRange(body);
      for(let i=0;i<3;i++){w.cellMin[i]=Math.floor((cameraLocal[i]-ROCKY_SURFACE.fadeEnd-E)/L);w.cellMax[i]=Math.floor((cameraLocal[i]+ROCKY_SURFACE.fadeEnd+E)/L);}enumerate(body,w.cellMin,w.cellMax,index,w,null,ROCKY_SURFACE.visibleCellCap);}return finish(w);}
  return {query,visible,clear,footings,maxRootReach:E,get renderAssets(){return catalogue;},stats,get revision(){return revision;},dispose(){if(disposed)return;clear();disposed=true;catalogue=null;stats.disposed=true;}};
}
