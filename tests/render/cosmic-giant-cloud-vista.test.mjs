import test from 'node:test';
import assert from 'node:assert/strict';
import {COSMIC_SPHERE_SURFACE_GLSL} from '../../src/render/cosmic-sphere-surface.js';

const gas = COSMIC_SPHERE_SURFACE_GLSL.match(/if\(uBodyKind==2\)\{([\s\S]*?)\n  \}\n  vec4 surfaceRock=/)?.[1];
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];

// CPU mirror of the shader's strictly local spherical storm frame.
// This checks topology and finite values, not GPU colour or artistic quality.
function stormCoordinates(phase, longitude, latitude) {
  const originAngle=phase*4.73,originLat=-.19+.16*Math.sin(phase*2.1);
  const center=[Math.cos(originAngle)*Math.cos(originLat),Math.sin(originLat),
    Math.sin(originAngle)*Math.cos(originLat)];
  const east=[-Math.sin(originAngle),0,Math.cos(originAngle)];
  const north=[center[1]*east[2]-center[2]*east[1],
    center[2]*east[0]-center[0]*east[2],
    center[0]*east[1]-center[1]*east[0]];
  const normal=[Math.cos(longitude)*Math.cos(latitude),Math.sin(latitude),
    Math.sin(longitude)*Math.cos(latitude)];
  const delta=normal.map((n,i)=>n-center[i]);
  return [dot(delta,east)*.72,dot(delta,north)*1.75];
}

test('gas giant cloud layering is seeded in 3D body coordinates and limits unresolved bands', () => {
  assert.ok(gas,'separate gas giant surface branch is present');
  assert.match(gas,/float beltPhase=normal\.y\*70\./);
  assert.match(gas,/fwidth\(beltPhase\*\.43\)/);
  assert.match(gas,/fwidth\(beltPhase\*1\.65\+cloud\)/);
  assert.match(gas,/mix\(\.5,broad,broadResolved\)/);
  assert.match(gas,/mix\(\.5,fine,fineResolved\)/);
  assert.match(gas,/ringWorldField\(world\+seed,8\.,footprint,false\)/);
  assert.doesNotMatch(gas,/uTime|elapsedTime|cameraPosition|random\(/);
});

test('the storm is stable across the spherical longitude seam and over repeated visits', () => {
  const phase=Math.PI/4.73,latitude=-.19+.16*Math.sin(phase*2.1);
  const a=stormCoordinates(phase,Math.PI-1e-6,latitude);
  const b=stormCoordinates(phase,-Math.PI+1e-6,latitude);
  assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1])<3e-6);
  assert.deepEqual(a,stormCoordinates(phase,Math.PI-1e-6,latitude));
  assert.match(gas,/vec3 stormCenter=vec3\(cos\(longitude\)/);
  assert.match(gas,/vec3 delta=normal-stormCenter/);
  assert.match(gas,/float edge=max\(fwidth\(ellipse\),\.00001\)/);
  for(let i=-200;i<=200;i++) {
    const p=i*.07;
    for(let j=0;j<20;j++) {
      const coordinates=stormCoordinates(p,j*.33-3.1,Math.sin(j*2)*1.4);
      assert.ok(coordinates.every(Number.isFinite));
      assert.ok(Math.hypot(...coordinates)<4);
    }
  }
});

test('light, ring shadow and existing cloud-map ownership remain in the same material', () => {
  assert.match(gas,/bodyMap\(uClouds,bodyUV\(normal\)/);
  assert.match(gas,/albedo\*=\.78\+\.38\*dot\(observed/);
  assert.match(gas,/gasRingCast\(point\+normal\*\.000001,uLight,hit,t\)/);
  assert.match(gas,/float sunlight=pow\(max\(ndl,0\.\),\.9\)/);
  assert.match(gas,/return albedo\*\(\.012\+sunlight\*1\.12\)\*\(1\.-shadow\*\.8\)/);
  assert.doesNotMatch(gas,/uBodyCenter\s*=|uBodyRadius\s*=|uLight\s*=/);
});
