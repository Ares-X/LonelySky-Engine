import * as THREE from 'three';
import {COSMIC_DEPTH_GLSL} from '../cosmic-structures.js';
import {sampleGalacticStars, GALACTIC_MEDIUM_REVISION, GALACTIC_MEDIUM_MAX_STARS, GALACTIC_MEDIUM_STELLAR_VOLUME_RESOLUTION, GALACTIC_MEDIUM_DUST_VOLUME_RESOLUTION} from '../galactic-medium.js';
import {GALACTIC_SPATIAL_MEDIUM_REVISION} from '../galactic-spatial-medium.js';
import {COSMIC_SCENE_DEPTH_GLSL} from './cosmic-scene-depth.js';
import {STELLAR_PSF_HALO_SIGMA_CSS} from './stellar-psf.js';
import {createStellarPsfTexture, STELLAR_PSF_TEXTURE_GLSL} from './stellar-psf-texture.js';

// RG are mature/young column luminosities; B is padding and A is planar dust.
// The CPU sampler, point CDF and renderer share these two normalized profiles.
export const GALACTIC_MEDIUM_GLSL = /* glsl */`
  uniform sampler2D mediumTable;
  uniform sampler2D verticalGeometryTable;
  precision highp sampler3D;
  uniform sampler3D stellarVolumeTable,dustVolumeTable;
  uniform vec2 mediumHeights;
  uniform float youngStellarHeight;
  uniform vec3 oldStellarColor,youngStellarColor;
  uniform vec3 bulgeCenter,bulgeAxes,bulgeColor,extinctionColor;
  uniform vec3 dustCloudCenter,dustCloudAxes;
  uniform float hasDustCloud,dustVolumeResolution;
  uniform float dustVerticalBound,diskDustVerticalBound,diskStellarVerticalBound,supportRadius;
  float mediumVertical(float y,float height){
    float t=y/height,shape=max(0.,1.-t*t);
    return shape*shape*15./(16.*height);
  }
  void galacticPlanarMedium(vec3 p,out vec3 emission,out vec3 extinction){
    emission=vec3(0.);extinction=vec3(0.);
    #ifndef GALACTIC_SPATIAL_EMISSION
    if(abs(p.x)>=1.||abs(p.z)>=1.
      ||(abs(p.y)>diskDustVerticalBound&&abs(p.y)>diskStellarVerticalBound))return;
    vec4 column=texture2D(mediumTable,p.xz*.5+.5);
    vec4 geometry=texture2D(verticalGeometryTable,p.xz*.5+.5);
    emission=column.r*oldStellarColor*mediumVertical(p.y-geometry.z,mediumHeights.x*geometry.w)
      +column.g*youngStellarColor*mediumVertical(p.y-geometry.z,youngStellarHeight*geometry.w);
    extinction=column.a*mediumVertical(p.y-geometry.x,mediumHeights.y*geometry.y)*extinctionColor;
    #endif
  }
  float galacticCloudDensity(vec3 p){
    vec3 d=(p-dustCloudCenter)/dustCloudAxes;
    if(all(lessThan(abs(d),vec3(1.))))return texture(dustVolumeTable,d*.5+.5).r;
    return 0.;
  }
  void galacticMedium(vec3 p,float cloudDensity,out vec3 emission,out vec3 extinction){
    galacticPlanarMedium(p,emission,extinction);
    vec3 b=(p-bulgeCenter)/bulgeAxes;
    if(all(lessThan(abs(b),vec3(1.)))){
      #ifdef GALACTIC_SPATIAL_EMISSION
      vec3 density=texture(stellarVolumeTable,b*.5+.5).rgb;
      emission+=density.r*oldStellarColor+density.g*youngStellarColor+density.b*bulgeColor;
      #else
      emission+=bulgeColor*texture(stellarVolumeTable,b*.5+.5).r;
      #endif
    }
    extinction+=extinctionColor*cloudDensity;
  }
  bool galacticCloudInterval(vec3 origin,vec3 direction,float minimumDistance,float maximumDistance,out vec2 interval){
    interval=vec2(0.);
    if(hasDustCloud<.5)return false;
    vec3 qOrigin=(origin-dustCloudCenter)/dustCloudAxes,qDirection=direction/dustCloudAxes;
    float entry=minimumDistance,exitDistance=maximumDistance,edge=1.-1./dustVolumeResolution;
    for(int axis=0;axis<3;axis++){
      if(abs(qDirection[axis])>.00000001){
        vec2 t=(vec2(-edge,edge)-qOrigin[axis])/qDirection[axis];
        entry=max(entry,min(t.x,t.y));exitDistance=min(exitDistance,max(t.x,t.y));
      }else if(abs(qOrigin[axis])>=edge)return false;
    }
    interval=vec2(entry,exitDistance);
    return exitDistance>entry;
  }
  void galacticCloudTraversal(vec3 origin,vec3 direction,float entry,out vec3 nextT,out vec3 deltaT){
    vec3 qOrigin=(origin-dustCloudCenter)/dustCloudAxes,qDirection=direction/dustCloudAxes;
    vec3 gridOrigin=(qOrigin*.5+.5)*dustVolumeResolution-.5;
    vec3 gridDirection=qDirection*.5*dustVolumeResolution;
    vec3 cell=floor(gridOrigin+gridDirection*entry);
    nextT=vec3(1.e20);deltaT=vec3(1.e20);
    for(int axis=0;axis<3;axis++)if(abs(gridDirection[axis])>.00000001){
      float boundary=cell[axis]+(gridDirection[axis]>0.?1.:0.);
      nextT[axis]=(boundary-gridOrigin[axis])/gridDirection[axis];
      deltaT[axis]=abs(1./gridDirection[axis]);
    }
  }
  // A trilinear density restricted to a ray is cubic within each grid cell.
  // Two Gauss nodes integrate its optical depth exactly, before exp(-tau).
  // A fixed N^3 grid crosses at most 3*(N-1)+1 cells; no sparse cloud can fall
  // between whole-segment bins. This is extinction only, not gas dynamics.
  float galacticCloudOpticalDepth(vec3 origin,vec3 direction,float distance){
    vec2 interval;if(!galacticCloudInterval(origin,direction,0.,distance,interval))return 0.;
    vec3 nextT,deltaT;galacticCloudTraversal(origin,direction,interval.x,nextT,deltaT);
    float t=interval.x,opticalDepth=0.;
    for(int i=0;i<${3 * GALACTIC_MEDIUM_DUST_VOLUME_RESOLUTION + 4};i++){
      float endT=max(t,min(interval.y,min(nextT.x,min(nextT.y,nextT.z))));
      float halfLength=max(0.,endT-t)*.5,middle=(t+endT)*.5;
      if(halfLength>0.){
        float offset=halfLength*.5773502691896258;
        opticalDepth+=halfLength*(galacticCloudDensity(origin+direction*(middle-offset))
          +galacticCloudDensity(origin+direction*(middle+offset)));
      }
      if(endT>=interval.y)break;
      for(int axis=0;axis<3;axis++)if(nextT[axis]<=endT)nextT[axis]+=deltaT[axis];
      t=endT;
    }
    return opticalDepth;
  }
  vec3 galacticTransmittance(vec3 origin,vec3 end){
    vec3 segment=end-origin;float distance=length(segment);
    if(distance<=.00000001)return vec3(1.);
    vec3 direction=segment/distance;
    vec3 opticalDepth=extinctionColor*galacticCloudOpticalDepth(origin,direction,distance);
    #ifdef GALACTIC_SPATIAL_EMISSION
    return exp(-opticalDepth);
    #else
    // Integrate only the finite planar interval. Sampling an entire distant
    // camera-to-star segment can otherwise skip a thin disk completely.
    float closest=-dot(origin,direction);
    vec3 foot=origin+direction*closest;
    float reach2=supportRadius*supportRadius-dot(foot,foot);
    if(reach2<=0.)return exp(-opticalDepth);
    float reach=sqrt(reach2),entry=max(0.,closest-reach),exitDistance=min(distance,closest+reach);
    if(abs(direction.y)>.00000001){
      vec2 planes=(vec2(-diskDustVerticalBound,diskDustVerticalBound)-origin.y)/direction.y;
      entry=max(entry,min(planes.x,planes.y));exitDistance=min(exitDistance,max(planes.x,planes.y));
    }else if(abs(origin.y)>=diskDustVerticalBound)return exp(-opticalDepth);
    if(exitDistance<=entry)return exp(-opticalDepth);
    float stride=(exitDistance-entry)/16.;
    for(int i=0;i<16;i++){
      vec3 emission,extinction;
      galacticPlanarMedium(origin+direction*(entry+(float(i)+.5)*stride),emission,extinction);
      opticalDepth+=extinction*stride;
    }
    return exp(-opticalDepth);
    #endif
  }
`;

const volumeVertex = /* glsl */`
  varying vec3 localExit;
  void main(){
    localExit=position;
    vec4 physical=projectionMatrix*modelViewMatrix*vec4(position,1.);
    physical.z=physical.w*.5;
    gl_Position=physical;
  }
`;
export const GALACTIC_VOLUME_FRAGMENT_GLSL = /* glsl */`
  ${COSMIC_DEPTH_GLSL}
  ${GALACTIC_MEDIUM_GLSL}
  varying vec3 localExit;
  uniform vec3 localCamera,shapeScale;
  uniform float radius,brightness,structureVisibility,uVisibility,uDensity;
  uniform float heightBound;
  uniform int steps;
  ${COSMIC_SCENE_DEPTH_GLSL}
  // Homogeneous-bin transfer, including its finite zero-extinction limit.
  vec3 binSource(vec3 tau){
    vec3 small=vec3(1.)-tau*.5+tau*tau/6.;
    return mix((vec3(1.)-exp(-tau))/max(tau,vec3(.000001)),small,lessThan(tau,vec3(.001)));
  }
  void galacticTransferPiece(vec3 samplePosition,float cloudDensity,float weight,inout vec3 radiance,inout vec3 transmittance){
    vec3 emission,extinction;galacticMedium(samplePosition,cloudDensity,emission,extinction);
    vec3 tau=extinction*weight;
    radiance+=transmittance*emission*weight*binSource(tau);
    transmittance*=exp(-tau);
  }
  void main(){
    if(structureVisibility<=0.||uVisibility<=0.||uDensity<=0.)discard;
    vec3 direction=normalize(localExit-localCamera);
    float closest=-dot(localCamera,direction);
    vec3 foot=localCamera+direction*closest;
    float reach2=supportRadius*supportRadius-dot(foot,foot);
    if(reach2<=0.)discard;
    float reach=sqrt(reach2),entry=max(0.,closest-reach);
    float exitDistance=min(closest+reach,scenePhysicalLimit(direction)/radius);
    // Intersect the exact finite vertical slab before spending bins on empty
    // space. This also resolves thin dust when looking out of the disk.
    if(abs(direction.y)>.00000001){
      vec2 planes=(vec2(-heightBound,heightBound)-localCamera.y)/direction.y;
      entry=max(entry,min(planes.x,planes.y));exitDistance=min(exitDistance,max(planes.x,planes.y));
    }else if(abs(localCamera.y)>heightBound)discard;
    if(exitDistance<=entry)discard;
    float stride=(exitDistance-entry)/float(steps);
    vec3 transmittance=vec3(1.),radiance=vec3(0.);
    vec2 cloudInterval;
    bool crossesCloud=galacticCloudInterval(localCamera,direction,entry,exitDistance,cloudInterval);
    vec3 nextCloud=vec3(1.e20),deltaCloud=vec3(1.e20);
    if(crossesCloud)galacticCloudTraversal(localCamera,direction,cloudInterval.x,nextCloud,deltaCloud);
    float t=entry,pendingStart=entry;int bin=0;
    // Partition the original quality bins at cloud grid faces. Outside G the
    // original midpoint rule remains; inside each trilinear cell Gauss2 gives
    // its exact optical depth. Ordered homogeneous source pieces still have
    // finite emission/transfer error, rather than an exact transport claim.
    // A ray crosses at most 3*(N-1)+1 G cells, plus 96 base bins and two edges.
    for(int i=0;i<${96 + 3 * GALACTIC_MEDIUM_DUST_VOLUME_RESOLUTION + 12};i++){
      float baseEnd=entry+float(bin+1)*stride;
      float endT=min(exitDistance,baseEnd);
      bool inCloud=crossesCloud&&t>=cloudInterval.x&&t<cloudInterval.y;
      if(crossesCloud&&t<cloudInterval.x)endT=min(endT,cloudInterval.x);
      if(inCloud)endT=min(endT,min(cloudInterval.y,min(nextCloud.x,min(nextCloud.y,nextCloud.z))));
      endT=max(t,endT);
      float length=endT-t;
      if(length>0.){
        float nearT=t+.2113248654051871*length,farT=t+.7886751345948129*length;
        float nearCloud=0.,farCloud=0.;
        if(inCloud){
          nearCloud=galacticCloudDensity(localCamera+direction*nearT);
          farCloud=galacticCloudDensity(localCamera+direction*farT);
        }
        // Nonnegative trilinear density cannot hide a positive interior lobe
        // between two strictly zero interior nodes. Merge only these empty-G
        // intervals within the original quality bin; never threshold a cloud.
        // J and planar kappa retain finite midpoint error in each merged run.
        if(nearCloud>0.||farCloud>0.){
          if(t>pendingStart)galacticTransferPiece(localCamera+direction*((pendingStart+t)*.5),0.,t-pendingStart,radiance,transmittance);
          galacticTransferPiece(localCamera+direction*nearT,nearCloud,length*.5,radiance,transmittance);
          galacticTransferPiece(localCamera+direction*farT,farCloud,length*.5,radiance,transmittance);
          pendingStart=endT;
        }
      }
      if((endT>=baseEnd||endT>=exitDistance)&&endT>pendingStart){
        galacticTransferPiece(localCamera+direction*((pendingStart+endT)*.5),0.,endT-pendingStart,radiance,transmittance);
        pendingStart=endT;
      }
      if(endT>=exitDistance)break;
      if(endT>=baseEnd)bin++;
      if(inCloud)for(int axis=0;axis<3;axis++)if(nextCloud[axis]<=endT)nextCloud[axis]+=deltaCloud[axis];
      t=endT;
    }
    float visibility=structureVisibility*uVisibility*uDensity;
    // RGB transfer is used for the galaxy's own light. The existing scene
    // behind it receives luminance transmittance (a bounded grey-background
    // approximation), so this single draw can absorb as well as emit.
    float backgroundTransmission=dot(transmittance,vec3(.2126,.7152,.0722));
    gl_FragColor=vec4(radiance*brightness*continuumWeight*visibility,mix(1.,backgroundTransmission,visibility));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
const pointsVertex = /* glsl */`
  ${COSMIC_DEPTH_GLSL}
  ${GALACTIC_MEDIUM_GLSL}
  attribute vec3 color;
  attribute float rawLuminosity;
  uniform vec3 localCamera;
  uniform float radius,pixelHeight,ratio,powerScale;
  varying vec3 stellarColor;
  varying float linearFlux,spritePixels;
  void main(){
    vec3 relative=position-localCamera;
    float normalizedDistance=length(relative),physicalDistance=normalizedDistance*radius;
    vec3 world=(modelMatrix*vec4(position,1.)).xyz;
    vec3 relativeWorld=world-cameraPosition;
    float drawDistance=cosmicDrawDistance(physicalDistance);
    vec3 proxy=cameraPosition+relativeWorld*(drawDistance/max(physicalDistance,.000001));
    gl_Position=projectionMatrix*viewMatrix*vec4(proxy,1.);
    // OpenGL clips point centers before expanding their rasterized squares.
    // These centers cannot produce fragments; avoid their extinction queries.
    if(gl_Position.w<=0.||any(greaterThan(abs(gl_Position.xy),vec2(gl_Position.w)))){
      stellarColor=vec3(0.);linearFlux=0.;spritePixels=1.;gl_PointSize=1.;return;
    }
    vec3 viewDirection=normalize((viewMatrix*vec4(relativeWorld,0.)).xyz);
    // A gnomonic pixel covers cos(theta)^3/focalPixels^2 steradians.
    // Point power and volume radiance therefore share one image-space unit.
    float focalPixels=.5*pixelHeight*projectionMatrix[1][1];
    float inversePixelSolidAngle=focalPixels*focalPixels/pow(max(.001,-viewDirection.z),3.);
    linearFlux=rawLuminosity*powerScale*inversePixelSolidAngle/max(normalizedDistance*normalizedDistance,1.e-12);
    stellarColor=color*galacticTransmittance(localCamera,position);
    spritePixels=ceil(${8 * STELLAR_PSF_HALO_SIGMA_CSS}*ratio);
    gl_PointSize=spritePixels;
  }
`;
const pointsFragment = /* glsl */`
  ${STELLAR_PSF_TEXTURE_GLSL}
  uniform float ratio,brightness,structureVisibility;
  varying vec3 stellarColor;
  varying float linearFlux,spritePixels;
  void main(){
    float energy=stellarPixelEnergy((gl_PointCoord-.5)*spritePixels);
    gl_FragColor=vec4(stellarColor*linearFlux*brightness*energy,structureVisibility);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function hull(radius) {
  const geometry=new THREE.SphereGeometry(radius,24,16),position=geometry.attributes.position,index=geometry.index;
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3(),normal=new THREE.Vector3(),edge=new THREE.Vector3();
  let minimum=Infinity;
  for(let i=0;i<index.count;i+=3){
    a.fromBufferAttribute(position,index.getX(i));b.fromBufferAttribute(position,index.getX(i+1));c.fromBufferAttribute(position,index.getX(i+2));
    normal.subVectors(b,a).cross(edge.subVectors(c,a));
    if(normal.lengthSq()>0)minimum=Math.min(minimum,Math.abs(normal.dot(a))/normal.length());
  }
  geometry.scale(radius/minimum*(1+1e-6),radius/minimum*(1+1e-6),radius/minimum*(1+1e-6));
  geometry.computeBoundingSphere();
  geometry.boundingSphere.radius=(geometry.boundingSphere.radius+geometry.boundingSphere.center.length())*(1+1e-6);
  geometry.boundingSphere.center.set(0,0,0);
  return geometry;
}

function fieldTexture(values,resolution,format,signed=false,volume=false){
  const pixels=new Uint16Array(values.length);
  for(let i=0;i<pixels.length;i++){
    const value=values[i];
    if(!Number.isFinite(value)||(!signed&&value<0)||Math.abs(value)>65504)throw new RangeError('Galactic field exceeds half-float texture range');
    pixels[i]=THREE.DataUtils.toHalfFloat(value);
  }
  const texture=volume?new THREE.Data3DTexture(pixels,resolution,resolution,resolution):new THREE.DataTexture(pixels,resolution,resolution);
  texture.format=format;texture.type=THREE.HalfFloatType;
  // A mip would spread the finite column into previously empty texels while
  // keeping the old support and luminosity CDF. Both paths sample base level.
  texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;
  texture.generateMipmaps=false;texture.needsUpdate=true;
  texture.unpackAlignment=1;
  return texture;
}

/** One finite emitting/absorbing medium and its resolved 3D stellar proxies.
 * The caller owns world placement and updates localCamera once per frame.
 * The same generated table supplies both paths. No photograph, extra canvas,
 * clock or animation loop is involved. All resources have this mesh's lifetime.
 */
export function createGalacticMediumVolume(descriptor) {
  const medium=descriptor.medium;
  const spatial=medium?.revision===GALACTIC_SPATIAL_MEDIUM_REVISION;
  if(!medium||!spatial&&medium.revision!==GALACTIC_MEDIUM_REVISION)
    throw new TypeError('Galactic volume requires the current medium revision; legacy RGB columns are not population densities');
  if(!spatial&&(!(medium.texels instanceof Float32Array)||medium.texels.length!==medium.resolution**2*4))
    throw new TypeError('Galactic volume requires compiled population columns');
  if(!spatial&&(!(medium.verticalGeometry instanceof Float32Array)||medium.verticalGeometry.length!==medium.resolution**2*4))
    throw new TypeError('Galactic volume requires compiled vertical geometry');
  const sourceResolution=spatial?medium.sourceVolumeResolution:medium.stellarVolumeResolution;
  const sourceTexels=spatial?medium.sourceVolumeTexels:medium.stellarVolumeTexels;
  const sourceCenter=spatial?medium.sourceVolumeCenter:medium.bulgeCenter;
  const sourceAxes=spatial?medium.sourceVolumeAxes:medium.bulgeAxes;
  if(sourceResolution!==GALACTIC_MEDIUM_STELLAR_VOLUME_RESOLUTION||!(sourceTexels instanceof Float32Array)||sourceTexels.length!==sourceResolution**3*(spatial?4:1))
    throw new TypeError('Galactic volume requires a compiled stellar population');
  if(medium.dustVolumeResolution!==GALACTIC_MEDIUM_DUST_VOLUME_RESOLUTION||!(medium.dustVolumeTexels instanceof Float32Array)||medium.dustVolumeTexels.length!==medium.dustVolumeResolution**3)
    throw new TypeError('Galactic volume requires compiled dust clouds');
  const table=spatial?null:fieldTexture(medium.texels,medium.resolution,THREE.RGBAFormat);
  const verticalGeometry=spatial?null:fieldTexture(medium.verticalGeometry,medium.resolution,THREE.RGBAFormat,true);
  const stellarVolumeTable=fieldTexture(sourceTexels,sourceResolution,spatial?THREE.RGBAFormat:THREE.RedFormat,false,true);
  const dustVolumeTable=fieldTexture(medium.dustVolumeTexels,medium.dustVolumeResolution,THREE.RedFormat,false,true);
  let uploadedDustBound=medium.dustVerticalBound,uploadedStellarBound=medium.stellarVerticalBound,verticalExpansion=0;
  let uploadedDiskDustBound=0;
  if(!spatial){
    uploadedDiskDustBound=medium.dustHeight;
    const sourceStellarHeight=Math.max(medium.stellarHeight,medium.youngStellarHeight);
    const dustHeight=Math.fround(medium.dustHeight),stellarHeight=Math.fround(sourceStellarHeight),halfGeometry=verticalGeometry.image.data;
    for(let i=0;i<halfGeometry.length;i+=4){
      const dustOffset=THREE.DataUtils.fromHalfFloat(halfGeometry[i]),dustScale=THREE.DataUtils.fromHalfFloat(halfGeometry[i+1]);
      const stellarOffset=THREE.DataUtils.fromHalfFloat(halfGeometry[i+2]),stellarScale=THREE.DataUtils.fromHalfFloat(halfGeometry[i+3]);
      uploadedDustBound=Math.max(uploadedDustBound,Math.abs(dustOffset)+dustHeight*dustScale);
      uploadedDiskDustBound=Math.max(uploadedDiskDustBound,Math.abs(dustOffset)+dustHeight*dustScale);
      uploadedStellarBound=Math.max(uploadedStellarBound,Math.abs(stellarOffset)+stellarHeight*stellarScale);
      verticalExpansion=Math.max(verticalExpansion,
        Math.abs(dustOffset-medium.verticalGeometry[i])+Math.abs(dustHeight*dustScale-medium.dustHeight*medium.verticalGeometry[i+1]),
        Math.abs(stellarOffset-medium.verticalGeometry[i+2])+Math.abs(stellarHeight*stellarScale-sourceStellarHeight*medium.verticalGeometry[i+3]));
    }
  }
  // Bounds cover the uploaded representation, including outward half/f32
  // rounding. They are coverage/integration bounds, never collision surfaces.
  uploadedDustBound=uploadedDustBound*(1+2**-22)+1e-9;
  uploadedDiskDustBound=uploadedDiskDustBound*(1+2**-22)+1e-9;
  if(medium.dustCloudIntegral>0)uploadedDustBound=Math.max(uploadedDustBound,Math.abs(Math.fround(medium.dustCloudCenter[1]))+Math.fround(medium.dustCloudAxes[1])+1e-6);
  uploadedStellarBound=uploadedStellarBound*(1+2**-22)+1e-9;
  const supportRadius=medium.supportRadius+verticalExpansion+1e-6;
  const mediumUniforms={stellarVolumeTable:{value:stellarVolumeTable},dustVolumeTable:{value:dustVolumeTable},dustVerticalBound:{value:uploadedDustBound},supportRadius:{value:supportRadius},
    oldStellarColor:{value:new THREE.Color(...medium.oldStellarColor)},youngStellarColor:{value:new THREE.Color(...medium.youngStellarColor)},
    bulgeCenter:{value:new THREE.Vector3(...sourceCenter)},bulgeAxes:{value:new THREE.Vector3(...sourceAxes)},
    bulgeColor:{value:new THREE.Color(...medium.bulgeColor)},extinctionColor:{value:new THREE.Vector3(...medium.extinctionColor)},
    dustCloudCenter:{value:new THREE.Vector3(...medium.dustCloudCenter)},dustCloudAxes:{value:new THREE.Vector3(...medium.dustCloudAxes)},hasDustCloud:{value:Number(medium.dustCloudIntegral>0)},
    dustVolumeResolution:{value:medium.dustVolumeResolution}};
  if(!spatial)Object.assign(mediumUniforms,{mediumTable:{value:table},verticalGeometryTable:{value:verticalGeometry},
    mediumHeights:{value:new THREE.Vector2(medium.stellarHeight,medium.dustHeight)},youngStellarHeight:{value:medium.youngStellarHeight},
    diskDustVerticalBound:{value:uploadedDiskDustBound},diskStellarVerticalBound:{value:uploadedStellarBound}});
  const shared={localCamera:{value:new THREE.Vector3()},radius:{value:descriptor.radius},brightness:{value:1},structureVisibility:{value:1}};
  const uniforms={...mediumUniforms,...shared,shapeScale:{value:new THREE.Vector3(1,1,1)},
    heightBound:{value:Math.max(uploadedStellarBound,uploadedDustBound,Math.abs(sourceCenter[1])+sourceAxes[1])+1e-6},
    continuumWeight:{value:1-medium.resolvedFraction},structureKind:{value:0},uVisibility:{value:1},uDensity:{value:1},steps:{value:64},
    worldOrientation:{value:new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...descriptor.orientation)))},
    uSceneDepth:{value:null},uHasSceneDepth:{value:0},uDepthResolution:{value:new THREE.Vector2(1,1)},uCameraNearFar:{value:new THREE.Vector2(1,220000)}};
  const defines=spatial?{GALACTIC_SPATIAL_EMISSION:1}:{};
  const material=new THREE.ShaderMaterial({uniforms,defines,vertexShader:volumeVertex,fragmentShader:GALACTIC_VOLUME_FRAGMENT_GLSL,
    transparent:true,side:THREE.BackSide,depthWrite:false,depthTest:false,blending:THREE.CustomBlending,
    blendEquation:THREE.AddEquation,blendSrc:THREE.OneFactor,blendDst:THREE.SrcAlphaFactor,
    blendSrcAlpha:THREE.ZeroFactor,blendDstAlpha:THREE.OneFactor});
  const geometry=hull(supportRadius),mesh=new THREE.Mesh(geometry,material);
  mesh.name=descriptor.id;mesh.rotation.fromArray(descriptor.orientation);mesh.scale.setScalar(descriptor.radius);mesh.frustumCulled=false;
  const sample=sampleGalacticStars(medium,descriptor.seed,GALACTIC_MEDIUM_MAX_STARS),starGeometry=new THREE.BufferGeometry();
  starGeometry.setAttribute('position',new THREE.BufferAttribute(sample.positions,3));
  starGeometry.setAttribute('color',new THREE.BufferAttribute(sample.colors,3));
  starGeometry.setAttribute('rawLuminosity',new THREE.BufferAttribute(sample.rawLuminosities,1));
  // Both populations occupy this real, finite parent support. A common sort
  // center keeps the volume before its already-attenuated points at equal
  // depth; it does not change ordering against foreground transparent bodies.
  starGeometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(),geometry.boundingSphere.radius);
  const psf=createStellarPsfTexture();
  const starUniforms={...psf.uniforms,...mediumUniforms,...shared,pixelHeight:{value:1},ratio:{value:1},powerScale:{value:0}};
  const starMaterial=new THREE.ShaderMaterial({uniforms:starUniforms,defines,vertexShader:pointsVertex,fragmentShader:pointsFragment,
    transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,depthTest:true});
  const stars=new THREE.Points(starGeometry,starMaterial);stars.frustumCulled=false;mesh.add(stars);
  const stats={stars:0,textureBytes:(table?table.image.data.byteLength:0)+(verticalGeometry?verticalGeometry.image.data.byteLength:0)+stellarVolumeTable.image.data.byteLength+dustVolumeTable.image.data.byteLength+psf.texture.image.data.byteLength,drawCalls:2,totalLuminosity:medium.totalLuminosity,resolvedLuminosity:0,unresolvedLuminosity:medium.totalLuminosity};
  mesh.userData.isGalacticMedium=true;mesh.userData.stats=stats;
  let disposed=false,previousCount=-1;
  mesh.userData.setQuality=(quality,pixelHeight=1,pixelRatio=1)=>{
    if(disposed)return;
    const count=quality==='low'?512:quality==='high'?4096:2048;
    uniforms.steps.value=quality==='low'?32:quality==='high'?96:64;
    starUniforms.pixelHeight.value=pixelHeight;starUniforms.ratio.value=pixelRatio;psf.setPixelRatio(pixelRatio);
    if(count===previousCount)return;
    let power=0;for(let i=0;i<count;i++)power+=sample.rawLuminosities[i];
    const represented=medium.resolvedFraction*medium.totalLuminosity;
    starUniforms.powerScale.value=represented/power;uniforms.continuumWeight.value=1-medium.resolvedFraction;
    starGeometry.setDrawRange(0,count);previousCount=count;stats.stars=count;
    stats.resolvedLuminosity=represented;stats.unresolvedLuminosity=medium.totalLuminosity-represented;
  };
  mesh.userData.setQuality('auto');
  mesh.userData.setSceneDepth=(texture,width,height,camera)=>{
    if(disposed)return;
    uniforms.uSceneDepth.value=texture;uniforms.uHasSceneDepth.value=texture?1:0;
    if(texture){uniforms.uDepthResolution.value.set(width,height);uniforms.uCameraNearFar.value.set(camera.near,camera.far);}
  };
  mesh.userData.dispose=()=>{
    if(disposed)return;disposed=true;uniforms.uSceneDepth.value=null;uniforms.uHasSceneDepth.value=0;
    psf.dispose();if(table)table.dispose();if(verticalGeometry)verticalGeometry.dispose();stellarVolumeTable.dispose();dustVolumeTable.dispose();geometry.dispose();material.dispose();starGeometry.dispose();starMaterial.dispose();mesh.clear();
  };
  return mesh;
}
