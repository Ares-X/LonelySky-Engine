import test from 'node:test';
import assert from 'node:assert/strict';
import {createSolidWorkspace,solidDistance,sweepSolid} from '../src/solid-geometry.js';
import {cosmicRingParts} from '../src/cosmic-bodies.js';
import {buildTerrainMesh} from '../src/mesh-terrain.js';
import {createRingHabitat} from '../src/ring-habitat.js';

const near=(a,b,e=1e-7)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);
function box(center,half){
  const vertices=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(v=>v.map((x,i)=>x*half[i]));
  return {center,radius:Math.hypot(...half),vertices,normals:vertices.map(v=>{const r=Math.hypot(...v);return v.map(x=>x/r);}),faces:[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]],planes:[[1,0,0,half[0]],[-1,0,0,half[0]],[0,1,0,half[1]],[0,-1,0,half[1]],[0,0,1,half[2]],[0,0,-1,half[2]]]};
}
const cluster=body=>buildTerrainMesh(body);
function fixture(){return {position:[0,0,0],boundsRadius:130,shape:{type:'compound',parts:[{type:'annular-sector-slab',innerRadius:100,outerRadius:120,minY:-20,maxY:20,gapCenter:0,gapHalfAngle:0}],terrainGroups:[cluster(box([98,0,0],[10,5,8]))]}};}
function sweep(s,start,end,radius=2,options){const w=createSolidWorkspace();return sweepSolid(s,start,end,radius,options,w.result,w);}

test('terrain/core union blocks the exposed solid first and keeps the outer core nearest',()=>{
  const s=fixture(),inside=sweep(s,[0,0,0],[150,0,0]),outside=sweep(s,[150,0,0],[0,0,0]);
  assert.equal(inside.status,'hit',inside.reason);near(inside.fraction,86/150);assert.equal(inside.part,1);near(inside.normal[0],-1);
  assert.equal(outside.status,'hit',outside.reason);near(outside.fraction,28/150);assert.equal(outside.part,0);
  near(solidDistance(s,[102,0,0]).distance,-5);
  const safe=[150*inside.safeFraction,0,0];assert.ok(solidDistance(s,safe).distance>=2-1e-8);
});

test('high speed closed-mesh crossings, finite rounded corners and departed tangencies use actual finite geometry',()=>{
  const hull=box([0,0,0],[10,5,8]),s={position:[0,0,0],boundsRadius:20,shape:{type:'compound',parts:[],terrainGroups:[cluster(hull)]}};
  const crossing=sweep(s,[-1e7,0,0],[1e7,0,0]);assert.equal(crossing.status,'hit',crossing.reason);near(crossing.fraction,(1e7-12)/2e7,1e-12);
  assert.equal(sweep(s,[-30,7,0],[30,7,0]).status,'clear');
  assert.equal(sweep(s,[-12,0,0],[-20,0,0]).status,'clear');
  assert.equal(sweep(s,[-30,6,9],[30,6,9]).status,'hit');
  assert.equal(sweep(s,[-30,6.5,9.5],[30,6.5,9.5]).status,'clear','rounded edge is not an inflated box');
});

test('terrain normals share the compound frame and distant culling preserves part indices',()=>{
  const s=fixture(),remote=cluster(box([-500,0,0],[10,10,10]));s.shape.terrainGroups.unshift(remote);
  s.frame=[0,0,-1,0,1,0,1,0,0];s.position=[1e8,-2e8,3e8];s.boundsRadius=600;
  const world=p=>[s.position[0]-p[2],s.position[1]+p[1],s.position[2]+p[0]];
  const hit=sweep(s,world([0,0,0]),world([150,0,0]));assert.equal(hit.status,'hit',hit.reason);assert.equal(hit.part,2);near(hit.fraction,86/150,1e-8);near(hit.normal[2],-1);
});

test('generated mountain summit is collidable before the unraised habitat floor',()=>{
  const options={radius:900000,halfWidth:.022,thickness:.0005,phase:1.3,broken:false,theme:'silver-dust',seed:'habitat-fixture'};
  const parts=cosmicRingParts(options),habitat=createRingHabitat({...options,parts});
  assert.ok(habitat.terrainGroups.length>0);
  const s={position:[0,0,0],boundsRadius:1000000,shape:{type:'compound',parts,terrainGroups:habitat.terrainGroups}};
  let tested=0;
  outer:for(const hull of s.shape.terrainGroups){
    const peak=hull.vertices.reduce((a,b)=>Math.hypot(hull.center[0]+a[0],hull.center[2]+a[2])<Math.hypot(hull.center[0]+b[0],hull.center[2]+b[2])?a:b);
    const p=peak.map((n,i)=>n+hull.center[i]),r=Math.hypot(p[0],p[2]),up=[-p[0]/r,0,-p[2]/r],start=p.map((n,i)=>n+up[i]*200),end=p.map((n,i)=>n-up[i]*200);
    if(solidDistance(s,start).distance<8)continue;
    const hit=sweep(s,start,end,7);assert.equal(hit.status,'hit',hit.reason);assert.ok(hit.part>=s.shape.parts.length);tested++;if(tested===4)break outer;
  }
  assert.ok(tested>=4);
});
