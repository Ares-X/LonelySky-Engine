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

test('shared broad/lane phase matches independent rotated kernels across axes, seams, footprints and bars', t => {
  const haze=createGalaxyHaze();haze.userData.setDescriptors(descriptors);
  const shader=haze.children[0].material.fragmentShader;
  const body=name=>{
    const match=shader.match(new RegExp(`(?:float|vec2) ${name}\\([^)]*\\)\\{([\\s\\S]*?)\\n  \\}`));
    assert.ok(match);return match[1].replace(/\bfloat\b/g,'let').replace(/\bvec3\s+(\w+)\s*=/g,'let $1=')
      .replace(/vec3\((angularOffset-period,angularOffset,angularOffset\+period)\)\/sigma/g,'vec3($1).map(n=>n/sigma)')
      .replace(/exp\(-\.5\*offsets\*offsets\)/g,'offsets.map(n=>exp(-.5*n*n))');
  };
  const smoothstep=(a,b,n)=>{const f=Math.max(0,Math.min(1,(n-a)/(b-a)));return f*f*(3-2*f);};
  const scope={sqrt:Math.sqrt,exp:Math.exp,max:Math.max,log:Math.log,sin:Math.sin,cos:Math.cos,floor:Math.floor,
    atan:Math.atan2,length:p=>Math.hypot(p.x,p.y),vec2:(x,y)=>[x,y],vec3:(...p)=>p.length===1?[p[0],p[0],p[0]]:p,
    dot:(a,b)=>a.reduce((s,n,i)=>s+n*b[i],0),mix:(a,b,f)=>a*(1-f)+b*f,smoothstep};
  const lobe=Function('angularOffset','width','angularVariance','period','arms',...Object.keys(scope),body('armLobe'));
  const paired=Function('p','width','footprint','arms','pitch','armLobe',...Object.keys(scope),body('armDensities'));
  const run=(p,width,footprint,arms,pitch)=>paired({x:p[0],y:p[1]},width,footprint,arms,pitch,
    (offset,w,variance,period)=>lobe(offset,w,variance,period,arms,...Object.values(scope)),...Object.values(scope));
  // Independent pre-optimization implementation, including the actual former
  // column-major matrix rotation. No shared phase or shared variance is used.
  const legacy=(p,width,footprint,arms,pitch)=>{
    const r=Math.hypot(...p);if(r<=.000001)return width*arms*.3989422804;
    const phase=(Math.atan2(p[1],p[0])-Math.log(r+.06)/pitch)*arms;
    const offset=Math.atan2(Math.sin(phase),Math.cos(phase))/arms;
    const gradient=Math.sqrt(1/Math.max(r*r,.000001)+1/(pitch*(r+.06))**2);
    const sigma=Math.sqrt(width*width+(footprint*gradient)**2/12),period=6.28318530718/arms;
    const filtered=[offset-period,offset,offset+period].reduce((sum,n)=>sum+Math.exp(-.5*(n/sigma)**2),0)*width/sigma;
    return filtered*(1-smoothstep(.3,.55,sigma/period))+width*arms*.3989422804*smoothstep(.3,.55,sigma/period);
  };
  const reference=(p,width,footprint,arms,pitch)=>{
    const a=.075,c=Math.cos(a),s=Math.sin(a),rotated=[c*p[0]+s*p[1],-s*p[0]+c*p[1]];
    return [legacy(p,width,footprint,arms,pitch),legacy(rotated,width*.24,footprint,arms,pitch)];
  };
  let maximumError=0,comparisons=0;
  const check=(actual,expected)=>{
    for(let i=0;i<2;i++){
      assert.ok(Number.isFinite(actual[i])&&actual[i]>=0);
      const error=Math.abs(actual[i]-expected[i]);maximumError=Math.max(maximumError,error);comparisons++;
      assert.ok(error<5e-10,`shared kernel differs from independent rotated kernel by ${error}`);
    }
  };
  for(const arms of [2,3,4,6])for(const pitch of [.22,.33,.41])for(const width of [.27,.305]){
    for(const r of [0,1e-12,.999e-6,1.001e-6,.01,.2,.98,2.8])for(const footprint of [0,1e-6,.001,.03,.1,1]){
      const seam=Math.log(r+.06)/pitch+Math.PI/arms;
      const angles=[-Math.PI,-2.1,-.3,0,.7,Math.PI,seam-1e-9,seam,seam+1e-9,seam+.075-1e-9,seam+.075,seam+.075+1e-9];
      for(const angle of angles){
        const p=[r*Math.cos(angle),r*Math.sin(angle)];
        check(run(p,width,footprint,arms,pitch),reference(p,width,footprint,arms,pitch));
        const unbarred=[p[0]/1.6,p[1]/.45],inside=1-smoothstep(.27,.31,Math.hypot(...unbarred));
        const old=reference(p,width,footprint,arms,pitch),oldBar=reference(unbarred,width,footprint/.45,arms,pitch);
        const expected=old.map((n,i)=>n*(1-inside)+oldBar[i]*inside);
        let actual=run(p,width,footprint,arms,pitch);
        if(inside>0){const next=run(unbarred,width,footprint/.45,arms,pitch);actual=actual.map((n,i)=>n*(1-inside)+next[i]*inside);}
        check(actual,expected);
      }
    }
  }
  t.diagnostic(`${comparisons} kernel comparisons; maximum absolute error ${maximumError}`);
  haze.userData.dispose();
});
