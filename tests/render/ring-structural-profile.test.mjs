import test from 'node:test';
import assert from 'node:assert/strict';
import {PerspectiveCamera} from 'three';
import {cosmicRingParts} from '../../src/cosmic-bodies.js';
import {solidDistance,sweepSolid} from '../../src/solid-geometry.js';
import {createCosmicBodies} from '../../src/render/cosmic-bodies.js';

const frame=[1,0,0,0,1,0,0,0,1],parameters={radius:1000000,halfWidth:.02,thickness:.0005,phase:.37,broken:false},polar=(r,a,y)=>[r*Math.cos(a),y,r*Math.sin(a)],solid=parts=>({position:[0,0,0],shape:{type:'compound',parts}});

test('existing fixed metadata packs the same bounded profile into visible and light-ray solids',()=>{
  const body={...parameters,id:'profile',kind:'ring',center:[0,0,0],frame,light:[.5,.4,-.8],tint:[.5,.58,.64],shape:{type:'compound',parts:cosmicRingParts(parameters)}},group=createCosmicBodies(),camera=new PerspectiveCamera(65,1.6,.5,220000);
  camera.position.set(2000000,30000,-4000000);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const update=()=>group.userData.update({body,camera,viewportHeight:1000,pixelRatio:1});
  let metadataDisposals=0,terrainDisposals=0;
  try{
    update();const u=group.children[0].material.uniforms,texture=u.uRingLattices.value,data=texture.image.data,sections=u.uSections.value,gaps=u.uGaps.value;
    texture.addEventListener('dispose',()=>metadataDisposals++);u.uHabitatTerrain.value.addEventListener('dispose',()=>terrainDisposals++);
    assert.equal(u.uSectionCount.value,61);assert.equal(data.byteLength,2048);assert.equal(sections.length,64);assert.equal(gaps.length,64);let profiles=0;
    for(let i=0;i<body.shape.parts.length;i++){
      const p=body.shape.parts[i],at=i*4;
      if(!p.sections){assert.ok(data[at]>=0,'existing slab/lattice protocol stays distinct');continue;}
      profiles++;assert.equal(data[at],-1);const f=v=>Math.fround(v),s=sections[i],g=gaps[i],base={type:'annular-sector-slab',innerRadius:f(s.x)*body.radius,outerRadius:f(s.y)*body.radius,minY:f(s.z)*body.radius,maxY:f(s.w)*body.radius,gapCenter:f(g.x),gapHalfAngle:f(g.y)},decoded=[{...base,minY:base.maxY-data[at+1]*body.radius},{...base,gapHalfAngle:data[at+2]},{...base,maxY:base.minY+data[at+1]*body.radius}];
      for(let j=0;j<3;j++){for(const key of['innerRadius','outerRadius','minY','maxY'])assert.ok(Math.abs(decoded[j][key]-p.sections[j][key])<.2);assert.ok(Math.abs(decoded[j].gapHalfAngle-p.sections[j].gapHalfAngle)*body.radius<.2);}
      const actual=solid([p]),packed=solid(decoded),r=(p.innerRadius+p.outerRadius)/2,a=p.gapCenter+Math.PI,edge=a-(Math.PI-p.gapHalfAngle),webEdge=a-(Math.PI-p.sections[1].gapHalfAngle),y=(p.sections[0].minY+p.sections[2].maxY)/2,start=polar(r,edge-300/r,y),cavity=polar(r,(edge+webEdge)/2,y);
      assert.ok(solidDistance(packed,cavity).distance>100);
      for(const radius of[0,2,7])for(const end of[cavity,polar(r,a,y),polar(r,(edge+webEdge)/2,p.maxY+300)]){const x=sweepSolid(actual,start,end,radius),o=sweepSolid(packed,start,end,radius);assert.notEqual(x.status,'failed',x.reason);assert.equal(x.status,o.status);if(x.status==='hit'){const delta=end.map((v,j)=>v-start[j]),length=Math.hypot(...delta),incidence=Math.abs(delta.reduce((sum,v,j)=>sum+v*x.normal[j],0))/length,angleError=Math.abs(base.gapCenter-p.gapCenter)+Math.max(Math.abs(base.gapHalfAngle-p.gapHalfAngle),Math.abs(decoded[1].gapHalfAngle-p.sections[1].gapHalfAngle)),boundError=Math.max(...decoded.flatMap((d,j)=>['innerRadius','outerRadius','minY','maxY'].map(k=>Math.abs(d[k]-p.sections[j][k])))),tolerance=(boundError+r*angleError)/incidence+.02;assert.ok(incidence>.1,'fixture crosses faces at a finite angle');assert.ok(Math.abs(x.fraction-o.fraction)*length<=tolerance,`part${i} radius${radius}: packed contact exceeds its Float32 positional bound`);}}
    }
    assert.equal(profiles,20);const version=texture.version,buffer=data.buffer;for(let i=0;i<20;i++)update();assert.equal(texture.image.data.buffer,buffer);assert.equal(texture.version,version);assert.equal(u.uSections.value,sections);
    // Primary, emissive and atmosphere surfaces borrow the same packed owner.
    assert.equal(group.children[1].material.uniforms.uRingLattices.value,texture);assert.equal(group.children[0].children[0].material.uniforms.uRingLattices.value,texture);
    group.userData.dispose();group.userData.dispose();assert.equal(metadataDisposals,1);assert.equal(terrainDisposals,1);
  }finally{group.userData.dispose();}
});
