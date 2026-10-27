import * as THREE from 'three';
import { DEEP_SKY_GLSL, deepSkyUniforms, setDeepSkyEnvironment } from './deep-sky.js';

const vertexShader = /* glsl */`
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */`
uniform vec3 uCamera;
uniform mat4 uLocalToWorld, projectionMatrix;
uniform mat3 uSkyRotation;
uniform sampler2D uSky;
uniform bool uHasSky;
uniform float uTime, uSeed, uStepScale, uSkyIntensity;
uniform float visibility;
uniform int uSteps;
varying vec3 vLocal;
const float PI = 3.14159265359;
const float BOUND = 8.0;
const vec3 DISK_NORMAL = vec3(0.0, 0.92847669, 0.37139068);
const vec3 DISK_X = vec3(1.0, 0.0, 0.0);
const vec3 DISK_Y = vec3(0.0, 0.37139068, -0.92847669);
${DEEP_SKY_GLSL}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
    mix(hash(i + vec2(0, 1)), hash(i + 1.0), f.x), f.y);
}

vec3 sky(vec3 localDirection) {
  vec3 worldDirection = normalize(mat3(uLocalToWorld) * localDirection);
  // The escaped optical ray samples the same world-fixed radiance as the sky.
  // Sky rotation/intensity belong only to the legacy photographic texture path.
  if (!uHasSky) return deepSky(worldDirection);
  vec3 d = normalize(uSkyRotation * worldDirection);
  vec2 uv = vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5,
    asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
  return texture2D(uSky, uv).rgb * uSkyIntensity;
}

vec3 diskEmission(vec3 p, vec3 lightDirection) {
  float r = length(p);
  float angle = atan(dot(p, DISK_Y), dot(p, DISK_X));
  float omega = 1.25 / pow(r, 1.5);
  float flow = angle - uTime * omega + uSeed;
  // Differential rotation stretches irregular bright knots into fine spiral lanes.
  float broad = noise(vec2(r * 3.6, sin(flow) * 3.0 + cos(flow) * 2.0));
  float lane = sin(r * 46.0 + flow * 4.0 + broad * 5.0);
  float fine = sin(r * 113.0 - flow * 9.0 + broad * 8.0);
  float texture = 0.52 + 0.29 * broad + 0.14 * lane + 0.055 * fine;
  float heat = pow(2.8 / max(r, 2.8), 1.65);
  vec3 tint = mix(vec3(1.0, 0.17, 0.018), vec3(1.0, 0.64, 0.22), heat);
  tint = mix(tint, vec3(1.0, 0.94, 0.77), smoothstep(0.6, 1.0, heat));
  vec3 velocity = normalize(cross(DISK_NORMAL, p));
  float beta = clamp(sqrt(0.5 / max(r - 1.0, 1.0)), 0.0, 0.53);
  float doppler = sqrt(1.0 - beta * beta) /
    max(0.3, 1.0 - beta * dot(velocity, -normalize(lightDirection)));
  float beam = clamp(pow(doppler, 3.0), 0.22, 3.3);
  tint = mix(tint, vec3(1.0, 0.96, 0.84), clamp((doppler - 1.0) * 0.65, 0.0, 0.45));
  float radiance = texture * (0.5 + 3.2 * heat * heat) * beam;
  // Bound the source before bloom: extreme beaming otherwise fills the black
  // shadow with a broad halo. One scalar shoulder preserves the disk's hue.
  radiance = radiance / (1.0 + radiance / 1.6);
  return tint * radiance;
}

vec3 acceleration(vec3 p, float h2) {
  float r2 = max(dot(p, p), 0.65);
  // A central optical approximation: conserved angular momentum and curved rays.
  // Units are horizon radii; this is not a Kerr metric or a numerical GR solver.
  return -1.5 * h2 * p / (r2 * r2 * sqrt(r2));
}

void main() {
  if (visibility <= 0.0) discard;
  vec3 originalDirection = normalize(vLocal - uCamera);
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
    float dh = newHeight - oldHeight;
    float fraction = abs(dh) > 0.00001 ? clamp(-oldHeight / dh, 0.0, 1.0) : 0.5;
    vec3 diskPoint = mix(p, nextP, fraction);
    float diskRadius = length(diskPoint - DISK_NORMAL * dot(diskPoint, DISK_NORMAL));
    float thickness = 0.032 * sqrt(max(diskRadius, 1.0));
    float height = abs(dot(diskPoint, DISK_NORMAL));
    float window = smoothstep(2.72, 2.94, diskRadius) * (1.0 - smoothstep(5.7, 7.0, diskRadius));
    if (window > 0.001 && height < thickness * 2.5) {
      float path = min(length(nextP - p), 2.0 * thickness /
        max(abs(dot(normalize(v), DISK_NORMAL)), 0.015));
      float density = exp(-height * height / (thickness * thickness));
      float opacity = 1.0 - exp(-density * path * window / thickness * 1.15);
      vec3 planarPoint = diskPoint - DISK_NORMAL * dot(diskPoint, DISK_NORMAL);
      emission += transmission * opacity * diskEmission(planarPoint, v);
      if (firstDiskDistance < 0.0 && opacity > 0.08) firstDiskDistance = traveled + dt * fraction;
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
  // Always bind a complete texture; it is unused when the procedural sky is active.
  const fallbackTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  fallbackTexture.needsUpdate = true;
  const numericSeed = typeof seed === 'number' ? seed : [...String(seed)]
    .reduce((value, character) => (value * 31 + character.charCodeAt(0)) | 0, 0);
  const uniforms = {
    ...deepSkyUniforms({detailTexture}),
    visibility: { value: 1 },
    uCamera: { value: new THREE.Vector3(0, 0, 20) },
    uLocalToWorld: { value: new THREE.Matrix4() },
    uSkyRotation: { value: new THREE.Matrix3() },
    uSkyIntensity: { value: 1 },
    uSky: { value: skyTexture || fallbackTexture },
    uHasSky: { value: Boolean(skyTexture) },
    uTime: { value: 0 },
    uSeed: { value: Number.isFinite(numericSeed) ? (numericSeed % 997) * 0.017 : 0 },
    uStepScale: { value: 0.075 },
    uSteps: { value: 120 },
  };
  const geometry = new THREE.SphereGeometry(8, 48, 32);
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader, fragmentShader,
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
    fallbackTexture.dispose();
  };
  return group;
}
