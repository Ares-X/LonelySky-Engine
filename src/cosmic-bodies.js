import {rotationFrame3,frameToWorld3} from './frame.js';
import {CELL_SIZE, decodeCell, encodeCell, wrapCell} from './coordinates.js';
import {randomFromSeed} from './random.js';
import {cosmicStructureContext} from './cosmic-structures.js';
import {createRingSurfaceLattice,ringSurfaceHash} from './ring-surface-lattice.js';
import {createRingHabitat} from './ring-habitat.js';

export const COSMIC_BODY_REVISION = 3;
export const COSMIC_BODY_GRID_CELLS = 512;
export const COSMIC_BODY_GRID_SIZE = CELL_SIZE * COSMIC_BODY_GRID_CELLS;
export const COSMIC_BODY_RENDER_RANGE = 32000000;
export const COSMIC_BODY_MAX_PLACEMENT_CLEARANCE = 840000;
const PERIOD=32768/COSMIC_BODY_GRID_CELLS,WORLD_SIZE=32768*CELL_SIZE;
const AXES=['x','y','z'],cache=new Map();
// Detailed terrain is much larger than an empty candidate. Bound retained
// geometry independently of the existing address count (32 full landscapes).
// Keep the retained face budget fixed as individual near meshes become finer.
const MAX_CACHED_TERRAIN_FACES=1_310_720;
// Region descriptors retain source recipes instead of meshes. Bound those
// independently too: at most 32 complete 32-site habitat recipe sets.
const MAX_CACHED_TERRAIN_RECIPES=1024;
let cachedTerrainFaces=0,cachedTerrainRecipes=0;
const wrap=(n,size)=>((n+size/2)%size+size)%size-size/2;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
// This admission stream is a published layout once V3 ships. New families
// need their own named candidates and must not be inserted into this lottery.
const KINDS=['ring','gas-giant','dark-world','stellar-giant'];
const unit=vector=>{const length=Math.sqrt(vector.reduce((sum,n)=>sum+n*n,0))||1;return vector.map(n=>n/length);};
export const COSMIC_BODY_THEME_WEIGHTS=freeze({
  'silver-dust':[8,55,20,17], 'dark-rift':[15,48,32,5],
  'old-gold':[13,10,52,25], 'tidal-islands':[4,35,42,19],
  'blue-nursery':[0,42,8,50],
  'cold-void':[0,0,100,0],
});

/** One physical cross section, consumed by both analytic radiance and CCD. */
export function cosmicRingParts({radius,halfWidth,thickness,phase,broken}){
  if(![radius,halfWidth,thickness,phase].every(Number.isFinite)||radius<=0||halfWidth<=0||halfWidth>=1||thickness<=0||thickness>=1/1.45||typeof broken!=='boolean')throw new RangeError('Invalid ring cross section');
  const w=halfWidth*radius,t=thickness*radius;
  const parts=Array.from({length:6},(_,section)=>{
    let innerRadius,outerRadius,minY,maxY;
    if(section<3){const low=-.9+section*.6;innerRadius=radius-t;outerRadius=radius+t;minY=low*w;maxY=(low+.6)*w;}
    else if(section===3){innerRadius=radius-t*1.45;outerRadius=radius+t*1.35;minY=.88*w;maxY=w;}
    else if(section===4){innerRadius=radius-t*1.45;outerRadius=radius+t*1.35;minY=-w;maxY=-.88*w;}
    else {innerRadius=radius+t*.95;outerRadius=radius+t*2.2;minY=-w*.28;maxY=w*.28;}
    return {type:'annular-sector-slab',innerRadius,outerRadius,minY,maxY,
      gapCenter:phase,gapHalfAngle:broken ? .326+Math.sin(section*13.47+phase*2)*.0425 : 0};
  });
  // Exterior structure is physical, rather than a normal-map silhouette. The
  // published interior and the original six cross sections remain unchanged.
  // World-sized ledges and buttresses stay readable beside the immense core;
  // the small-radius caps keep this public constructor valid for model tests.
  const structuralGap=broken?Math.max(...parts.map(part=>part.gapHalfAngle)):0;
  const railHalfHeight=Math.min(180,w*.06);
  for(const row of [-.94,-.58,.58,.94])parts.push({type:'annular-sector-slab',
    innerRadius:radius+t*.92,outerRadius:radius+t*3.6,
    minY:row*w-railHalfHeight,maxY:row*w+railHalfHeight,
    gapCenter:phase,gapHalfAngle:structuralGap});
  const count=24,pitch=Math.PI*2/count;
  for(let index=0;index<count;index++){
    const center=phase+(index+.5)*pitch;
    const arcWidth=9000+3000*Math.sin(index*1.618+phase);
    const halfAngle=Math.min(arcWidth/(2*radius),pitch*.25);
    const reach=7+1.5*Math.sin(index*2.399+phase*1.7);
    const fromBreak=Math.abs(Math.atan2(Math.sin(center-phase),Math.cos(center-phase)));
    if(broken&&fromBreak<=structuralGap+halfAngle)continue;
    const supportDepth=radius*(.035+(reach-5.5)*.005);
    parts.push({type:'annular-sector-slab',innerRadius:radius+t*.8,outerRadius:radius+Math.max(t*3.6,supportDepth),
      minY:-w*1.015,maxY:w*1.015,gapCenter:center+Math.PI,gapHalfAngle:Math.PI-halfAngle});
  }
  // QA candidate: spend the same unaccepted cabinet slots on finite shoulder
  // crossbeams. Keep the first/last cabinet pairs; other pairs share an existing
  // support anchor and add mirrored exterior axial relief, not inner metal.
  const supportEnd=parts.length;
  const cabinetHalfHeight=Math.min(500,w*.2),cabinetDepth=Math.min(128,radius*.002);
  const shoulderBeamHeight=Math.min(1600,w*.08),lastCabinetPair=Math.floor((supportEnd-11)/2);
  for(let index=10;index<supportEnd;index++){
    const slot=index-10,pair=Math.floor(slot/2);
    if(pair!==0&&pair!==lastCabinetPair){
      const anchor=parts[11+slot-slot%2],side=slot%2===0?1:-1;
      const halfAngle=(Math.PI-anchor.gapHalfAngle)*.65;
      const beam={type:'annular-sector-slab',innerRadius:radius+t*1.1,outerRadius:anchor.outerRadius,
        minY:side>0?w*.97:-w-shoulderBeamHeight,maxY:side>0?w+shoulderBeamHeight:-w*.97,
        gapCenter:anchor.gapCenter,gapHalfAngle:Math.PI-halfAngle};
      // A bounded I-sector remains one catalogue part. These same three
      // immutable closed solids feed distance, CCD, camera and light rays.
      // The original envelope, attachment, index and seed stream stay fixed.
      const flange=Math.min(160,(beam.maxY-beam.minY)*.12);
      beam.sections=[{...beam,minY:beam.maxY-flange},
        {...beam,gapHalfAngle:Math.PI-halfAngle*.16},
        {...beam,maxY:beam.minY+flange}];
      parts.push(beam);
    }else{
      const support=parts[index],cabinetHalfAngle=Math.min(210/radius,(Math.PI-support.gapHalfAngle)*.4);
      parts.push({type:'annular-sector-slab',innerRadius:support.outerRadius-t*.05,
        outerRadius:support.outerRadius+cabinetDepth,
        minY:-w*.5-cabinetHalfHeight,maxY:-w*.5+cabinetHalfHeight,
        gapCenter:support.gapCenter,gapHalfAngle:Math.PI-cabinetHalfAngle});
    }
  }
  // Continuous shoulder decks join the original flanges to the deep supports.
  // Between decks, supports and spine, the recessed bays remain empty space.
  for(const side of [-1,1])parts.push({type:'annular-sector-slab',
    innerRadius:radius+t*1.2,outerRadius:radius+Math.max(radius*.04,t*1.35),
    minY:side<0?-w:w*.88,maxY:side<0?-w*.88:w,
    gapCenter:phase,gapHalfAngle:structuralGap});
  // The spine sits below the shoulder edges; finite supports project beyond
  // both. Proportional overlaps also admit the public constructor's thick rings.
  parts.push({type:'annular-sector-slab',innerRadius:radius+t*2.1,outerRadius:radius+Math.max(radius*.025,t*2.2),
    minY:-w*.16,maxY:w*.16,gapCenter:phase,gapHalfAngle:structuralGap});
  // Raised hull plates remain implicit: one bounded cell recipe is queried by
  // both analytic rendering and continuous collisions. They cover the core's
  // exterior, its spine and finite-width supports, never the open interior.
  for(let index=0;index<parts.length;index++)if(index<3||(index>=10&&index<supportEnd)||index===parts.length-1){
    parts[index].surfaceLattice=createRingSurfaceLattice(parts[index],{
      seed:ringSurfaceHash(Math.floor(phase*1000000),index,0)&0xffffff,depth:Math.min(80,radius*.00125),tiered:true,
    });
  }
  return freeze(parts);
}

/** Fixed independent candidates: no observer, render quality or visitation RNG. */
export function describeCosmicBody(coordinate,seed='lonelysky',terrainMode='legacy'){
  if(typeof seed!=='string'||!coordinate||!Number.isSafeInteger(coordinate.x)||!Number.isSafeInteger(coordinate.y)||!Number.isSafeInteger(coordinate.z))throw new TypeError('Invalid cosmic body address');
  if(terrainMode!=='legacy'&&terrainMode!=='regions')throw new TypeError('Unknown habitat terrain representation');
  const cx=wrap(coordinate.x,PERIOD),cy=wrap(coordinate.y,PERIOD),cz=wrap(coordinate.z,PERIOD),key=`${seed}:cosmic-body-v3:${cx},${cy},${cz}`;
  const cacheKey=terrainMode==='legacy'?key:`${key}:halo-field-v1`;
  if(cache.has(cacheKey))return cache.get(cacheKey).descriptor;
  const cell=[cx,cy,cz];
  const random=randomFromSeed(key),offset=AXES.map(()=>(random()-.5)*COSMIC_BODY_GRID_SIZE*.06);
  let descriptor=null;
  if(random()<.08){
    const global=cell.map((n,i)=>n*COSMIC_BODY_GRID_SIZE+offset[i]);
    const localCell=Object.fromEntries(AXES.map((axis,i)=>[axis,wrapCell(Math.floor((global[i]+CELL_SIZE/2)/CELL_SIZE))]));
    const sectorIndex=encodeCell(localCell),cameraPosition=global.map((n,i)=>wrap(n-localCell[AXES[i]]*CELL_SIZE,WORLD_SIZE));
    const context=cosmicStructureContext({sectorIndex,cameraPosition,seed});
    const theme=context?.theme??context?.family??'cold-void';
    const weights=COSMIC_BODY_THEME_WEIGHTS[theme]??COSMIC_BODY_THEME_WEIGHTS['cold-void'];
    // Truly empty intergalactic space has substantially fewer solid wonders.
    if(context||random()<.08){
      let roll=random()*weights.reduce((a,b)=>a+b,0),kindIndex=0;
      while(kindIndex<weights.length-1&&(roll-=weights[kindIndex])>=0)kindIndex++;
      const kind=KINDS[kindIndex],orientation=AXES.map(()=>random()*Math.PI*2);
      const frame=rotationFrame3(orientation);
      const radius=kind==='ring'?600000+random()*600000:kind==='stellar-giant'?500000+random()*700000:350000+random()*650000;
      const halfWidth=.016+random()*.012,thickness=.00025+random()*.0005,phase=random()*Math.PI*2,broken=random()<.38;
      const young=theme==='blue-nursery';
      const tint=kind==='stellar-giant'?(young?[.65,.8,1]:[1,.76,.48]):kind==='dark-world'?[.23,.28,.34]:[.68,.62,.49];
      const shape=kind==='ring'?{type:'compound',parts:cosmicRingParts({radius,halfWidth,thickness,phase,broken})}:{type:'sphere',radius};
      const habitat=kind==='ring'?createRingHabitat({radius,halfWidth,thickness,phase,broken,parts:shape.parts,theme,seed:key,terrainMode}):null;
      if(habitat)shape.terrainGroups=habitat.terrainGroups;
      const habitatData=habitat?{climate:habitat.climate,ecology:habitat.ecology}:null;
      if(habitatData&&terrainMode==='regions')habitatData.terrainRecipes=habitat.terrainRecipes;
      const boundsRadius=kind==='ring'?Math.max(...shape.parts.map(p=>Math.hypot(p.surfaceLattice?.outerRadius??p.outerRadius,Math.max(Math.abs(p.minY),Math.abs(p.maxY))))):radius;
      const prominences=kind==='stellar-giant'?Array.from({length:3},(_,i)=>{const angle=phase+i*Math.PI*2/3;return {axis:unit([Math.sin(angle),Math.sin(angle*2+phase)*.14,Math.cos(angle)]),radii:[.04+.01*Math.sin(i+phase),.08+.025*Math.sin(i*3+phase)]};}):[];
      descriptor=freeze({id:`cosmic-body-v3:${cell}`,revision:COSMIC_BODY_REVISION,kind,theme,
        galaxyId:context?.id??context?.galaxyId??null,cell:Object.fromEntries(AXES.map((axis,i)=>[axis,cell[i]])),offset,frame,
        radius,halfWidth,thickness,phase,broken,shape,boundsRadius,prominences,tint,habitat:habitatData,
        // Reserve room for the parent system, without turning that room into
        // a collision wall. Unrelated local suns cannot populate its low sky.
        placementClearance:radius*(kind==='ring'?.18:.7),
        light:unit([-.6+random()*1.2,.25+random()*.6,.4+random()*.6]),
        ringed:kind==='gas-giant'&&random()<.55});
    }
  }
  let terrainFaces=0;
  if(descriptor?.shape.terrainGroups)for(const mesh of descriptor.shape.terrainGroups)terrainFaces+=mesh.faces.length;
  const terrainRecipes=terrainMode==='regions'&&descriptor?.kind==='ring'?descriptor.habitat.terrainRecipes.length:0;
  cache.set(cacheKey,{descriptor,terrainFaces,terrainRecipes});cachedTerrainFaces+=terrainFaces;cachedTerrainRecipes+=terrainRecipes;
  while(cache.size>4096||cachedTerrainFaces>MAX_CACHED_TERRAIN_FACES||cachedTerrainRecipes>MAX_CACHED_TERRAIN_RECIPES){
    const oldest=cache.keys().next().value;
    const retired=cache.get(oldest);cachedTerrainFaces-=retired.terrainFaces;cachedTerrainRecipes-=retired.terrainRecipes;cache.delete(oldest);
  }
  return descriptor;
}

export function cosmicBodyCenter(body,sectorIndex,cameraPosition=[0,0,0]){
  const cell=decodeCell(sectorIndex);
  return AXES.map((axis,i)=>wrap(body.cell[axis]*COSMIC_BODY_GRID_SIZE+body.offset[i]-cell[axis]*CELL_SIZE-cameraPosition[i],WORLD_SIZE));
}

/** A 32M-L render-radius box touches fewer than 8^3 macro cells, including
 * body-radius padding. Capacity bounds traversal as well as retained records. */
export const COSMIC_SOLID_QUERY_CAPACITY = 512;
function makeCosmicQueryRecord(){return {id:'',revision:0,kind:'',theme:'',galaxyId:null,cell:null,offset:null,frame:null,radius:0,halfWidth:0,thickness:0,phase:0,broken:false,shape:null,boundsRadius:0,prominences:null,tint:null,habitat:null,placementClearance:0,light:null,ringed:false,position:[0,0,0]};}
function copyCosmicQueryRecord(body,out){
  out.id=body.id;out.revision=body.revision;out.kind=body.kind;out.theme=body.theme;out.galaxyId=body.galaxyId;
  out.cell=body.cell;out.offset=body.offset;out.frame=body.frame;out.radius=body.radius;out.halfWidth=body.halfWidth;out.thickness=body.thickness;
  out.phase=body.phase;out.broken=body.broken;out.shape=body.shape;out.boundsRadius=body.boundsRadius;out.prominences=body.prominences;out.tint=body.tint;
  out.habitat=body.habitat;out.placementClearance=body.placementClearance;out.light=body.light;out.ringed=body.ringed;
}
export function createCosmicSolidQueryWorkspace(capacity=COSMIC_SOLID_QUERY_CAPACITY){
  if(!Number.isInteger(capacity)||capacity<1||capacity>COSMIC_SOLID_QUERY_CAPACITY)throw new RangeError('Cosmic query capacity must be 1..512');
  return {records:Array.from({length:capacity},makeCosmicQueryRecord),results:[],seen:new Set(),cell:{x:0,y:0,z:0},coordinate:{x:0,y:0,z:0},range:[0,0,0,0,0,0],disposed:false};
}
export function disposeCosmicSolidQueryWorkspace(workspace){
  workspace.results.length=0;workspace.records.length=0;workspace.seen.clear();workspace.disposed=true;
}
function cosmicQueryRange({sectorIndex,bounds,terrainMode='legacy'},cell,range){
  if(terrainMode!=='legacy'&&terrainMode!=='regions')throw new TypeError('Unknown habitat terrain representation');
  if(!bounds||!Array.isArray(bounds.min)||bounds.min.length!==3||!Number.isFinite(bounds.min[0])||!Number.isFinite(bounds.min[1])||!Number.isFinite(bounds.min[2])
    ||!Array.isArray(bounds.max)||bounds.max.length!==3||!Number.isFinite(bounds.max[0])||!Number.isFinite(bounds.max[1])||!Number.isFinite(bounds.max[2]))throw new TypeError('Invalid cosmic query bounds');
  decodeCell(sectorIndex,cell);
  const padding=1250000+COSMIC_BODY_GRID_SIZE*.03;
  range[0]=Math.ceil((cell.x*CELL_SIZE+bounds.min[0]-padding)/COSMIC_BODY_GRID_SIZE);range[1]=Math.floor((cell.x*CELL_SIZE+bounds.max[0]+padding)/COSMIC_BODY_GRID_SIZE);
  range[2]=Math.ceil((cell.y*CELL_SIZE+bounds.min[1]-padding)/COSMIC_BODY_GRID_SIZE);range[3]=Math.floor((cell.y*CELL_SIZE+bounds.max[1]+padding)/COSMIC_BODY_GRID_SIZE);
  range[4]=Math.ceil((cell.z*CELL_SIZE+bounds.min[2]-padding)/COSMIC_BODY_GRID_SIZE);range[5]=Math.floor((cell.z*CELL_SIZE+bounds.max[2]+padding)/COSMIC_BODY_GRID_SIZE);
  if(bounds.min[0]>bounds.max[0]||range[1]-range[0]>PERIOD||bounds.min[1]>bounds.max[1]||range[3]-range[2]>PERIOD||bounds.min[2]>bounds.max[2]||range[5]-range[4]>PERIOD)throw new RangeError('Cosmic query exceeds one world period');
}
function queryCosmicSolids({bounds,seed='lonelysky',terrainMode='legacy'},cell,range,coordinate,seen,result,records){
  let count=0;if(seen.size)seen.clear();
  // A bounded nearby box has unique wrapped addresses. Only full-period
  // queries need the duplicate set (whose engine backing store may allocate).
  const deduplicate=range[1]-range[0]===PERIOD||range[3]-range[2]===PERIOD||range[5]-range[4]===PERIOD;
  for(let x=range[0];x<=range[1];x++)for(let y=range[2];y<=range[3];y++)for(let z=range[4];z<=range[5];z++){
    coordinate.x=x;coordinate.y=y;coordinate.z=z;
    const body=describeCosmicBody(coordinate,seed,terrainMode);if(!body||(deduplicate&&seen.has(body.id)))continue;if(deduplicate)seen.add(body.id);
    const px=wrap(body.cell.x*COSMIC_BODY_GRID_SIZE+body.offset[0]-cell.x*CELL_SIZE,WORLD_SIZE);
    const py=wrap(body.cell.y*COSMIC_BODY_GRID_SIZE+body.offset[1]-cell.y*CELL_SIZE,WORLD_SIZE);
    const pz=wrap(body.cell.z*COSMIC_BODY_GRID_SIZE+body.offset[2]-cell.z*CELL_SIZE,WORLD_SIZE),r=body.boundsRadius;
    if(px+r<bounds.min[0]||px-r>bounds.max[0]||py+r<bounds.min[1]||py-r>bounds.max[1]||pz+r<bounds.min[2]||pz-r>bounds.max[2])continue;
    if(records){const out=records[count];copyCosmicQueryRecord(body,out);
      out.position[0]=px;out.position[1]=py;out.position[2]=pz;result[count++]=out;
    }else result[count++]={...body,position:[px,py,pz]};
  }
  result.length=count;return result;
}
/** Borrowed results/outer records/positions remain valid until the next query
 * using this workspace, or disposal. Immutable descriptor children are shared.
 * Capacity failure clears output and occurs before querying any candidate. */
export function cosmicSolidsInBoundsInto(options,workspace){
  if(workspace.disposed)throw new Error('Cosmic query workspace disposed');
  const {cell,range,coordinate,seen,results,records}=workspace;
  try{
    cosmicQueryRange(options,cell,range);
    const candidates=Math.max(0,range[1]-range[0]+1)*Math.max(0,range[3]-range[2]+1)*Math.max(0,range[5]-range[4]+1);
    if(candidates>records.length)throw new RangeError('Complete cosmic query exceeds workspace capacity');
    return queryCosmicSolids(options,cell,range,coordinate,seen,results,records);
  }catch(error){results.length=0;throw error;}
}
/** Public broadphase snapshots own their outer records and positions. */
export function cosmicSolidsInBounds(options){
  const cell={x:0,y:0,z:0},range=[0,0,0,0,0,0];cosmicQueryRange(options,cell,range);
  return queryCosmicSolids(options,cell,range,{x:0,y:0,z:0},new Set(),[],null);
}

export function visibleCosmicBodies({sectorIndex,cameraPosition=[0,0,0],seed='lonelysky',terrainMode='legacy'}){
  const range=COSMIC_BODY_RENDER_RANGE;
  return cosmicSolidsInBounds({sectorIndex,seed,terrainMode,bounds:{min:cameraPosition.map(n=>n-range),max:cameraPosition.map(n=>n+range)}})
    .map(body=>{const center=cosmicBodyCenter(body,sectorIndex,cameraPosition),distance=Math.hypot(...center);
      const f=Math.max(0,Math.min(1,(distance-range*.75)/(range*.25))),visibility=1-f*f*(3-2*f);
      return {...body,center,visibility};}).filter(body=>body.visibility>0);
}

/** Empty-space candidate pose; the game checks its complete world before use. */
export function cosmicBodyAddress(body){
  let up=[0,1,0],local,aim;
  if(body.kind==='ring'){
    const angle=body.phase+Math.PI,radial=[Math.cos(angle),0,Math.sin(angle)];
    const forward=unit([-radial[2]-.2*radial[0],0,radial[0]-.2*radial[2]]);
    local=radial.map(n=>n*(1-body.thickness-200/body.radius));
    aim=local.map((n,i)=>n+forward[i]*1000/body.radius);
    up=radial.map(n=>-n);
  }else{
    local=[.15,.2,1.45];aim=[-.25,.25,0];
  }
  const global=AXES.map((axis,i)=>body.cell[axis]*COSMIC_BODY_GRID_SIZE+body.offset[i]);
  const offset=frameToWorld3(body.frame,local.map(n=>n*body.radius)),targetOffset=frameToWorld3(body.frame,aim.map(n=>n*body.radius));
  const absolute=global.map((n,i)=>n+offset[i]);
  const cell=Object.fromEntries(AXES.map((axis,i)=>[axis,wrapCell(Math.floor((absolute[i]+CELL_SIZE/2)/CELL_SIZE))]));
  return {sectorIndex:encodeCell(cell),position:absolute.map((n,i)=>wrap(n-cell[AXES[i]]*CELL_SIZE,WORLD_SIZE)),
    target:global.map((n,i)=>wrap(n+targetOffset[i]-cell[AXES[i]]*CELL_SIZE,WORLD_SIZE)),up:frameToWorld3(body.frame,up),fov:65};
}
