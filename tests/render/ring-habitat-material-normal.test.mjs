import test from 'node:test';
import assert from 'node:assert/strict';
import {RING_HABITAT_SURFACE_GLSL} from '../../src/render/ring-habitat-surface.js';

const vec3=(x,y,z)=>({x,y,z});
const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const normalize=v=>{const length=Math.sqrt(dot(v,v));return vec3(v.x/length,v.y/length,v.z/length);};
const near=(a,b)=>{for(const k of ['x','y','z'])assert.ok(Math.abs(a[k]-b[k])<1e-12,`${k}: ${a[k]} != ${b[k]}`);};
const weights=n=>{const w=vec3(n.x**4,n.y**4,n.z**4),sum=w.x+w.y+w.z;return vec3(w.x/sum,w.y/sum,w.z/sum);};
const sides=n=>vec3(n.x>=0?1:-1,n.y>=0?1:-1,n.z>=0?1:-1);
// Execute the scalar/vector-constructor math from the actual GLSL helper.
// This exercises the implementation's projection signs and blend, rather
// than a separately maintained triplanar-normal reference implementation.
const body=RING_HABITAT_SURFACE_GLSL.match(/vec3 habitatTriplanarNormal\([^)]*\)\{([\s\S]*?)\n\}/)?.[1];
assert.ok(body);
const blend=Function('vec3','dot','normalize',`return function(n,w,side,nx,ny,nz){${body.replace(/\b(vec3|float) (\w+)=/g,'const $2=') }}`)(vec3,dot,normalize);
const flat=vec3(0,0,1);

test('flat tangent normals retain arbitrary positive and negative terrain slopes',()=>{
  for(const n0 of [vec3(.2,.7,.4),vec3(-.2,.7,-.4),vec3(-.9,-.3,.2),vec3(1,1,1),vec3(0,-1,0)]){
    const n=normalize(n0);near(blend(n,weights(n),sides(n),flat,flat,flat),n);
  }
});

test('each signed projection uses a right-handed OpenGL tangent frame',()=>{
  const m=normalize(vec3(.2,.3,1));
  for(const sign of [-1,1]){
    const x=vec3(sign,0,0),y=vec3(0,sign,0),z=vec3(0,0,sign);
    near(blend(x,weights(x),sides(x),m,m,m),vec3(sign*m.z,m.y,-sign*m.x));
    near(blend(y,weights(y),sides(y),m,m,m),vec3(m.x,sign*m.z,-sign*m.y));
    near(blend(z,weights(z),sides(z),m,m,m),vec3(sign*m.x,m.y,sign*m.z));
  }
});

test('cyclic body-frame rotation rotates the same physical normal perturbation',()=>{
  const rotate=v=>vec3(v.y,v.z,v.x);
  for(const n0 of [vec3(.3,-.7,.5),vec3(-.8,.2,-.4)]){
    const n=normalize(n0),s=sides(n),nx=normalize(vec3(.12,-.22,1)),ny=normalize(vec3(-.18,.08,1)),nz=normalize(vec3(.23,.17,1));
    const actual=blend(n,weights(n),s,nx,ny,nz),r=rotate(n);
    const rx=vec3(-s.y*ny.x,-s.y*ny.y,ny.z),ry=vec3(nz.y,-nz.x,nz.z),rz=vec3(s.x*nx.y,-s.x*nx.x,nx.z);
    near(blend(r,weights(r),sides(r),rx,ry,rz),rotate(actual));
  }
});
