import * as THREE from 'three';
import {STELLAR_PSF_GLSL, STELLAR_PSF_HALO_SIGMA_CSS} from './stellar-psf.js';

/** Unresolved directional sources, with caller-owned positions and appearance.
 * Population is a spatial selection; magnitude visibility is an independent
 * observation threshold. Flux is relative linear light, tone mapped once by
 * the existing scene pipeline. There is no camera, clock or animation owner.
 */
export function createDirectionalStars({positions, colors, flux, magnitudes, ranks, limitingMagnitude = 7.7}) {
  const count = flux.length;
  if (positions.length !== count * 3 || colors.length !== count * 3 || magnitudes.length !== count || ranks.length !== count)
    throw new RangeError('Directional stellar attributes must have matching lengths');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('stellarFlux', new THREE.BufferAttribute(flux, 1));
  geometry.setAttribute('magnitude', new THREE.BufferAttribute(magnitudes, 1));
  geometry.setAttribute('rank', new THREE.BufferAttribute(ranks, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {ratio: {value: 1}, brightness: {value: 1}, density: {value: .2},
      populationTint: {value: new THREE.Color(1, 1, 1)}, bandNormal: {value: new THREE.Vector3(0, 1, 0)}, bandStrength: {value: 0},
      limitingMagnitude: {value: limitingMagnitude}},
    vertexShader: /* glsl */`
      attribute vec3 color;attribute float stellarFlux;attribute float magnitude;attribute float rank;
      uniform float ratio;uniform float density;uniform vec3 populationTint;uniform vec3 bandNormal;uniform float bandStrength;uniform float limitingMagnitude;
      varying vec3 stellarColor;varying float linearFlux;varying float visibility;varying float spritePixels;
      void main(){
        float latitude=dot(normalize(position),bandNormal);
        float population=clamp(density+exp(-latitude*latitude*70.)*bandStrength*.3,0.,1.);
        visibility=(1.-smoothstep(max(0.,population-.035),population+.035,rank))
          *(1.-smoothstep(limitingMagnitude-.3,limitingMagnitude+.3,magnitude));
        if(visibility==0.){gl_Position=vec4(0.,0.,2.,1.);gl_PointSize=1.;return;}
        stellarColor=color*populationTint;linearFlux=stellarFlux;
        spritePixels=ceil(${8 * STELLAR_PSF_HALO_SIGMA_CSS}*ratio);gl_PointSize=spritePixels;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
        #ifdef USE_REVERSED_DEPTH_BUFFER
          gl_Position.z=0.;
        #else
          gl_Position.z=gl_Position.w;
        #endif
      }`,
    fragmentShader: /* glsl */`
      ${STELLAR_PSF_GLSL}
      varying vec3 stellarColor;varying float linearFlux;varying float visibility;varying float spritePixels;
      uniform float ratio;uniform float brightness;
      void main(){
        float energy=stellarPixelEnergy((gl_PointCoord-.5)*spritePixels,ratio);
        gl_FragColor=vec4(stellarColor*linearFlux*brightness*energy,visibility);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
  });
  const points = new THREE.Points(geometry, material); points.frustumCulled = false; points.renderOrder = -1e12;
  const stats = Object.freeze({revision: 1, candidates: count, integratedHaloFraction: .03, photometry: 'relative-magnitude', pixelIntegral: true});
  points.userData.stats = stats;
  let disposed = false;
  points.userData.dispose = () => {if (disposed) return; disposed = true; geometry.dispose(); material.dispose();};
  return points;
}
