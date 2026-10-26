import * as THREE from 'three';
import { randomFromSeed } from '../random.js';

// A bounded emission integral through a real ellipsoid, not a camera-facing
// painted galaxy. All materials share the same shader program and geometry.
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
  uniform int steps;
  float armDensity(vec2 p,float width){
    float r=length(p);float theta=atan(p.y,p.x);
    // Exact centre phase used by sampleGalaxy: theta=arm*TAU/arms+log(r+.06)/pitch.
    float phase=(theta-log(r+.06)/pitch)*arms;
    float angularOffset=atan(sin(phase),cos(phase))/arms;
    return exp(-.5*pow(angularOffset/width,2.));
  }
  vec4 density(vec3 q){
    float edge=1.-smoothstep(.8,1.,length(q));
    if(edge<=0.) return vec4(0.);
    vec3 p=q*shapeScale;
    if(morphology<.5){
      float r=length(p.xz);
      // Two coherent texture samples create spatially stable dusty gaps and
      // knots. No per-step hash noise, frame noise or additional scene layers.
      float coarse=textureLod(structureNoise,p.xz*.11+noiseOffset,0.).r;
      float fine=textureLod(structureNoise,p.xz*.37+noiseOffset.yx+vec2(.37,.19),0.).r;
      float angleWarp=(coarse-.5)*.2,radialWarp=1.+(fine-.5)*.12;
      mat2 warp=mat2(cos(angleWarp),-sin(angleWarp),sin(angleWarp),cos(angleWarp));
      vec2 armPoint=warp*p.xz*radialWarp;
      float width=.1+.14*clamp((coarse-.25)*2.,0.,1.);
      float disk=exp(-r*2.8)*exp(-.5*pow(p.y/(thickness*(.4+r)),2.));
      float arm=armDensity(armPoint,width);
      if(bar>.5){
        vec2 unbarred=armPoint/vec2(1.6,.45);
        float inside=1.-smoothstep(.27,.31,length(unbarred));
        arm=mix(arm,armDensity(unbarred,width),inside);
      }
      float outer=smoothstep(.3,.85,r);
      float knots=smoothstep(.38,.65,coarse*.65+fine*.35);
      float breakup=mix(.65+coarse*.7,knots,outer);
      float dust=.2+.8*smoothstep(.25,.6,coarse*.5+fine*.5);
      float armLight=arm*(.3+1.5*knots)*dust*breakup*(1.-smoothstep(.48,.96,r));
      float bulge=exp(-length(vec3(p.x,p.y/.52,p.z))*8.);
      float amount=edge*(disk*(.035+2.1*armLight)*smoothstep(.025,.08,r)+bulge*1.8);
      float core=exp(-r*9.);
      float cool=smoothstep(.6,.74,fine)*smoothstep(.3,.65,r)*.35;
      vec3 population=mix(vec3(1.),vec3(.79,.9,1.12),cool);
      population=mix(population,vec3(1.12,.94,.74),core);
      return vec4(tint*population,amount);
    }
    if(morphology<1.5) return vec4(tint,edge*exp(-length(q)*5.8)*1.8);
    float result=0.;
    for(int knot=0;knot<3;knot++){
      float k=float(knot);float theta=k*2.1+asymmetry;
      vec3 center=vec3(cos(theta)*(.2+k*.17),(k-1.)*.12,sin(theta)*(.2+k*.17));
      vec3 delta=(p-center)/vec3(.17,thickness,.19);
      result+=exp(-.5*dot(delta,delta))*.44;
    }
    return vec4(tint,edge*result);
  }
  void main(){
    vec3 direction=normalize(localExit-localCamera);
    float b=dot(localCamera,direction),c=dot(localCamera,localCamera)-1.;
    float discriminant=b*b-c;if(discriminant<=0.) discard;
    float root=sqrt(discriminant),entry=max(0.,-b-root),exitDistance=-b+root;
    if(exitDistance<=entry) discard;
    float stride=(exitDistance-entry)/float(steps);
    float physicalStride=length(direction*shapeScale)*stride;
    vec3 emission=vec3(0.);
    for(int i=0;i<24;i++){
      if(i>=steps) break;
      vec3 q=localCamera+direction*(entry+(float(i)+.5)*stride);
      float trueDistance=length((q-localCamera)*shapeScale)*radius;
      float visibility=1.-smoothstep(420000.,520000.,trueDistance);
      vec4 light=density(q);
      emission+=light.rgb*light.a*visibility*physicalStride;
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
  structureNoise.minFilter = structureNoise.magFilter = THREE.LinearFilter;
  structureNoise.wrapS = structureNoise.wrapT = THREE.RepeatWrapping;
  structureNoise.generateMipmaps = false; structureNoise.needsUpdate = true;
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
          asymmetry: { value: descriptor.asymmetry }, bar: { value: Number(descriptor.bar) }, brightness: { value: 1 }, steps: { value: 16 } },
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
      mesh.material.uniforms.steps.value = quality === 'low' ? 8 : quality === 'high' ? 24 : 16;
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
