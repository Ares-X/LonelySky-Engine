import * as THREE from 'three';
import { deepSkyShader, deepSkyUniforms, setDeepSkyEnvironment } from './deep-sky.js';

const vertexShader = /* glsl */`
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const opticalFragment = detailTexture => /* glsl */`
uniform vec3 uCamera;
uniform mat4 uLocalToWorld, projectionMatrix;
#ifdef BLACK_HOLE_SKY_MAP
  uniform mat3 uSkyRotation;
  uniform sampler2D uSky;
  uniform bool uHasSky;
  uniform float uSkyIntensity;
#endif
uniform float uTime, uSeed, uStepScale;
uniform float visibility;
uniform int uSteps;
varying vec3 vLocal;
const float PI = 3.14159265359;
const float BOUND = 8.0;
const vec3 DISK_NORMAL = vec3(0.0, 0.92847669, 0.37139068);
const vec3 DISK_X = vec3(1.0, 0.0, 0.0);
const vec3 DISK_Y = vec3(0.0, 0.37139068, -0.92847669);
${deepSkyShader(Boolean(detailTexture))}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
// Periodic gradient noise on a sheared polar lattice. Gradient interpolation
// has no value-noise plateaus/zero-slope grid lines; quintic weights are C2.
// Rebasing both lattice axes by the angular tile keeps the atan seam exact.
vec2 polarLatticeGradient(vec2 lattice, float angularPeriod) {
  float angularTile = floor(lattice.y / angularPeriod);
  float phase = hash(vec2(lattice.x - angularTile * angularPeriod,
    mod(lattice.y, angularPeriod)));
  vec2 gradient = abs(fract(vec2(phase, phase + 0.25)) * 4.0 - 2.0) - 1.0;
  return gradient * inversesqrt(dot(gradient, gradient));
}
vec3 polarNoiseGradient(vec2 p, float angularPeriod) {
  // A one-cell-per-angular-cell shear avoids radial/azimuthal grid alignment;
  // the integer period rebase above preserves periodic value and derivatives.
  p = vec2(p.x + p.y, p.y);
  vec2 i = floor(p), f = fract(p);
  vec2 weight = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 slope = 30.0 * f * f * (f - 1.0) * (f - 1.0);
  vec2 a = polarLatticeGradient(i, angularPeriod);
  vec2 b = polarLatticeGradient(i + vec2(1.0, 0.0), angularPeriod);
  vec2 c = polarLatticeGradient(i + vec2(0.0, 1.0), angularPeriod);
  vec2 d = polarLatticeGradient(i + vec2(1.0, 1.0), angularPeriod);
  float av = dot(a, f), bv = dot(b, f - vec2(1.0, 0.0));
  float cv = dot(c, f - vec2(0.0, 1.0)), dv = dot(d, f - vec2(1.0, 1.0));
  float value = mix(mix(av, bv, weight.x), mix(cv, dv, weight.x), weight.y);
  float dx = mix(mix(a.x, b.x, weight.x), mix(c.x, d.x, weight.x), weight.y)
    + slope.x * mix(bv - av, dv - cv, weight.y);
  float dy = mix(mix(a.y, b.y, weight.x), mix(c.y, d.y, weight.x), weight.y)
    + slope.y * mix(cv - av, dv - bv, weight.x);
  // Unit gradients and quintic interpolation bound the raw value by 1/sqrt(2).
  // Chain back through the lattice shear: d/dp.y = d/dq.x + d/dq.y.
  return vec3(0.5 + 0.70710678 * value, 0.70710678 * dx, 0.70710678 * (dx + dy));
}
float polarNoise(vec2 p, float angularPeriod) {
  return polarNoiseGradient(p, angularPeriod).x;
}

vec3 sky(vec3 localDirection) {
  vec3 worldDirection = normalize(mat3(uLocalToWorld) * localDirection);
  // The escaped optical ray samples the same world-fixed radiance as the sky.
  // Sky rotation/intensity belong only to the legacy photographic texture path.
  #ifdef BLACK_HOLE_SKY_MAP
    if(uHasSky){
      vec3 d = normalize(uSkyRotation * worldDirection);
      vec2 uv = vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5,
        asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
      return texture2D(uSky, uv).rgb * uSkyIntensity;
    }
  #endif
  return deepSky(worldDirection);
}

float diskBandWeight(float phaseFootprint) {
  return 1.0 - smoothstep(0.30, 0.85, phaseFootprint);
}
// A phase gradient is projected onto the incoming ray's transverse plane,
// rather than expanding every phase along the disk's most foreshortened axis.
// This is a local planar ray-cone approximation, not a curved-ray differential.
float diskPhaseFootprint(vec3 phaseX, vec3 phaseY, vec3 ray, float coneRadius) {
  float normalRay = dot(DISK_NORMAL, ray);
  // Truly tangent plane intersections have unbounded footprint. Absorb their
  // unresolved detail explicitly instead of dividing by zero or inventing a ray.
  if (abs(normalRay) < 0.00001) return 1000000.0;
  // The material's actual lattice x coordinate is original phaseX+phaseY.
  vec3 shearedX = phaseX + phaseY;
  vec3 projectedX = shearedX - DISK_NORMAL * (dot(shearedX, ray) / normalRay);
  vec3 projectedY = phaseY - DISK_NORMAL * (dot(phaseY, ray) / normalRay);
  return max(length(projectedX), length(projectedY)) * coneRadius;
}
// Bounded, continuous material contrast. This widens dark flow channels and
// bright strands in source space; it is not image sharpening or added light.
float diskLaneContrast(float value) {
  float signedValue = 2.0 * value - 1.0;
  return signedValue / (0.25 + 0.75 * abs(signedValue));
}
// Artistic sheared emission structure, not an MHD or fluid integration.
// Two broad, advected deformations own one continuous flow domain. Wide dark
// channels organize the bundled strands; no independent concentric ring stack.
float diskStructure(float r, float turn, float winding, vec3 radial, vec3 ray, float coneRadius) {
  vec3 turnGradient = cross(DISK_NORMAL, radial) / (2.0 * PI * r)
    + radial * (1.875 * uTime / (2.0 * PI * pow(r, 2.5)));
  vec3 windingGradient = radial / r;

  vec3 bendX = radial * 0.85;
  vec3 bendY = turnGradient * 3.0 + windingGradient * 0.17;
  vec3 bendNoise = polarNoiseGradient(vec2(r * 0.85 + 17.3,
    turn * 3.0 + winding * 0.17), 3.0);
  float bend = bendNoise.x;
  vec3 bendGradient = bendNoise.y * bendX + bendNoise.z * bendY;

  vec3 curlX = radial * 1.8 + bendGradient * 0.8;
  vec3 curlY = turnGradient * 7.0 + windingGradient * 0.4 + bendGradient * 0.3;
  vec3 curlNoise = polarNoiseGradient(vec2(r * 1.8 + (bend - 0.5) * 0.8 + 39.7,
    turn * 7.0 + winding * 0.4 + (bend - 0.5) * 0.3), 7.0);
  float curl = curlNoise.x;
  vec3 curlGradient = curlNoise.y * curlX + curlNoise.z * curlY;

  float flowRadius = r + (bend - 0.5) * 1.2 + (curl - 0.5) * 0.55;
  vec3 flowRadiusGradient = radial + bendGradient * 1.2 + curlGradient * 0.55;
  float flowTurn = turn + (bend - 0.5) * 0.025 + (curl - 0.5) * 0.012;
  vec3 flowTurnGradient = turnGradient + bendGradient * 0.025 + curlGradient * 0.012;

  vec3 channelX = flowRadiusGradient * 3.3;
  vec3 channelY = flowTurnGradient * 9.0 + windingGradient * 0.8;
  vec3 channelNoise = polarNoiseGradient(vec2(flowRadius * 3.3 + 63.9,
    flowTurn * 9.0 + winding * 0.8), 9.0);
  float channel = channelNoise.x;
  vec3 channelGradient = channelNoise.y * channelX + channelNoise.z * channelY;

  vec3 bundleX = flowRadiusGradient * 10.7 + channelGradient * 2.8;
  vec3 bundleY = flowTurnGradient * 17.0 + windingGradient * 1.3;
  vec3 bundleNoise = polarNoiseGradient(vec2(flowRadius * 10.7 + (channel - 0.5) * 2.8 + 97.1,
    flowTurn * 17.0 + winding * 1.3), 17.0);
  float bundle = bundleNoise.x;
  vec3 bundleGradient = bundleNoise.y * bundleX + bundleNoise.z * bundleY;

  vec3 filamentX = flowRadiusGradient * 19.9 + bundleGradient * 1.8 + channelGradient * 2.1;
  vec3 filamentY = flowTurnGradient * 37.0 + windingGradient * 2.1 + bundleGradient * 0.5;
  float filament = polarNoise(vec2(flowRadius * 19.9 + (bundle - 0.5) * 1.8 + (channel - 0.5) * 2.1 + 131.3,
    flowTurn * 37.0 + winding * 2.1 + (bundle - 0.5) * 0.5), 37.0);

  // Same symmetric, bounded contrast and radiance headroom. Filtering each
  // actual warped phase returns unresolved structure to zero expected mean.
  return 0.34 * diskLaneContrast(channel) * diskBandWeight(diskPhaseFootprint(channelX, channelY, ray, coneRadius))
    + 0.32 * diskLaneContrast(bundle) * diskBandWeight(diskPhaseFootprint(bundleX, bundleY, ray, coneRadius))
    + 0.34 * diskLaneContrast(filament) * diskBandWeight(diskPhaseFootprint(filamentX, filamentY, ray, coneRadius));
}

vec3 diskEmission(vec3 p, vec3 lightDirection, float coneRadius) {
  float r = length(p);
  float angle = atan(dot(p, DISK_Y), dot(p, DISK_X));
  float omega = 1.25 / pow(r, 1.5);
  float flow = angle - uTime * omega + uSeed;
  // Visual emission texture, not a fluid solver. All detail follows one
  // differentially advected polar source; radial domain offsets connect the
  // narrow strands into changing flow lanes instead of independent rings.
  float turn = flow / (2.0 * PI);
  float winding = log(r / 2.8);
  float structure = diskStructure(r, turn, winding, p / r, normalize(lightDirection), coneRadius);
  float heat = pow(2.8 / max(r, 2.8), 1.65);
  vec3 tint = mix(vec3(1.0, 0.17, 0.018), vec3(1.0, 0.64, 0.22), heat);
  tint = mix(tint, vec3(1.0, 0.94, 0.77), smoothstep(0.6, 1.0, heat));
  vec3 velocity = normalize(cross(DISK_NORMAL, p));
  float beta = clamp(sqrt(0.5 / max(r - 1.0, 1.0)), 0.0, 0.53);
  float doppler = sqrt(1.0 - beta * beta) /
    max(0.3, 1.0 - beta * dot(velocity, -normalize(lightDirection)));
  float beam = clamp(pow(doppler, 3.0), 0.22, 3.3);
  tint = mix(tint, vec3(1.0, 0.96, 0.84), clamp((doppler - 1.0) * 0.65, 0.0, 0.45));
  // Mean source uses the unchanged thermal/beaming energy and shoulder.
  // Give the material its contrast INSIDE the remaining bounded radiance
  // headroom: it must not be compressed a second time by this same shoulder.
  float meanRadiance = 0.665 * (0.5 + 3.2 * heat * heat) * beam;
  meanRadiance = meanRadiance / (1.0 + meanRadiance / 1.6);
  float contrastHeadroom = min(meanRadiance, 1.6 - meanRadiance);
  float radiance = meanRadiance + 0.95 * contrastHeadroom * structure;
  return tint * radiance;
}

vec3 acceleration(vec3 p, float h2) {
  float r2 = max(dot(p, p), 0.65);
  // A central optical approximation: conserved angular momentum and curved rays.
  // Units are horizon radii; this is not a Kerr metric or a numerical GR solver.
  return -1.5 * h2 * p / (r2 * r2 * sqrt(r2));
}

// Finite Gaussian chord profile. Approximation error of this erf polynomial
// is below 1.5e-7; Newton inversion is bounded to three iterations.
float gaussianErf(float x) {
  float t = 1.0 / (1.0 + 0.3275911 * abs(x));
  float polynomial = (((((1.061405429 * t - 1.453152027) * t)
    + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign(x) * (1.0 - polynomial * exp(-x * x));
}
float gaussianInverseErf(float value) {
  // Use the linear inverse seed where the square-root formula would lose
  // float precision; the same bounded Newton solve refines both seeds.
  float x;
  if (abs(value) < 0.01) {
    x = value * 0.886226925;
  } else {
    float logarithm = log(1.0 - value * value);
    float term = 2.0 / (PI * 0.147) + logarithm * 0.5;
    x = sign(value) * sqrt(sqrt(term * term - logarithm / 0.147) - term);
  }
  for (int j = 0; j < 3; j++) {
    x -= (gaussianErf(x) - value) / (1.128379167 * exp(-x * x));
  }
  return x;
}
float gaussianChordFraction(float opticalFraction, float height0, float heightDelta,
  float thickness, float erfStart, float erfEnd, float nearFraction, float farFraction, bool tangent) {
  if (tangent) return opticalFraction;
  // Newton/float error is projected back onto this actual finite chord.
  return clamp((thickness * gaussianInverseErf(mix(erfStart, erfEnd, opticalFraction))
    - height0) / heightDelta, nearFraction, farFraction);
}

void main() {
  if (visibility <= 0.0) discard;
  vec3 originalDirection = normalize(vLocal - uCamera);
  // Derivatives are evaluated before ray-dependent branches or loop exits.
  float pixelCone = max(length(dFdx(originalDirection)), length(dFdy(originalDirection)));
  float b = dot(uCamera, originalDirection);
  float discriminant = b * b - dot(uCamera, uCamera) + BOUND * BOUND;
  if (discriminant <= 0.0) discard;
  float entry = max(0.0, -b - sqrt(discriminant));
  vec3 p = uCamera + originalDirection * (entry + 0.001);
  vec3 v = originalDirection;
  vec3 angularMomentum = cross(p, v);
  float h2 = dot(angularMomentum, angularMomentum);
  float impact = sqrt(h2);
  if (impact > 7.96) discard;
  vec3 emission = vec3(0.0);
  float transmission = 1.0;
  float traveled = entry;
  float firstDiskDistance = -1.0;
  bool captured = false;
  bool escaped = false;

  for (int i = 0; i < 144; i++) {
    if (i >= uSteps) break;
    float r = length(p);
    if (r < 1.01) { captured = true; break; }
    if (r > BOUND + 0.01 && dot(p, v) > 0.0) { escaped = true; break; }
    float dt = clamp(r * uStepScale, 0.035, 0.65);
    // Midpoint integration keeps the thin secondary disk image continuous.
    vec3 a = acceleration(p, h2);
    vec3 midpoint = p + v * dt * 0.5;
    vec3 nextV = v + acceleration(midpoint, h2) * dt;
    vec3 nextP = p + (v + a * dt * 0.5) * dt;
    float oldHeight = dot(p, DISK_NORMAL);
    float newHeight = dot(nextP, DISK_NORMAL);
    float heightDelta = newHeight - oldHeight;
    float segmentLength = length(nextP - p);
    float middleHeight = (oldHeight + newHeight) * 0.5;
    vec3 middlePoint = (p + nextP) * 0.5 - DISK_NORMAL * middleHeight;
    float profileRadius = length(middlePoint);
    float thickness = 0.032 * sqrt(max(profileRadius, 1.0));
    float window = smoothstep(2.72, 2.94, profileRadius)
      * (1.0 - smoothstep(5.7, 7.0, profileRadius));
    float opticalDepth = 0.0;
    float nearFraction = 0.0, farFraction = 1.0;
    float erfStart = 0.0, erfEnd = 0.0;
    bool tangent = abs(heightDelta) < 0.00001;
    if (window > 0.001) {
      if (tangent) {
        // Exact constant-height limit on this finite segment; no 1/normalRay.
        if (abs(middleHeight) < thickness * 2.5) {
          opticalDepth = segmentLength * window / thickness * 1.15
            * exp(-middleHeight * middleHeight / (thickness * thickness));
        }
      } else {
        float boundaryA = (-2.5 * thickness - oldHeight) / heightDelta;
        float boundaryB = (2.5 * thickness - oldHeight) / heightDelta;
        nearFraction = clamp(min(boundaryA, boundaryB), 0.0, 1.0);
        farFraction = clamp(max(boundaryA, boundaryB), 0.0, 1.0);
        if (farFraction > nearFraction) {
          erfStart = gaussianErf((oldHeight + heightDelta * nearFraction) / thickness);
          erfEnd = gaussianErf((oldHeight + heightDelta * farFraction) / thickness);
          opticalDepth = segmentLength * 0.886226925 * (erfEnd - erfStart)
            / heightDelta * window * 1.15;
        }
      }
    }
    if (opticalDepth > 0.0) {
      float opacity = 1.0 - exp(-opticalDepth);
      vec3 sourceSum = vec3(0.0);
      // Two positive Gauss nodes in absorbed-light mass, not fixed ray-step
      // endpoints. Their physical source coordinates vary continuously.
      for (int j = 0; j < 2; j++) {
        float absorptionFraction = j == 0 ? 0.211324865405187 : 0.788675134594813;
        float opticalFraction = -log(1.0 - absorptionFraction * opacity) / opticalDepth;
        float sourceFraction = gaussianChordFraction(opticalFraction, oldHeight, heightDelta,
          thickness, erfStart, erfEnd, nearFraction, farFraction, tangent);
        vec3 sourcePoint = mix(p, nextP, sourceFraction);
        sourcePoint -= DISK_NORMAL * dot(sourcePoint, DISK_NORMAL);
        vec3 sourceVelocity = mix(v, nextV, sourceFraction);
        float coneRadius = pixelCone * (traveled + segmentLength * sourceFraction);
        sourceSum += diskEmission(sourcePoint, sourceVelocity, coneRadius);
      }
      emission += transmission * opacity * 0.5 * sourceSum;
      // Locate the same 8% detectable encounter cumulatively, rather than
      // making depth depend on whether one arbitrary segment alone exceeds it.
      if (firstDiskDistance < 0.0 && 1.0 - transmission * (1.0 - opacity) > 0.08) {
        float opticalFraction = clamp(log(transmission / 0.92) / opticalDepth, 0.0, 1.0);
        float encounter = gaussianChordFraction(opticalFraction, oldHeight, heightDelta,
          thickness, erfStart, erfEnd, nearFraction, farFraction, tangent);
        firstDiskDistance = traveled + segmentLength * encounter;
      }
      transmission *= 1.0 - opacity;
    }
    traveled += length(nextP - p);
    p = nextP;
    v = nextV;
    if (transmission < 0.008) break;
  }

  // Unresolved near-critical orbits are absorbed rather than leaking the sky
  // through the shadow when the low quality integration runs out of steps.
  if (!escaped && transmission > 0.008) captured = true;
  vec3 color = emission;
  if (!captured) color += sky(normalize(v)) * transmission;
  float lensFade = 1.0 - smoothstep(5.6, 7.95, impact);
  float alpha = max(lensFade, 1.0 - transmission) * visibility;
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(color, alpha);

  // The enclosing back face is only a rasterization proxy. Put the pixel at
  // the first disk encounter or centre plane, so foreground planets still win.
  // An escaped outward ray inside the proxy has no forward centre plane.
  // Its optical sky contribution belongs at far depth; using .001 would place
  // the entire back face in front of every physical foreground surface. A
  // forward disk encounter still owns its actual depth, even on outward rays.
  if (firstDiskDistance <= 0.0 && b >= 0.0 && escaped && !captured) {
    #ifdef USE_REVERSED_DEPTH_BUFFER
      gl_FragDepth = 0.0;
    #else
      gl_FragDepth = 1.0;
    #endif
  } else {
    float depthDistance = firstDiskDistance > 0.0 ? firstDiskDistance : max(0.001, -b);
    vec3 depthPoint = uCamera + originalDirection * depthDistance;
    vec4 clip = projectionMatrix * (viewMatrix * (uLocalToWorld * vec4(depthPoint, 1.0)));
    #ifdef USE_REVERSED_DEPTH_BUFFER
      gl_FragDepth = clamp(clip.z / max(clip.w, 0.0001), 0.0, 1.0);
    #else
      gl_FragDepth = clamp(0.5 * clip.z / max(clip.w, 0.0001) + 0.5, 0.0, 1.0);
    #endif
  }
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** A view-dependent, bounded black-hole optical effect. radius is horizon scale. */
export function createBlackHole({ radius = 600, seed = 0, skyTexture = null, detailTexture = null } = {}) {
  const group = new THREE.Group();
  group.name = 'Black hole — curved light and accretion disk';
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 600;
  const numericSeed = typeof seed === 'number' ? seed : [...String(seed)]
    .reduce((value, character) => (value * 31 + character.charCodeAt(0)) | 0, 0);
  const uniforms = {
    ...deepSkyUniforms({detailTexture}),
    visibility: { value: 1 },
    uCamera: { value: new THREE.Vector3(0, 0, 20) },
    uLocalToWorld: { value: new THREE.Matrix4() },
    uSkyRotation: { value: new THREE.Matrix3() },
    uSkyIntensity: { value: 1 },
    uSky: { value: skyTexture },
    uHasSky: { value: Boolean(skyTexture) },
    uTime: { value: 0 },
    uSeed: { value: Number.isFinite(numericSeed) ? (numericSeed % 997) * 0.017 : 0 },
    uStepScale: { value: 0.075 },
    uSteps: { value: 120 },
  };
  const geometry = new THREE.SphereGeometry(8, 48, 32);
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader:opticalFragment(detailTexture),
    defines:skyTexture?{BLACK_HOLE_SKY_MAP:1}:{},
    side: THREE.BackSide,
    transparent: true,
    depthTest: true,
    depthWrite: true,
    toneMapped: true,
  });
  const volume = new THREE.Mesh(geometry, material);
  volume.name = 'Bounded optical ray volume';
  volume.scale.setScalar(safeRadius);
  // Sort after the opaque scene. Custom fragment depth keeps foreground occlusion.
  volume.renderOrder = 5;
  group.add(volume);
  const cameraPosition = new THREE.Vector3();
  let disposed = false;
  group.userData.setVisibility = (value) => {
    if (disposed) return;
    uniforms.visibility.value = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  };
  group.userData.stats = { radius: safeRadius, boundRadius: safeRadius * 8, steps: 120, opticalApproximation: true };
  group.userData.setEnvironment = (environment, quiet = 0) => {
    if (disposed || !environment) return;
    setDeepSkyEnvironment(uniforms, environment, quiet);
    // An explicit shared environment supersedes any caller-supplied legacy map.
    uniforms.uHasSky.value = false;
  };
  group.userData.setSkyTransform = (matrix3, intensity = 1) => {
    if (disposed) return;
    if (matrix3?.isMatrix3) uniforms.uSkyRotation.value.copy(matrix3);
    uniforms.uSkyIntensity.value = Number.isFinite(intensity) ? Math.max(0, intensity) : 1;
  };
  group.userData.update = (camera, time, { quality = 'auto' } = {}) => {
    if (disposed || !camera) return;
    group.updateWorldMatrix(true, true);
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(cameraPosition);
    uniforms.uCamera.value.copy(cameraPosition);
    volume.worldToLocal(uniforms.uCamera.value);
    uniforms.uLocalToWorld.value.copy(volume.matrixWorld);
    uniforms.uTime.value = Number.isFinite(time) ? time : 0;
    uniforms.uSteps.value = quality === 'low' ? 72 : quality === 'high' ? 144 : 120;
    uniforms.uStepScale.value = quality === 'low' ? 0.12 : quality === 'high' ? 0.06 : 0.075;
    group.userData.stats.steps = uniforms.uSteps.value;
  };
  group.userData.dispose = () => {
    if (disposed) return;
    disposed = true;
    geometry.dispose();
    material.dispose();
  };
  return group;
}
