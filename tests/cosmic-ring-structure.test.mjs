import test from 'node:test';
import assert from 'node:assert/strict';
import {cosmicRingParts,describeCosmicBody} from '../src/cosmic-bodies.js';
import {createSolidWorkspace,solidDistance,sweepSolid} from '../src/solid-geometry.js';

const dimensions={radius:1000000,halfWidth:.02,thickness:.0005,phase:.37,broken:false};
const polar=(radius,angle,y=0)=>[radius*Math.cos(angle),y,radius*Math.sin(angle)];
const close=(actual,expected,tolerance=1e-6)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
function ring(overrides={}){
  const parameters={...dimensions,...overrides},parts=cosmicRingParts(parameters);
  return {position:[0,0,0],shape:{type:'compound',parts},
    boundsRadius:Math.max(...parts.map(part=>Math.hypot(part.outerRadius,Math.max(Math.abs(part.minY),Math.abs(part.maxY)))))};
}

test('raised exterior has actual finite walls, edges and continuous sphere contacts',()=>{
  const solid=ring(),part=solid.shape.parts[10],angle=part.gapCenter-Math.PI;
  assert.equal(solid.shape.parts.length,59);
  const face=solidDistance(solid,polar(part.outerRadius+37,angle));
  close(face.distance,37);assert.equal(face.part,10);assert.equal(face.feature,'outer');
  const corner=solidDistance(solid,polar(part.outerRadius+30,angle,part.maxY+40));
  close(corner.distance,50);assert.equal(corner.part,10);assert.equal(corner.feature,'outer-top');
  close(corner.normal[1],.8);
  const start=polar(part.outerRadius+1000,angle),end=polar(part.outerRadius-100,angle);
  const workspace=createSolidWorkspace(),result=sweepSolid(solid,start,end,8,{},undefined,workspace);
  assert.equal(result.status,'hit');assert.equal(result.part,10);assert.equal(result.feature,'outer');
  close(result.fraction,(1000-8)/1100,1e-8);
  const safe=start.map((value,index)=>value+(end[index]-value)*result.safeFraction);
  assert.ok(solidDistance(solid,safe).distance>=8-1e-8);
  // Reusing a collision workspace retains its grown storage on later sweeps.
  const candidates=workspace.candidates;
  sweepSolid(solid,start,end,8,{},undefined,workspace);
  assert.equal(workspace.candidates,candidates);
});

test('main spine is deep attached geometry and its supporting spans vary in width and reach',()=>{
  const solid=ring(),spine=solid.shape.parts.at(-1),{radius,thickness,halfWidth,phase}=dimensions;
  const t=radius*thickness,w=radius*halfWidth;
  close(spine.outerRadius-radius,6*t);close(spine.maxY-spine.minY,.32*w);
  assert.ok(spine.innerRadius<solid.shape.parts[5].outerRadius);
  const face=solidDistance(solid,polar(spine.outerRadius+19,phase));
  close(face.distance,19);assert.equal(face.part,58);
  const hit=sweepSolid(solid,polar(spine.outerRadius+1000,phase),polar(spine.outerRadius-300,phase),8);
  assert.equal(hit.status,'hit');assert.equal(hit.part,58);close(hit.fraction,992/1300,1e-8);
  const supports=solid.shape.parts.slice(10,34);
  const widths=supports.map(part=>(Math.PI-part.gapHalfAngle)*radius*2);
  const reaches=supports.map(part=>(part.outerRadius-radius)/t);
  for(let index=0;index<supports.length;index++){
    assert.ok(widths[index]>=6000&&widths[index]<=12000);
    assert.ok(reaches[index]>=5.5&&reaches[index]<=8.5);
    close(solid.shape.parts[34+index].outerRadius-supports[index].outerRadius,60);
  }
  assert.ok(Math.max(...widths)-Math.min(...widths)>5000);
  assert.ok(Math.max(...reaches)-Math.min(...reaches)>2.5);
});

test('a close-range cabinet has sixty units of solid relief above its attached support',()=>{
  const solid=ring(),support=solid.shape.parts[10],cabinet=solid.shape.parts[34];
  const angle=cabinet.gapCenter-Math.PI,y=(cabinet.minY+cabinet.maxY)/2;
  close(cabinet.outerRadius-support.outerRadius,60);
  close(cabinet.maxY-cabinet.minY,1000);
  close((Math.PI-cabinet.gapHalfAngle)*dimensions.radius*2,420);
  assert.ok(cabinet.innerRadius<support.outerRadius,'cabinet is attached, with radial overlap');
  const face=solidDistance(solid,polar(cabinet.outerRadius+17,angle,y));
  close(face.distance,17);assert.equal(face.part,34);
  const topEdge=solidDistance(solid,polar(cabinet.outerRadius+30,angle,cabinet.maxY+40));
  close(topEdge.distance,50);assert.equal(topEdge.part,34);assert.equal(topEdge.feature,'outer-top');
  const start=polar(cabinet.outerRadius+180,angle,y),end=polar(support.outerRadius+20,angle,y);
  const hit=sweepSolid(solid,start,end,8);
  assert.equal(hit.status,'hit');assert.equal(hit.part,34);assert.equal(hit.feature,'outer');
  close(hit.fraction,172/220,1e-8);
  // Past the cabinet top the same radial space remains open over the support.
  assert.equal(sweepSolid(solid,polar(cabinet.outerRadius+180,angle,cabinet.maxY+25),
    polar(support.outerRadius+20,angle,cabinet.maxY+25),8).status,'clear');
});

test('ledges collide between buttresses while open angular space above them remains open',()=>{
  const solid=ring(),angle=dimensions.phase,rail=solid.shape.parts[8];
  const ledge=solidDistance(solid,polar(rail.outerRadius+30,angle,(rail.minY+rail.maxY)/2));
  close(ledge.distance,30);assert.equal(ledge.part,8);
  const result=sweepSolid(solid,polar(rail.outerRadius+100,angle,rail.maxY+25),
    polar(dimensions.radius*(1+dimensions.thickness)+20,angle,rail.maxY+25),8);
  assert.equal(result.status,'clear','a rail must not inflate the whole radial wall');
});

test('broken ring opening, centre and existing interior flight clearance stay traversable',()=>{
  const solid=ring({broken:true}),{radius,thickness,halfWidth,phase}=dimensions,t=radius*thickness,w=radius*halfWidth;
  assert.ok(solid.shape.parts.length<59);
  const gap=sweepSolid(solid,polar(radius+t*7,phase),polar(radius-t*4,phase),8);
  assert.equal(gap.status,'clear');
  assert.equal(sweepSolid(solid,[0,-w*2,0],[0,w*2,0],8).status,'clear');
  const inner=polar(radius-t-200,phase+Math.PI);
  close(solidDistance(solid,inner).distance,200);
  assert.equal(sweepSolid(solid,inner,polar(radius-t-200,phase+Math.PI+.00001),8).status,'clear');
  for(const part of solid.shape.parts.slice(10,-1)){
    const center=part.gapCenter-Math.PI,half=Math.PI-part.gapHalfAngle;
    const separation=Math.abs(Math.atan2(Math.sin(center-phase),Math.cos(center-phase)));
    const gapWidth=Math.max(...solid.shape.parts.slice(0,6).map(value=>value.gapHalfAngle));
    assert.ok(separation-half>gapWidth,'a complete buttress must stay outside the traversal gap');
  }
});

test('structure preserves published body identity, RNG-derived fields and core sections',()=>{
  const body=describeCosmicBody({x:-29,y:-12,z:14},'body-fixture');
  assert.equal(body.id,'cosmic-body-v3:-29,-12,14');
  assert.equal(body.radius,1178470.0957126915);
  assert.deepEqual(body.offset,[-277934.8168373108,297786.44127845764,-304285.9877586365]);
  assert.deepEqual(body.light,[0.5124921320218281,0.6137466848327536,0.6005554274773692]);
  assert.deepEqual(body.shape.parts.slice(0,3).map(part=>[part.innerRadius,part.outerRadius]),
    Array.from({length:3},()=>[1177836.047567455,1179104.143857928]));
  assert.deepEqual(body.shape.parts.slice(3,6).map(part=>[part.innerRadius,part.outerRadius]),[
    [1177550.7259020987,1179326.0607087607],[1177550.7259020987,1179326.0607087607],
    [1179072.4414506662,1179865.0016322117]]);
  assert.deepEqual(cosmicRingParts(dimensions),cosmicRingParts(dimensions));
  for(const part of body.shape.parts){
    assert.ok(Object.isFrozen(part));
    assert.ok(Math.hypot(part.outerRadius,Math.max(Math.abs(part.minY),Math.abs(part.maxY)))<=body.boundsRadius);
    assert.ok(part.outerRadius<=body.radius*(1+body.thickness*8.5)+60+1e-6);
  }
});
