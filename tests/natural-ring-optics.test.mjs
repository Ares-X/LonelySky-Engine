import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {NATURAL_RING,NATURAL_RING_OPTICS,createNaturalRingOpticalWorkspace,naturalRingVisualSigma,naturalRingArtTint,naturalRingTransfer,naturalRingSunTransmission,naturalRingPhase,naturalRingMaterial,createNaturalRingField,createNaturalRingQueryWorkspace} from '../src/natural-ring.js';
import {NATURAL_RING_GRAINS} from '../src/render/natural-ring-grains.js';
const R=919090.8566932194;

test('unequal optical bands retain real voids, bounded grain admission and normalized normal optical depth',()=>{
 const r=1.5*R,phase=.67,center=naturalRingVisualSigma(r,0,0,R,phase);let column=0;
 for(let i=0;i<4096;i++)column+=naturalRingVisualSigma(r,-64+(i+.5)*128/4096,0,R,phase)*128/4096;
 assert.ok(Math.abs(column-center*1024/15)<1e-10);
 for(const point of [[r,64,0],[1.24*R,0,0],[2.11*R,0,0]])assert.equal(naturalRingVisualSigma(...point,R,phase),0);
 // Equal-area samples are independent of the plateau/lobe implementation.
 // This is an optical-depth budget, not a physical mass or orbit assertion.
 const area=2.1**2-1.25**2,n=65536;
 for(const phase of [0,.125,.25,.5,.67,.75,.875,3.730486541829717]){
  let opticalDepth=0,voids=0;
  for(let i=0;i<n;i++){
   const radius=Math.sqrt(1.25**2+area*(i+.5)/n)*R,tau=naturalRingVisualSigma(radius,0,0,R,phase)*1024/15;
   assert.ok(tau>=0&&tau<=NATURAL_RING_GRAINS.maximumNormalTau,'finite grain candidate bound must contain every optical column');
   opticalDepth+=tau/n;if(tau===0)voids++;
  }
  assert.ok(Math.abs(opticalDepth-.675)<1e-6,`area-weighted normal optical depth phase${phase}: ${opticalDepth}`);
  assert.ok(voids/n>.08,'visible ring gaps must contain true zero-density columns');
 }
 for(const nr of [1.3,1.5,1.85,2.05])for(const angle of [0,.7,2.8,-Math.PI]){
  const reference=naturalRingVisualSigma(nr*R,0,0,R,phase),rotated=naturalRingVisualSigma(nr*R*Math.cos(angle),0,nr*R*Math.sin(angle),R,phase);
  assert.ok(Math.abs(reference-rotated)<1e-12,'static optical bands must not add angular channels or a polar seam');
 }
 assert.notEqual(center,naturalRingVisualSigma(r,0,0,R,phase+.4));
});

test('radial ice/dust detail filters to its local material mean without changing density',()=>{
 const resolved=[0,0,0],filtered=[0,0,0],left=[0,0,0],right=[0,0,0];let resolvedVariation=0,filteredVariation=0;
 for(let i=1;i<2048;i++){
  const r=1.25+.85*i/2048,epsilon=1e-5;
  naturalRingArtTint(r,.67,resolved);naturalRingArtTint(r,.67,filtered,1);
  assert.ok(resolved.every(Number.isFinite)&&filtered.every(Number.isFinite));
  // Fully subpixel lobes disappear. Local radial structure must remain
  // observable at resolved footprints without changing its density owner.
  naturalRingArtTint(r-epsilon,.67,left);naturalRingArtTint(r+epsilon,.67,right);
  resolvedVariation+=Math.abs(left[0]-right[0]);
  naturalRingArtTint(r-epsilon,.67,left,1);naturalRingArtTint(r+epsilon,.67,right,1);
  filteredVariation+=Math.abs(left[0]-right[0]);
 }
 assert.ok(resolvedVariation>filteredVariation*2,`material detail must resolve/filter: ${resolvedVariation}/${filteredVariation}`);
});

test('finite Sun transfer includes parent shadow and ring-face depth, with a bounded grazing reference error',()=>{
  const work=createNaturalRingOpticalWorkspace(),reference=createNaturalRingOpticalWorkspace();
  assert.equal(naturalRingSunTransmission([-1.5*R,0,0],[1,0,0],R,.67,work),0);
  let worst=0;
  for(const ly of [.5,.1,.01,0]){
    const light=[Math.sqrt(1-ly*ly),ly,0];
    for(const phi of [0,.3,1,2.7])for(const y of [-63,0,63]){
      const p=[1.5*R*Math.cos(phi),y,1.5*R*Math.sin(phi)],actual=naturalRingSunTransmission(p,light,R,.67,work),fine=naturalRingSunTransmission(p,light,R,.67,reference,4096);
      assert.ok(actual>=0&&actual<=1);worst=Math.max(worst,Math.abs(actual-fine));
    }
  }
  assert.ok(worst<.006,`absolute grazing Sun transmission error ${worst}`);
  const light=[.6,.8,0];
  assert.ok(naturalRingSunTransmission([1.5*R,63,0],light,R,.67,work)>naturalRingSunTransmission([1.5*R,-63,0],light,R,.67,work));
});

test('positive C/T transfer resolves near, high and grazing chords against a fine quadrature',()=>{
  const work=createNaturalRingOpticalWorkspace(),reference=createNaturalRingOpticalWorkspace();let maxT=0,maxC=0;
  for(const ly of [.5,.01,0]){
    const light=[Math.sqrt(1-ly*ly),ly,0];
    for(const phi of [0,1,2.7])for(const height of [0,64,10206])for(const v of [-.3,-.003,0]){
      const origin=[1.5*R*Math.cos(phi),height,1.5*R*Math.sin(phi)],ray=[Math.sqrt(1-v*v),v,0];
      const actual=naturalRingTransfer(origin,ray,R,0,3e6,.67,light,true,work),fine=naturalRingTransfer(origin,ray,R,0,3e6,.67,light,true,reference,2048,128);
      assert.ok(actual.transmission>=0&&actual.transmission<=1&&actual.radiance>=0);
      assert.ok(actual.radiance<=NATURAL_RING_OPTICS.albedo*(NATURAL_RING_OPTICS.ambientRadiance+NATURAL_RING_OPTICS.incidentIrradiance*2.5/(4*Math.PI))*(1-actual.transmission)+1e-12);
      maxT=Math.max(maxT,Math.abs(actual.transmission-fine.transmission));maxC=Math.max(maxC,Math.abs(actual.radiance-fine.radiance));
    }
  }
  assert.ok(maxT<.001,`absolute T error ${maxT}`);assert.ok(maxC<.001,`absolute C error ${maxC}`);
  assert.ok(naturalRingPhase(-1)>naturalRingPhase(1),'declared backscattering phase');
});

test('new visual optics do not alter v1 macro placement or its bounded owner',()=>{
  const body={id:'stable-ring',kind:'gas-giant',ringed:true,radius:R,position:[0,0,0],frame:[1,0,0,0,1,0,0,0,1]},field=createNaturalRingField({seed:'stable',parentsInBounds:()=>[body]}),work=createNaturalRingQueryWorkspace(NATURAL_RING.visibleCapacity);
  try{
    const camera=[1.5*R,0,0],records=field.visible(body,camera,0,work),before=records.map(r=>[r.id,...r.localPosition]);
    const optical=createNaturalRingOpticalWorkspace();naturalRingTransfer(camera,[0,1,0],R,0,1000,4,[0,1,0],true,optical);
    assert.deepEqual(field.visible(body,camera,0,work).map(r=>[r.id,...r.localPosition]),before);
    // Independently reproduced from the unmodified parent HEAD before this optical change.
    assert.equal(before.length,242);
    assert.equal(createHash('sha256').update(JSON.stringify(before)).digest('hex'),'870b8f0d8c61c03afa7c9691b981c83f53ffc6389601fa2ff6e99cfc6b1829f2');
    assert.equal(field.stats.cacheTiles,81);
  }finally{field.dispose();}
  assert.equal(field.stats.cacheTiles,0);
});

test('single-scatter phase has unit spherical integral and shares Lambert incident irradiance',()=>{
  let integral=0;const n=65536;
  for(let i=0;i<n;i++)integral+=naturalRingPhase(-1+(i+.5)*2/n)*4*Math.PI/n;
  assert.ok(Math.abs(integral-1)<1e-9);
  assert.equal(NATURAL_RING_OPTICS.incidentIrradiance/Math.PI,1.05);
  assert.ok(Math.abs(NATURAL_RING_OPTICS.incidentIrradiance*naturalRingPhase(0)-.2625*(1-.28**2)/(1+.28**2)**1.5)<1e-15);
});


test('filtered optical flakes retain bounded energy and remove unresolved fake directions',()=>{
  const point=[1.5*R,0,0],light=[.6,.8,0],ray=[.3,-.8,Math.sqrt(.27)],out={};
  const unresolved=naturalRingMaterial(point,ray,light,.67,576,out);
  assert.equal(unresolved.resolvedWeight,0);assert.equal(unresolved.albedo,.85);
  assert.equal(unresolved.response,naturalRingPhase(ray[0]*light[0]+ray[1]*light[1]+ray[2]*light[2]));
  let power=0;const n=64,m=128;
  for(let i=0;i<n;i++)for(let j=0;j<m;j++){
    const y=-1+(i+.5)*2/n,a=(j+.5)*Math.PI*2/m,radial=Math.sqrt(1-y*y);
    ray[0]=radial*Math.cos(a);ray[1]=y;ray[2]=radial*Math.sin(a);
    const material=naturalRingMaterial(point,ray,light,.67,0,out);
    assert.ok(material.response>=0&&material.albedo>=.7&&material.albedo<=1);
    power+=material.response*4*Math.PI/(n*m);
  }
  assert.ok(power>.8&&power<=1.0001,`integrated directional scattering power ${power}`);
});

test('source material and column centroid remain continuous across body angle and material-cell boundaries',()=>{
  const work=createNaturalRingOpticalWorkspace(),fine=createNaturalRingOpticalWorkspace();
  const ray=[.3,-.8,Math.sqrt(.27)],light=[.6,.8,0];let previousC=null,px=0,py=0,pz=0,worstC=0,worstPosition=0,worstReference=0;
  for(let i=0;i<=256;i++){
    const origin=[1.5*R+i-128,200,0],actual=naturalRingTransfer(origin,ray,R,0,3000,.67,light,true,work,32,8,24);
    const reference=naturalRingTransfer(origin,ray,R,0,3000,.67,light,true,fine,2048,128,24);
    worstReference=Math.max(worstReference,Math.abs(actual.radiance-reference.radiance));
    if(previousC!==null){worstC=Math.max(worstC,Math.abs(actual.radiance-previousC));worstPosition=Math.max(worstPosition,Math.hypot(work.point[0]-px,work.point[1]-py,work.point[2]-pz));}
    previousC=actual.radiance;px=work.point[0];py=work.point[1];pz=work.point[2];
  }
  assert.ok(worstReference<.001,`resolved material reference error ${worstReference}`);
  assert.ok(worstC<.005,`1L source motion increment ${worstC}`);
  assert.ok(worstPosition<1.01,`centroid moves continuously by ${worstPosition}L per 1L camera step`);
  // No polar atan/hash seam: approach the same negative-X body point from
  // either side, and straddle an exact 384L material lattice boundary.
  const out={},points=[[-1.5*R,0,0],[Math.round(1.5*R/384)*384,0,0]];
  for(const p of points){
    p[2]=-.00001;const left={...naturalRingMaterial(p,ray,light,.67,24,out)};
    p[2]=.00001;const right=naturalRingMaterial(p,ray,light,.67,24,out);
    assert.ok(Math.abs(left.response-right.response)<1e-5);
    assert.ok(Math.abs(left.albedo-right.albedo)<1e-5);
  }
});
