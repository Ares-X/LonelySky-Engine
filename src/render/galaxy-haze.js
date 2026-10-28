import * as THREE from 'three';
import { randomFromSeed } from '../random.js';
import { describeGalaxyAppearance } from './galaxy-appearance.js';
import { COSMIC_VIEW_FADE_START, COSMIC_VIEW_FAR, COSMIC_DEPTH_GLSL } from '../cosmic-structures.js';

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
  ${COSMIC_DEPTH_GLSL}
  varying vec3 localExit;
  void main(){
    localExit=position;
    vec3 world=(modelMatrix*vec4(position,1.)).xyz;
    vec3 relative=world-cameraPosition;float distanceToCamera=length(relative);
    float drawDistance=distanceToCamera<=160000.?distanceToCamera:160000.+40000.*(1.-exp(-(distanceToCamera-160000.)/180000.));
    vec3 proxy=cameraPosition+relative*(drawDistance/max(distanceToCamera,.001));
    #ifdef COSMIC_STRUCTURES
      // This back face only supplies ray coverage. Preserve physical x/y/w
      // for interpolation, but keep its unused raster depth away from clip
      // planes: ordinary float32 z≈w loses the far-plane gap at 100M scales.
      // Actual opaque occlusion is applied to the physical integral below.
      vec4 physicalClip=projectionMatrix*viewMatrix*vec4(world,1.);
      physicalClip.z=physicalClip.w*.5;
      gl_Position=physicalClip;
    #else
      gl_Position=projectionMatrix*viewMatrix*vec4(proxy,1.);
    #endif
  }
`;
const fragmentShader = /* glsl */`
  ${COSMIC_DEPTH_GLSL}
  varying vec3 localExit;
  uniform vec3 localCamera;uniform vec3 shapeScale;uniform vec3 tint;
  uniform float radius;uniform float thickness;uniform float arms;uniform float pitch;
  uniform float morphology;uniform float asymmetry;uniform float bar;uniform float brightness;
  uniform float armStrength;uniform float coreStrength;uniform float dustStrength;uniform float haloStrength;
  uniform float bridgeStrength;uniform float knotScale;uniform float youngStrength;uniform float emissionStrength;
  uniform sampler2D structureNoise;uniform vec2 noiseOffset;
  #ifdef COSMIC_STRUCTURES
    uniform sampler2D uSceneDepth;uniform vec2 uDepthResolution;uniform vec2 uCameraNearFar;
    uniform float uHasSceneDepth;uniform float continuumWeight;uniform float structureKind;uniform mat3 worldOrientation;
    float scenePhysicalLimit(vec3 direction){
      if(uHasSceneDepth<.5) return 1.e15;
      float depth=texture2D(uSceneDepth,gl_FragCoord.xy/uDepthResolution).r;
      float near=uCameraNearFar.x,far=uCameraNearFar.y;
      #ifdef USE_REVERSED_DEPTH_BUFFER
        if(depth<=0.) return 1.e15;
        float forward=near*far/(near+depth*(far-near));
      #else
        if(depth>=1.) return 1.e15;
        float forward=near*far/(far-depth*(far-near));
      #endif
      vec3 worldDirection=normalize(worldOrientation*(direction*shapeScale));
      float cosine=-(viewMatrix*vec4(worldDirection,0.)).z;
      float drawDistance=forward/max(cosine,.000001);
      if(drawDistance>=200000.) return 1.e15;
      return cosmicTrueDistance(drawDistance);
    }
  #endif
  #ifdef COSMIC_SUPPORT_FADE
    uniform float structureVisibility;
  #endif
  uniform int steps;uniform vec2 quadrature[48];uniform vec2 coreQuadrature[48];
  float armLobe(float angularOffset,float width,float angularVariance,float period){
    float sigma=sqrt(width*width+angularVariance);
    // Adjacent periods keep the convolution continuous at the phase seam.
    // Scaling by width/sigma preserves the original arm's integrated light.
    vec3 offsets=vec3(angularOffset-period,angularOffset,angularOffset+period)/sigma;
    vec3 lobes=exp(-.5*offsets*offsets);
    float filtered=dot(lobes,vec3(1.))*width/sigma;
    float mean=width*arms*.3989422804;
    return mix(filtered,mean,smoothstep(.3,.55,sigma/period));
  }
  vec2 armDensities(vec2 p,float width,float footprint){
    float r=length(p);
    // The axis has no angular phase; its disk contribution is masked below.
    if(r<=.000001) return vec2(width*arms*.3989422804,width*.24*arms*.3989422804);
    float theta=atan(p.y,p.x);
    // Exact centre phase used by sampleGalaxy: theta=arm*TAU/arms+log(r+.06)/pitch.
    float phase=(theta-log(r+.06)/pitch)*arms;
    float angularOffset=atan(sin(phase),cos(phase))/arms;
    // Mips only filter the dust texture, not this analytic atan/log phase.
    // Approximate the ray/pixel box footprint by a Gaussian of equal variance.
    // The logarithmic radial and angular gradients are orthogonal.
    float radialSlope=pitch*(r+.06);
    float angularVariance=footprint*footprint*(1./max(r*r,.000001)+1./(radialSlope*radialSlope))/12.;
    float period=6.28318530718/arms;
    // The former mat2(cos(a),-sin(a),sin(a),cos(a)) rotates by -a.
    // Rotation preserves r and its footprint; only the wrapped phase shifts.
    float laneOffset=angularOffset-.075;
    laneOffset-=floor(laneOffset/period+.5)*period;
    return vec2(armLobe(angularOffset,width,angularVariance,period),armLobe(laneOffset,width*.24,angularVariance,period));
  }
  // Analytic column through a finite dust sheet, modulated by filtered clouds.
  // The Lorentzian column has a stable grazing limit and needs no extra ray steps.
  // Only this volume's emission is absorbed; empty sky remains untouched.
  float dustTransmission(vec3 q,float footprint){
    if(dustStrength<=0.) return 1.;
    #ifdef COSMIC_STRUCTURES
      // Attenuate this emitter's world-fixed dusty pocket. A full flat sheet
      // column created an opaque ruler across every V3 edge-on stellar disc.
      vec3 p=q*shapeScale;
      vec2 dustPlane=p.xz+p.y*vec2(.37,.71);
      float dustLod=max(0.,log2(max(1.,footprint*64.*1.43)));
      float cloud=textureLod(structureNoise,dustPlane*1.43+noiseOffset,dustLod).r;
      float warpedHeight=p.y/thickness+(cloud-.5)*1.7;
      float pocketVertical=exp(-.5*warpedHeight*warpedHeight);
      float r=length(p.xz);
      float radial=smoothstep(.025,.13,r)*(1.-smoothstep(.72,1.,r));
      float pocket=smoothstep(.38,.68,cloud);
      return exp(-dustStrength*2.4*pocketVertical*radial*pocket);
    #else
    vec3 p=q*shapeScale,camera=localCamera*shapeScale;
    vec3 delta=camera-p;float reach=length(delta);
    vec3 direction=delta/max(reach,.000001);
    // The sheet ends at the existing support sphere. Moving the observer
    // farther along the same external ray cannot add fictitious foreground dust.
    float b=dot(p,direction);
    float supportReach=max(0.,-b+sqrt(max(0.,b*b+1.-dot(p,p))));
    reach=min(reach,supportReach);camera=p+direction*reach;
    float sheet=max(thickness*.3,.008);
    float column;
    if(abs(direction.y)<.0001) column=reach/(1.+(p.y/sheet)*(p.y/sheet));
    else column=sheet*(atan(camera.y/sheet)-atan(p.y/sheet))/direction.y;
    float crossing=abs(direction.y)<.0001?reach*.5:clamp(-p.y/direction.y,0.,reach);
    vec3 sheetPoint=p+direction*crossing;
    float radial=exp(-length(sheetPoint.xz)*2.2);
    float dustLod=max(0.,log2(max(1.,footprint*64.*.73)));
    float dustCloud=textureLod(structureNoise,sheetPoint.xz*.73+noiseOffset,dustLod).r;
    radial*=.22+2.8*smoothstep(.32,.69,dustCloud);
    return exp(-clamp(max(0.,column)*radial*dustStrength*6.,0.,12.));
    #endif
  }
  vec3 islandCenter(float k){
    float theta=k*2.1+asymmetry;
    return vec3(cos(theta)*(.2+k*.17),(k-1.)*.12,sin(theta)*(.2+k*.17));
  }
  vec4 density(vec3 q,float footprint,float dustFootprint){
    float edge=1.-smoothstep(.8,1.,length(q));
    if(edge<=0.) return vec4(0.);
    vec3 p=q*shapeScale;
    #ifdef COSMIC_STRUCTURES
      if(structureKind>1.5){
        // Three world-fixed noise planes give depth to the cloud; this field
        // stays the same while crossing it from either side.
        float lod=max(0.,log2(max(1.,footprint*64.*1.8)));
        float a=textureLod(structureNoise,p.xz*.83+noiseOffset,lod).r;
        float b=textureLod(structureNoise,p.xy*1.37+noiseOffset.yx,lod).r;
        float c=textureLod(structureNoise,p.yz*2.13+noiseOffset+vec2(.31,.67),lod).r;
        float cloud=smoothstep(.47,.64,a*.5+b*.3+c*.2);
        // A real local 3D void, deformed by the same stationary cloud field.
        // Its empty interior is not a screen mask or a luminous solid shell.
        vec3 voidCenter=vec3((noiseOffset.x-.5)*.45,.025,(noiseOffset.y-.5)*.45);
        vec3 voidMetric=(p-voidCenter)/vec3(.34,.26,.44)+vec3(a-.5,b-.5,c-.5)*.6;
        float voidRadius=length(voidMetric);
        float cavity=smoothstep(.72,1.12,voidRadius);
        float wall=1.-smoothstep(1.12,1.6,voidRadius);
        float ridgeHeight=(p.y+(a-.5)*.85)/.17;
        float ridge=exp(-ridgeHeight*ridgeHeight);
        // Concentrate the light in the irregular cavity walls and embedded
        // knots; low-density outskirts connect them without filling the void.
        float knots=smoothstep(.45,.62,b)*smoothstep(.43,.61,c);
        float gas=edge*exp(-dot(p,p)*1.8)*cloud*cavity*ridge*(.25+1.3*wall+.75*knots);
        vec3 palette=mix(vec3(.32,.40,.49),vec3(.65,.37,.32),smoothstep(.43,.66,c)*wall);
        return vec4(palette,gas*.38);
      }
    #endif
    if(morphology<.5){
      float r=length(p.xz);
      // Resolved stellar mottling lies inside a continuous arm envelope. The
      // former low-frequency multiplicative gates broke arms into large beads.
      // All structural texture samples remain mip-filtered in world coordinates.
      float coarseLod=max(0.,log2(max(1.,footprint*64.*.31)));
      float fineLod=max(0.,log2(max(1.,footprint*64.*1.71)));
      float coarse=textureLod(structureNoise,p.xz*.31+noiseOffset,coarseLod).r;
      float fine=textureLod(structureNoise,p.xz*1.71+noiseOffset.yx+vec2(.37,.19),fineLod).r;
      float grainLod=max(0.,log2(max(1.,footprint*64.*6.1)));
      float grain=textureLod(structureNoise,p.xz*6.1+noiseOffset+vec2(.13,.47),grainLod).r;
      // Correlated structure bends the arm spine gently; resolved star particles
      // still sit in the same arm envelope and retain their original positions.
      float angleWarp=(coarse-.5)*.13,radialWarp=1.+(fine-.5)*.045;
      mat2 warp=mat2(cos(angleWarp),-sin(angleWarp),sin(angleWarp),cos(angleWarp));
      vec2 armPoint=warp*p.xz*radialWarp;
      float width=.20+.14*clamp((coarse-.25)*2.,0.,1.);
      #ifdef COSMIC_STRUCTURES
        width=.075+.07*clamp((coarse-.25)*2.,0.,1.);
      #endif
      float vertical=p.y/(thickness*(.4+r));
      float disk=exp(-r*2.8)*exp(-.5*vertical*vertical);
      vec2 armPair=armDensities(armPoint,width,footprint*radialWarp);
      if(bar>.5){
        vec2 unbarred=armPoint/vec2(1.6,.45);
        float inside=1.-smoothstep(.27,.31,length(unbarred));
        if(inside>0.) armPair=mix(armPair,armDensities(unbarred,width,footprint*radialWarp/.45),inside);
      }
      float arm=armPair.x,lane=armPair.y;
      float mottling=.78+.4*smoothstep(.26,.73,fine);
      float laneShadow=1.-.58*clamp(lane,0.,1.)*(.65+.35*coarse);
      float armLight=arm*(.86+.28*coarse)*mottling*laneShadow*(1.-smoothstep(.63,.98,r));
      // A dim inter-arm population joins the arms without lifting empty sky.
      // Additional taper avoids thick, equally bright edges in grazing views.
      float height=p.y/(thickness*.65);
      float taper=exp(-r*r*1.5)*exp(-.5*height*height);
      float interarm=.38*(.85+.15*coarse);
      #ifdef COSMIC_STRUCTURES
        // Sparse arms and real black inter-arm gaps; no uniform glowing disk.
        interarm*=.035;
        armLight*=smoothstep(.28,.61,coarse*.65+fine*.35);
      #endif
      // Dust complexes absorb starlight within the arms at several scales.
      // Keep a positive transmission floor through optical depth rather than
      // cutting disconnected holes into the stellar population.
      #ifndef COSMIC_STRUCTURES
        float cloudTransmission=exp(-dustStrength*(.4+lane*2.)*smoothstep(.35,.68,coarse)*smoothstep(.4,.65,grain)*2.8);
      #else
        // V3 disc and core share the same local dusty-pocket owner above.
        float cloudTransmission=1.;
      #endif
      float amount=edge*disk*taper*(interarm+armStrength*armLight)*smoothstep(.025,.08,r)*cloudTransmission*dustTransmission(q,dustFootprint);
      float core=exp(-r*9.);
      float cool=smoothstep(.42,.64,fine)*smoothstep(.16,.5,r)*youngStrength;
      vec3 population=mix(vec3(1.03,.99,.91),vec3(.52,.76,1.3),cool);
      population=mix(population,vec3(1.12,.94,.74),core);
      // Sparse H-II regions follow dusty arms, between the cool young clusters.
      // This is a display palette inspired by Hubble, not an infrared sky map.
      float ionized=smoothstep(.64,.82,grain)*smoothstep(.48,.68,fine)*arm*youngStrength;
      population+=vec3(.85,.14,.23)*ionized*1.6;
      return vec4(tint*population,amount);
    }
    if(morphology<1.5) return vec4(0.);
    // The same tiny repeat texture resolves three-dimensional dusty pockets,
    // not three equal smooth Gaussian lamps. Two fetches per density sample.
    vec2 dustPlane=p.xz+p.y*vec2(.37,.71);
    float cloudLod=max(0.,log2(max(1.,footprint*64.*.9)));
    float grainLod=max(0.,log2(max(1.,footprint*64.*2.7)));
    float cloud=textureLod(structureNoise,dustPlane*.9+noiseOffset,cloudLod).r;
    float grain=textureLod(structureNoise,dustPlane*2.7+noiseOffset.yx+vec2(.23,.61),grainLod).r;
    cloud=clamp((cloud-.5)*2.8+.5,0.,1.);
    grain=clamp((grain-.5)*4.+.5,0.,1.);
    float structure=.2+1.25*smoothstep(.35,.65,cloud*.55+grain*.45);
    float pockets=1.-.72*smoothstep(.51,.68,cloud)*(1.-smoothstep(.37,.57,grain));
    float result=0.;float knots=0.;
    for(int knot=0;knot<3;knot++){
      float k=float(knot);vec3 center=islandCenter(k);
      float individuality=.78+.22*cos(k*2.4+asymmetry*2.);
      float islandWeight=.65+.35*sin(k*2.3+asymmetry*4.);
      vec3 delta=(p-center)/(vec3(.17,thickness*.5,.19)*knotScale*individuality);
      delta.x+=.28*sin(delta.z*2.1+k);
      float island=exp(-.5*dot(delta,delta));
      knots+=island;
      // An offset dense subcluster gives the smaller nursery knots internal
      // asymmetry. Its envelope stays bounded by the same support sphere.
      vec3 subcluster=delta-vec3(.7*cos(k*2.7),.4*sin(k*1.3),.6);
      float detail=exp(-dot(subcluster,subcluster)*2.2)*youngStrength;
      result+=(island+detail)*islandWeight*.85*structure*pockets/sqrt(knotScale);
      if(knot<2){
        vec3 next=islandCenter(k+1.);vec3 span=next-center;
        float along=clamp(dot(p-center,span)/max(dot(span,span),.000001),0.,1.);
        vec3 bridge=(p-center-span*along)/vec3(.035,.045,.035);
        result+=bridgeStrength*exp(-.5*dot(bridge,bridge))*max(0.,sin(along*3.14159265359));
      }
    }
    result+=haloStrength*exp(-dot(p,p)*5.)*.035;
    vec3 population=mix(vec3(1.08,.96,.84),vec3(.64,.85,1.32),clamp(knots*youngStrength,0.,1.));
    #ifdef COSMIC_STRUCTURES
      if(structureKind>.5&&structureKind<1.5) result*=.06;
    #endif
    return vec4(tint*population,edge*result);
  }
  vec3 coreEmission(vec3 q,float footprint,float dustFootprint){
    float edge=1.-smoothstep(.8,1.,length(q));
    if(morphology>.5){
      float stellarRadius=length(q);
      vec2 stellarPlane=q.xz+q.y*vec2(.41,.63);
      float stellarLod=max(0.,log2(max(1.,footprint*64.*1.1)));
      float stellarGrain=textureLod(structureNoise,stellarPlane*1.1+noiseOffset,stellarLod).r;
      #ifdef COSMIC_STRUCTURES
        if(structureKind>.5&&structureKind<1.5){
          // Resolved cluster stars own the halo. Retain only the compact,
          // unresolved central population instead of an elliptical-galaxy lamp.
          float clusterCore=exp(-stellarRadius*18.)*coreStrength*.05;
          return tint*edge*clusterCore*(.7+.6*stellarGrain);
        }
      #endif
      float compactCore=exp(-stellarRadius*8.5)*coreStrength;
      float envelope=exp(-stellarRadius*3.5)*haloStrength*.03;
      return tint*edge*(compactCore+envelope)*(.7+.6*stellarGrain);
    }
    vec3 p=q*shapeScale;
    float bulge=exp(-length(p*vec3(1.,1./.52,1.))*8.);
    float halo=exp(-dot(q,q)*4.)*haloStrength*.045;
    // A real oriented stellar bar, in the exact local x-long / z-short frame
    // already used by the unchanged particle generator's central bar.
    vec3 barMetric=p/vec3(.36,.055,.07);
    float stellarBar=bar*exp(-.5*dot(barMetric,barMetric))*1.6;
    #ifdef COSMIC_STRUCTURES
      bulge=exp(-length(p*vec3(1.,1./.52,1.))*14.)*.55;
      halo*=.2;
      stellarBar*=.14;
    #endif
    return tint*mix(vec3(1.),vec3(1.12,.94,.74),exp(-length(p.xz)*9.))*edge*(bulge*coreStrength+halo+stellarBar)*dustTransmission(q,dustFootprint);
  }
  void main(){
    vec3 direction=normalize(localExit-localCamera);
    // Evaluate derivatives before divergent ray/support branches. This footprint
    // filters both pixel aliasing and texture detail unresolved along the ray.
    float angularFootprint=max(length(dFdx(direction).xz*shapeScale.xz),length(dFdy(direction).xz*shapeScale.xz));
    float b=dot(localCamera,direction),c=dot(localCamera,localCamera)-1.;
    float discriminant=b*b-c;if(discriminant<=0.) discard;
    float root=sqrt(discriminant),entry=max(0.,-b-root),exitDistance=-b+root;
    float physicalSpeed=length(direction*shapeScale);
    #ifdef COSMIC_STRUCTURES
      exitDistance=min(exitDistance,scenePhysicalLimit(direction)/(physicalSpeed*radius));
    #endif
    if(exitDistance<=entry) discard;
    float rayRange=exitDistance-entry;
    float binFootprint=length(direction.xz*shapeScale.xz)*rayRange*2./float(steps);
    vec3 emission=vec3(0.);
    if(morphology<.5||morphology>=1.5){
      for(int i=0;i<48;i++){
        if(i>=steps) break;
        vec2 node=quadrature[i];
        float distanceAlongRay=entry+node.x*rayRange;
        vec3 q=localCamera+direction*distanceAlongRay;
        float visibility=1.;
        #ifndef COSMIC_SUPPORT_FADE
          float trueDistance=distanceAlongRay*physicalSpeed*radius;
          visibility=1.-smoothstep(FADE_START,FADE_FAR,trueDistance);
        #endif
        if(visibility==0.) continue;
        float sampleFootprint=max(binFootprint,angularFootprint*distanceAlongRay);
        if(morphology>=1.5) sampleFootprint=max(sampleFootprint,physicalSpeed*rayRange*2./float(steps));
        // A dust-plane crossing is localized; ray-bin width only filters
        // stellar integration, not the transverse structure of that crossing.
        float dustFootprint=angularFootprint*distanceAlongRay;
        vec4 light=density(q,sampleFootprint,dustFootprint);
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
        vec2 visibility=vec2(1.);
        #ifndef COSMIC_SUPPORT_FADE
          visibility=1.-smoothstep(vec2(FADE_START),vec2(FADE_FAR),distanceAlongRay*physicalSpeed*radius);
        #endif
        vec3 nearCore=vec3(0.),farCore=vec3(0.);
        if(reach.x!=0.&&visibility.x!=0.) nearCore=coreEmission(localCamera+direction*distanceAlongRay.x,max(binFootprint,angularFootprint*distanceAlongRay.x),angularFootprint*distanceAlongRay.x);
        if(reach.y!=0.&&visibility.y!=0.) farCore=coreEmission(localCamera+direction*distanceAlongRay.y,max(binFootprint,angularFootprint*distanceAlongRay.y),angularFootprint*distanceAlongRay.y);
        emission+=(nearCore*reach.x*visibility.x+farCore*reach.y*visibility.y)*2.*u*node.y*physicalSpeed;
      }
    }
    #ifdef COSMIC_SUPPORT_FADE
      emission*=structureVisibility;
    #endif
    // Restrained warm-white emission; no chromatic fog or time-dependent noise.
    #ifdef COSMIC_STRUCTURES
      // The same density is integrated from outside and inside the structure;
      // close-up travel resolves stars and dust instead of a complete postcard.
      gl_FragColor=vec4(emission*1.35*brightness*emissionStrength*continuumWeight,1.);
    #else
      gl_FragColor=vec4(emission*2.4*brightness*emissionStrength,1.);
    #endif
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

export function createGalaxyHaze({ seed = 'lonelysky', structures = false, supportVisibility = null } = {}) {
  const group = new THREE.Group(); group.name = 'galaxy-emission-volumes';
  const geometry = new THREE.SphereGeometry(1, 40, 24);
  const noiseRandom = randomFromSeed(`${seed}:galaxy-dust-texture-v1`);
  const lattice = Float32Array.from({length: 64 * 64}, () => noiseRandom());
  const pixels = new Uint8Array(64 * 64);
  // A periodic multiscale field gives broad dusty complexes and fine structure.
  // Blurring white noise alone erased its contrast and left smooth neon arms.
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    let value = 0;
    for (const [frequency, weight] of [[4, .52], [8, .28], [16, .14], [32, .06]]) {
      const px = x / 64 * frequency, py = y / 64 * frequency;
      const ix = Math.floor(px), iy = Math.floor(py);
      const tx = px - ix, ty = py - iy;
      const fx = tx * tx * (3 - 2 * tx), fy = ty * ty * (3 - 2 * ty);
      const at = (dx, dy) => lattice[((iy + dy) % frequency) * 64 + (ix + dx) % frequency];
      const lower = at(0, 0) * (1 - fx) + at(1, 0) * fx;
      const upper = at(0, 1) * (1 - fx) + at(1, 1) * fx;
      value += (lower * (1 - fy) + upper * fy) * weight;
    }
    pixels[y * 64 + x] = Math.round(THREE.MathUtils.clamp(.5 + (value - .5) * 1.65, 0, 1) * 255);
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
      const appearance = describeGalaxyAppearance(descriptor);
      const detail = randomFromSeed(`${descriptor.seed}:dust-offset-v1`);
      const material = new THREE.ShaderMaterial({
        uniforms: { localCamera: { value: new THREE.Vector3() }, shapeScale: { value: new THREE.Vector3(...shape) },
          tint: { value: new THREE.Color(descriptor.morphology === 'elliptical' ? 0xc7bba5 : 0xc4c2b9) },
          structureNoise: { value: structureNoise }, noiseOffset: { value: new THREE.Vector2(detail(), detail()) },
          radius: { value: descriptor.radius }, thickness: { value: descriptor.thickness },
          arms: { value: descriptor.arms }, pitch: { value: descriptor.pitch },
          morphology: { value: descriptor.morphology === 'spiral' ? 0 : descriptor.morphology === 'elliptical' ? 1 : 2 },
          asymmetry: { value: descriptor.asymmetry }, bar: { value: Number(descriptor.bar) }, brightness: { value: 1 }, steps: { value: 32 }, quadrature: { value: integrationRules[32] }, coreQuadrature: { value: integrationRules[16] } },
        defines: { FADE_START: structures ? `${COSMIC_VIEW_FADE_START}.` : '420000.', FADE_FAR: structures ? `${COSMIC_VIEW_FAR}.` : '520000.', ...(structures ? { COSMIC_STRUCTURES: 1 } : {}), ...(supportVisibility ? { COSMIC_SUPPORT_FADE: 1 } : {}) },
        vertexShader, fragmentShader, side: THREE.BackSide, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: !structures,
      });
      if (supportVisibility) material.uniforms.structureVisibility = { value: 1 };
      if (structures) {
        material.uniforms.continuumWeight = { value: 1 };
        material.uniforms.structureKind = { value: descriptor.kind === 'nebula' ? 2 : descriptor.kind === 'cluster' ? 1 : 0 };
        material.uniforms.uVisibility = { value: 1 }; material.uniforms.uDensity = { value: 1 };
        material.uniforms.uSceneDepth = { value: null }; material.uniforms.uHasSceneDepth = { value: 0 };
        material.uniforms.uDepthResolution = { value: new THREE.Vector2(1, 1) };
        material.uniforms.uCameraNearFar = { value: new THREE.Vector2(1, 220000) };
        material.uniforms.worldOrientation = { value: new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...descriptor.orientation))) };
      }
      for (const name of ['armStrength', 'coreStrength', 'dustStrength', 'haloStrength', 'bridgeStrength', 'knotScale', 'youngStrength', 'emissionStrength']) material.uniforms[name] = { value: appearance[name] };
      const mesh = new THREE.Mesh(geometry, material); mesh.name = descriptor.id;
      if (structures && descriptor.theme === 'old-gold') material.uniforms.tint.value.setHex(0xc0ac8e);
      if (structures && descriptor.theme === 'blue-nursery') material.uniforms.tint.value.setHex(0x9aaeba);
      mesh.userData.appearance = appearance;
      if (structures) {
        mesh.userData.setSceneDepth = (texture, width, height, viewCamera) => {
          material.uniforms.uSceneDepth.value = texture;
          material.uniforms.uHasSceneDepth.value = texture ? 1 : 0;
          if (texture) {
            material.uniforms.uDepthResolution.value.set(width, height);
            material.uniforms.uCameraNearFar.value.set(viewCamera.near, viewCamera.far);
          }
        };
      }
      mesh.rotation.fromArray(descriptor.orientation);
      mesh.scale.fromArray(shape).multiplyScalar(descriptor.radius);
      mesh.frustumCulled = false; group.add(mesh);
    }
  };
  group.userData.update = ({ centers, cameraPosition, quality, brightness, home }) => {
    if (disposed) return 0;
    camera.fromArray(cameraPosition); let visible = 0;
    for (let i = 0; i < group.children.length; i++) {
      const mesh = group.children[i];
      mesh.position.fromArray(centers[i]);
      const distance = mesh.position.distanceTo(camera);
      mesh.visible = !home && (supportVisibility ? supportVisibility[i] > 0 : distance - descriptors[i].radius < (structures ? COSMIC_VIEW_FAR : 520000));
      if (supportVisibility) mesh.material.uniforms.structureVisibility.value = supportVisibility[i];
      if (structures) {
        mesh.material.uniforms.uVisibility.value = Number(mesh.visible);
        // A statistical stellar continuum is appropriate at exterior scales.
        // Resolve it into the unchanged 3D tracers on entry, retaining only
        // low-density nearby dust instead of a screen-filling luminous fog.
        mesh.material.uniforms.continuumWeight.value = .004 + .996 * THREE.MathUtils.smoothstep(distance / descriptors[i].radius, .6, 1.8);
      }
      if (!mesh.visible) continue;
      inverse.copy(mesh.quaternion).invert();
      mesh.material.uniforms.localCamera.value.copy(camera).sub(mesh.position).applyQuaternion(inverse).divide(mesh.scale);
      const steps = quality === 'low' ? 16 : quality === 'high' ? 48 : 32;
      mesh.material.uniforms.steps.value = steps;
      mesh.material.uniforms.quadrature.value = integrationRules[steps];
      mesh.material.uniforms.coreQuadrature.value = integrationRules[steps / 2];
      mesh.material.uniforms.brightness.value = brightness;
      visible++;
    }
    return visible;
  };
  group.userData.dispose = () => {
    if (disposed) return; disposed = true;
    for (const mesh of group.children) mesh.material.dispose();
    geometry.dispose(); structureNoise.dispose(); group.clear(); descriptors = []; supportVisibility = null;
  };
  return group;
}
