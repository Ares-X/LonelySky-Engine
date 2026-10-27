import * as THREE from 'three';
import { NEBULA_APPEARANCE_FAMILIES } from './nebula-appearance.js';
import { NEBULA_VOLUME } from '../nebula-volume.js';

let sharedNoise = null, noiseUsers = 0;

function noiseTexture(seed) {
  const size = 32;
  const data = new Uint8Array(size ** 3);
  const lattice = (x, y, z, period) => {
    let h = Math.imul((x % period + period) % period, 374761393)
      ^ Math.imul((y % period + period) % period, 668265263)
      ^ Math.imul((z % period + period) % period, 2147483647) ^ seed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const valueNoise = (x, y, z, period) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let fx = x - ix, fy = y - iy, fz = z - iz;
    fx *= fx * (3 - 2 * fx); fy *= fy * (3 - 2 * fy); fz *= fz * (3 - 2 * fz);
    const mix = (a, b, t) => a + (b - a) * t;
    return mix(
      mix(mix(lattice(ix, iy, iz, period), lattice(ix + 1, iy, iz, period), fx),
        mix(lattice(ix, iy + 1, iz, period), lattice(ix + 1, iy + 1, iz, period), fx), fy),
      mix(mix(lattice(ix, iy, iz + 1, period), lattice(ix + 1, iy, iz + 1, period), fx),
        mix(lattice(ix, iy + 1, iz + 1, period), lattice(ix + 1, iy + 1, iz + 1, period), fx), fy), fz);
  };
  for (let z = 0; z < size; z += 1) for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    let value = 0;
    for (const [frequency, weight] of [[4, 0.57], [8, 0.29], [16, 0.14]]) {
      value += valueNoise(x / size * frequency, y / size * frequency, z / size * frequency, frequency) * weight;
    }
    data[x + y * size + z * size * size] = Math.round(value * 255);
  }
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

const vertexShader = /* glsl */`
out vec3 vLocal;
void main(){
  vLocal=position;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}
`;

const fragmentShader = /* glsl */`
precision highp sampler3D;
in vec3 vLocal;
out vec4 nebulaColor;
#define gl_FragColor nebulaColor
uniform sampler3D uNoise;
uniform vec3 uCamera,uColorA,uColorB,uNoiseOffset;
uniform mat4 uLocalToWorld,uViewProjection;
uniform sampler2D uSceneDepth;
uniform vec2 uSceneDepthSize;
uniform mat4 uClipToLocal;
uniform bool uHasSceneDepth;
uniform float uVisibility,uDensity,uTime;
uniform int uSteps,uMorphology,uAppearance;
uniform vec3 uLightDirection;
uniform float uEmission,uScattering,uExcitation,uRimStrength,uExtinction,uPhase;
const vec3 LIGHT=vec3(-0.650945,0.650945,0.390567);

float field(vec3 p){
  float envelope=1.0-smoothstep(0.68,1.0,length(p*vec3(0.83,0.84,0.92)));
  if(envelope<=0.001)return 0.0;
  float broad=texture(uNoise,p*0.48+uNoiseOffset).r;
  float fine=texture(uNoise,p*3.7+uNoiseOffset+vec3(0.17,0.37,0.63)).r;
  float micro=texture(uNoise,p*12.7+uNoiseOffset+vec3(0.63,0.11,0.29)).r;
  vec3 q=p+vec3(broad-0.5,fine-0.5,broad-fine)*0.31;
  if(uMorphology!=0){
    float eroded=smoothstep(0.27,0.72,broad*0.48+fine*0.34+micro*0.18);
    float shape=0.0;
    if(uMorphology==1){
      // A disrupted ellipsoidal envelope with a hollow, dark interior.
      float r=length(q*vec3(1.0,1.6,1.25));
      shape=(1.0-smoothstep(0.055,0.23,abs(r-0.62)))*(0.36+eroded*0.64);
      if(uAppearance==4){
        // The optional shell has a genuinely empty cavity and a smooth outer rim;
        // high-frequency displacement would turn this into disconnected blobs.
        float shellRadius=length(p*vec3(1.0,1.6,1.25));
        float shellOffset=(broad-0.5)*0.045+(fine-0.5)*0.012;
        shape=(1.0-smoothstep(0.015,0.065,abs(shellRadius-0.62+shellOffset)))
          *(0.52+eroded*0.3);
      }
    }else if(uMorphology==2){
      // Three separated knots connected only by thin turbulent material.
      float a=length(q-vec3(-0.46,-0.19,0.04));
      float b=length(q-vec3(0.12,0.35,-0.09));
      float c=length(q-vec3(0.47,-0.24,0.12));
      shape=(1.0-smoothstep(0.12,0.4,min(a,min(b,c))))*(0.25+eroded);
    }else if(uMorphology==3){
      // An almost edge-on dust sheet split by a long empty rift.
      float sheet=1.0-smoothstep(0.045,0.29,abs(q.y+0.15*sin(q.x*4.0)));
      float split=smoothstep(0.06,0.22,abs(q.x+0.18*sin(q.z*4.0)));
      shape=sheet*split*(0.2+eroded*0.9);
    }else if(uMorphology==4){
      // A thin, incomplete expanding remnant, not another solid cloud wall.
      float shell=1.0-smoothstep(0.026,0.12,abs(length(q*vec3(1.0,1.15,1.0))-0.65));
      float broken=smoothstep(0.38,0.65,broad+fine*0.13);
      shape=shell*broken*(0.34+eroded*0.7);
      if(uAppearance==5){
        // Thin shock fronts on a mostly open shell. Angular gaps and ridges reuse
        // the same three noise samples; the old geometric family stays intact.
        vec3 shock=p*vec3(1.0,1.15,1.0);
        float radius=length(shock);
        float theta=atan(shock.z,shock.x);
        float latitude=asin(clamp(shock.y/max(radius,0.0001),-1.0,1.0));
        float sectors=smoothstep(0.12,0.6,sin(theta*3.0+uPhase+(broad-0.5)*1.3));
        float ridge=1.0-smoothstep(0.055,0.2,abs(sin(latitude*7.0+theta*2.0+(fine-0.5)*1.8)));
        float shockOffset=(broad-0.5)*0.032+(fine-0.5)*0.01;
        float front=1.0-smoothstep(0.012,0.06,abs(radius-0.65+shockOffset));
        shape=front*sectors*ridge*(0.58+micro*0.5);
      }
    }else if(uMorphology==5){
      float stream=length(vec2(q.y-0.23*sin(q.x*3.4),q.z+0.14*cos(q.x*2.5)));
      shape=(1.0-smoothstep(0.045,0.2,stream))*(0.24+eroded);
      shape+=(1.0-smoothstep(0.025,0.09,abs(q.y+0.43+q.x*0.13)))*eroded*0.14;
    }else{
      shape=smoothstep(0.5,0.73,broad*0.7+fine*0.3)*(0.2+micro*0.24);
    }
    return max(0.0,shape-0.025)*envelope;
  }
  // Three eroded, spatially fixed stems; their unequal tips leave open sky lanes.
  float a=(1.0-smoothstep(0.10,0.255,length(vec2(q.x+0.43+0.055*sin(q.y*5.0),q.z+0.08))))
    *(1.0-smoothstep(0.36,0.65,q.y));
  float b=(1.0-smoothstep(0.07,0.205,length(vec2(q.x+0.025+0.055*sin(q.y*4.0+1.4),q.z-0.06))))
    *(1.0-smoothstep(0.57,0.83,q.y));
  float c=(1.0-smoothstep(0.08,0.22,length(vec2(q.x-0.39+0.06*sin(q.y*3.0),q.z+0.15))))
    *(1.0-smoothstep(0.02,0.4,q.y));
  float stems=max(max(a,b),c)*smoothstep(-1.0,-0.78,q.y);
  float wisps=smoothstep(0.49,0.73,broad*0.65+fine*0.35)*0.40;
  float base=smoothstep(0.38,0.68,broad)*0.25*(1.0-smoothstep(-0.55,-0.1,q.y));
  float erosion=smoothstep(0.29,0.66,broad*0.45+fine*0.35+micro*0.2);
  return max(0.0,(stems*(0.25+erosion*1.1)+wisps*0.45+base*0.6-0.08)*envelope);
}

void main(){
  if(uVisibility<=0.0||uDensity<=0.0)discard;
  vec3 rd=normalize(vLocal-uCamera);
  vec3 inv=sign(rd+vec3(0.0000001))/max(abs(rd),vec3(0.000001));
  vec3 t0=(-vec3(1.0)-uCamera)*inv,t1=(vec3(1.0)-uCamera)*inv;
  vec3 lo=min(t0,t1),hi=max(t0,t1);
  float entry=max(0.0,max(max(lo.x,lo.y),lo.z));
  float exit=min(min(hi.x,hi.y),hi.z);
  if(uHasSceneDepth){
    vec2 uv=gl_FragCoord.xy/uSceneDepthSize;
    float surfaceDepth=texture(uSceneDepth,uv).r;
    if(surfaceDepth<1.0){
      vec4 surface=uClipToLocal*vec4(uv*2.0-1.0,surfaceDepth*2.0-1.0,1.0);
      // Integrate only the dust between the camera and the actual opaque
      // surface. A first-cloud depth alone also blends dust behind that surface.
      exit=min(exit,dot(surface.xyz/surface.w-uCamera,rd));
    }
  }
  if(exit<=entry)discard;
  float stepSize=(exit-entry)/float(uSteps);
  vec3 color=vec3(0.0);
  float transmission=1.0;
  float firstCloud=-1.0;
  for(int i=0;i<48;i++){
    if(i>=uSteps)break;
    float distance=entry+(float(i)+0.5)*stepSize;
    vec3 p=uCamera+rd*distance;
    float rho=field(p);
    if(uAppearance==4||uAppearance==5){
      vec3 shellNormal=normalize(p*(uAppearance==4?vec3(1.0,2.56,1.5625):vec3(1.0,1.3225,1.0))+vec3(0.000001));
      float limb=1.0-abs(dot(shellNormal,rd));
      // Suppress front/back haze so the empty shell reads through its centre.
      rho*=0.06+0.94*limb*limb;
    }
    if(rho>0.012){
      if(firstCloud<0.0)firstCloud=distance;
      float towardLight=field(p+(uAppearance==0?LIGHT:uLightDirection)*0.13);
      float illumination=0.015+0.985*exp(-towardLight*12.0);
      float rim=clamp((rho-towardLight)*4.0,0.0,1.0);
      float structure=texture(uNoise,p*0.65+uNoiseOffset+vec3(0.11)).r;
      vec3 tint=mix(uColorA,uColorB,smoothstep(0.3,0.75,structure)*0.62);
      vec3 source=tint*(0.025+illumination*1.3);
      source+=vec3(0.09,0.29,0.37)*rim*illumination*0.6;
      source+=vec3(0.62,0.29,0.07)*pow(rim,2.0)*0.15;
      if(uAppearance==0){
        // Preserve the original appearance when no descriptor is supplied.
        source*=0.97+0.03*sin(uTime*0.035+structure*6.0);
      }else{
        // Bounded display cues reuse density, rim and the existing structure sample.
        // They suggest excitation and directional dust illumination, not transport.
        float directional=0.3+0.7*pow(max(0.0,dot(-rd,uLightDirection)),2.0);
        float excitation=0.65+uExcitation*smoothstep(0.32,0.76,structure);
        float filament=uAppearance==5?0.5+0.5*smoothstep(0.38,0.7,structure+rim*0.16):1.0;
        if(uAppearance==5){
          float thermal=smoothstep(-0.2,0.35,sin(atan(p.z,p.x)*2.0+uPhase)+(structure-0.5));
          tint=mix(uColorA,uColorB,thermal);
        }
        source=tint*(uEmission*excitation*filament+uScattering*illumination*directional);
        source+=mix(uColorA,uColorB,0.75)*rim*uRimStrength*illumination;
        // Thin shell fronts occupy few ray samples. A fixed bounded source gain
        // reveals their muted colours without thickening or filling the cavity.
        source*=uAppearance==5?3.0:uAppearance==4?2.0:1.0;
        source*=0.99+0.01*sin(uTime*0.018+uPhase+structure*3.0);
      }
      float opacity=1.0-exp(-rho*stepSize*uDensity*7.5*uExtinction);
      color+=transmission*opacity*source;
      transmission*=1.0-opacity;
      if(transmission<0.025)break;
    }
  }
  float alpha=(1.0-transmission)*uVisibility;
  if(alpha<0.002)discard;
  // Return straight alpha because Three's normal blending premultiplies RGB.
  gl_FragColor=vec4(color/max(1.0-transmission,0.0001),alpha);
  vec3 depthPoint=uCamera+rd*max(entry,firstCloud);
  vec4 clip=uViewProjection*uLocalToWorld*vec4(depthPoint,1.0);
  gl_FragDepth=clamp(0.5*clip.z/max(clip.w,0.0001)+0.5,0.0,1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Bounded artistic dust/emission volume, fixed in the caller's floating origin. */
export function createNebula({ colorA = 0x254689, colorB = 0x42a5b3, density = 1, seed = 1, morphology = 'columns', appearance = null } = {}) {
  const profile = appearance && Object.hasOwn(NEBULA_APPEARANCE_FAMILIES, appearance.family)
    ? NEBULA_APPEARANCE_FAMILIES[appearance.family] : null;
  const bounded = (key, fallback, min, max) => Number.isFinite(appearance?.[key])
    ? Math.max(min, Math.min(max, appearance[key])) : fallback;
  const lightDirection = new THREE.Vector3(-0.650945, 0.650945, 0.390567);
  if (profile && Array.isArray(appearance.lightDirection) && appearance.lightDirection.length === 3
    && appearance.lightDirection.every(Number.isFinite) && appearance.lightDirection.some(value => value !== 0)) {
    // Scaling before normalization also keeps very large finite caller input finite.
    const scale = Math.max(...appearance.lightDirection.map(Math.abs));
    lightDirection.fromArray(appearance.lightDirection.map(value => value / scale)).normalize();
  }
  const palette = key => profile && Number.isInteger(appearance[key]) && appearance[key] >= 0 && appearance[key] <= 0xffffff
    ? appearance[key] : profile?.[key] ?? (key === 'colorA' ? colorA : colorB);
  const group = new THREE.Group();
  group.name = 'Structured interstellar dust columns';
  const numericSeed = typeof seed === 'number' ? seed >>> 0 : [...String(seed)]
    .reduce((hash, letter) => Math.imul(hash ^ letter.charCodeAt(0), 16777619) >>> 0, 2166136261);
  // Reuse one stationary noise tile. Each volume samples a seeded offset; crossing
  // a cell must not synchronously rebuild several 32³ textures on the main thread.
  const texture = sharedNoise ||= noiseTexture(0x51a7d05);
  noiseUsers += 1;
  const uniforms = {
    uNoise: { value: texture },
    uCamera: { value: new THREE.Vector3() },
    uColorA: { value: new THREE.Color(palette('colorA')) },
    uColorB: { value: new THREE.Color(palette('colorB')) },
    uNoiseOffset: { value: new THREE.Vector3((numericSeed % 251) / 251, (numericSeed % 241) / 241, (numericSeed % 239) / 239) },
    uLocalToWorld: { value: new THREE.Matrix4() },
    uViewProjection: { value: new THREE.Matrix4() },
    uSceneDepth: { value: null },
    uSceneDepthSize: { value: new THREE.Vector2(1, 1) },
    uClipToLocal: { value: new THREE.Matrix4() },
    uHasSceneDepth: { value: false },
    uDensity: { value: Number.isFinite(density) ? Math.max(0, Math.min(2, density)) : 1 },
    uVisibility: { value: 1 },
    uSteps: { value: 32 },
    uMorphology: { value: Math.max(0, ['columns', 'halo', 'knots', 'rift', 'shell', 'stream', 'wisps'].indexOf(morphology)) },
    uTime: { value: 0 },
    uAppearance: { value: profile?.code ?? 0 },
    uLightDirection: { value: lightDirection },
    uEmission: { value: profile ? bounded('emission', profile.emission, 0, .6) : 0 },
    uScattering: { value: profile ? bounded('scattering', profile.scattering, 0, 1) : 0 },
    uExcitation: { value: profile ? bounded('excitation', profile.excitation, 0, .6) : 0 },
    uRimStrength: { value: profile ? bounded('rimStrength', profile.rimStrength, 0, .5) : 0 },
    uExtinction: { value: profile ? bounded('extinction', profile.extinction, .5, 2) : 1 },
    uPhase: { value: profile ? bounded('phase', 0, 0, Math.PI * 2) : 0 },
  };
  if (profile?.code === 3) {
    uniforms.uEmission.value = 0; uniforms.uExcitation.value = 0;
    uniforms.uScattering.value = Math.min(.035, uniforms.uScattering.value);
    uniforms.uRimStrength.value = Math.min(.015, uniforms.uRimStrength.value);
  }
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms, vertexShader, fragmentShader,
    side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: true,
  });
  const volume = new THREE.Mesh(geometry, material);
  volume.position.fromArray(NEBULA_VOLUME.center);
  volume.scale.fromArray(NEBULA_VOLUME.halfExtents);
  // The compositor binds a depth snapshot, never the attachment currently being
  // rendered into. Keep direct createNebula/render callers backward compatible.
  volume.userData.setSceneDepth = (depth, width, height, camera) => {
    uniforms.uHasSceneDepth.value = depth !== null;
    uniforms.uSceneDepth.value = depth;
    if (depth === null) return;
    uniforms.uSceneDepthSize.value.set(width, height);
    volume.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    uniforms.uClipToLocal.value.copy(volume.matrixWorld).invert()
      .multiply(camera.matrixWorld).multiply(camera.projectionMatrixInverse);
  };
  group.add(volume);
  let disposed = false;
  const cameraPosition = new THREE.Vector3();
  const boundsPoint = new THREE.Vector3();
  const localBounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const worldBounds = new THREE.Box3(), frustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4();
  group.userData.isInView = camera => {
    volume.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    worldBounds.copy(localBounds).applyMatrix4(volume.matrixWorld);
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
    return frustum.intersectsBox(worldBounds);
  };
  // Fade from the transformed cloud volume, not its caller's chunk origin.
  // The nearest point on this oriented box remains zero everywhere inside it.
  group.userData.distanceToVolume = worldPosition => {
    volume.updateWorldMatrix(true, false);
    boundsPoint.copy(worldPosition);
    volume.worldToLocal(boundsPoint).clampScalar(-1, 1);
    return volume.localToWorld(boundsPoint).distanceTo(worldPosition);
  };
  group.userData.stats = { steps: 32, morphology, noiseResolution: 32, bounds: [9000, 6700, 16300], opticalApproximation: true };
  group.userData.update = (camera, time, { quality = 'auto', visibility = 1 } = {}) => {
    if (disposed || !camera) return;
    group.updateWorldMatrix(true, true);
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(cameraPosition);
    uniforms.uCamera.value.copy(cameraPosition);
    volume.worldToLocal(uniforms.uCamera.value);
    uniforms.uLocalToWorld.value.copy(volume.matrixWorld);
    uniforms.uViewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    uniforms.uTime.value = Number.isFinite(time) ? time : 0;
    uniforms.uVisibility.value = Number.isFinite(visibility) ? Math.max(0, Math.min(1, visibility)) : 0;
    uniforms.uSteps.value = quality === 'low' ? 16 : quality === 'high' ? 48 : 32;
    group.userData.stats.steps = uniforms.uSteps.value;
  };
  group.userData.dispose = () => {
    if (disposed) return;
    disposed = true;
    geometry.dispose();
    material.dispose();
    noiseUsers -= 1;
    if (noiseUsers === 0) { sharedNoise.dispose(); sharedNoise = null; }
  };
  return group;
}
