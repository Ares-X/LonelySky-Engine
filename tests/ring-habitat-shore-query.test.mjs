import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRetainedShoreline} from '../src/ring-habitat-field.js';
import {randomFromSeed} from '../src/random.js';

// Actual retained source patches, including vertical and multi-arc coastlines.
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/ring-habitat-shore-shared-events.json',import.meta.url)));

// Exhaustive geometric oracle has no index, ring termination or nearest-value
// rejection. Project in normalized segment-length coordinates independently.
function fullDistance(shore,x,y){
  let nearest=Infinity;
  for(const {a,b} of shore.segments){
    const ax=a[0]*shore.metric,ay=a[1],vx=(b[0]-a[0])*shore.metric,vy=b[1]-a[1],length=Math.hypot(vx,vy),ux=vx/length,uy=vy/length;
    const along=Math.max(0,Math.min(length,(x*shore.metric-ax)*ux+(y-ay)*uy));
    nearest=Math.min(nearest,Math.hypot(x*shore.metric-(ax+along*ux),y-(ay+along*uy)));
  }
  return nearest;
}

test('indexed shore nearest distance agrees with complete geometry inside and outside its index',()=>{
  const random=randomFromSeed('shore-distance-complete-geometry-v1'),out={};
  for(const fixture of fixtures){
    const shore=createRetainedShoreline(fixture.patch,fixture.options),points=[[0,0],[shore.width,shore.height],[-1024,shore.height/2],[shore.width+1024,-1024]];
    for(let i=0;i<128;i++)points.push([(random()*1.6-.3)*shore.width,(random()*1.6-.3)*shore.height]);
    for(const n of [-655360000,655360000,-1e100,1e100,-1e200,1e200,-1e300,1e300])points.push([n,shore.height/2],[shore.width/2,n],[n,-n]);
    for(const [x,y] of points){
      assert.equal(shore.query(x,y,out),out);
      const expected=fullDistance(shore,x,y),tolerance=1e-8+32*Number.EPSILON*expected;
      assert.ok(Number.isFinite(out.distance));assert.ok(Math.abs(Math.abs(out.distance)-expected)<=tolerance,fixture.kind+' complete nearest distance');
      assert.ok(Number.isFinite(out.closestX)&&Number.isFinite(out.closestY));
    }
  }
});

test('actual exterior witnesses retain precise distances, nearest points and strict shore ties',()=>{
  const expected=[
    {distance:-4636.306415250072,closestX:2248.992413065211,closestY:5784.8078970940605},
    {distance:-10361.026692355132,closestX:7363.523218641281,closestY:9473.240696592742},
  ],out={};
  for(let i=0;i<fixtures.length;i++){
    const fixture=fixtures[i],shore=createRetainedShoreline(fixture.patch,fixture.options);
    shore.query(fixture.point.x,fixture.point.y,out);assert.equal(out.inside,false);
    for(const key of ['distance','closestX','closestY'])assert.equal(out[key],expected[i][key],fixture.kind+' '+key);
    // Neighboring segments share endpoints: a zero-distance tie must retain
    // the queried endpoint and the existing signed-zero/parity contract.
    for(const point of [shore.segments[0].a,shore.segments[0].b]){
      shore.query(point[0],point[1],out);assert.equal(out.closestX,point[0]);assert.equal(out.closestY,point[1]);assert.equal(out.distance,out.inside?0:-0);
    }
  }
});
