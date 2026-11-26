import * as THREE from 'three';
import {STELLAR_PSF_HALO_SIGMA_CSS} from './stellar-psf.js';
import {createStellarPsfTexture, STELLAR_PSF_TEXTURE_GLSL} from './stellar-psf-texture.js';
import {DISTANT_SKY_FIELD_GLSL, distantSkyFieldUniforms, setDistantSkyField} from './distant-sky-field.js';

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
  const psf = createStellarPsfTexture();
  const material = new THREE.ShaderMaterial({
    uniforms: {...psf.uniforms, ...distantSkyFieldUniforms(), ratio: {value: 1}, brightness: {value: 1}, density: {value: .2},
      populationTint: {value: new THREE.Color(1, 1, 1)}, bandNormal: {value: new THREE.Vector3(0, 1, 0)}, bandStrength: {value: 0},
      limitingMagnitude: {value: limitingMagnitude}, hostStrength: {value: 0}, hostPhase: {value: 0},
      hostCenter: {value: new THREE.Vector3()}, hostNormal: {value: new THREE.Vector3(0,1,0)}, hostFlattening: {value: 0},
      associationCenter: {value: new THREE.Vector3()}, associationAxis: {value: new THREE.Vector3(1,0,0)},
      associationWidth: {value: 1}, associationStretch: {value: 0}},
    vertexShader: /* glsl */`
      attribute vec3 color;attribute float stellarFlux;attribute float magnitude;attribute float rank;
      uniform float ratio;uniform float density;uniform vec3 populationTint;uniform vec3 bandNormal;uniform float bandStrength;uniform float limitingMagnitude;
      varying vec3 stellarColor;varying float linearFlux;varying float visibility;varying float spritePixels;
      uniform vec3 hostCenter,hostNormal,associationCenter,associationAxis;
      uniform float hostStrength,hostPhase,hostFlattening,associationWidth,associationStretch;
      ${DISTANT_SKY_FIELD_GLSL}
      // Length ahead of the observer inside a finite stellar envelope. Both center
      // and minor radius are in host radii. Stretch only its symmetry axis.
      float stellarColumn(vec3 ray,vec3 center,vec3 axis,float stretch,float radius){
        vec3 c=center+axis*(dot(center,axis)*stretch), d=ray+axis*(dot(ray,axis)*stretch);
        float norm2=dot(d,d), along=dot(c,d)/norm2;
        vec3 miss=c-d*along;
        float halfChord=sqrt(max(0.,radius*radius-dot(miss,miss))/norm2);
        return max(0.,along+halfChord-max(0.,along-halfChord));
      }
      float visibleRank(float threshold,float sourceRank){
        return 1.-smoothstep(max(0.,threshold-.035),threshold+.035,sourceRank);
      }
      void main(){
        vec3 ray=normalize(position);
        vec3 fieldTint=vec3(1.);
        float directionalGain=1.+.38*uDistantFieldBlend;
        float latitude=dot(ray,bandNormal);
        float population=clamp(density+exp(-latitude*latitude*70.)*bandStrength*.3,0.,1.);
        float selected=visibleRank(population,rank);
        if(uDistantFieldBlend>0.){
          float field=distantSkyPattern(ray);
          // The diffuse field modulates an existing sparse all-sky population.
          // Even a sparse region resolves part of its own stellar population.
          float remotePopulation=.16+uDistantFieldStyle.x*(.045+.69*smoothstep(.02,.82,field));
          selected=mix(selected,visibleRank(remotePopulation,distantStarRank(rank)),uDistantFieldBlend);
          float fieldWeight=uDistantFieldBlend*uDistantFieldStyle.x*smoothstep(.01,.09,field);
          if(fieldWeight>0.){
            float knots=distantStellarKnots(ray,field);
            fieldTint=mix(vec3(1.),distantStellarTint(knots,field),fieldWeight*smoothstep(.01,.72,field));
            directionalGain+=fieldWeight*(1.25*field+7.2*knots);
          }
        }
        if(hostStrength>0.){
          float depth=stellarColumn(ray,hostCenter,hostNormal,hostFlattening,1.);
          float cluster=stellarColumn(ray,associationCenter,associationAxis,associationStretch,associationWidth);
          float localDensity=clamp(.13+.70*depth+.35*cluster/associationWidth,0.,1.);
          float localRank=fract(rank+hostPhase);
          selected=mix(selected,1.-smoothstep(localDensity-.035,localDensity+.035,localRank),hostStrength);
        }
        visibility=selected*(1.-smoothstep(limitingMagnitude-.3,limitingMagnitude+.3,magnitude));
        if(visibility==0.){gl_Position=vec4(0.,0.,2.,1.);gl_PointSize=1.;return;}
        stellarColor=color*populationTint*fieldTint;linearFlux=stellarFlux*directionalGain;
        spritePixels=ceil(${8 * STELLAR_PSF_HALO_SIGMA_CSS}*ratio);gl_PointSize=spritePixels;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
        #ifdef USE_REVERSED_DEPTH_BUFFER
          gl_Position.z=0.;
        #else
          gl_Position.z=gl_Position.w;
        #endif
      }`,
    fragmentShader: /* glsl */`
      ${STELLAR_PSF_TEXTURE_GLSL}
      varying vec3 stellarColor;varying float linearFlux;varying float visibility;varying float spritePixels;
      uniform float ratio;uniform float brightness;
      void main(){
        float energy=stellarPixelEnergy((gl_PointCoord-.5)*spritePixels);
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
  points.userData.setDistantSkyField = field => {if (!disposed) setDistantSkyField(material.uniforms, field);};
  points.onBeforeRender = () => {if (!disposed) psf.setPixelRatio(material.uniforms.ratio.value);};
  points.userData.dispose = () => {if (disposed) return; disposed = true; psf.dispose(); geometry.dispose(); material.dispose();};
  return points;
}
