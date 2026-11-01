import {Vector2} from 'three';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';

/** Artistic bloom with unit DC gain before strength for a neutral, constant
 * HDR field above the high-pass transition. This is not finite-image energy
 * conservation or a model of stellar light transport.
 */
export function createBloomPass({strength=.35,radius=.65,threshold=1}={}) {
  const pass=new UnrealBloomPass(new Vector2(1,1),strength,radius,threshold);
  for(const material of pass.separableBlurMaterials){
    const uniforms=material.uniforms,weights=uniforms.gaussianWeights.value;
    let total=uniforms.centerWeight.value;
    for(const weight of weights)total+=2*weight;
    uniforms.centerWeight.value/=total;
    for(let i=0;i<weights.length;i++)weights[i]/=total;
  }
  // Three 0.186.1 composites 3 * strength * sum(lerp(w, 1.2-w, radius)).
  // Its actual five factors sum to 3; their complements also sum to 3, so
  // this gain is independent of radius. Blur offsets and tap supports stay put.
  const factors=pass.compositeMaterial.uniforms.bloomFactors.value;
  const compositeGain=3*factors.reduce((sum,factor)=>sum+factor,0);
  for(const tint of pass.bloomTintColors)tint.setScalar(1/compositeGain);

  // Three 0.186.1's native dispose omits its owned high-pass material. Keep
  // its target/material cleanup and release that one omission exactly once.
  const nativeDispose=pass.dispose;
  let disposed=false;
  pass.dispose=()=>{
    if(disposed)return;
    disposed=true;
    try { nativeDispose.call(pass); }
    finally { pass.materialHighPassFilter.dispose(); }
  };
  return pass;
}
