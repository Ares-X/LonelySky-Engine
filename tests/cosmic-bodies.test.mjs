import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {CELL_SIZE,encodeCell,decodeCell,wrapCell} from '../src/coordinates.js';
import {describeCosmicBody,cosmicBodyCenter,cosmicBodyAddress,cosmicSolidsInBounds,cosmicRingParts,COSMIC_BODY_THEME_WEIGHTS} from '../src/cosmic-bodies.js';
import {solidDistance} from '../src/solid-geometry.js';

const seed='body-fixture',axes=['x','y','z'];
const fixtures=[
  [{x:-32,y:-32,z:-16},'dark-world',940356.6195978783],
  [{x:-30,y:5,z:-19},'gas-giant',660908.4770199843],
  [{x:-29,y:-12,z:14},'ring',1178470.0957126915],
  [{x:-29,y:5,z:-16},'stellar-giant',602314.6495921537],
];

test('published primary candidates keep independent fixed identities and dimensions',()=>{
  for(const [coordinate,kind,radius] of fixtures){
    const first=describeCosmicBody(coordinate,seed);
    assert.equal(first.kind,kind);assert.equal(first.radius,radius);
    assert.equal(first.id,`cosmic-body-v3:${axes.map(axis=>coordinate[axis])}`);
    assert.ok(Object.isFrozen(first)&&Object.isFrozen(first.shape));
    describeCosmicBody({x:3,y:-4,z:7},seed+'-unrelated');
    assert.deepEqual(describeCosmicBody(coordinate,seed),first);
    assert.deepEqual(describeCosmicBody({x:coordinate.x+64,y:coordinate.y-64,z:coordinate.z+128},seed),first);
  }
  for(const weights of Object.values(COSMIC_BODY_THEME_WEIGHTS))assert.ok(Object.isFrozen(weights));
  assert.equal(COSMIC_BODY_THEME_WEIGHTS['blue-nursery'][0],0,'giant rings are not injected into every theme');
  assert.equal(COSMIC_BODY_THEME_WEIGHTS['cold-void'][0],0);
});

test('physical queries retain near surfaces with remote centres at cell and world seams',()=>{
  for(const [coordinate] of fixtures){
    const body=describeCosmicBody(coordinate,seed),address=cosmicBodyAddress(body);
    const center=cosmicBodyCenter(body,address.sectorIndex),offset=address.position.map((n,i)=>n-center[i]),length=Math.hypot(...offset);
    const point=body.kind==='ring'?address.position:center.map((n,i)=>n+offset[i]/length*(body.radius+10));
    const bounds={min:point.map(n=>n-20),max:point.map(n=>n+20)};
    const queried=cosmicSolidsInBounds({sectorIndex:address.sectorIndex,bounds,seed});
    assert.equal(queried.filter(value=>value.id===body.id).length,1);
    const solid=queried.find(value=>value.id===body.id);
    assert.deepEqual(solid.position,center);assert.deepEqual(solid.shape,body.shape);
    const cell=decodeCell(address.sectorIndex),next=encodeCell({...cell,x:wrapCell(cell.x+1)});
    const relative=cosmicBodyCenter(body,next);
    relative.forEach((n,i)=>assert.ok(Math.abs(n-(center[i]-(i===0?CELL_SIZE:0)))<1e-6));
    if(body.kind==='ring')assert.ok(Math.abs(solidDistance(solid,address.position).distance-200)<1e-6);
    else assert.ok(solidDistance(solid,address.position).distance>body.radius*.4);
  }
});

test('ring collision sections share conservative dimensions and an actually empty centre',()=>{
  const body=describeCosmicBody(fixtures[2][0],seed);
  assert.ok(body.shape.parts.length>6,'physical structure extends the original six core sections');
  assert.ok(body.shape.parts.length<=64,'one shared CPU/shader section budget');
  for(const part of body.shape.parts){
    assert.ok(Math.hypot(part.outerRadius,Math.max(Math.abs(part.minY),Math.abs(part.maxY)))<=body.boundsRadius);
    assert.ok(Object.isFrozen(part));
  }
  const solid={...body,position:[0,0,0]};
  assert.ok(solidDistance(solid,[0,0,0]).distance>body.radius*.99);
  for(const change of [{radius:0},{radius:Infinity},{halfWidth:0},{thickness:1},{phase:NaN},{broken:'yes'}]){
    assert.throws(()=>cosmicRingParts({radius:1e6,halfWidth:.02,thickness:.0005,phase:0,broken:false,...change}),RangeError);
  }
  assert.throws(()=>cosmicSolidsInBounds({sectorIndex:0,bounds:{min:[1,0,0],max:[0,0,0]},seed}),RangeError);
});

test('regional habitat recipes preserve published macro placement and the legacy default',()=>{
  for(const [coordinate] of fixtures){
    const legacy=describeCosmicBody(coordinate,seed),regional=describeCosmicBody(coordinate,seed,'regions');
    assert.strictEqual(describeCosmicBody(coordinate,seed,'legacy'),legacy);
    for(const key of ['id','revision','kind','theme','galaxyId','cell','offset','frame','radius','halfWidth','thickness','phase','broken','boundsRadius','prominences','tint','placementClearance','light','ringed'])
      assert.deepEqual(regional[key],legacy[key],key);
    if(legacy.kind!=='ring'){assert.deepEqual(regional,legacy);continue;}
    assert.deepEqual(regional.shape.parts,legacy.shape.parts);
    assert.equal(createHash('sha256').update(JSON.stringify(regional.habitat)).digest('hex'),'3b49b47360e8fcc38be7611fe8383dd15cfcc17cb59bbf32df0847828c42488a','shoulder structure does not reseed or change the landscape recipe');
    assert.ok(legacy.shape.terrainGroups.length>0);
    assert.deepEqual(regional.shape.terrainGroups,[],'canonical fine solids come from the region registry, without the old collision roof');
    assert.equal(regional.habitat.terrainRecipes.length,legacy.shape.terrainGroups.length);
    assert.deepEqual(regional.habitat.ecology,legacy.habitat.ecology);
    assert.equal(regional.habitat.climate,legacy.habitat.climate);
    for(const recipe of regional.habitat.terrainRecipes){
      assert.ok(Object.isFrozen(recipe)&&Object.isFrozen(recipe.sources));
      assert.equal(recipe.version,'halo-field-v1');assert.equal(recipe.lengthUnit,'L');
      assert.equal('faces' in recipe,false);assert.equal('vertices' in recipe,false);
    }
    assert.equal('terrainRecipes' in legacy.habitat,false);
    assert.strictEqual(describeCosmicBody(coordinate,seed,'regions'),regional);
  }
});

test('regional physical queries forward the canonical mode across a sector seam',()=>{
  const body=describeCosmicBody(fixtures[2][0],seed,'regions'),address=cosmicBodyAddress(body);
  const cell=decodeCell(address.sectorIndex);
  for(const sectorIndex of [address.sectorIndex,encodeCell({...cell,x:wrapCell(cell.x+1)})]){
    const center=cosmicBodyCenter(body,sectorIndex);
    const queried=cosmicSolidsInBounds({sectorIndex,bounds:{min:center.map(n=>n-2),max:center.map(n=>n+2)},seed,terrainMode:'regions'});
    const actual=queried.find(candidate=>candidate.id===body.id);
    assert.ok(actual);assert.deepEqual(actual.position,center);
    assert.strictEqual(actual.shape,body.shape);assert.strictEqual(actual.habitat,body.habitat);
  }
  assert.throws(()=>describeCosmicBody(fixtures[2][0],seed,'camera-window'),/Unknown habitat terrain/);
  assert.throws(()=>cosmicSolidsInBounds({sectorIndex:0,bounds:{min:[0,0,0],max:[1,1,1]},seed,terrainMode:'camera-window'}),/Unknown habitat terrain/);
});

test('borrowed cosmic queries reuse records and match independent snapshots in both terrain modes',async()=>{
  const {createCosmicSolidQueryWorkspace,cosmicSolidsInBoundsInto,disposeCosmicSolidQueryWorkspace,COSMIC_BODY_RENDER_RANGE}=await import('../src/cosmic-bodies.js');
  for(const terrainMode of ['legacy','regions']){
    const body=describeCosmicBody(fixtures[2][0],seed,terrainMode),address=cosmicBodyAddress(body),center=cosmicBodyCenter(body,address.sectorIndex);
    const options={sectorIndex:address.sectorIndex,bounds:{min:center.map(n=>n-2),max:center.map(n=>n+2)},seed,terrainMode},w=createCosmicSolidQueryWorkspace();
    const snapshot=cosmicSolidsInBounds(options),first=cosmicSolidsInBoundsInto(options,w),record=first[0],position=record.position,seen=w.seen,coordinate=w.coordinate,cell=w.cell;
    assert.deepEqual(first,snapshot);assert.notEqual(first,snapshot);assert.notEqual(record,snapshot[0]);assert.notEqual(position,snapshot[0].position);
    for(let i=0;i<1000;i++){assert.strictEqual(cosmicSolidsInBoundsInto(options,w),first);assert.strictEqual(first[0],record);assert.strictEqual(record.position,position);}
    assert.strictEqual(w.seen,seen);assert.strictEqual(w.coordinate,coordinate);assert.strictEqual(w.cell,cell);assert.equal(w.records.length,512);
    const old=snapshot[0].position.slice(),next=encodeCell({...decodeCell(options.sectorIndex),x:wrapCell(decodeCell(options.sectorIndex).x+1)});
    options.sectorIndex=next;options.bounds={min:center.map((n,i)=>n-(i===0?CELL_SIZE:0)-2),max:center.map((n,i)=>n-(i===0?CELL_SIZE:0)+2)};
    cosmicSolidsInBoundsInto(options,w);assert.equal(position[0],old[0]-CELL_SIZE);assert.deepEqual(snapshot[0].position,old);
    options.bounds={min:center.map(n=>n-COSMIC_BODY_RENDER_RANGE),max:center.map(n=>n+COSMIC_BODY_RENDER_RANGE)};
    assert.deepEqual(cosmicSolidsInBoundsInto(options,w),cosmicSolidsInBounds(options),'full existing render range fits fixed traversal capacity');
    disposeCosmicSolidQueryWorkspace(w);assert.equal(first.length,0);assert.equal(w.records.length,0);assert.equal(seen.size,0);assert.throws(()=>cosmicSolidsInBoundsInto(options,w),/disposed/);
  }
});

test('independent cosmic workspaces survive interleaved sectors and fail capacity before partial output',async()=>{
  const {createCosmicSolidQueryWorkspace,cosmicSolidsInBoundsInto,disposeCosmicSolidQueryWorkspace}=await import('../src/cosmic-bodies.js');
  const body=describeCosmicBody(fixtures[0][0],seed,'regions'),address=cosmicBodyAddress(body),center=cosmicBodyCenter(body,address.sectorIndex),bounds={min:center.map(n=>n-2),max:center.map(n=>n+2)},options={sectorIndex:address.sectorIndex,bounds,seed,terrainMode:'regions'},a=createCosmicSolidQueryWorkspace(),b=createCosmicSolidQueryWorkspace();
  const first=cosmicSolidsInBoundsInto(options,a),record=first[0],position=record.position.slice();
  const next=encodeCell({...decodeCell(address.sectorIndex),y:wrapCell(decodeCell(address.sectorIndex).y+1)}),other={...options,sectorIndex:next,bounds:{min:bounds.min.map((n,i)=>n-(i===1?CELL_SIZE:0)),max:bounds.max.map((n,i)=>n-(i===1?CELL_SIZE:0))}};
  const second=cosmicSolidsInBoundsInto(other,b);assert.notEqual(record,second[0]);assert.notEqual(record.position,second[0].position);assert.deepEqual(record.position,position);assert.equal(second[0].position[1],position[1]-CELL_SIZE);
  assert.throws(()=>cosmicSolidsInBoundsInto({...options,seed:123,bounds:{min:[-1e8,-1e8,-1e8],max:[1e8,1e8,1e8]}},a),/capacity/);assert.equal(first.length,0);assert.deepEqual(record.position,position);assert.equal(second.length,1);
  assert.deepEqual(cosmicSolidsInBoundsInto(options,a),cosmicSolidsInBounds(options),'a capacity failure does not poison a reusable query');
  for(const capacity of [0,-1,513,NaN])assert.throws(()=>createCosmicSolidQueryWorkspace(capacity),RangeError);
  disposeCosmicSolidQueryWorkspace(a);disposeCosmicSolidQueryWorkspace(b);
});
