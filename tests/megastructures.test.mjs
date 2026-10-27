import test from 'node:test';
import assert from 'node:assert/strict';
import {CELL_SIZE, decodeCell, encodeCell, wrapCell} from '../src/coordinates.js';
import {describeDistantLandmark, sampleDistantLandmark, distantLandmarkAddress, distantLandmarkCenter,
  LANDMARK_GRID_CELLS, LANDMARK_GRID_SIZE, LANDMARK_THEME_WEIGHTS} from '../src/megastructures.js';
import {loadedMacros, galaxyRelativeCenter} from '../src/render/cosmos.js';
import {describeGalaxyAppearance} from '../src/render/galaxy-appearance.js';

const axes=['x','y','z'], seed='engine-distant-vistas';
const population=[];
for(let x=-12;x<=12;x++)for(let y=-12;y<=12;y++)for(let z=0;z<4;z++) {
  const coordinate={x,y,z},descriptor=describeDistantLandmark(coordinate,seed);
  if(descriptor)population.push({coordinate,descriptor});
}

test('distant wonders are mostly empty, with rare rings and themed natural giants',()=>{
  assert.ok(population.length/2500>.2&&population.length/2500<.35);
  const ringFraction=population.filter(({descriptor:d})=>d.kind==='ring').length/population.length;
  assert.ok(ringFraction>.04&&ringFraction<.09);
  assert.deepEqual(new Set(population.map(({descriptor:d})=>d.kind)),new Set(['ring','gas-giant','dark-world','stellar-giant']));
  assert.deepEqual(new Set(population.map(({descriptor:d})=>d.theme)),new Set(Object.keys(LANDMARK_THEME_WEIGHTS)));
  for(const {descriptor:d} of population){
    if(d.theme==='cold-void'){assert.equal(d.kind,'dark-world');assert.equal(d.galaxyId,null);assert.equal(d.family,null);}
    if(d.theme==='stellar-nursery')assert.notEqual(d.kind,'ring');
    assert.ok(d.radius>=LANDMARK_GRID_SIZE*.15&&d.radius<LANDMARK_GRID_SIZE*.235);
    const address=distantLandmarkAddress(d);
    const factor=d.kind==='ring'?1.14:d.kind==='stellar-giant'?1.55:1.18;
    assert.ok(d.radius*factor<LANDMARK_GRID_SIZE*.35,'scenic point lies entirely inside full visibility support');
    assert.ok(Math.abs(Math.hypot(...distantLandmarkCenter(d,address.sectorIndex,address.position))/d.radius-factor)<1e-10);
    assert.ok(Object.isFrozen(d)&&Object.isFrozen(d.frame)&&Object.isFrozen(d.tint));
    assert.ok(Math.abs(Math.hypot(...d.light)-1)<1e-12);
    assert.ok(d.tint.every(n=>Number.isFinite(n)&&n>=0&&n<=1));
    assert.ok(d.frame.every(Number.isFinite));
  }
  for(const theme of ['grand-spiral','barred-spiral','dust-disk'])assert.ok(LANDMARK_THEME_WEIGHTS[theme][1]>40);
  assert.ok(LANDMARK_THEME_WEIGHTS['ancient-halo'][2]>LANDMARK_THEME_WEIGHTS['ancient-halo'][1]);
  assert.ok(LANDMARK_THEME_WEIGHTS['stellar-nursery'][3]>LANDMARK_THEME_WEIGHTS['stellar-nursery'][1]);
});

test('anchor context matches real nearby galaxies independently of observer or visits',()=>{
  for(const {coordinate,descriptor:d} of population.filter((_,i)=>i%11===0)){
    assert.deepEqual(d,describeDistantLandmark(coordinate,seed));
    describeDistantLandmark({x:35,y:21,z:-7},seed);
    assert.deepEqual(d,describeDistantLandmark({...coordinate,x:coordinate.x+256},seed));
    const global=d.offset.map((n,i)=>n+d.cell[axes[i]]*LANDMARK_GRID_SIZE);
    const anchorCell=Object.fromEntries(axes.map((axis,i)=>[axis,wrapCell(Math.floor((global[i]+CELL_SIZE/2)/CELL_SIZE))]));
    const position=d.offset.map(n=>((n+CELL_SIZE/2)%CELL_SIZE+CELL_SIZE)%CELL_SIZE-CELL_SIZE/2);
    const candidates=loadedMacros(encodeCell(anchorCell),seed).map(galaxy=>({galaxy,distance:Math.hypot(...galaxyRelativeCenter(galaxy,anchorCell).map((n,i)=>n-position[i]))}))
      .filter(entry=>entry.distance<=520000).sort((a,b)=>a.distance-b.distance||a.galaxy.id.localeCompare(b.galaxy.id));
    assert.equal(d.galaxyId,candidates[0]?.galaxy.id??null);
    if(candidates.length)assert.equal(d.theme,describeGalaxyAppearance(candidates[0].galaxy).family);
    const address=distantLandmarkAddress(d),found=sampleDistantLandmark({...address,cameraPosition:address.position,seed});
    assert.equal(found.id,d.id);assert.equal(found.visibility,1);assert.equal(found.theme,d.theme);
    assert.deepEqual(found.center,distantLandmarkCenter(d,address.sectorIndex,address.position));
    assert.ok(address.position.every(n=>Number.isFinite(n)&&Math.abs(n)<=CELL_SIZE/2));
  }
});

test('landmark support is disjoint, fades continuously and leaves long empty intervals',()=>{
  assert.ok(2*.44<1-.06);
  const d=population[0].descriptor,address=distantLandmarkAddress(d),anchor=distantLandmarkCenter(d,address.sectorIndex);
  let previous=1,seenEmpty=false;
  for(let i=0;i<=200;i++){
    const offset=LANDMARK_GRID_SIZE*(.34+i*.12/200);
    const found=sampleDistantLandmark({sectorIndex:address.sectorIndex,cameraPosition:anchor.map((n,axis)=>n+(axis===0?offset:0)),seed});
    const visibility=found?.visibility??0;
    if(found)assert.equal(found.id,d.id,'a visible contributor never swaps');
    assert.ok(visibility<=previous+1e-10);assert.ok(previous-visibility<.025);
    previous=visibility;seenEmpty ||= found===null;
  }
  assert.ok(seenEmpty);assert.equal(previous,0);
});

test('perspective and theme are rebase-equivalent across all axes and the signed world seam',()=>{
  for(const axis of axes)for(const boundary of [0,LANDMARK_GRID_CELLS,16384]){
    const before={x:0,y:0,z:0,[axis]:wrapCell(boundary-1)},after={...before,[axis]:wrapCell(boundary)};
    const a=[0,0,0],b=[0,0,0],i=axes.indexOf(axis);a[i]=CELL_SIZE/2;b[i]=-CELL_SIZE/2;
    assert.deepEqual(sampleDistantLandmark({sectorIndex:encodeCell(before),cameraPosition:a,seed}),sampleDistantLandmark({sectorIndex:encodeCell(after),cameraPosition:b,seed}));
  }
  for(const {descriptor:d} of population.slice(0,20)){
    const address=distantLandmarkAddress(d),cell=decodeCell(address.sectorIndex);
    for(let i=0;i<3;i++){
      const neighbor={...cell,[axes[i]]:wrapCell(cell[axes[i]]+1)},position=[...address.position];position[i]-=CELL_SIZE;
      assert.deepEqual(sampleDistantLandmark({sectorIndex:address.sectorIndex,cameraPosition:address.position,seed}),sampleDistantLandmark({sectorIndex:encodeCell(neighbor),cameraPosition:position,seed}));
    }
  }
});


test('generation rejects malformed addresses and seeds without depending on existing body data',()=>{
  for(const coordinate of [null,{}, {x:0,y:0,z:.1}, {x:Infinity,y:0,z:0}])assert.throws(()=>describeDistantLandmark(coordinate,seed),TypeError);
  assert.throws(()=>describeDistantLandmark({x:0,y:0,z:0},123),TypeError);
  for(const cameraPosition of [null,[0,0],[0,NaN,0]])assert.throws(()=>sampleDistantLandmark({sectorIndex:0,cameraPosition,seed}),TypeError);
  assert.throws(()=>sampleDistantLandmark({sectorIndex:-1,seed}),RangeError);
  for(const {coordinate,descriptor} of population.slice(0,20))assert.notDeepEqual(descriptor,describeDistantLandmark(coordinate,'another-universe'));
});
