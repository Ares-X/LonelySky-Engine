import test from 'node:test';
import assert from 'node:assert/strict';
import {RING_HABITAT_SURFACE_GLSL} from '../../src/render/ring-habitat-surface.js';

const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
const subtract=(a,b)=>a.map((n,i)=>n-b[i]);
const normalize=a=>{const size=Math.hypot(...a);return a.map(n=>n/size);};
const reflect=(ray,normal)=>ray.map((n,i)=>n-2*dot(ray,normal)*normal[i]);
const near=(a,b)=>a.forEach((n,i)=>assert.ok(Math.abs(n-b[i])<1e-12,`${a} != ${b}`));

// Execute the actual material's water-normal expression with vector arithmetic.
// Passing both normal inputs lets the behavior checks detect an accidental
// return to interpolated land normals without asserting shader wording.
const expression=RING_HABITAT_SURFACE_GLSL.match(/vec3 waterNormal=([^;]+);/)?.[1];
assert.ok(expression,'water material publishes its optical normal');
const waterNormal=Function('normalize','subtract',`return function(geometricNormal,shadingNormal,waterGradient){return ${expression.replace(/\b(geometricNormal|shadingNormal)\s*-\s*waterGradient\b/g,'subtract($1,waterGradient)')};}`)(normalize,subtract);

test('marine coast coverage follows physical height instead of a separate continental mask',()=>{
  const materialExpression=name=>{
    const value=RING_HABITAT_SURFACE_GLSL.match(new RegExp(`float ${name}=([^;]+);`))?.[1];
    assert.ok(value,`material expression ${name}`);return value;
  };
  const height=Function('groundRadius','radius','uBodyRadius','max',`return ${materialExpression('actualHeight')};`);
  const coverage=Function('actualHeight','heightAA','smoothstep',`return ${materialExpression('hillLand')};`);
  const land=Function('uHabitatClimate','hillLand','macroLand',`return ${materialExpression('land')};`);
  const beach=Function('uHabitatClimate','hillLand','actualHeight','smoothstep',`return ${materialExpression('beach')};`);
  const smoothstep=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
  const radius=1e6,ground=.9995;
  for(const climate of [0,1,3])for(const macro of [0,.5,1]){
    const sea=height(ground,ground,radius,Math.max),island=height(ground,ground-100/radius,radius,Math.max);
    const seaCoverage=coverage(sea,1,smoothstep),islandCoverage=coverage(island,1,smoothstep);
    assert.equal(land(climate,seaCoverage,macro),0,'a flat core cannot become a painted island');
    assert.equal(beach(climate,seaCoverage,sea,smoothstep),0,'no shoreline exists without physical land');
    assert.equal(land(climate,islandCoverage,macro),1,'actual raised terrain stays land in every marine theme');
  }
  assert.equal(land(2,0,0),1,'the old-gold desert remains a dry physical deck');
  assert.equal(beach(2,.5,8,smoothstep),0,'the dry theme has no marine beach');
  const tide=coverage(7,1,smoothstep);assert.ok(tide>0&&tide<1,'a resolved tidal margin blends continuously');
});

// V4 frozen forest-close image, pixel (316,572). This is a nearly level
// submerged top triangle: the neighbouring mountain's averaged lighting normal
// has a different slope. The saved noise gradient is deliberately unchanged.
const observed={
  geometric:[.49204809501858027,0,.8705680169800556],
  land:[.5084338368795854,.018914641003902784,.860893297611032],
  gradient:[.0013371425549564171,-.01658940658894595,-.0007564272180702114],
  ray:[.6674374938011169,.5935184955596924,-.4497365355491638],
};

test('a real shallow water reflection remains above its triangle when nearby land lighting normals tilt',()=>{
  const {geometric,land,gradient,ray}=observed;
  const oldNormal=normalize(subtract(land,gradient));
  assert.ok(-dot(oldNormal,ray)>0,'the original fault does not require a back-facing normal');
  assert.ok(dot(reflect(ray,oldNormal),geometric)<-.007,'fixture exercises the original below-ground reflection');
  const actual=waterNormal(geometric,land,gradient);
  assert.ok(-dot(actual,ray)>0);
  assert.ok(dot(reflect(ray,actual),geometric)>.04,'same wave slopes reflect into the real optical column');
  assert.ok(Math.acos(dot(actual,geometric))>.01,'resolved wave relief remains present');
});

test('water reflection ignores unrelated smooth land normals and retains directional wave response',()=>{
  const geometric=[0,1,0],gradient=[.01,0,.02],ray=normalize([.8,-.2,.6]);
  const normal=waterNormal(geometric,geometric,gradient);
  for(const land of [[0,1,0],normalize([.8,.1,.6]),normalize([-.6,.4,-.7])]){
    near(waterNormal(geometric,land,gradient),normal);
    near(reflect(ray,waterNormal(geometric,land,gradient)),reflect(ray,normal));
  }
  const other=waterNormal(geometric,geometric,gradient.map(n=>-n));
  assert.ok(Math.hypot(...subtract(reflect(ray,normal),reflect(ray,other)))>.05,'changing wave direction still changes the reflection');
  near(waterNormal(geometric,observed.land,[0,0,0]),geometric);
});

test('the optical normal and reflection follow the actual water plane under body-frame rotation',()=>{
  const rotate=([x,y,z])=>[z,-x,-y];
  const {geometric,land,gradient,ray}=observed;
  const normal=waterNormal(geometric,land,gradient);
  const rotated=waterNormal(rotate(geometric),rotate(land),rotate(gradient));
  near(rotated,rotate(normal));
  near(reflect(rotate(ray),rotated),rotate(reflect(ray,normal)));
});
