/** World-owned canonical Halo triangles. Scene lengths are L. Renderers borrow
 * these CPU meshes; camera position never participates in physical generation.
 * Query results remain borrowed until releaseQuery(workspace), its next query,
 * clear or dispose. prepare/acquire leases survive clear/dispose until release;
 * release empties their regions array. GPU ownership stays with the renderer.
 */
import {createRingHabitatField,RING_HABITAT_FIELD_LATTICE_L,RING_HABITAT_REGION_SIZE_L,RING_HABITAT_FIELD_MIN_HEIGHT_L,RING_HABITAT_FIELD_MAX_HEIGHT_L} from './ring-habitat-field.js';
import {buildTerrainMesh} from './mesh-terrain.js';
import {SolidQueryFailure} from './solid-geometry.js';

const TAU=Math.PI*2,STEP=RING_HABITAT_FIELD_LATTICE_L,SIZE=RING_HABITAT_REGION_SIZE_L,PREPARATION_BUDGET_MS=2;
const EMPTY_PARTS=Object.freeze([]),ZERO=Object.freeze([0,0,0]);
export class HaloTerrainUnavailable extends SolidQueryFailure {
  constructor(code='halo-region-unavailable',message='Canonical Halo regions must be prepared before this query'){super(code,message);this.name='HaloTerrainUnavailable';}
}
function boundsCheck(b){if(!b||!Array.isArray(b.min)||!Array.isArray(b.max)||b.min.length!==3||b.max.length!==3)throw new TypeError('Halo query needs finite ordered bounds');for(let i=0;i<3;i++)if(!Number.isFinite(b.min[i])||!Number.isFinite(b.max[i])||b.min[i]>b.max[i])throw new TypeError('Halo query needs finite ordered bounds');}
function positive(n,name){if(!Number.isSafeInteger(n)||n<1)throw new RangeError(`Invalid Halo ${name}`);return n;}
function recipes(body){return body.habitat?.terrainRecipes??EMPTY_PARTS;}
function makeRecord(){return {id:'',parentId:'',role:'ring-habitat-region',position:[0,0,0],localPosition:[0,0,0],frame:new Array(9).fill(0),boundsRadius:0,shape:null,mesh:null,region:null};}
export function createRingHabitatRegionQueryWorkspace(capacity=256){positive(capacity,'query capacity');return {records:Array.from({length:capacity},makeRecord),candidates:Array.from({length:capacity},()=>({body:null,recipe:null,tx:0,ty:0,entry:null})),results:[],localMin:[0,0,0],localMax:[0,0,0],entries:new Array(capacity),count:0,pins:0,owner:null,registry:null};}
function localBounds(body,b,min,max){const f=body.frame;min.fill(Infinity);max.fill(-Infinity);for(let c=0;c<8;c++){const x=(c&1?b.max[0]:b.min[0])-body.position[0],y=(c&2?b.max[1]:b.min[1])-body.position[1],z=(c&4?b.max[2]:b.min[2])-body.position[2];for(let a=0;a<3;a++){const q=f[a]*x+f[3+a]*y+f[6+a]*z;min[a]=Math.min(min[a],q);max[a]=Math.max(max[a],q);}}}
function copyRecord(body,e,out){const f=body.frame,c=e.mesh.center;out.id=e.id;out.parentId=body.id;out.boundsRadius=e.mesh.radius;out.shape=e.shape;out.mesh=e.mesh;out.region=e.view;for(let a=0;a<3;a++){out.localPosition[a]=c[a];out.position[a]=body.position[a]+f[a*3]*c[0]+f[a*3+1]*c[1]+f[a*3+2]*c[2];}for(let i=0;i<9;i++)out.frame[i]=f[i];}
// Conservative angular image of the full local AABB. If the rectangle contains
// the axis, all angles are possible. Otherwise corner extrema bound its cone.
function enumerate(body,r,min,max,w){
  const nearX=Math.max(min[0],0,-max[0]),nearZ=Math.max(min[2],0,-max[2]);
  const farX=Math.max(Math.abs(min[0]),Math.abs(max[0])),farZ=Math.max(Math.abs(min[2]),Math.abs(max[2]));
  const low=(r.innerRadius-RING_HABITAT_FIELD_MAX_HEIGHT_L)*Math.cos(STEP/(2*r.innerRadius)),high=r.innerRadius+Math.max(-RING_HABITAT_FIELD_MIN_HEIGHT_L,2*r.depth);
  if(nearX*nearX+nearZ*nearZ>high*high||farX*farX+farZ*farZ<low*low)return;
  const width=(r.maxAngle-r.minAngle)*r.innerRadius,height=r.maxY-r.minY;
  let y0=Math.max(0,min[1]-r.minY),y1=Math.min(height,max[1]-r.minY);if(y0>y1)return;
  const nx=Math.ceil(width/SIZE),ny=Math.ceil(height/SIZE),mid=(r.minAngle+r.maxAngle)*.5;
  let x0=0,x1=width;
  if(!(min[0]<=0&&max[0]>=0&&min[2]<=0&&max[2]>=0)){
    const centre=Math.atan2((min[2]+max[2])*.5,(min[0]+max[0])*.5);let half=0;
    for(let c=0;c<4;c++){const a=Math.atan2(c&2?max[2]:min[2],c&1?max[0]:min[0]);half=Math.max(half,Math.abs(Math.atan2(Math.sin(a-centre),Math.cos(a-centre))));}
    const unwrapped=centre+Math.round((mid-centre)/TAU)*TAU;
    if(unwrapped+half<r.minAngle||unwrapped-half>r.maxAngle)return;
    x0=Math.max(0,(unwrapped-half-r.minAngle)*r.innerRadius);x1=Math.min(width,(unwrapped+half-r.minAngle)*r.innerRadius);
  }
  // Include both owners of an exact boundary, including a zero-width sweep.
  const tx0=Math.max(0,Math.ceil(x0/SIZE)-1),tx1=Math.min(nx-1,Math.floor(x1/SIZE));
  const ty0=Math.max(0,Math.ceil(y0/SIZE)-1),ty1=Math.min(ny-1,Math.floor(y1/SIZE));
  const n=(tx1-tx0+1)*(ty1-ty0+1);if(w.count+n>w.candidates.length)throw new HaloTerrainUnavailable('halo-region-query-capacity','Complete canonical Halo query exceeds workspace capacity');
  for(let ty=ty0;ty<=ty1;ty++)for(let tx=tx0;tx<=tx1;tx++){const c=w.candidates[w.count++];c.body=body;c.recipe=r;c.tx=tx;c.ty=ty;c.entry=null;}
}
function freezeMesh(mesh){for(const key of ['vertices','faces','normals','vertexUV','refinedFaces','nodes']){for(const value of mesh[key]){if(Array.isArray(value))Object.freeze(value);else{Object.freeze(value.min);Object.freeze(value.max);Object.freeze(value);}}Object.freeze(mesh[key]);}for(const key of ['center','triangleOrder','featureMasks','surfaceKinds'])Object.freeze(mesh[key]);Object.freeze(mesh.topGrid);return Object.freeze(mesh);}
function makeMesh(field,r,tx,ty){
  const x0=tx*SIZE,y0=ty*SIZE,x1=Math.min(x0+SIZE,field.bounds.maxX),y1=Math.min(y0+SIZE,field.bounds.maxY);
  const columns=Math.ceil((x1-x0)/STEP)+1,rows=Math.ceil((y1-y0)/STEP)+1,n=columns*rows;
  const center=[0,0,0],p=[0,0,0],normal=[0,0,0];field.position((x0+x1)*.5,(y0+y1)*.5,center);
  const bottom=field.innerRadius+Math.max(32,-field.hmin+16);if(bottom>field.innerRadius+2*r.depth)throw new RangeError('Halo foundation does not fit inside the annular core');
  const vertices=[],normals=[],faces=[],vertexUV=[],surfaceKinds=[];
  for(let layer=0;layer<2;layer++)for(let j=0;j<rows;j++)for(let i=0;i<columns;i++){
    const x=Math.min(x0+i*STEP,x1),y=Math.min(y0+j*STEP,y1),angle=field.minAngle+x/field.innerRadius;
    if(layer===0){sampleVertex(field,x,y,p,normal);}else{p[0]=bottom*Math.cos(angle);p[1]=field.minY+y;p[2]=bottom*Math.sin(angle);normal[0]=Math.cos(angle);normal[1]=0;normal[2]=Math.sin(angle);}
    vertices.push([p[0]-center[0],p[1]-center[1],p[2]-center[2]]);normals.push(normal.slice());vertexUV.push([i,j]);surfaceKinds.push(0);
  }
  for(let j=0;j<rows-1;j++)for(let i=0;i<columns-1;i++){const a=j*columns+i,b=a+1,c=a+columns,d=c+1;faces.push([a,b,c],[b,d,c]);}
  const topFaces=faces.length;for(let i=0;i<topFaces;i++){const f=faces[i];faces.push([f[2]+n,f[1]+n,f[0]+n]);}
  function side(a,b){faces.push([b,a,a+n],[b,a+n,b+n]);}
  for(let i=0;i<columns-1;i++)side(i,i+1);
  for(let j=0;j<rows-1;j++)side(j*columns+columns-1,(j+1)*columns+columns-1);
  for(let i=columns-1;i>0;i--)side((rows-1)*columns+i,(rows-1)*columns+i-1);
  for(let j=rows-1;j>0;j--)side(j*columns,(j-1)*columns);
  let radius=0;for(const v of vertices)radius=Math.max(radius,Math.hypot(v[0],v[1],v[2]));
  const mesh=buildTerrainMesh({center,radius,vertices,normals,faces,vertexUV,surfaceKinds,refinedFaces:[],topGrid:{columns,rows,minAngle:field.minAngle+x0/field.innerRadius,maxAngle:field.minAngle+x1/field.innerRadius,minY:field.minY+y0,maxY:field.minY+y1,innerRadius:field.innerRadius,latticeStepL:STEP},topFaces,chartBounds:Object.freeze({minX:x0,minY:y0,maxX:x1,maxY:y1})});
  return freezeMesh(mesh);
}
// Accounting includes numeric payload and a declared allowance for each retained
// JS array/object; it is a cache budget, not a browser heap measurement.
function meshBytes(m){return 1024+m.vertices.length*(3*8+64)*2+m.vertexUV.length*(2*8+64)+m.faces.length*(3*8+64)+m.nodes.length*224+(m.triangleOrder.length+m.featureMasks.length+m.surfaceKinds.length)*8;}

function sampleVertex(field,x,y,point,normal){field.position(x,y,point);field.normal(x,y,normal);}
function interpolateTriangle(center,va,vb,vc,na,nb,nc,u,v,point,normal,flat,info,index){
  const side=u+v>1,a=side?1-v:1-u-v,c=side?1-u:v,d=1-a-c;
  point.x=center[0]+va[0]*a+vb[0]*d+vc[0]*c;point.y=center[1]+va[1]*a+vb[1]*d+vc[1]*c;point.z=center[2]+va[2]*a+vb[2]*d+vc[2]*c;
  if(normal){normal.x=na[0]*a+nb[0]*d+nc[0]*c;normal.y=na[1]*a+nb[1]*d+nc[1]*c;normal.z=na[2]*a+nb[2]*d+nc[2]*c;const length=Math.hypot(normal.x,normal.y,normal.z);normal.x/=length;normal.y/=length;normal.z/=length;}
  const ax=vb[0]-va[0],ay=vb[1]-va[1],az=vb[2]-va[2],bx=vc[0]-va[0],by=vc[1]-va[1],bz=vc[2]-va[2];
  flat.x=ay*bz-az*by;flat.y=az*bx-ax*bz;flat.z=ax*by-ay*bx;const length=Math.hypot(flat.x,flat.y,flat.z);flat.x/=length;flat.y/=length;flat.z/=length;
  if(info){info.rockCoverage=0;info.face=index;}return true;
}
function sampleTopTriangle(m,x,y,point,normal,flat,info){
  const b=m.chartBounds,g=m.topGrid,col=Math.min(g.columns-2,Math.floor((x-b.minX)/STEP)),row=Math.min(g.rows-2,Math.floor((y-b.minY)/STEP));
  const x0=b.minX+col*STEP,y0=b.minY+row*STEP,u=(x-x0)/(Math.min(x0+STEP,b.maxX)-x0),v=(y-y0)/(Math.min(y0+STEP,b.maxY)-y0);
  const index=(row*(g.columns-1)+col)*2+(u+v>1?1:0),f=m.faces[index];
  return interpolateTriangle(m.center,m.vertices[f[0]],m.vertices[f[1]],m.vertices[f[2]],m.normals[f[0]],m.normals[f[1]],m.normals[f[2]],u,v,point,normal,flat,info,index);
}
/** Caller owns this fixed vertex memo and must clear it when releasing fields.
 * Zero capacity is the uncached reference mode for diagnostics. */
export function createRingHabitatLatticeWorkspace(vertexCapacity=4096){
  if(!Number.isInteger(vertexCapacity)||vertexCapacity<0||vertexCapacity>4096)throw new RangeError('Halo vertex memo capacity must be0..4096');
  const keysX=new Int32Array(vertexCapacity).fill(-1),keysY=new Int32Array(vertexCapacity).fill(-1),values=new Float64Array(vertexCapacity*6),normalReady=new Uint8Array(vertexCapacity);
  return {center:[0,0,0],centerNormal:[0,0,0],vertices:Array.from({length:4},()=>[0,0,0]),normals:Array.from({length:4},()=>[0,0,0]),vertexCapacity,keysX,keysY,values,normalReady,field:null,hits:0,misses:0,cacheBytes:keysX.byteLength+keysY.byteLength+values.byteLength+normalReady.byteLength};
}
export function clearRingHabitatLatticeWorkspace(w){w.field=null;w.keysX.fill(-1);w.keysY.fill(-1);w.normalReady.fill(0);w.hits=w.misses=0;}
function memoVertex(field,x,y,ix,iy,p,n,w,wantNormal=true){
  if(w.vertexCapacity===0){w.misses++;field.position(x,y,p);if(wantNormal)field.normal(x,y,n);return;}
  const slot=((Math.imul(ix+1,73856093)^Math.imul(iy+1,19349663))>>>0)%w.vertexCapacity,offset=slot*6;
  if(w.keysX[slot]===ix&&w.keysY[slot]===iy){w.hits++;for(let a=0;a<3;a++)p[a]=w.values[offset+a];}
  else{w.misses++;field.position(x,y,p);w.keysX[slot]=ix;w.keysY[slot]=iy;w.normalReady[slot]=0;for(let a=0;a<3;a++)w.values[offset+a]=p[a];}
  if(wantNormal){if(!w.normalReady[slot]){field.normal(x,y,n);for(let a=0;a<3;a++)w.values[offset+3+a]=n[a];w.normalReady[slot]=1;}else for(let a=0;a<3;a++)n[a]=w.values[offset+3+a];}
}
/** Exact canonical triangle sampler without a mesh/BVH cache dependency.
 * Outputs are x/y/z objects; workspace and field are caller-owned/borrowed.
 * Pass normal=null to omit smooth normals without changing point/flat/info.
 * The chart domain is half-open, matching physical sampleTop. */
export function sampleCanonicalTop(field,x,y,point,normal,flat,info,w){
  if(!Number.isFinite(x)||!Number.isFinite(y))throw new TypeError('Halo chart coordinates must be finite');
  const width=field.bounds.maxX,height=field.bounds.maxY;if(x<0||y<0||x>=width||y>=height)return false;
  if(w.field!==field){w.keysX.fill(-1);w.keysY.fill(-1);w.field=field;}
  const tx=Math.floor(x/SIZE),ty=Math.floor(y/SIZE),tileX=tx*SIZE,tileY=ty*SIZE,tileMaxX=Math.min(tileX+SIZE,width),tileMaxY=Math.min(tileY+SIZE,height);
  const col=Math.floor((x-tileX)/STEP),row=Math.floor((y-tileY)/STEP),x0=tileX+col*STEP,y0=tileY+row*STEP,x1=Math.min(x0+STEP,width),y1=Math.min(y0+STEP,height),u=(x-x0)/(x1-x0),v=(y-y0)/(y1-y0);
  const centreX=(tileX+tileMaxX)*.5,centreY=(tileY+tileMaxY)*.5;
  if(w.vertexCapacity&&centreX%STEP===0&&centreY%STEP===0)memoVertex(field,centreX,centreY,centreX/STEP,centreY/STEP,w.center,w.centerNormal,w,false);else field.position(centreX,centreY,w.center);
  const ix=tx*(SIZE/STEP)+col,iy=ty*(SIZE/STEP)+row;
  const side=u+v>1,ia=side?1:0,ib=side?3:1,ic=2;
  // Only these three corners belong to the authoritative hit triangle.
  for(let j=0;j<3;j++){const i=j===0?ia:j===1?ib:ic,p=w.vertices[i];memoVertex(field,i&1?x1:x0,i&2?y1:y0,ix+(i&1),iy+(i>>1),p,w.normals[i],w,normal!==null);for(let a=0;a<3;a++)p[a]-=w.center[a];}
  const index=(row*Math.ceil((tileMaxX-tileX)/STEP)+col)*2+(side?1:0);
  return interpolateTriangle(w.center,w.vertices[ia],w.vertices[ib],w.vertices[ic],w.normals[ia],w.normals[ib],w.normals[ic],u,v,point,normal,flat,info,index);
}

/** parentsInBounds receives {seed,sectorIndex,bounds} in sector-local world L.
 * Resident budgets include retired external leases and field-owned accounting.
 * Construction additionally holds one transient field/mesh before admission;
 * Cold construction yields at a2ms work budget between tiles, not within a
 * synchronous field/mesh builder. Resident lease acquisition needs no timer.
 */
export function createRingHabitatRegions({seed='lonelysky',parentsInBounds,createField=createRingHabitatField,maxRegions=512,maxFields=32,maxBytes=64*1024*1024,maxFaces=600000,queryCapacity=256}={}){
  if(typeof seed!=='string'||typeof parentsInBounds!=='function'||typeof createField!=='function')throw new TypeError('Halo registry needs seed, parent provider and field builder');
  positive(maxRegions,'cache regions');positive(maxFields,'cache fields');positive(maxBytes,'cache bytes');positive(maxFaces,'cache faces');positive(queryCapacity,'query capacity');
  const parents=new Map(),fields=new Set(),entries=new Set(),retired=new Set(),queries=new Set(),jobs=new Set(),discovery={sectorIndex:0,seed,bounds:null};let disposed=false,revision=0,clock=0;
  const stats={get cacheParents(){return parents.size;},regionsBuilt:0,fieldsBuilt:0,cacheRegions:0,cacheFaces:0,accountedBytes:0,fieldBytes:0,cacheSites:0,pinnedRegions:0,pinnedFields:0,retiredRegions:0,retiredFields:0,queryWorkspaces:0,pendingJobs:0,lastBuildMs:0,totalBuildMs:0,maxBuildMs:0,lastFieldBuildMs:0,disposed:false};
  function live(){if(disposed)throw new Error('Halo registry disposed');}
  function checkedRecipes(body){if(body.kind==='ring'&&!Array.isArray(body.habitat?.terrainRecipes))throw new SolidQueryFailure('halo-recipe-contract','Canonical Halo provider returned a ring without terrainRecipes');return recipes(body);}
  function recipeFor(body,index){for(const r of checkedRecipes(body))if(r.siteIndex===index)return r;throw new RangeError('Unknown Halo site');}
  function address(r,tx,ty){if(!Number.isInteger(tx)||!Number.isInteger(ty)||tx<0||ty<0||tx>=Math.ceil((r.maxAngle-r.minAngle)*r.innerRadius/SIZE)||ty>=Math.ceil((r.maxY-r.minY)/SIZE))throw new RangeError('Invalid Halo region address');}
  function detachField(site){const sites=parents.get(site.bodyId);if(sites?.get(site.index)===site){sites.delete(site.index);if(sites.size===0)parents.delete(site.bodyId);}}
  function forgetField(site){detachField(site);fields.delete(site);stats.cacheSites--;stats.accountedBytes-=site.bytes;stats.fieldBytes-=site.bytes;if(site.retired)stats.retiredFields--;}
  function finishRetiredField(site){if(site.retired&&site.resident===0&&site.fieldPins===0)forgetField(site);}
  function pinField(site){if(site.fieldPins++===0)stats.pinnedFields++;site.used=++clock;}
  function unpinField(site){if(--site.fieldPins===0){stats.pinnedFields--;finishRetiredField(site);}}
  function forget(e){stats.cacheRegions--;stats.cacheFaces-=e.mesh.faces.length;stats.accountedBytes-=e.bytes;e.site.resident--;finishRetiredField(e.site);}
  function remove(e){entries.delete(e);e.site.tiles.delete(e.key);if(e.pins){e.retired=true;retired.add(e);stats.retiredRegions++;}else forget(e);}
  function pin(e){if(e.pins++===0)stats.pinnedRegions++;e.used=e.site.used=++clock;}
  function unpin(e){if(--e.pins===0){stats.pinnedRegions--;if(e.retired){retired.delete(e);stats.retiredRegions--;forget(e);}}}
  function room(bytes,regions,faces,fieldCount){
    if(bytes>maxBytes||regions>maxRegions||faces>maxFaces||fieldCount>maxFields)throw new HaloTerrainUnavailable('halo-region-cache-capacity','One canonical Halo resource exceeds the resident cache budget');
    while(stats.cacheRegions+regions>maxRegions||stats.accountedBytes+bytes>maxBytes||stats.cacheFaces+faces>maxFaces||stats.cacheSites+fieldCount>maxFields){
      if(stats.accountedBytes+bytes>maxBytes||stats.cacheSites+fieldCount>maxFields){let unused=null;for(const f of fields)if(!f.retired&&f.resident===0&&f.fieldPins===0&&(!unused||f.used<unused.used))unused=f;if(unused){forgetField(unused);continue;}}
      let oldest=null;for(const e of entries)if(e.pins===0&&(!oldest||e.used<oldest.used))oldest=e;
      if(!oldest)throw new HaloTerrainUnavailable('halo-region-cache-capacity','Complete canonical Halo resources cannot fit while resident leases are pinned');remove(oldest);
    }
  }
  function siteOf(body,r,create=false){
    const old=parents.get(body.id)?.get(r.siteIndex);if(old||!create)return old;
    // Construction and accounting validation precede cache publication.
    const begin=performance.now(),field=createField(r),bytes=field.statistics.accountedBytes;positive(bytes,'field accounted bytes');room(bytes,0,0,1);
    let sites=parents.get(body.id);if(!sites){sites=new Map();parents.set(body.id,sites);}
    const site={bodyId:body.id,index:r.siteIndex,recipe:r,field,bytes,resident:0,fieldPins:0,retired:false,tiles:new Map(),used:++clock};sites.set(r.siteIndex,site);fields.add(site);
    stats.cacheSites++;stats.fieldsBuilt++;stats.fieldBytes+=bytes;stats.accountedBytes+=bytes;stats.lastFieldBuildMs=performance.now()-begin;return site;
  }
  function lookup(body,r,tx,ty){return siteOf(body,r)?.tiles.get(ty*Math.ceil((r.maxAngle-r.minAngle)*r.innerRadius/SIZE)+tx);}
  function build(c){
    const old=lookup(c.body,c.recipe,c.tx,c.ty);if(old)return old;const begin=performance.now(),site=siteOf(c.body,c.recipe,true);pinField(site);
    try{const mesh=makeMesh(site.field,c.recipe,c.tx,c.ty),bytes=meshBytes(mesh);room(bytes,1,mesh.faces.length,0);
      const key=c.ty*Math.ceil((c.recipe.maxAngle-c.recipe.minAngle)*c.recipe.innerRadius/SIZE)+c.tx;
      const collisionMesh=Object.freeze({...mesh,center:ZERO}),shape=Object.freeze({type:'compound',parts:EMPTY_PARTS,terrainGroups:Object.freeze([collisionMesh])});
      const e={id:`${c.body.id}:${c.recipe.version}:site-${c.recipe.siteIndex}:region-${c.tx},${c.ty}:mesh-16-256-v1`,mesh,shape,site,key,bytes,pins:0,used:++clock,tileX:c.tx,tileY:c.ty,retired:false};
      e.view=Object.freeze({id:e.id,parentId:c.body.id,mesh,shape,siteIndex:c.recipe.siteIndex,tileX:c.tx,tileY:c.ty});site.tiles.set(key,e);site.resident++;entries.add(e);stats.regionsBuilt++;stats.cacheRegions++;stats.cacheFaces+=mesh.faces.length;stats.accountedBytes+=bytes;return e;
    }finally{unpinField(site);const ms=performance.now()-begin;stats.lastBuildMs=ms;stats.totalBuildMs+=ms;stats.maxBuildMs=Math.max(stats.maxBuildMs,ms);}
  }
  function gather(index,bounds,w){boundsCheck(bounds);w.count=0;discovery.sectorIndex=index;discovery.bounds=bounds;for(const body of parentsInBounds(discovery)){const list=checkedRecipes(body);if(list.length===0)continue;localBounds(body,bounds,w.localMin,w.localMax);for(const r of list)enumerate(body,r,w.localMin,w.localMax,w);}}
  function resetQuery(w){if(w.registry&&w.registry!==owner)throw new TypeError('Halo workspace belongs to another registry');for(let i=0;i<w.pins;i++){unpin(w.entries[i]);w.entries[i]=undefined;}w.pins=0;w.results.length=0;for(let i=0;i<w.count;i++){const c=w.candidates[i];c.entry=c.body=c.recipe=null;w.records[i].shape=w.records[i].mesh=w.records[i].region=null;}w.count=0;w.owner=null;}
  function releaseQuery(w){resetQuery(w);queries.delete(w);w.registry=null;stats.queryWorkspaces=queries.size;}
  function query(index,bounds,w){live();if(w.registry&&w.registry!==owner)throw new TypeError('Halo workspace belongs to another registry');if(!queries.has(w)){if(queries.size===32)throw new HaloTerrainUnavailable('halo-query-workspace-capacity','Halo registry supports 32 live query workspaces');queries.add(w);w.registry=owner;stats.queryWorkspaces=queries.size;}resetQuery(w);gather(index,bounds,w);for(let i=0;i<w.count;i++){const c=w.candidates[i];c.entry=lookup(c.body,c.recipe,c.tx,c.ty);if(!c.entry)throw new HaloTerrainUnavailable();}
    for(let i=0;i<w.count;i++){const c=w.candidates[i],e=c.entry;pin(e);w.entries[w.pins++]=e;copyRecord(c.body,e,w.records[i]);w.results[i]=w.records[i];}w.results.length=w.count;w.owner=owner;return w.results;}
  function lease(list){let released=false;const regions=list.map(e=>e.view);return Object.freeze({regions,release(){if(released)return;released=true;for(const e of list)unpin(e);list.length=0;regions.length=0;}});}
  function fieldLease(site){pinField(site);let held=site;return Object.freeze({parentId:site.bodyId,siteIndex:site.index,get field(){return held?.field??null;},release(){if(!held)return;const old=held;held=null;unpinField(old);}});}
  function cancelled(signal,generation,job){if(signal?.aborted||generation!==revision||disposed||job?.cancelled)throw new DOMException('Halo preparation cancelled','AbortError');}
  async function prepareWork(w,signal){
    // Macro providers may lend their outer records until their next query.
    // Cross the asynchronous boundary with one independent snapshot per parent.
    const snapshots=new Map();for(let i=0;i<w.count;i++){const c=w.candidates[i],body=c.body;let copy=snapshots.get(body.id);if(!copy){copy={...body};if(body.position)copy.position=body.position.slice();if(body.frame)copy.frame=body.frame.slice();snapshots.set(body.id,copy);}c.body=copy;}
    const generation=revision,held=[],job={cancelled:false};let workMs=0;jobs.add(job);stats.pendingJobs=jobs.size;
    try{cancelled(signal,generation,job);for(let i=0;i<w.count;i++){
      cancelled(signal,generation,job);
      const c=w.candidates[i],cached=lookup(c.body,c.recipe,c.tx,c.ty),begin=cached?0:performance.now();
      const e=cached??build(c);pin(e);held.push(e);
      if(!cached){
        workMs+=performance.now()-begin;
        if(workMs>=PREPARATION_BUDGET_MS&&i+1<w.count){await new Promise(resolve=>setTimeout(resolve,0));workMs=0;}
      }
    }cancelled(signal,generation,job);return lease(held);
    }catch(error){for(const e of held)unpin(e);throw error;}finally{jobs.delete(job);stats.pendingJobs=jobs.size;}}
  async function prepare(index,bounds,{signal}={}){live();cancelled(signal,revision);const w=createRingHabitatRegionQueryWorkspace(queryCapacity);gather(index,bounds,w);return prepareWork(w,signal);}
  async function prepareRegions(body,addresses,{signal}={}){
    live();cancelled(signal,revision);if(!Array.isArray(addresses))throw new TypeError('Halo region address batch must be an array');if(addresses.length>queryCapacity)throw new HaloTerrainUnavailable('halo-region-query-capacity','Complete Halo address batch exceeds its declared capacity');
    const w=createRingHabitatRegionQueryWorkspace(queryCapacity),seen=new Set();
    for(const a of addresses){const r=recipeFor(body,a.siteIndex);address(r,a.tileX,a.tileY);const key=`${a.siteIndex}:${a.tileX},${a.tileY}`;if(seen.has(key))throw new RangeError('Duplicate Halo region address');seen.add(key);const c=w.candidates[w.count++];c.body=body;c.recipe=r;c.tx=a.tileX;c.ty=a.tileY;}
    return prepareWork(w,signal);
  }
  async function prepareField(body,siteIndex,{signal}={}){live();const generation=revision;cancelled(signal,generation);const site=siteOf(body,recipeFor(body,siteIndex),true);cancelled(signal,generation);return fieldLease(site);}
  function acquireField(body,siteIndex){live();const site=siteOf(body,recipeFor(body,siteIndex));if(!site)throw new HaloTerrainUnavailable('halo-field-unavailable','Canonical Halo field must be prepared before borrowing');return fieldLease(site);}
  function acquire(body,siteIndex,tx,ty){live();const r=recipeFor(body,siteIndex);address(r,tx,ty);const e=lookup(body,r,tx,ty);if(!e)throw new HaloTerrainUnavailable();pin(e);return lease([e]);}
  function sampleTop(body,siteIndex,x,y,point,normal,faceNormal,surfaceInfo,required=true){live();if(!Number.isFinite(x)||!Number.isFinite(y))throw new TypeError('Halo chart coordinates must be finite');const r=recipeFor(body,siteIndex),width=(r.maxAngle-r.minAngle)*r.innerRadius,height=r.maxY-r.minY;if(x<0||y<0||x>=width||y>=height)return false;const e=lookup(body,r,Math.floor(x/SIZE),Math.floor(y/SIZE));if(!e){if(required)throw new HaloTerrainUnavailable();return false;}e.used=e.site.used=++clock;return sampleTopTriangle(e.mesh,x,y,point,normal,faceNormal,surfaceInfo);}
  function clear(){live();for(const job of jobs)job.cancelled=true;for(const w of queries)releaseQuery(w);queries.clear();stats.queryWorkspaces=0;for(const e of entries)remove(e);for(const f of fields){if(f.retired)continue;detachField(f);f.retired=true;stats.retiredFields++;finishRetiredField(f);}parents.clear();revision++;}
  // Opportunistic read of the same physical page; never construct or pin here.
  function samplePreparedTop(body,siteIndex,x,y,point,normal,faceNormal,surfaceInfo){return sampleTop(body,siteIndex,x,y,point,normal,faceNormal,surfaceInfo,false);}
  const owner={query,prepare,prepareRegions,prepareField,acquire,acquireField,sampleTop,samplePreparedTop,releaseQuery,clear,stats,limits:Object.freeze({maxRegions,maxFields,maxBytes,maxFaces,queryCapacity,maxQueryWorkspaces:32}),createQueryWorkspace(capacity=queryCapacity){return createRingHabitatRegionQueryWorkspace(capacity);},get revision(){return revision;},dispose(){if(disposed)return;clear();disposed=true;stats.disposed=true;}};return owner;
}
