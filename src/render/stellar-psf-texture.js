import * as THREE from 'three';
import {gaussianPixelAxis, stellarPsfSupportPixels, STELLAR_PSF_CORE_SIGMA_CSS,
  STELLAR_PSF_HALO_SIGMA_CSS, STELLAR_PSF_HALO_ENERGY} from './stellar-psf.js';

export const STELLAR_PSF_AXIS_SAMPLES = 4097;
// A 4097-wide row exceeds the 2048 WebGL2 minimum texture-size guarantee.
const TABLE_WIDTH = 1024, TABLE_HEIGHT = Math.ceil(STELLAR_PSF_AXIS_SAMPLES / TABLE_WIDTH);

/** One renderer instance owns this fixed-size RG32F table for its lifetime.
 * R/G store the original core/halo pixel-box axis integrals, not a sampled PSF
 * image. Only a changed physical/CSS pixel ratio refills and uploads the table.
 * Nearest + explicit interpolation needs no float-linear texture extension.
 */
export function createStellarPsfTexture() {
  const data = new Float32Array(TABLE_WIDTH * TABLE_HEIGHT * 2);
  const texture = new THREE.DataTexture(data, TABLE_WIDTH, TABLE_HEIGHT, THREE.RGFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter; texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false; texture.unpackAlignment = 1;
  const uniforms = {stellarPsfTable: {value: texture}, stellarPsfAxisScale: {value: 1}};
  let previousRatio = 0;
  function setPixelRatio(pixelRatio) {
    if (pixelRatio === previousRatio) return;
    const halfSupport = stellarPsfSupportPixels(pixelRatio) * .5;
    const scale = (STELLAR_PSF_AXIS_SAMPLES - 1) / halfSupport;
    const coreSigma = STELLAR_PSF_CORE_SIGMA_CSS * pixelRatio;
    const haloSigma = STELLAR_PSF_HALO_SIGMA_CSS * pixelRatio;
    for (let i = 0; i < STELLAR_PSF_AXIS_SAMPLES; i++) {
      const center = i / scale;
      data[i * 2] = gaussianPixelAxis(center, coreSigma);
      data[i * 2 + 1] = gaussianPixelAxis(center, haloSigma);
    }
    uniforms.stellarPsfAxisScale.value = scale;
    previousRatio = pixelRatio; texture.needsUpdate = true;
  }
  setPixelRatio(1);
  return {texture, uniforms, setPixelRatio, dispose: () => texture.dispose()};
}

/** Four base-level fetches per pixel, with the same separable Gaussian mixture.
 * The sprite bounds the input to the table's physical half-support. The final
 * interval includes its endpoint without fetching past the last texel.
 */
export const STELLAR_PSF_TEXTURE_GLSL = /* glsl */`
  uniform highp sampler2D stellarPsfTable;
  uniform float stellarPsfAxisScale;
  vec2 stellarPixelAxis(float pixelCenter){
    float coordinate=min(abs(pixelCenter)*stellarPsfAxisScale,${STELLAR_PSF_AXIS_SAMPLES - 1}.);
    int lower=min(int(coordinate),${STELLAR_PSF_AXIS_SAMPLES - 2});
    int upper=lower+1;
    return mix(texelFetch(stellarPsfTable,ivec2(lower&1023,lower>>10),0).rg,
      texelFetch(stellarPsfTable,ivec2(upper&1023,upper>>10),0).rg,coordinate-float(lower));
  }
  float stellarPixelEnergy(vec2 pixelCenter){
    vec2 x=stellarPixelAxis(pixelCenter.x),y=stellarPixelAxis(pixelCenter.y);
    return ${1 - STELLAR_PSF_HALO_ENERGY}*x.r*y.r+${STELLAR_PSF_HALO_ENERGY}*x.g*y.g;
  }
`;
