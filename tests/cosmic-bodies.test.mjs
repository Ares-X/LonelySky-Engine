import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(body.shape.parts.length,6);
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
