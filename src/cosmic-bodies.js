import {rotationFrame3,frameToWorld3} from './frame.js';
import {CELL_SIZE, decodeCell, encodeCell, wrapCell} from './coordinates.js';
import {randomFromSeed} from './random.js';
import {cosmicStructureContext} from './cosmic-structures.js';

export const COSMIC_BODY_REVISION = 3;
export const COSMIC_BODY_GRID_CELLS = 512;
export const COSMIC_BODY_GRID_SIZE = CELL_SIZE * COSMIC_BODY_GRID_CELLS;
export const COSMIC_BODY_RENDER_RANGE = 32000000;
export const COSMIC_BODY_MAX_PLACEMENT_CLEARANCE = 840000;
const PERIOD=32768/COSMIC_BODY_GRID_CELLS,WORLD_SIZE=32768*CELL_SIZE;
const AXES=['x','y','z'],cache=new Map();
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
  return freeze(Array.from({length:6},(_,section)=>{
    let innerRadius,outerRadius,minY,maxY;
    if(section<3){const low=-.9+section*.6;innerRadius=radius-t;outerRadius=radius+t;minY=low*w;maxY=(low+.6)*w;}
    else if(section===3){innerRadius=radius-t*1.45;outerRadius=radius+t*1.35;minY=.88*w;maxY=w;}
    else if(section===4){innerRadius=radius-t*1.45;outerRadius=radius+t*1.35;minY=-w;maxY=-.88*w;}
    else {innerRadius=radius+t*.95;outerRadius=radius+t*2.2;minY=-w*.28;maxY=w*.28;}
    return {type:'annular-sector-slab',innerRadius,outerRadius,minY,maxY,
      gapCenter:phase,gapHalfAngle:broken ? .326+Math.sin(section*13.47+phase*2)*.0425 : 0};
  }));
}

/** Fixed independent candidates: no observer, render quality or visitation RNG. */
export function describeCosmicBody(coordinate,seed='lonelysky'){
  if(typeof seed!=='string'||!AXES.every(axis=>Number.isSafeInteger(coordinate?.[axis])))throw new TypeError('Invalid cosmic body address');
  const cx=wrap(coordinate.x,PERIOD),cy=wrap(coordinate.y,PERIOD),cz=wrap(coordinate.z,PERIOD),key=`${seed}:cosmic-body-v3:${cx},${cy},${cz}`;
  if(cache.has(key))return cache.get(key);
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
      const boundsRadius=kind==='ring'?Math.max(...shape.parts.map(p=>Math.hypot(p.outerRadius,Math.max(Math.abs(p.minY),Math.abs(p.maxY))))):radius;
      const prominences=kind==='stellar-giant'?Array.from({length:3},(_,i)=>{const angle=phase+i*Math.PI*2/3;return {axis:unit([Math.sin(angle),Math.sin(angle*2+phase)*.14,Math.cos(angle)]),radii:[.04+.01*Math.sin(i+phase),.08+.025*Math.sin(i*3+phase)]};}):[];
      descriptor=freeze({id:`cosmic-body-v3:${cell}`,revision:COSMIC_BODY_REVISION,kind,theme,
        galaxyId:context?.id??context?.galaxyId??null,cell:Object.fromEntries(AXES.map((axis,i)=>[axis,cell[i]])),offset,frame,
        radius,halfWidth,thickness,phase,broken,shape,boundsRadius,prominences,tint,
        // Reserve room for the parent system, without turning that room into
        // a collision wall. Unrelated local suns cannot populate its low sky.
        placementClearance:radius*(kind==='ring'?.18:.7),
        light:unit([-.6+random()*1.2,.25+random()*.6,.4+random()*.6]),
        ringed:kind==='gas-giant'&&random()<.55});
    }
  }
  cache.set(key,descriptor);if(cache.size>4096)cache.delete(cache.keys().next().value);
  return descriptor;
}

export function cosmicBodyCenter(body,sectorIndex,cameraPosition=[0,0,0]){
  const cell=decodeCell(sectorIndex);
  return AXES.map((axis,i)=>wrap(body.cell[axis]*COSMIC_BODY_GRID_SIZE+body.offset[i]-cell[axis]*CELL_SIZE-cameraPosition[i],WORLD_SIZE));
}

/** Broadphase in macro space; independent of visibility and small-cell streaming. */
export function cosmicSolidsInBounds({sectorIndex,bounds,seed='lonelysky'}){
  if(!bounds||!Array.isArray(bounds.min)||bounds.min.length!==3||!bounds.min.every(Number.isFinite)
    ||!Array.isArray(bounds.max)||bounds.max.length!==3||!bounds.max.every(Number.isFinite))throw new TypeError('Invalid cosmic query bounds');
  const cell=decodeCell(sectorIndex),padding=1250000+COSMIC_BODY_GRID_SIZE*.03;
  const minX=Math.ceil((cell.x*CELL_SIZE+bounds.min[0]-padding)/COSMIC_BODY_GRID_SIZE),maxX=Math.floor((cell.x*CELL_SIZE+bounds.max[0]+padding)/COSMIC_BODY_GRID_SIZE);
  const minY=Math.ceil((cell.y*CELL_SIZE+bounds.min[1]-padding)/COSMIC_BODY_GRID_SIZE),maxY=Math.floor((cell.y*CELL_SIZE+bounds.max[1]+padding)/COSMIC_BODY_GRID_SIZE);
  const minZ=Math.ceil((cell.z*CELL_SIZE+bounds.min[2]-padding)/COSMIC_BODY_GRID_SIZE),maxZ=Math.floor((cell.z*CELL_SIZE+bounds.max[2]+padding)/COSMIC_BODY_GRID_SIZE);
  if(bounds.min[0]>bounds.max[0]||maxX-minX>PERIOD||bounds.min[1]>bounds.max[1]||maxY-minY>PERIOD||bounds.min[2]>bounds.max[2]||maxZ-minZ>PERIOD)throw new RangeError('Cosmic query exceeds one world period');
  const result=[],seen=new Set(),coordinate={x:0,y:0,z:0};
  for(let x=minX;x<=maxX;x++)for(let y=minY;y<=maxY;y++)for(let z=minZ;z<=maxZ;z++){
    coordinate.x=x;coordinate.y=y;coordinate.z=z;
    const body=describeCosmicBody(coordinate,seed);if(!body||seen.has(body.id))continue;seen.add(body.id);
    const px=wrap(body.cell.x*COSMIC_BODY_GRID_SIZE+body.offset[0]-cell.x*CELL_SIZE-0,WORLD_SIZE);
    const py=wrap(body.cell.y*COSMIC_BODY_GRID_SIZE+body.offset[1]-cell.y*CELL_SIZE-0,WORLD_SIZE);
    const pz=wrap(body.cell.z*COSMIC_BODY_GRID_SIZE+body.offset[2]-cell.z*CELL_SIZE-0,WORLD_SIZE),r=body.boundsRadius;
    if(px+r<bounds.min[0]||px-r>bounds.max[0]||py+r<bounds.min[1]||py-r>bounds.max[1]||pz+r<bounds.min[2]||pz-r>bounds.max[2])continue;
    result.push({...body,position:[px,py,pz]});
  }
  return result;
}

export function visibleCosmicBodies({sectorIndex,cameraPosition=[0,0,0],seed='lonelysky'}){
  const range=COSMIC_BODY_RENDER_RANGE;
  return cosmicSolidsInBounds({sectorIndex,seed,bounds:{min:cameraPosition.map(n=>n-range),max:cameraPosition.map(n=>n+range)}})
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
