import test from 'node:test';
import assert from 'node:assert/strict';
import {Vector2} from 'three';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {createBloomPass} from '../../src/render/bloom.js';

// Read the installed shader's actual scale, complement and five texture terms.
// This dependency-boundary test must fail if its composition contract changes.
function compositeSpec(pass){
  const shader=pass.compositeMaterial.fragmentShader;
  const scale=shader.match(/vec3 bloom\s*=\s*([\d.]+)\s*\*\s*bloomStrength/);
  const complement=shader.match(/float mirrorFactor\s*=\s*([\d.]+)\s*-\s*factor/);
  assert.ok(scale);assert.ok(complement);
  const terms=[...shader.matchAll(/lerpBloomFactor\( bloomFactors\[ (\d+) \] \) \* bloomTintColors\[ (\d+) \] \* texture2D\( blurTexture(\d+), vUv \)\.rgb/g)];
  assert.equal(terms.length,pass.nMips);
  for(let i=0;i<terms.length;i++)assert.deepEqual(terms[i].slice(1).map(Number),[i,i,i+1]);
  return {scale:Number(scale[1]),complement:Number(complement[1])};
}
function kernelDC(material,quantize=Number){
  const uniforms=material.uniforms;
  // Constant texels enter once at the center and once on each side of every
  // paired tap, exactly as the installed separable shader consumes them.
  assert.match(material.fragmentShader,/diffuseSum \+= \( sample1 \+ sample2 \) \* gaussianWeights\[ i \]/);
  return quantize(uniforms.centerWeight.value)+2*uniforms.gaussianWeights.value.reduce((sum,weight)=>sum+quantize(weight),0);
}
function constantFieldBloom(pass,radius,input,quantize=Number){
  const {scale,complement}=compositeSpec(pass),factors=pass.compositeMaterial.uniforms.bloomFactors.value;
  const result=[0,0,0];let cumulativeDC=1;
  for(let i=0;i<pass.nMips;i++){
    cumulativeDC*=kernelDC(pass.separableBlurMaterials[i],quantize)**2;
    const factor=quantize(factors[i]),r=quantize(radius);
    const weight=(1-r)*factor+r*(quantize(complement)-factor);
    for(let c=0;c<3;c++)result[c]+=weight*quantize(pass.bloomTintColors[i].getComponent(c))*cumulativeDC*input[c];
  }
  return result.map(value=>value*quantize(scale)*quantize(pass.strength));
}
const disposeNative=pass=>{pass.dispose();pass.materialHighPassFilter.dispose();};

test('the native pass API and defaults retain the existing render path',()=>{
  const pass=createBloomPass();
  try{
    assert.ok(pass instanceof UnrealBloomPass);assert.equal(Object.getPrototypeOf(pass),UnrealBloomPass.prototype);
    assert.equal(pass.render,UnrealBloomPass.prototype.render);assert.equal(pass.setSize,UnrealBloomPass.prototype.setSize);
    assert.equal(pass.strength,.35);assert.equal(pass.radius,.65);assert.equal(pass.threshold,1);assert.equal(pass.enabled,true);
    assert.deepEqual(pass.resolution.toArray(),[1,1]);
    assert.equal(pass.renderTargetsHorizontal.length,pass.nMips);assert.equal(pass.renderTargetsVertical.length,pass.nMips);
  }finally{pass.dispose();}
});

test('actual finite kernels and complementary mip weights give unit DC before strength',()=>{
  const pass=createBloomPass({strength:.42,radius:.65,threshold:1});
  try{
    const spec=compositeSpec(pass),factors=pass.compositeMaterial.uniforms.bloomFactors.value;
    assert.equal(factors.length,5);assert.deepEqual(factors,[1,.8,.6,.4,.2]);
    assert.ok(Math.abs(factors.reduce((sum,f)=>sum+f,0)-factors.reduce((sum,f)=>sum+spec.complement-f,0))<1e-14);
    for(const material of pass.separableBlurMaterials){
      assert.ok(Math.abs(kernelDC(material)-1)<1e-14);
      assert.ok(Math.abs(kernelDC(material,Math.fround)-1)<1e-7);
    }
    // Above the actual high-pass transition, a constant HDR field is passed
    // through. This tests DC response, not energy of arbitrary finite images.
    const highPass=pass.highPassUniforms,input=[2,3,4];
    assert.ok(input.every(value=>value>highPass.luminosityThreshold.value+highPass.smoothWidth.value));
    for(const strength of [0,.42])for(const radius of [0,.65,1]){
      pass.strength=strength;pass.radius=radius;
      const output=constantFieldBloom(pass,radius,input),uploaded=constantFieldBloom(pass,radius,input,Math.fround);
      for(let c=0;c<3;c++){
        assert.ok(Math.abs(output[c]-input[c]*strength)<1e-13);
        assert.ok(Math.abs(uploaded[c]-input[c]*strength)<1e-6,'Float32 uniform rounding remains bounded');
      }
    }
  }finally{pass.dispose();}
});

test('normalization preserves native shaders, paired offsets and resource layout',()=>{
  const pass=createBloomPass({strength:.18,radius:1,threshold:1.7}),native=new UnrealBloomPass(new Vector2(1,1),.18,1,1.7);
  try{
    assert.equal(pass.strength,native.strength);assert.equal(pass.radius,native.radius);assert.equal(pass.threshold,native.threshold);
    assert.equal(pass.highPassUniforms.luminosityThreshold.value,native.highPassUniforms.luminosityThreshold.value);
    assert.equal(pass.highPassUniforms.smoothWidth.value,native.highPassUniforms.smoothWidth.value);
    assert.equal(pass.materialHighPassFilter.fragmentShader,native.materialHighPassFilter.fragmentShader);
    assert.equal(pass.compositeMaterial.fragmentShader,native.compositeMaterial.fragmentShader);
    assert.equal(pass.nMips,native.nMips);
    for(let i=0;i<pass.nMips;i++){
      const material=pass.separableBlurMaterials[i],original=native.separableBlurMaterials[i];
      assert.equal(material.fragmentShader,original.fragmentShader);assert.deepEqual(material.defines,original.defines);
      assert.deepEqual(material.uniforms.gaussianOffsets.value,original.uniforms.gaussianOffsets.value);
      assert.equal(material.uniforms.gaussianWeights.value.length,original.uniforms.gaussianWeights.value.length);
    }
    const targets=[pass.renderTargetBright,...pass.renderTargetsHorizontal,...pass.renderTargetsVertical];
    const weights=pass.separableBlurMaterials.map(material=>material.uniforms.gaussianWeights.value);
    pass.setSize(1920,1080);
    assert.deepEqual([pass.renderTargetBright,...pass.renderTargetsHorizontal,...pass.renderTargetsVertical],targets);
    for(let i=0;i<weights.length;i++)assert.equal(pass.separableBlurMaterials[i].uniforms.gaussianWeights.value,weights[i]);
  }finally{pass.dispose();disposeNative(native);}
});

test('instances own their normalization coefficients independently',()=>{
  const first=createBloomPass(),second=createBloomPass();
  try{
    const firstWeights=first.separableBlurMaterials[0].uniforms.gaussianWeights.value;
    const secondWeights=second.separableBlurMaterials[0].uniforms.gaussianWeights.value,before=[...secondWeights];
    assert.notEqual(firstWeights,secondWeights);assert.notEqual(first.bloomTintColors,second.bloomTintColors);
    firstWeights[0]*=.5;first.bloomTintColors[0].setScalar(.7);first.strength=0;
    assert.deepEqual(secondWeights,before);assert.ok(Math.abs(second.bloomTintColors[0].x-1/9)<1e-15);
    assert.equal(second.strength,.35);
  }finally{first.dispose();second.dispose();}
});

test('all native targets and owned materials, including high-pass, dispose exactly once',()=>{
  const pass=createBloomPass();
  const resources=[pass.renderTargetBright,...pass.renderTargetsHorizontal,...pass.renderTargetsVertical,
    pass.materialHighPassFilter,...pass.separableBlurMaterials,pass.compositeMaterial,pass.blendMaterial,pass._basic,pass._fsQuad._mesh.geometry];
  const counts=resources.map(()=>0);
  resources.forEach((resource,i)=>resource.addEventListener('dispose',()=>counts[i]++));
  pass.dispose();pass.dispose();
  assert.deepEqual(counts,resources.map(()=>1));
});
