import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cosmicRingParts,describeCosmicBody} from '../src/cosmic-bodies.js';
import {createSolidWorkspace,solidDistance,sweepSolid} from '../src/solid-geometry.js';

const dimensions={radius:1000000,halfWidth:.02,thickness:.0005,phase:.37,broken:false};
const polar=(radius,angle,y=0)=>[radius*Math.cos(angle),y,radius*Math.sin(angle)];
const close=(actual,expected,tolerance=1e-6)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
function ring(overrides={}){
  const parameters={...dimensions,...overrides};
  // These queries isolate macro walls; implicit plate contacts have their own
  // full-shape comparison in ring-surface-integration.test.mjs.
  const parts=cosmicRingParts(parameters).map(({surfaceLattice,...part})=>part);
  return {position:[0,0,0],shape:{type:'compound',parts},
    boundsRadius:Math.max(...parts.map(part=>Math.hypot(part.outerRadius,Math.max(Math.abs(part.minY),Math.abs(part.maxY)))))};
}

test('raised exterior has actual finite walls, edges and continuous sphere contacts',()=>{
  const solid=ring(),part=solid.shape.parts[10],angle=part.gapCenter-Math.PI;
  assert.equal(solid.shape.parts.length,61);
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
  close(spine.outerRadius-radius,.025*radius);close(spine.maxY-spine.minY,.32*w);
  assert.ok(spine.innerRadius<solid.shape.parts[5].outerRadius);
  const face=solidDistance(solid,polar(spine.outerRadius+19,phase));
  close(face.distance,19);assert.equal(face.part,60);
  const hit=sweepSolid(solid,polar(spine.outerRadius+1000,phase),polar(spine.outerRadius-300,phase),8);
  assert.equal(hit.status,'hit');assert.equal(hit.part,60);close(hit.fraction,992/1300,1e-8);
  const supports=solid.shape.parts.slice(10,34);
  const widths=supports.map(part=>(Math.PI-part.gapHalfAngle)*radius*2);
  const reaches=supports.map(part=>(part.outerRadius-radius)/radius);
  for(let index=0;index<supports.length;index++){
    assert.ok(widths[index]>=6000&&widths[index]<=12000);
    assert.ok(reaches[index]>=.035&&reaches[index]<=.05);
  }
  assert.ok(Math.max(...widths)-Math.min(...widths)>5000);
  assert.ok(Math.max(...reaches)-Math.min(...reaches)>.0125);
});

test('shoulder decks have continuous solid faces and CCD while the layered bays stay hollow',()=>{
  const solid=ring(),{radius,thickness,halfWidth,phase}=dimensions,t=radius*thickness,w=radius*halfWidth;
  const shoulders=solid.shape.parts.slice(-3,-1);
  for(let index=0;index<shoulders.length;index++){
    const deck=shoulders[index],part=58+index,sign=index===0?-1:1;
    close(deck.innerRadius,radius+1.2*t);close(deck.outerRadius,radius*1.04);
    close(deck.minY,sign<0?-w:.88*w);close(deck.maxY,sign<0?-.88*w:w);
    const y=(deck.minY+deck.maxY)/2;
    const face=solidDistance(solid,polar(deck.outerRadius+30,phase,y));
    close(face.distance,30);assert.equal(face.part,part);assert.equal(face.feature,'outer');
    const radial=sweepSolid(solid,polar(deck.outerRadius+1000,phase,y),polar(deck.outerRadius-1000,phase,y),8);
    assert.equal(radial.status,'hit');assert.equal(radial.part,part);close(radial.fraction,992/2000,1e-8);
    const axial=sweepSolid(solid,polar(radius*1.03,phase,sign*(w+1000)),polar(radius*1.03,phase,sign*(w-5000)),8);
    assert.equal(axial.status,'hit');assert.equal(axial.part,part);close(axial.fraction,992/6000,1e-8);
    close(axial.normal[1],sign);
  }
  assert.equal(sweepSolid(solid,polar(radius*1.039,phase,w*.4),polar(radius*1.003,phase,w*.4),8).status,'clear');
  assert.ok(solidDistance(solid,polar(radius*1.032,phase)).distance>6000,'the exterior bounds are not a solid cylinder');
});

test('exterior shoulder crossbeams share attached finite geometry with zero/ship-radius CCD',()=>{
  const solid=ring(),parts=solid.shape.parts,{radius,halfWidth,thickness}=dimensions,w=radius*halfWidth,t=radius*thickness;
  const attachments=parts.slice(34,-3),beams=attachments.filter(p=>p.minY< -w||p.maxY>w),cabinets=attachments.filter(p=>p.minY>=-w&&p.maxY<=w);
  assert.equal(beams.length,20);assert.equal(cabinets.length,4);assert.ok(parts.length<=64);
  // This fixture protects the pre-existing six core sections, rails, supports,
  // decks and spine, including their original shared lattice metadata.
  const unchanged=cosmicRingParts(dimensions);assert.equal(createHash('sha256').update(JSON.stringify([...unchanged.slice(0,34),...unchanged.slice(-3)])).digest('hex'),'43ccd3f0a031a3e73eefaef1a024f83d31fb86348a2b62557251369ef2648bf9');
  for(const beam of beams){
    const support=parts.slice(10,34).find(p=>p.gapCenter===beam.gapCenter&&p.outerRadius===beam.outerRadius),side=beam.maxY>w?1:-1,deck=parts[side>0?59:58],angle=beam.gapCenter-Math.PI;
    assert.ok(support,'each finite crossbeam joins an existing support anchor');assert.ok(beam.innerRadius>radius+t,'exterior structure stays outside the inner landscape');
    assert.ok(Math.PI-beam.gapHalfAngle<Math.PI-support.gapHalfAngle,'the beam remains within the admitted angular support');
    for(const other of [support,deck]){
      const low=Math.max(beam.innerRadius,other.innerRadius),high=Math.min(beam.outerRadius,other.outerRadius),minY=Math.max(beam.minY,other.minY),maxY=Math.min(beam.maxY,other.maxY);assert.ok(high>low&&maxY>minY,'positive radial/axial overlap');
      const point=polar((low+high)/2,angle,(minY+maxY)/2);for(const part of [beam,other])assert.ok(solidDistance({position:[0,0,0],shape:{type:'compound',parts:[part]}},point).distance<0);
    }
  }
  for(const side of [-1,1]){
    const beam=beams.find(p=>side>0?p.maxY>w:p.minY< -w),part=parts.indexOf(beam),angle=beam.gapCenter-Math.PI,r=(beam.innerRadius+beam.outerRadius)/2,top=side>0?beam.maxY:beam.minY;
    for(const shipRadius of [0,7]){const hit=sweepSolid(solid,polar(r,angle,top+side*2000),polar(r,angle,top-side*2000),shipRadius);assert.equal(hit.status,'hit',hit.reason);assert.equal(hit.part,part);close(hit.fraction,(2000-shipRadius)/4000,1e-8);assert.ok(hit.normal[1]*side>.99999);}
    const y=side*(w+800),radial=sweepSolid(solid,polar(beam.outerRadius+2000,angle,y),polar(beam.outerRadius-2000,angle,y),7);assert.equal(radial.status,'hit',radial.reason);assert.equal(radial.part,part);close(radial.fraction,1993/4000,1e-8);
    const edge=angle+Math.PI-beam.gapHalfAngle,da=1500/r,angular=sweepSolid(solid,polar(r,edge+da,y),polar(r,edge-da,y),7);assert.equal(angular.status,'clear','the real side channel replaces the old solid shoulder wall');
    const web=sweepSolid(solid,polar(r,edge-da,y),polar(r,angle,y),7);assert.equal(web.status,'hit',web.reason);assert.equal(web.part,part);assert.match(web.feature,/gap/);
  }
});

test('retained service cabinets keep 128 units of solid relief above their attached supports',()=>{
  const solid=ring(),support=solid.shape.parts[10],cabinet=solid.shape.parts[34];
  const angle=cabinet.gapCenter-Math.PI,y=(cabinet.minY+cabinet.maxY)/2;
  close(cabinet.outerRadius-support.outerRadius,128);
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
  close(hit.fraction,172/288,1e-8);
  // Past the cabinet top the same radial space remains open over the support.
  assert.equal(sweepSolid(solid,polar(cabinet.outerRadius+180,angle,cabinet.maxY+25),
    polar(support.outerRadius+80,angle,cabinet.maxY+25),8).status,'clear');
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
  assert.ok(solid.shape.parts.length<61);
  const gap=sweepSolid(solid,polar(radius*1.06,phase),polar(radius-t*4,phase),8);
  assert.equal(gap.status,'clear');
  for(const y of [-.94*w,.94*w])assert.equal(sweepSolid(solid,polar(radius*1.06,phase,y),polar(radius-t*4,phase,y),8).status,'clear');
  assert.equal(sweepSolid(solid,[0,-w*2,0],[0,w*2,0],8).status,'clear');
  const inner=polar(radius-t-200,phase+Math.PI);
  close(solidDistance(solid,inner).distance,200);
  assert.equal(sweepSolid(solid,inner,polar(radius-t-200,phase+Math.PI+.00001),8).status,'clear');
  for(const part of solid.shape.parts.slice(10,-3)){
    const center=part.gapCenter-Math.PI,half=Math.PI-part.gapHalfAngle;
    const separation=Math.abs(Math.atan2(Math.sin(center-phase),Math.cos(center-phase)));
    const gapWidth=Math.max(...solid.shape.parts.slice(0,6).map(value=>value.gapHalfAngle));
    assert.ok(separation-half>gapWidth,'a complete buttress must stay outside the traversal gap');
  }
  const gapWidth=Math.max(...solid.shape.parts.slice(0,6).map(value=>value.gapHalfAngle));
  for(const part of solid.shape.parts.slice(-3))close(part.gapHalfAngle,gapWidth);
});

test('proportional shoulders, supports and spine remain valid at small and thick public-constructor scales',()=>{
  for(const radius of [1,1000])for(const thickness of [.0005,.2,.68]){
    const parts=cosmicRingParts({...dimensions,radius,thickness});
    assert.equal(parts.length,61);
    for(const part of parts){
      assert.ok(part.innerRadius>=0);assert.ok(part.outerRadius>part.innerRadius);
      assert.ok(part.maxY>part.minY);
    }
    for(const deck of parts.slice(-3,-1))assert.ok(deck.innerRadius<parts[3].outerRadius,'shoulder overlaps its original flange');
    assert.ok(parts.at(-1).innerRadius<parts[5].outerRadius,'spine overlaps the original middle rail');
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
    assert.ok(Math.hypot(part.surfaceLattice?.outerRadius??part.outerRadius,Math.max(Math.abs(part.minY),Math.abs(part.maxY)))<=body.boundsRadius);
    assert.ok(part.outerRadius<=body.radius*1.05+128+1e-6);
  }
});
