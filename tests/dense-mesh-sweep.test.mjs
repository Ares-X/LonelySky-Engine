import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTerrainMesh} from '../src/mesh-terrain.js';
import {createSolidWorkspace,solidDistance,sweepSolid} from '../src/solid-geometry.js';

// A closed, outward-wound subdivided box. Subdivision adds surface features,
// while its physical boundary stays exactly the analytic [-half,half]^3 box.
function subdividedBox(half=4,divisions=32){
  const vertices=[],faces=[],lookup=new Map();
  function vertex(fixedAxis,side,uAxis,vAxis,i,j){
    const grid=[0,0,0];grid[fixedAxis]=side*divisions;grid[uAxis]=-divisions+2*i;grid[vAxis]=-divisions+2*j;
    const key=grid.join(',');let index=lookup.get(key);
    if(index===undefined){index=vertices.length;lookup.set(key,index);vertices.push(grid.map(value=>half*value/divisions));}
    return index;
  }
  for(const[fixedAxis,side,uAxis,vAxis]of[[0,1,1,2],[0,-1,2,1],[1,1,2,0],[1,-1,0,2],[2,1,0,1],[2,-1,1,0]]){
    for(let j=0;j<divisions;j++)for(let i=0;i<divisions;i++){
      const a=vertex(fixedAxis,side,uAxis,vAxis,i,j),b=vertex(fixedAxis,side,uAxis,vAxis,i+1,j),c=vertex(fixedAxis,side,uAxis,vAxis,i+1,j+1),d=vertex(fixedAxis,side,uAxis,vAxis,i,j+1);
      faces.push([a,b,c],[a,c,d]);
    }
  }
  const normals=vertices.map(point=>{const length=Math.hypot(...point);return point.map(value=>value/length);});
  return buildTerrainMesh({center:[0,0,0],radius:half*Math.sqrt(3),vertices,faces,normals});
}
const half=4,craftRadius=7,span=28,mesh=subdividedBox(half),shape={type:'compound',parts:[],terrainGroups:[mesh]};

function crossing(position){
  const solid={position,boundsRadius:mesh.radius,shape},start=[position[0]-span,position[1],position[2]],end=[position[0]+span,position[1],position[2]],workspace=createSolidWorkspace();
  const hit=sweepSolid(solid,start,end,craftRadius,{maxIterations:256},workspace.result,workspace);
  assert.equal(hit.status,'hit',hit.reason);
  assert.equal(workspace.sweepSolid,null,'completed queries release their temporary body reference');
  // Sphere first touches the unchanged left box face at x=-half-craftRadius.
  const expected=(span-half-craftRadius)/(2*span);
  assert.ok(Math.abs(hit.fraction-expected)<1e-12,`${hit.fraction} != analytic box TOI ${expected}`);
  assert.ok(Math.abs(hit.normal[0]+1)<1e-10);
  assert.ok(Math.hypot(hit.normal[1],hit.normal[2])<1e-10);
  const safe=[start[0]+2*span*hit.safeFraction,start[1],start[2]];
  assert.ok(solidDistance(solid,safe).distance>=craftRadius-1e-8);
  return {fraction:hit.fraction,safeFraction:hit.safeFraction};
}

test('a sphere crosses a densely subdivided closed box at the analytic Minkowski TOI within256 roots',()=>{
  crossing([0,0,0]);
});

test('dense-box first contact and verified safe point retain translated-frame equivalence',()=>{
  const translated=crossing([1e6,-2e6,3e6]),local=crossing([0,0,0]);
  assert.ok(Math.abs(translated.fraction-local.fraction)<1e-12);
  assert.ok(Math.abs(translated.safeFraction-local.safeFraction)<1e-12);
});

test('a sphere passing strictly outside the rounded box support remains clear',()=>{
  const solid={position:[0,0,0],boundsRadius:mesh.radius,shape};
  const result=sweepSolid(solid,[-span,half+craftRadius+.01,0],[span,half+craftRadius+.01,0],craftRadius,{maxIterations:256});
  assert.equal(result.status,'clear',result.reason);
  assert.equal(result.fraction,1);
});

test('a root-budget failure releases the temporary body reference without reporting a safe crossing',()=>{
  const solid={position:[0,0,0],boundsRadius:mesh.radius,shape},workspace=createSolidWorkspace();
  const result=sweepSolid(solid,[-span,0,0],[span,0,0],craftRadius,{maxIterations:1},workspace.result,workspace);
  assert.equal(result.status,'failed');
  assert.equal(result.reason,'solid-root-budget');
  assert.equal(workspace.sweepSolid,null);
});
