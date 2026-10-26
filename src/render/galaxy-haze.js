import * as THREE from 'three';
import { randomFromSeed } from '../random.js';

// A bounded emission integral through a real ellipsoid, not a camera-facing
// painted galaxy. All materials share the same shader program and geometry.
// Two-point Gauss cells integrate a bin instead of sampling one coherent plane.
// Arrays are reused by every volume and quality update; no frame allocations.
const integrationRules = Object.fromEntries([4, 8, 12, 16, 24].map(cells => {
  const nodes = [];
  for (let i = 0; i < cells; i++) for (const sign of [-1, 1])
    nodes.push(new THREE.Vector2((i + .5 + sign / Math.sqrt(12)) / cells, .5 / cells));
  while (nodes.length < 48) nodes.push(new THREE.Vector2(0, 0));
  return [cells * 2, nodes];
}));

const vertexShader = /* glsl */`
  varying vec3 localExit;
  void main(){
    localExit=position;
    vec3 world=(modelMatrix*vec4(position,1.)).xyz;
    vec3 relative=world-cameraPosition;float distanceToCamera=length(relative);
    float drawDistance=distanceToCamera<=160000.?distanceToCamera:160000.+40000.*(1.-exp(-(distanceToCamera-160000.)/180000.));
    vec3 proxy=cameraPosition+relative*(drawDistance/max(distanceToCamera,.001));
    gl_Position=projectionMatrix*viewMatrix*vec4(proxy,1.);
  }
`;
const fragmentShader = /* glsl */`
  varying vec3 localExit;
  uniform vec3 localCamera;uniform vec3 shapeScale;uniform vec3 tint;
  uniform float radius;uniform float thickness;uniform float arms;uniform float pitch;
  uniform float morphology;uniform float asymmetry;uniform float bar;uniform float brightness;
  uniform sampler2D structureNoise;uniform vec2 noiseOffset;
  uniform int steps;uniform vec2 quadrature[48];uniform vec2 coreQuadrature[48];
  float armDensity(vec2 p,float width,float footprint){
    float r=length(p);float theta=atan(p.y,p.x);
    // Exact centre phase used by sampleGalaxy: theta=arm*TAU/arms+log(r+.06)/pitch.
    float phase=(theta-log(r+.06)/pitch)*arms;
    float angularOffset=atan(sin(phase),cos(phase))/arms;
    // Mips only filter the dust texture, not this analytic atan/log phase.
    // Approximate the ray/pixel box footprint by a Gaussian of equal variance.
    // The logarithmic radial and angular gradients are orthogonal.
    float angularGradient=sqrt(1./max(r*r,.000001)+1./pow(pitch*(r+.06),2.));
    float sigma=sqrt(width*width+pow(footprint*angularGradient,2.)/12.);
    float period=6.28318530718/arms;
    // Adjacent periods keep the convolution continuous at the phase seam.
    // Scaling by width/sigma preserves the original arm's integrated light.
    vec3 offsets=vec3(angularOffset-period,angularOffset,angularOffset+period)/sigma;
    vec3 lobes=exp(-.5*offsets*offsets);
    float filtered=dot(lobes,vec3(1.))*width/sigma;
    float mean=width*arms*.3989422804;
    // A footprint spanning many arms has no resolvable phase. The exact mean
    // also avoids truncating the periodic Gaussian's far tails at large sigma.
    return mix(filtered,mean,smoothstep(.3,.55,sigma/period));
  }
  vec4 density(vec3 q,float footprint){
    float edge=1.-smoothstep(.8,1.,length(q));
    if(edge<=0.) return vec4(0.);
    vec3 p=q*shapeScale;
    if(morphology<.5){
      float r=length(p.xz);
      // Two coherent texture samples create spatially stable dusty gaps and
      // knots. No per-step hash noise, frame noise or additional scene layers.
      float coarseLod=max(0.,log2(max(1.,footprint*64.*.11)));
      float fineLod=max(0.,log2(max(1.,footprint*64.*.73)));
      float coarse=textureLod(structureNoise,p.xz*.11+noiseOffset,coarseLod).r;
      float fine=textureLod(structureNoise,p.xz*.73+noiseOffset.yx+vec2(.37,.19),fineLod).r;
      float angleWarp=(coarse-.5)*.1,radialWarp=1.+(fine-.5)*.045;
      mat2 warp=mat2(cos(angleWarp),-sin(angleWarp),sin(angleWarp),cos(angleWarp));
      vec2 armPoint=warp*p.xz*radialWarp;
      float width=.085+.1*clamp((coarse-.25)*2.,0.,1.);
      float disk=exp(-r*2.8)*exp(-.5*pow(p.y/(thickness*(.4+r)),2.));
      float arm=armDensity(armPoint,width,footprint*radialWarp);
      if(bar>.5){
        vec2 unbarred=armPoint/vec2(1.6,.45);
        float inside=1.-smoothstep(.27,.31,length(unbarred));
        arm=mix(arm,armDensity(unbarred,width,footprint*radialWarp/.45),inside);
      }
      float outer=smoothstep(.3,.85,r);
      float knots=smoothstep(.3,.72,coarse*.55+fine*.45);
      // Fine dust modulates a connected arm instead of gating it into blobs.
      float breakup=mix(.65+coarse*.7,.35+.65*knots,outer);
      float dust=.18+.82*smoothstep(.32,.62,coarse*.35+fine*.65);
      float armLight=arm*(.3+1.5*knots)*dust*breakup*(1.-smoothstep(.48,.96,r));
      float amount=edge*disk*(.035+2.1*armLight)*smoothstep(.025,.08,r);
      float core=exp(-r*9.);
      float cool=smoothstep(.6,.74,fine)*smoothstep(.3,.65,r)*.35;
      vec3 population=mix(vec3(1.),vec3(.79,.9,1.12),cool);
      population=mix(population,vec3(1.12,.94,.74),core);
      return vec4(tint*population,amount);
    }
    if(morphology<1.5) return vec4(0.);
    float result=0.;
    for(int knot=0;knot<3;knot++){
      float k=float(knot);float theta=k*2.1+asymmetry;
      vec3 center=vec3(cos(theta)*(.2+k*.17),(k-1.)*.12,sin(theta)*(.2+k*.17));
      vec3 delta=(p-center)/vec3(.17,thickness,.19);
      result+=exp(-.5*dot(delta,delta))*.44;
    }
    return vec4(tint,edge*result);
  }
  vec3 coreEmission(vec3 q){
    float edge=1.-smoothstep(.8,1.,length(q));
    if(morphology>.5) return tint*edge*exp(-length(q)*5.8)*1.8;
    vec3 p=q*shapeScale;
    float bulge=exp(-length(p*vec3(1.,1./.52,1.))*8.);
    return tint*mix(vec3(1.),vec3(1.12,.94,.74),exp(-length(p.xz)*9.))*edge*bulge*1.8;
  }
  void main(){
    vec3 direction=normalize(localExit-localCamera);
    // Evaluate derivatives before divergent ray/support branches. This footprint
    // filters both pixel aliasing and texture detail unresolved along the ray.
    float angularFootprint=max(length(dFdx(direction).xz*shapeScale.xz),length(dFdy(direction).xz*shapeScale.xz));
    float b=dot(localCamera,direction),c=dot(localCamera,localCamera)-1.;
    float discriminant=b*b-c;if(discriminant<=0.) discard;
    float root=sqrt(discriminant),entry=max(0.,-b-root),exitDistance=-b+root;
    if(exitDistance<=entry) discard;
    float rayRange=exitDistance-entry;
    float physicalSpeed=length(direction*shapeScale);
    float binFootprint=length(direction.xz*shapeScale.xz)*rayRange*2./float(steps);
    vec3 emission=vec3(0.);
    if(morphology<.5||morphology>=1.5){
      for(int i=0;i<48;i++){
        if(i>=steps) break;
        vec2 node=quadrature[i];
        float distanceAlongRay=entry+node.x*rayRange;
        vec3 q=localCamera+direction*distanceAlongRay;
        float trueDistance=distanceAlongRay*physicalSpeed*radius;
        float visibility=1.-smoothstep(420000.,520000.,trueDistance);
        vec4 light=density(q,max(binFootprint,angularFootprint*distanceAlongRay));
        emission+=light.rgb*light.a*visibility*physicalSpeed*rayRange*node.y;
      }
    }
    if(morphology<1.5){
      // The narrow smooth core is independent of the noisy disk. Split at its
      // metric closest point and square the integration coordinate on both
      // sides, concentrating cheap samples where the exponential changes fast.
      // This removes the synchronized equal-depth core slices without jitter.
      vec3 metric=morphology<.5?shapeScale*vec3(1.,1./.52,1.):vec3(1.);
      vec3 coreCamera=localCamera*metric,coreDirection=direction*metric;
      float center=clamp(-dot(coreCamera,coreDirection)/dot(coreDirection,coreDirection),entry,exitDistance);
      vec2 reach=vec2(center-entry,exitDistance-center);
      for(int i=0;i<24;i++){
        if(i>=steps/2) break;
        vec2 node=coreQuadrature[i];float u=node.x;
        vec2 distanceAlongRay=vec2(center)-vec2(reach.x,-reach.y)*u*u;
        vec2 visibility=1.-smoothstep(vec2(420000.),vec2(520000.),distanceAlongRay*physicalSpeed*radius);
        vec3 nearCore=coreEmission(localCamera+direction*distanceAlongRay.x);
        vec3 farCore=coreEmission(localCamera+direction*distanceAlongRay.y);
        emission+=(nearCore*reach.x*visibility.x+farCore*reach.y*visibility.y)*2.*u*node.y*physicalSpeed;
      }
    }
    // Restrained warm-white emission; no chromatic fog or time-dependent noise.
    gl_FragColor=vec4(emission*2.4*brightness,1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Shape scales remain inside the existing galaxy support radius. */
export function galaxyHazeScale(descriptor) {
  if (descriptor.morphology === 'spiral') return [1, Math.min(.28, descriptor.thickness * 3.2), 1];
  if (descriptor.morphology === 'elliptical') return [1, descriptor.thickness, .8];
  return [1, 1, 1];
}

export function createGalaxyHaze({ seed = 'lonelysky' } = {}) {
  const group = new THREE.Group(); group.name = 'galaxy-emission-volumes';
  const geometry = new THREE.SphereGeometry(1, 40, 24);
  const noiseRandom = randomFromSeed(`${seed}:galaxy-dust-texture-v1`);
  let pixels = Uint8Array.from({ length: 64 * 64 }, () => Math.floor(noiseRandom() * 256));
  // Toroidal smoothing makes linear repeat sampling continuous at both seams.
  for (let pass = 0; pass < 2; pass++) {
    const filtered = new Uint8Array(pixels.length);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const at = (dx, dy) => pixels[((y + dy + 64) % 64) * 64 + (x + dx + 64) % 64];
      filtered[y * 64 + x] = Math.round(at(0, 0) * .5 + (at(-1, 0) + at(1, 0) + at(0, -1) + at(0, 1)) * .125);
    }
    pixels = filtered;
  }
  const structureNoise = new THREE.DataTexture(pixels, 64, 64, THREE.RedFormat, THREE.UnsignedByteType);
  structureNoise.minFilter = THREE.LinearMipmapLinearFilter; structureNoise.magFilter = THREE.LinearFilter;
  structureNoise.wrapS = structureNoise.wrapT = THREE.RepeatWrapping;
  structureNoise.generateMipmaps = true; structureNoise.needsUpdate = true;
  const camera = new THREE.Vector3(), inverse = new THREE.Quaternion();
  let descriptors = [], disposed = false;
  group.userData.setDescriptors = (next) => {
    if (disposed) return;
    for (const mesh of group.children) mesh.material.dispose();
    group.clear(); descriptors = next;
    for (const descriptor of descriptors) {
      const shape = galaxyHazeScale(descriptor);
      const detail = randomFromSeed(`${descriptor.seed}:dust-offset-v1`);
      const material = new THREE.ShaderMaterial({
        uniforms: { localCamera: { value: new THREE.Vector3() }, shapeScale: { value: new THREE.Vector3(...shape) },
          tint: { value: new THREE.Color(descriptor.morphology === 'elliptical' ? 0xc7bba5 : 0xc4c2b9) },
          structureNoise: { value: structureNoise }, noiseOffset: { value: new THREE.Vector2(detail(), detail()) },
          radius: { value: descriptor.radius }, thickness: { value: descriptor.thickness },
          arms: { value: descriptor.arms }, pitch: { value: descriptor.pitch },
          morphology: { value: descriptor.morphology === 'spiral' ? 0 : descriptor.morphology === 'elliptical' ? 1 : 2 },
          asymmetry: { value: descriptor.asymmetry }, bar: { value: Number(descriptor.bar) }, brightness: { value: 1 }, steps: { value: 32 }, quadrature: { value: integrationRules[32] }, coreQuadrature: { value: integrationRules[16] } },
        vertexShader, fragmentShader, side: THREE.BackSide, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true,
      });
      const mesh = new THREE.Mesh(geometry, material); mesh.name = descriptor.id;
      mesh.rotation.fromArray(descriptor.orientation);
      mesh.scale.fromArray(shape).multiplyScalar(descriptor.radius);
      mesh.frustumCulled = false; group.add(mesh);
    }
  };
  group.userData.update = ({ centers, cameraPosition, quality, brightness, home }) => {
    if (disposed) return 0;
    camera.fromArray(cameraPosition); let visible = 0;
    group.children.forEach((mesh, i) => {
      mesh.position.fromArray(centers[i]);
      mesh.visible = !home && mesh.position.distanceTo(camera) - descriptors[i].radius < 520000;
      if (!mesh.visible) return;
      inverse.copy(mesh.quaternion).invert();
      mesh.material.uniforms.localCamera.value.copy(camera).sub(mesh.position).applyQuaternion(inverse).divide(mesh.scale);
      const steps = quality === 'low' ? 16 : quality === 'high' ? 48 : 32;
      mesh.material.uniforms.steps.value = steps;
      mesh.material.uniforms.quadrature.value = integrationRules[steps];
      mesh.material.uniforms.coreQuadrature.value = integrationRules[steps / 2];
      mesh.material.uniforms.brightness.value = brightness;
      visible++;
    });
    return visible;
  };
  group.userData.dispose = () => {
    if (disposed) return; disposed = true;
    for (const mesh of group.children) mesh.material.dispose();
    geometry.dispose(); structureNoise.dispose(); group.clear(); descriptors = [];
  };
  return group;
}
