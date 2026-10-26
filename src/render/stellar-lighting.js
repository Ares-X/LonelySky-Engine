import * as THREE from 'three';

export const MAX_STELLAR_LIGHTS = 2;
export const MAX_STELLAR_OCCLUDERS = 2;
const NO_OCCLUDERS = Object.freeze([]);

// Allocated once with each material. The legacy directional light remains live
// until a caller supplies a scene sample, including an explicitly empty sample.
export function stellarLightingUniforms() {
  return {
    stellarLighting: { value: false }, stellarCount: { value: 0 },
    stellarOffsets: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    stellarColors: { value: [new THREE.Color(), new THREE.Color()] },
    stellarIntensities: { value: new Float32Array(2) },
    stellarRadii: { value: new Float32Array(2) },
    occluderCount: { value: 0 },
    occluderOffsets: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    occluderRadii: { value: new Float32Array(2) },
  };
}

function validateOffset(offset) {
  if (!offset || offset.length !== 3) throw new TypeError('Stellar offsets must contain three coordinates');
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(offset[i]) || Math.abs(offset[i]) > 1e15) {
      throw new TypeError('Stellar offsets must contain finite coordinates within 1e15 world units');
    }
  }
}
function validatePositive(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1e15) throw new TypeError(`${name} must be finite and between 0 and 1e15`);
}

/** Copy a bounded scene sample in untranslated world axes, relative to the receiver's center. */
export function setStellarLighting(material, lights, occluders = NO_OCCLUDERS) {
  const uniforms = material.uniforms;
  if (!uniforms?.stellarLighting) throw new TypeError('Material does not support stellar lighting');
  if (!Array.isArray(lights) || lights.length > MAX_STELLAR_LIGHTS || !Array.isArray(occluders) || occluders.length > MAX_STELLAR_OCCLUDERS) {
    throw new RangeError('Stellar lighting supports at most two lights and two occluders');
  }
  // Validate before mutation so an invalid scene sample cannot partly replace a valid one.
  for (let i = 0; i < lights.length; i++) {
    const light = lights[i];
    validateOffset(light.offset); validatePositive(light.intensity, 'Stellar intensity'); validatePositive(light.radius, 'Stellar radius');
    if (!Number.isInteger(light.color) || light.color < 0 || light.color > 0xffffff) throw new TypeError('Stellar color must be a 24-bit hex color');
  }
  for (let i = 0; i < occluders.length; i++) {
    validateOffset(occluders[i].offset); validatePositive(occluders[i].radius, 'Occluder radius');
  }
  for (let i = 0; i < MAX_STELLAR_LIGHTS; i++) {
    const light = lights[i];
    if (light) {
      uniforms.stellarOffsets.value[i].fromArray(light.offset);
      uniforms.stellarColors.value[i].setHex(light.color);
    }
    uniforms.stellarIntensities.value[i] = light?.intensity ?? 0;
    uniforms.stellarRadii.value[i] = light?.radius ?? 0;
  }
  for (let i = 0; i < MAX_STELLAR_OCCLUDERS; i++) {
    const occluder = occluders[i];
    if (occluder) uniforms.occluderOffsets.value[i].fromArray(occluder.offset);
    uniforms.occluderRadii.value[i] = occluder?.radius ?? 0;
  }
  uniforms.stellarCount.value = lights.length;
  uniforms.occluderCount.value = occluders.length;
  uniforms.stellarLighting.value = true;
}

export function planetRingShadowUniforms() {
  return {
    ringShadowEnabled: { value: false }, ringShadowNormal: { value: new THREE.Vector3(0, 1, 0) },
    ringShadowMap: { value: null }, ringShadowUseMap: { value: false }, ringShadowSeed: { value: 0 },
  };
}

/** The texture is borrowed, as it is by ringMaterial; disposing a material never disposes it. */
export function setPlanetRingShadow(material, { normal, texture = null, seed = 0, enabled = true }) {
  const uniforms = material.uniforms;
  if (!uniforms?.ringShadowEnabled) throw new TypeError('Material does not support ring shadows');
  validateOffset(normal);
  if (Math.hypot(normal[0], normal[1], normal[2]) < 1e-12 || !Number.isFinite(seed)) throw new TypeError('Ring shadow needs a nonzero normal and finite seed');
  uniforms.ringShadowNormal.value.fromArray(normal).normalize();
  uniforms.ringShadowMap.value = texture;
  uniforms.ringShadowUseMap.value = Boolean(texture);
  uniforms.ringShadowSeed.value = seed % 100;
  uniforms.ringShadowEnabled.value = Boolean(enabled);
}

export const ringDensityGLSL = /* glsl */`
float ringDensity(float r,float ringSeed,sampler2D ringTexture,bool textured){
  float v=(r-1.18)/1.08;
  float band=.6+.12*sin(r*163.+ringSeed)+.08*sin(r*391.)+.05*sin(r*1087.);
  float alpha=band*smoothstep(0.,.012,v)*(1.-smoothstep(.96,1.,v));
  if(textured)alpha*=texture2D(ringTexture,vec2(v,.5)).a;
  float cassini=1.-smoothstep(.008,.018,abs(v-.65));
  return clamp(alpha*(1.-cassini*.88)*.7,0.,1.);
}
`;

export const stellarLightingGLSL = /* glsl */`
uniform bool stellarLighting;uniform int stellarCount,occluderCount;
uniform vec3 stellarOffsets[2],stellarColors[2],occluderOffsets[2];
uniform float stellarIntensities[2],stellarRadii[2],occluderRadii[2];
vec3 safeDirection(vec3 vector){return vector/max(length(vector),1e-8);}
// Visible area of a finite stellar disc under a spherical occulting disc.
float stellarDiscVisibility(float sourceRadius,float blockerRadius,float separation){
  if(blockerRadius<=0.)return 1.;
  if(sourceRadius<=1e-7)return step(blockerRadius,separation);
  if(separation>=sourceRadius+blockerRadius)return 1.;
  if(separation<=abs(sourceRadius-blockerRadius))return clamp(1.-blockerRadius*blockerRadius/(sourceRadius*sourceRadius),0.,1.);
  float distance=max(separation,1e-8),sourceSquared=sourceRadius*sourceRadius,blockerSquared=blockerRadius*blockerRadius;
  float sourceAngle=acos(clamp((distance*distance+sourceSquared-blockerSquared)/(2.*distance*sourceRadius),-1.,1.));
  float blockerAngle=acos(clamp((distance*distance+blockerSquared-sourceSquared)/(2.*distance*blockerRadius),-1.,1.));
  float product=(-distance+sourceRadius+blockerRadius)*(distance+sourceRadius-blockerRadius)*(distance-sourceRadius+blockerRadius)*(distance+sourceRadius+blockerRadius);
  float overlap=sourceSquared*sourceAngle+blockerSquared*blockerAngle-.5*sqrt(max(product,0.));
  return clamp(1.-overlap/(3.14159265359*sourceSquared),0.,1.);
}
float sphereTransmission(vec3 point,vec3 source,float sourceRadius,vec3 blocker,float blockerRadius){
  vec3 toSource=source-point,toBlocker=blocker-point;
  float sourceDistance=max(length(toSource),1e-8),blockerDistance=length(toBlocker);
  // A selected star may also occlude the other emitter. Exclude its own
  // center before the ray test: normalization roundoff can make its projected
  // distance slightly shorter than its Euclidean distance in float32.
  if(length(blocker-source)<=max(1e-7,sourceDistance*1e-7))return 1.;
  float along=dot(toBlocker,toSource/sourceDistance);
  if(blockerRadius<=0.||along<=0.||along>=sourceDistance)return 1.;
  if(blockerDistance<=blockerRadius)return 0.;
  float sourceAngle=asin(clamp(sourceRadius/sourceDistance,0.,.999999));
  float blockerAngle=asin(clamp(blockerRadius/max(blockerDistance,1e-8),0.,.999999));
  // atan is stable near alignment, where acos loses the small separation.
  float separation=atan(length(cross(toSource/sourceDistance,toBlocker/blockerDistance)),clamp(dot(toSource/sourceDistance,toBlocker/blockerDistance),-1.,1.));
  return stellarDiscVisibility(sourceAngle,blockerAngle,separation);
}
float stellarTransmission(vec3 point,int index){
  float transmission=1.;
  for(int j=0;j<2;j++)if(j<occluderCount)transmission*=sphereTransmission(point,stellarOffsets[index],stellarRadii[index],occluderOffsets[j],occluderRadii[j]);
  return transmission;
}
float stellarAngularRadius(vec3 point,int index){return clamp(stellarRadii[index]/max(length(stellarOffsets[index]-point),1e-8),0.,1.);}
float stellarDay(float cosine,float angularRadius){float width=max(angularRadius,.0001);return smoothstep(-width,width,cosine);}
float stellarDiffuse(float cosine,float angularRadius){
  float width=max(angularRadius,.0001),day=stellarDay(cosine,width);
  return max(0.,cosine*day+width*.25*(1.-clamp(abs(cosine)/width,0.,1.)));
}
`;

export const planetRingShadowGLSL = /* glsl */`
uniform bool ringShadowEnabled,ringShadowUseMap;uniform vec3 ringShadowNormal;uniform sampler2D ringShadowMap;uniform float ringShadowSeed;
${ringDensityGLSL}
float ringRayTransmission(vec3 point,vec3 direction,float sourceDistance,float radius){
  float denominator=dot(direction,ringShadowNormal);
  if(abs(denominator)<1e-6)return 1.;
  float travel=-dot(point,ringShadowNormal)/denominator;
  if(travel<=0.||travel>=sourceDistance)return 1.;
  vec3 hit=point+direction*travel;
  float ratio=length(hit)/max(radius,1e-8);
  if(ratio<1.18||ratio>2.26)return 1.;
  return 1.-ringDensity(ratio,ringShadowSeed,ringShadowMap,ringShadowUseMap);
}
float planetRingTransmission(vec3 point,int index,float radius){
  if(!ringShadowEnabled)return 1.;
  vec3 vector=stellarOffsets[index]-point,direction=safeDirection(vector);
  float distance=length(vector),spread=stellarAngularRadius(point,index)*.65;
  // Three disc samples soften a finite source's band shadow without shadow maps.
  // Project the plane normal onto the source disc: these rays vary the
  // incidence angle and cross band edges rather than sliding along them.
  vec3 axis=ringShadowNormal-direction*dot(direction,ringShadowNormal);
  if(dot(axis,axis)<1e-8)axis=cross(direction,vec3(.734,.459,.5));
  axis=safeDirection(axis);
  return (ringRayTransmission(point,direction,distance,radius)*2.+ringRayTransmission(point,safeDirection(direction+axis*spread),distance,radius)+ringRayTransmission(point,safeDirection(direction-axis*spread),distance,radius))*.25;
}
`;
