import test from 'node:test';
import assert from 'node:assert/strict';
import {cosmicRingParts} from '../src/cosmic-bodies.js';
import {createSolidWorkspace,solidDistance,sweepSolid} from '../src/solid-geometry.js';

const parameters={radius:1000000,halfWidth:.02,thickness:.0005,phase:.37,broken:false};
const polar=(r,a,y)=>[r*Math.cos(a),y,r*Math.sin(a)];
const solid=parts=>({position:[0,0,0],shape:{type:'compound',parts}});
const close=(a,b,e=1e-6)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);

test('all shoulder profiles are bounded closed attached members without expanding logical slots',()=>{
  for(const radius of[1,1000,1000000])for(const thickness of[.0005,.2,.68])for(const broken of[false,true]){
    const p={...parameters,radius,thickness,broken},parts=cosmicRingParts(p),width=radius*p.halfWidth;
    assert.ok(parts.length<=64);let count=0;
    for(const part of parts){
      const shoulder=!part.surfaceLattice&&(part.minY< -width||part.maxY>width);
      assert.equal(Boolean(part.sections),shoulder,'every shoulder, no core/rail/cabinet, gets the profile');
      if(!shoulder)continue;count++;assert.equal(part.sections.length,3);assert.ok(Object.isFrozen(part.sections));
      for(const member of part.sections){assert.ok(Object.isFrozen(member));assert.equal(member.type,'annular-sector-slab');assert.ok(member.innerRadius<member.outerRadius&&member.minY<member.maxY);assert.ok(member.innerRadius>=part.innerRadius&&member.outerRadius<=part.outerRadius&&member.minY>=part.minY&&member.maxY<=part.maxY);assert.ok(member.gapHalfAngle>=part.gapHalfAngle);assert.equal(member.sections,undefined);assert.equal(member.surfaceLattice,undefined);}
      const[top,web,bottom]=part.sections;assert.ok(top.minY<web.maxY&&bottom.maxY>web.minY);assert.ok(top.minY>bottom.maxY);assert.ok(web.gapHalfAngle>part.gapHalfAngle);
    }
    assert.ok(count>0);if(!broken){assert.equal(parts.length,61);assert.equal(count,20);}
  }
});

test('real side cavities stay open while both flanges and web stop r0/r2/r7 crossings',()=>{
  const parts=cosmicRingParts(parameters);
  for(const beam of parts.filter(p=>p.sections)){
    const[top,web,bottom]=beam.sections,shape=solid([beam]),r=(beam.innerRadius+beam.outerRadius)/2,a=beam.gapCenter+Math.PI,half=Math.PI-beam.gapHalfAngle,edge=a-half,webEdge=a-(Math.PI-web.gapHalfAngle),y=(top.minY+bottom.maxY)/2;
    const outside=polar(r,edge-300/r,y),cavity=polar(r,(edge+webEdge)/2,y),throughWeb=polar(r,a,y);
    assert.ok(solidDistance(shape,cavity).distance>100);assert.ok(solidDistance(solid([{...beam,sections:undefined}]),cavity).distance<0,'the former envelope occupied this exact cavity');
    for(const radius of[0,2,7]){
      assert.equal(sweepSolid(shape,outside,cavity,radius).status,'clear');
      for(const[start,end,feature]of[[cavity,throughWeb,'gap'],[cavity,polar(r,(edge+webEdge)/2,top.maxY+300),'bottom'],[cavity,polar(r,(edge+webEdge)/2,bottom.minY-300),'top']]){
        const hit=sweepSolid(shape,start,end,radius);assert.equal(hit.status,'hit',hit.reason);assert.equal(hit.part,0);assert.ok(feature==='gap'?hit.feature.startsWith('gap-'):hit.feature===feature);assert.ok(hit.fraction>0&&hit.fraction<1);assert.ok(hit.normal.every(Number.isFinite));
        const safe=start.map((v,i)=>v+(end[i]-v)*hit.safeFraction);assert.ok(solidDistance(shape,safe).distance>=radius-1e-6);
      }
    }
  }
});

test('logical profile distances and swept contacts agree with an explicit closed-slab union',()=>{
  const parts=cosmicRingParts(parameters).map(({surfaceLattice,...p})=>p),actual=solid(parts),flat=[],owners=[];
  for(let i=0;i<parts.length;i++)for(const member of parts[i].sections??[parts[i]]){flat.push(member);owners.push(i);}
  const oracle=solid(flat),a=createSolidWorkspace(),b=createSolidWorkspace();
  for(let i=0;i<parts.length;i++){
    const p=parts[i];if(!p.sections)continue;const angle=p.gapCenter+Math.PI,r=(p.innerRadius+p.outerRadius)/2,half=Math.PI-p.gapHalfAngle;
    for(const side of[-1,0,1])for(const y of[p.minY-100,(p.minY+p.maxY)/2,p.maxY+100]){
      const point=polar(r,angle+side*half*1.1,y),x=solidDistance(actual,point,undefined,a),o=solidDistance(oracle,point,undefined,b);close(x.distance,o.distance);assert.equal(x.part,owners[o.part]);for(let j=0;j<3;j++)close(x.normal[j],o.normal[j]);
    }
    for(const radius of[0,2,7]){
      const start=polar(r,angle+half+2000/r,(p.minY+p.maxY)/2),end=polar(r,angle-half-2000/r,(p.minY+p.maxY)/2),x=sweepSolid(actual,start,end,radius,{},undefined,a),o=sweepSolid(oracle,start,end,radius,{},undefined,b);assert.notEqual(x.status,'failed',x.reason);assert.equal(x.status,o.status);close(x.fraction,o.fraction,1e-10);if(x.status==='hit'){assert.equal(x.part,owners[o.part]);for(let j=0;j<3;j++)close(x.normal[j],o.normal[j]);}
    }
  }
});

test('cold sweep storage accounts for physical members and stays reused after warm queries',()=>{
  const parts=cosmicRingParts(parameters).map(({surfaceLattice,...p})=>p),shape=solid(parts),plain=solid(parts.map(({sections,...p})=>p)),profileCount=parts.filter(p=>p.sections).length,a=createSolidWorkspace(),b=createSolidWorkspace();
  sweepSolid(shape,[0,0,0],[100,0,0],7,{},undefined,a);sweepSolid(plain,[0,0,0],[100,0,0],7,{},undefined,b);
  assert.equal(a.candidates.byteLength-b.candidates.byteLength,profileCount*2*128*8);assert.equal(profileCount*2*128*8,40960);
  const buffer=a.candidates;for(let i=0;i<20;i++)sweepSolid(shape,[0,0,0],[100,0,0],i%3,{},undefined,a);assert.equal(a.candidates,buffer);
});
