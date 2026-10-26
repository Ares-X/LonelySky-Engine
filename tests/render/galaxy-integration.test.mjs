import test from 'node:test';
import assert from 'node:assert/strict';
import {createGalaxyHaze} from '../../src/render/galaxy-haze.js';
const descriptors = ['spiral','elliptical','irregular'].map(morphology => ({
  id:'test-'+morphology, seed:'test-'+morphology, morphology, radius:55000, thickness:.1,
  arms:3,pitch:.33,bar:true,asymmetry:.37,orientation:[.2,.8,.1],
}));

test('bounded integration rules preserve energy and reuse stable nodes across updates and volumes', () => {
  const haze = createGalaxyHaze(); haze.userData.setDescriptors(descriptors);
  const centers = descriptors.map(() => [0,0,-180000]);
  for (const quality of ['low','auto','high']) {
    const update = () => haze.userData.update({centers,cameraPosition:[0,0,0],quality,brightness:1,home:false});
    update();
    const uniforms = haze.children[0].material.uniforms, steps = uniforms.steps.value;
    for (const [key,count] of [['quadrature',steps],['coreQuadrature',steps/2]]) {
      const nodes = uniforms[key].value;
      assert.equal(nodes.length,48); assert.ok(count<=48);
      for (let power=0;power<=3;power++) {
        const integral = nodes.slice(0,count).reduce((sum,node)=>sum+node.x**power*node.y,0);
        assert.ok(Math.abs(integral-1/(power+1))<1e-12,'Gauss weights preserve constant, linear and cubic density');
      }
      assert.ok(nodes.slice(0,count).every(node=>node.x>0&&node.x<1&&node.y>0));
      assert.ok(nodes.slice(count).every(node=>node.x===0&&node.y===0));
      for (const mesh of haze.children) assert.equal(mesh.material.uniforms[key].value,nodes);
      update(); assert.equal(uniforms[key].value,nodes,'camera updates do not reseed quadrature');
    }
  }
  haze.userData.dispose();
});

test('focused smooth-core quadrature removes equal-depth slice error against a converged reference', () => {
  const haze = createGalaxyHaze(); haze.userData.setDescriptors(descriptors);
  const nodes = haze.children[0].material.uniforms.coreQuadrature.value.slice(0,16);
  const edge = radius => {const t=Math.max(0,Math.min(1,(radius-.8)/.2));return 1-t*t*(3-2*t);};
  const core = (z,impact) => {const radius=Math.hypot(z,impact);return Math.exp(-8*radius)*edge(radius);};
  let focusedSquaredError=0,oldSquaredError=0,maxError=0;
  // Sweep adjacent rays through the narrow core: coherent sample-plane error
  // here becomes parallel brightness bands in the image. The reference uses
  // 8192 uniform samples, independent of the uploaded quadrature rules.
  for(let ray=0;ray<=100;ray++) {
    const impact=ray*.004,reach=Math.sqrt(1-impact*impact),stride=2*reach/8192;
    let reference=0,focused=0,old=0;
    for(let i=0;i<8192;i++) reference+=core(-reach+(i+.5)*stride,impact)*stride;
    for(let i=0;i<16;i++) old+=core(-reach+(i+.5)*2*reach/16,impact)*2*reach/16;
    for(const node of nodes) focused+=2*core(reach*node.x*node.x,impact)*2*reach*node.x*node.y;
    const error=Math.abs(focused-reference);maxError=Math.max(maxError,error);
    focusedSquaredError+=error*error;oldSquaredError+=(old-reference)**2;
  }
  assert.ok(maxError<.00003,'absolute integration error is bounded against the converged reference');
  assert.ok(focusedSquaredError<oldSquaredError/10000,'RMS core error improves by at least 100x');
  haze.userData.dispose();
});

// Numerical counterpart of the analytic shader filter; the independent target
// below is a high-resolution periodic integral, not an assertion about GLSL text.
function filteredArm(offset,width,arms,radius,pitch,footprint) {
  const gradient=Math.sqrt(1/Math.max(radius*radius,.000001)+1/(pitch*(radius+.06))**2);
  const sigma=Math.sqrt(width*width+(footprint*gradient)**2/12),period=2*Math.PI/arms;
  const lobes=[offset-period,offset,offset+period].reduce((sum,n)=>sum+Math.exp(-.5*(n/sigma)**2),0)*width/sigma;
  const t=Math.max(0,Math.min(1,(sigma/period-.3)/.25)),blend=t*t*(3-2*t);
  return lobes*(1-blend)+width*arms/Math.sqrt(2*Math.PI)*blend;
}

test('analytic arm footprint conserves periodic light and converges to the unresolved mean', () => {
  for(const arms of [2,3,4,6]) for(const width of [.085,.12,.185]) {
    const period=2*Math.PI/arms,count=8192,step=period/count;
    const periodicReference = offset => {
      let sum=0;for(let image=-4;image<=4;image++)sum+=Math.exp(-.5*((offset+image*period)/width)**2);return sum;
    };
    let reference=0;
    for(let i=0;i<count;i++) reference+=periodicReference(-period/2+(i+.5)*step)*step;
    for(const footprint of [0,.001,.01,.04,.1,.3,1]) {
      let integral=0;
      for(let i=0;i<count;i++) integral+=filteredArm(-period/2+(i+.5)*step,width,arms,.08,.33,footprint)*step;
      assert.ok(Math.abs(integral-reference)/reference<.001,'blur preserves integrated arm light within 0.1%');
    }
    for(const offset of [-period/2,-period*.17,0,period*.31,period/2]) {
      const resolved=filteredArm(offset,width,arms,.4,.33,0);
      assert.ok(Math.abs(resolved-periodicReference(offset))<.00001,'zero footprint retains resolved periodic Gaussian arms');
      const unresolved=filteredArm(offset,width,arms,.08,.33,1),mean=width*arms/Math.sqrt(2*Math.PI);
      assert.ok(Math.abs(unresolved-mean)<1e-12,'unresolved arms have no coherent phase stripes');
    }
    const left=filteredArm(-period/2,width,arms,.08,.33,.04),right=filteredArm(period/2,width,arms,.08,.33,.04);
    assert.ok(Math.abs(left-right)<1e-12,'wrapped arm seams stay continuous');
  }
});
