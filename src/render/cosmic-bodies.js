import {bindGasMacroIdentity,bindGasMacroTime} from './gas-cloud-macro.js';
import {createRingHabitatRegionRenderer} from './ring-habitat-regions.js';
import {HaloTerrainUnavailable} from '../ring-habitat-regions.js';
import {createRockyContactShadows,createRockyContactShadowUniforms,ROCKY_CONTACT_SHADOW_GLSL} from './rocky-contact-shadows.js';
import {createScannedRockySurface} from './rocky-scanned-surface.js';
import {NATURAL_RING} from '../natural-ring.js';
import {createNaturalRingDebris} from './natural-ring-debris.js';
import {createRingHabitatVegetation} from './ring-habitat-vegetation.js';
import {createRingHabitatGroundcover} from './ring-habitat-groundcover.js';
import {createRingHabitatShadows} from './ring-habitat-shadows.js';
import {createRingHabitatTemporal} from './ring-habitat-temporal.js';
import {GAS_CLOUD_ATMOSPHERE_GLSL} from './gas-cloud-atmosphere.js';
import {createEmptyRingHabitatGeometryTexture} from './ring-habitat-geometry.js';
import {COSMIC_WORLD_SCENE_DEPTH_GLSL} from './cosmic-scene-depth.js';
import {isDepthVolumeVisible} from './depth-volume.js';
import * as THREE from 'three';
import { COSMIC_DEPTH_GLSL } from '../cosmic-structures.js';
import { COSMIC_BODY_INTERSECTIONS_GLSL, COSMIC_BODY_SURFACE_GLSL, COSMIC_BODY_NOISE_GLSL, cosmicBodyUniforms, setCosmicBody, stellarProminenceSupport } from './distant-landmark.js';
import {RING_HABITAT_AIR_GLSL,RING_HABITAT_ATMOSPHERE_GLSL} from './ring-habitat-atmosphere.js';

const STELLAR_LIMB_SCALE_HEIGHT=.0015,STELLAR_LIMB_OUTER=1.012;

const vertexShader = /* glsl */`
out vec3 worldRay;
uniform mat4 uInverseProjection;
uniform mat3 uCameraRotation;
uniform vec4 uScreenBounds;
void main(){
  vec2 ndc=mix(uScreenBounds.xy,uScreenBounds.zw,position.xy*.5+.5);
  worldRay=uCameraRotation*(uInverseProjection*vec4(ndc,1.,1.)).xyz;
  gl_Position=vec4(ndc,0.,1.);
}`;
const bodyFragmentInputs = /* glsl */`
precision highp float;
precision highp int;
in vec3 worldRay;
uniform mat4 projectionMatrix;
uniform mat3 uViewRotation;
uniform float uCameraNear;
uniform highp sampler2D uHaloNearDepth;
uniform float uHaloNearDepthEnabled;
uniform vec2 uHaloNearDepthSize,uHaloNearDepthCamera;
${COSMIC_DEPTH_GLSL}
${COSMIC_BODY_INTERSECTIONS_GLSL}
// Projection uses a camera-relative direction, so floating origins and camera
// rotation do not move the object. Only radial drawing depth is compressed;
// intersections and perspective size always use physical world coordinates.
void bodyDepth(vec3 direction,float physicalDistance){
  vec3 viewPoint=uViewRotation*direction*cosmicDrawDistance(physicalDistance);
  vec4 clip=projectionMatrix*vec4(viewPoint,1.);
  #ifdef USE_REVERSED_DEPTH_BUFFER
    gl_FragDepth=clip.z/clip.w;
  #else
    gl_FragDepth=.5*clip.z/clip.w+.5;
  #endif
}
`;
const commonFragment = bodyFragmentInputs + /* glsl */`
out vec4 bodyColor;
#define gl_FragColor bodyColor
`;
const opaqueFragment = commonFragment + `\n#define ROCKY_CONTACT_SHADOW\n` + ROCKY_CONTACT_SHADOW_GLSL + COSMIC_BODY_SURFACE_GLSL + /* glsl */`
void main(){
  vec3 direction=normalize(worldRay),ray=uBodyFrame*direction,origin=uBodyOrigin;
  float minimum=uCameraNear/uBodyRadius/max(-(uViewRotation*direction).z,1.e-8);
  vec3 point,normal;float distance;
  if(!bodyCast(origin,ray,minimum,point,normal,distance))discard;
  // The canonical terrain depth pass precedes this expensive analytic core.
  // It is sampled only here; hardware triangles retain ordinary MSAA coverage.
  if(uHaloNearDepthEnabled>.5){
    float depth=texelFetch(uHaloNearDepth,ivec2(gl_FragCoord.xy),0).r;
    float near=uHaloNearDepthCamera.x,far=uHaloNearDepthCamera.y,forward;bool covered;
    #ifdef USE_REVERSED_DEPTH_BUFFER
      forward=near*far/(near+depth*(far-near));covered=depth>0.;
    #else
      forward=near*far/(far-depth*(far-near));covered=depth<1.;
    #endif
    float terrainDistance=cosmicTrueDistance(forward/max(-(uViewRotation*direction).z,1.e-8));
    if(covered&&distance*uBodyRadius>terrainDistance)discard;
  }
  bodyDepth(direction,distance*uBodyRadius);
  vec3 color=uBodyKind==1?ringSurface(point,normal,ray,distance):sphereSurface(point,normal,ray,distance);
  // Exhausting the finite geometry traversal is visibly invalid, never a
  // plausible smooth wall with silently omitted physical plates.
  if(ringGeometryOverflow)color=vec3(10.,0.,10.);
  bodyColor=vec4(color,uVisibility);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const overlayFragment = commonFragment + COSMIC_WORLD_SCENE_DEPTH_GLSL + /* glsl */`
uniform bool uNaturalRingResolved;
void main(){
  vec3 direction=normalize(worldRay),ray=uBodyFrame*direction,origin=uBodyOrigin;
  float minimum=uCameraNear/uBodyRadius/max(-(uViewRotation*direction).z,1.e-8);
  float maximum=sceneWorldPhysicalLimit(direction)/uBodyRadius;
  vec3 solidPoint,solidNormal;float solidDistance;
  if(bodyCast(origin,ray,minimum,solidPoint,solidNormal,solidDistance))maximum=min(maximum,solidDistance);
  float distance,alpha;vec3 color;
  if(uBodyKind==2){
    vec3 litShare;
    alpha=naturalRingColumn(origin,ray,minimum,maximum,uNaturalRingResolved,distance,litShare);
    color=uTint*litShare;
  }else{
    alpha=plasmaCast(origin,ray,minimum,maximum,distance,color);
  }
  if(alpha<=.002||distance<=minimum)discard;
  bodyDepth(direction,distance*uBodyRadius);
  bodyColor=vec4(color,alpha*uVisibility);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// A separate optical layer owns its ray interval and depth. Mixing it with a
// planetary-ring plane gives two unrelated surfaces one depth and cuts the
// atmosphere at the plane. The exponential shell is an artistic single-scatter
// approximation; it is transparent and does not change the solid boundary.
const atmosphereInputs = COSMIC_WORLD_SCENE_DEPTH_GLSL + COSMIC_BODY_NOISE_GLSL + RING_HABITAT_AIR_GLSL + RING_HABITAT_ATMOSPHERE_GLSL;
// The temporal owner consumes exactly the same full-quality optical integral.
// Store linear premultiplied radiance and physical interval distances before
// tone mapping; the presentation pass alone maps and blends the result.
const rawHabitatAtmosphereFragment = bodyFragmentInputs + atmosphereInputs + /* glsl */`
layout(location=0) out vec4 habitatRawColor;
layout(location=1) out vec4 habitatRawMetadata;
void main(){
  vec3 direction=normalize(worldRay),ray=uBodyFrame*direction,origin=uBodyOrigin;
  float minimum=uCameraNear/uBodyRadius/max(-(uViewRotation*direction).z,1.e-8);
  float maximum=sceneWorldPhysicalLimit(direction)/uBodyRadius;
  vec3 color;float alpha,distance;
  habitatAtmosphere(origin,ray,minimum,maximum,color,alpha,distance);
  float opacity=alpha*uVisibility;
  habitatRawColor=vec4(color*opacity,opacity);
  habitatRawMetadata=vec4(distance*uBodyRadius,habitatColumnMeanDistance*uBodyRadius,
    habitatColumnMaximum*uBodyRadius,habitatColumnValid?1.:0.);
}`;
const gasAtmosphereShadowInputs = /* glsl */`
// Directional planet shadow = interior of the radius-R cylinder around the
// sun axis, intersected with dot(point,sun)<0. All positions/distances remain
// in this body's radius-normalized frame; uLight is already unit length.
vec2 gasAtmosphereShadowInterval(vec3 origin,vec3 ray,float radius,float lo,float hi){
  float shadowLo=lo,shadowHi=hi;
  float sunOrigin=dot(origin,uLight),sunDirection=dot(ray,uLight);
  // A ray parallel to the dividing plane is either entirely on the day side
  // or entirely in its anti-sun halfspace. No artificial epsilon/cap is used.
  if(sunDirection==0.){
    if(sunOrigin>=0.)return vec2(lo,lo);
  }else{
    float plane=-sunOrigin/sunDirection;
    if(sunDirection>0.)shadowHi=min(shadowHi,plane);
    else shadowLo=max(shadowLo,plane);
  }
  if(shadowHi<=shadowLo)return vec2(lo,lo);
  vec3 rayCross=cross(ray,uLight),originCross=cross(origin,uLight);
  float quadratic=dot(rayCross,rayCross),constantTerm=dot(originCross,originCross)-radius*radius;
  // Exactly axial rays have no quadratic crossing. Cylinder tangencies have
  // zero shadow-interior length, including an axial ray on its boundary.
  if(quadratic==0.)return constantTerm<0.?vec2(shadowLo,shadowHi):vec2(lo,lo);
  float linearTerm=dot(originCross,rayCross);
  vec3 crossOffset=cross(originCross,rayCross);
  float discriminant=quadratic*radius*radius-dot(crossOffset,crossOffset);
  if(discriminant<=0.)return vec2(lo,lo);
  // Product-of-roots form avoids subtracting almost equal near-entry roots.
  float root=sqrt(discriminant),q=-linearTerm-(linearTerm>=0.?root:-root);
  float first=q/quadratic,second=constantTerm/q;
  shadowLo=max(shadowLo,min(first,second));shadowHi=min(shadowHi,max(first,second));
  return shadowHi>shadowLo?vec2(shadowLo,shadowHi):vec2(lo,lo);
}
float gasAtmosphereLitAbsorbed(float lo,float hi,float opticalDepth,float absorbed,vec2 shadow){
  float shadowLo=max(lo,shadow.x),shadowHi=min(hi,shadow.y);
  if(shadowHi<=shadowLo)return absorbed;
  if(shadowLo<=lo&&shadowHi>=hi)return 0.;
  float start=(shadowLo-lo)/(hi-lo),span=(shadowHi-shadowLo)/(hi-lo);
  // Exact Beer-weighted absorption in the lit portion of this cell while its
  // existing midpoint density stays constant. Length fraction alone would
  // bias front-lit and rear-lit columns differently at finite optical depth.
  float shadowAbsorbed=exp(-opticalDepth*start)*(1.-exp(-opticalDepth*span));
  // The analytic difference lies in [0,absorbed]; bound only float roundoff
  // at a shadow endpoint, not the physical interval or an invalid parameter.
  return clamp(absorbed-shadowAbsorbed,0.,absorbed);
}`;
const gasCloudInputs=gasAtmosphereShadowInputs+GAS_CLOUD_ATMOSPHERE_GLSL;
const atmosphereFragment=commonFragment+atmosphereInputs+gasCloudInputs+/* glsl */`
void main(){
  vec3 direction=normalize(worldRay),ray=uBodyFrame*direction,origin=uBodyOrigin;
  float minimum=uCameraNear/uBodyRadius/max(-(uViewRotation*direction).z,1.e-8);
  float maximum=sceneWorldPhysicalLimit(direction)/uBodyRadius;
  if(uBodyKind==1){
    vec3 color;float alpha,distance;
    if(!habitatAtmosphere(origin,ray,minimum,maximum,color,alpha,distance))discard;
    bodyDepth(direction,distance*uBodyRadius);
    bodyColor=vec4(color,alpha*uVisibility);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }

  if(uBodyKind==4){
    // A thin emissive display layer, not a magnetic/plasma solver. Its fixed
    // body-relative scale is independent of the camera and photosphere gain.
    const float scaleHeight=${STELLAR_LIMB_SCALE_HEIGHT},outer=${STELLAR_LIMB_OUTER};
    float along=dot(origin,ray),perpendicular=dot(cross(origin,ray),cross(origin,ray));
    float disc=outer*outer-perpendicular;if(disc<=0.)discard;
    float root=sqrt(disc),lo=max(minimum,-along-root),hi=min(maximum,-along+root);
    float innerDisc=1.-perpendicular;
    if(innerDisc>=0.){float innerRoot=sqrt(innerDisc),front=-along-innerRoot,back=-along+innerRoot;if(back>minimum){if(front<=minimum)discard;hi=min(hi,front);}}
    if(hi<=lo)discard;
    float stepSize=(hi-lo)/16.,column=0.;
    for(int i=0;i<16;i++){
      float node=(floor(float(i)*.5)+.5+(mod(float(i),2.)-.5)*.577350269)*2.;
      float radius=length(origin+ray*(lo+node*stepSize));
      column+=exp(-(radius-1.)/scaleHeight)*stepSize/scaleHeight;
    }
    if(column<=.00001)discard;
    vec3 tint=mix(vec3(1.,.20,.045),vec3(.12,.42,1.),step(uTint.r,uTint.b));
    bodyColor=vec4(tint*(.06*column*uVisibility),1.);
    bodyDepth(direction,hi*uBodyRadius);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }

  vec3 radiance,metadata;float transmission;
  if(!gasCloudColumn(origin,ray,minimum,maximum,radiance,transmission,metadata))discard;
  float alpha=1.-transmission;if(alpha<=.001)discard;
  // Composite at the column entry. Inside the air shell its clipped end can
  // coincide with the opaque sphere; using that depth makes the layers fight.
  // Foreground geometry already clips the optical column through scene depth.
  bodyDepth(direction,metadata.x);
  bodyColor=vec4(radiance/alpha,alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function supportRadius(body) {
  if (body.kind === 'gas-giant') return Math.max(body.shape.radius*1.006,body.ringed?Math.hypot(body.radius*NATURAL_RING.outer,NATURAL_RING.halfHeight):0);
  if (body.shape.type === 'compound') {
    let support = 0;
    for (const part of body.shape.parts) support = Math.max(support, Math.hypot(part.surfaceLattice?.outerRadius??part.outerRadius, Math.max(Math.abs(part.minY), Math.abs(part.maxY))));
    if(body.shape.terrainGroups)for(const cluster of body.shape.terrainGroups) support=Math.max(support,Math.hypot(cluster.center[0],cluster.center[1],cluster.center[2])+cluster.radius);
    return support;
  }
  let support = body.shape.radius;
  if(body.kind==='stellar-giant')support=Math.max(support,body.radius*STELLAR_LIMB_OUTER);
  if (body.kind === 'stellar-giant' && body.prominences) for (const prominence of body.prominences)
    support = Math.max(support, body.radius * stellarProminenceSupport(prominence.radii[0],prominence.radii[1]));
  return support;
}

// Project a conservative camera-aligned bounding box of the physical sphere.
// Objects meeting the near plane use the full screen. Intersections still use
// the actual shape; this only limits fragments that could never hit it.
function screenBounds(body, camera, viewRotation, out) {
  const p = body.center, f = viewRotation.elements, radius = supportRadius(body);
  const x = f[0] * p[0] + f[3] * p[1] + f[6] * p[2];
  const y = f[1] * p[0] + f[4] * p[1] + f[7] * p[2];
  const forward = -(f[2] * p[0] + f[5] * p[1] + f[8] * p[2]);
  if (forward + radius <= camera.near) return false;
  if (forward - radius <= camera.near) { out.set(-1, -1, 1, 1); return true; }
  const near = forward - radius, far = forward + radius, projection = camera.projectionMatrix.elements;
  const minX = Math.min((x - radius) / near, (x - radius) / far) * projection[0] - projection[8];
  const maxX = Math.max((x + radius) / near, (x + radius) / far) * projection[0] - projection[8];
  const minY = Math.min((y - radius) / near, (y - radius) / far) * projection[5] - projection[9];
  const maxY = Math.max((y + radius) / near, (y + radius) / far) * projection[5] - projection[9];
  if (minX > 1 || maxX < -1 || minY > 1 || maxY < -1) return false;
  out.set(Math.max(-1, minX), Math.max(-1, minY), Math.min(1, maxX), Math.min(1, maxY));
  return true;
}

/** Camera-relative physical solids and their optional translucent decoration.
 * Textures are borrowed; the caller retains their ownership. No camera-following
 * scaling, scene origin changes, or shape reconstruction occurs here. Slots grow
 * only to the active catalogue query's peak count, never with visited body IDs,
 * and are released together. The caller owns that bounded catalogue query.
 */
export function createCosmicBodies(options = {}) {
  // Validate/copy once before resource acquisition. Later slots must not read
  // mutable caller metadata or repeat validation during catalogue updates.
  const cloudColorMean=options.cloudColorMean===undefined?[1,1,1]:options.cloudColorMean;
  if(!Array.isArray(cloudColorMean)||cloudColorMean.length!==3)
    throw new RangeError('Cloud material mean must contain three finite positive linear values');
  for(const value of cloudColorMean)if(!Number.isFinite(value)||value<=0)
    throw new RangeError('Cloud material mean must contain three finite positive linear values');
  const materialOptions={...options,cloudColorMean:cloudColorMean.slice()};
  const photosphere=options.photosphereMaterial;
  if(photosphere!=null){
    if(options.stellarTexture?.isTexture!==true)throw new TypeError('Photosphere material requires a borrowed stellar texture');
    const rect=photosphere.uvRect;
    if(!Array.isArray(rect)||rect.length!==4||rect.some(v=>!Number.isFinite(v)||v<0||v>1)||rect[0]>=rect[2]||rect[1]>=rect[3])
      throw new RangeError('Photosphere UV rectangle must have positive area inside the image');
    if(!Number.isFinite(photosphere.linearLumaMean)||photosphere.linearLumaMean<=0||photosphere.linearLumaMean>1
      ||!Number.isFinite(photosphere.tileGranules)||photosphere.tileGranules<=0)
      throw new RangeError('Photosphere linear mean and nominal tile scale must be positive');
    const image=options.stellarTexture.image;
    if(!image||!Number.isFinite(image.width)||image.width<=0||!Number.isFinite(image.height)||image.height<=0
      ||!Number.isInteger(photosphere.maxLod)||photosphere.maxLod<0||photosphere.maxLod>Math.floor(Math.log2(Math.min(image.width,image.height))))
      throw new RangeError('Photosphere texture dimensions and maximum LOD must be valid');
    materialOptions.photosphereMaterial={uvRect:rect.slice(),linearLumaMean:photosphere.linearLumaMean,tileGranules:photosphere.tileGranules,maxLod:photosphere.maxLod};
  }
  const habitatMaterials=options.habitatMaterials;
  if(habitatMaterials!=null){
    const layers=['rock'];
    // Existing clients can still supply the original two-layer bundle.
    if(['groundColor','groundNormal','groundTileSize','groundColorMean'].some(key=>Object.hasOwn(habitatMaterials,key)))layers.push('ground');
    for(const layer of layers){
      for(const kind of ['Color','Normal']){
        const key=layer+kind;
        if(habitatMaterials[key]?.isTexture!==true)throw new TypeError(`Habitat material ${key} must be a Three texture`);
      }
      const size=habitatMaterials[layer+'TileSize'];
      if(!Number.isFinite(size)||size<=0)throw new RangeError('Habitat material tile sizes must be positive world-unit lengths');
      const mean=habitatMaterials[layer+'ColorMean'];
      if(!Array.isArray(mean)||mean.length!==3||mean.some(value=>!Number.isFinite(value)||value<=0||value>1))
        throw new RangeError(`Habitat material ${layer}ColorMean must contain three positive linear reflectances`);
    }
  }
  const foliageMaterial=options.foliageMaterial;
  if(foliageMaterial!=null){
    for(const key of ['color','alpha'])
      if(foliageMaterial[key]?.isTexture!==true)throw new TypeError(`Habitat foliage ${key} must be a Three texture`);
    const image=foliageMaterial.color.image;
    if(!image||!Number.isFinite(image.width)||image.width<=0||!Number.isFinite(image.height)||image.height<=0)
      throw new RangeError('Habitat foliage colour atlas must have loaded dimensions');
    const rect=foliageMaterial.uvRect;
    if(!Array.isArray(rect)||rect.length!==4||rect.some(value=>!Number.isFinite(value)||value<0||value>1)
      ||rect[0]>=rect[2]||rect[1]>=rect[3])throw new RangeError('Habitat foliage UV rectangle must have positive area inside the atlas');
  }
  const group = new THREE.Group();
  const habitatMapDefines={
    ...(materialOptions.habitatTexture?{HABITAT_PORT_MAP:1}:{}),
    ...(materialOptions.surfaceTexture?{HABITAT_SURFACE_MAP:1}:{}),
  };
  const observedDefines={
    ...habitatMapDefines,
    ...(materialOptions.cloudTexture?{GAS_OBSERVED_CLOUDS:1}:{}),
    ...(materialOptions.stellarTexture?{OBSERVED_STELLAR_SURFACE:1}:{}),
    ...(habitatMaterials?{SCANNED_ROCK_SURFACE:1}:{}),
  };
  group.name = 'Physical cosmic body';
  group.visible = false;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  // One full-resolution history serves the nearest visible habitat. Other
  // rings retain their complete direct integral, without per-body histories.
  const temporal=createRingHabitatTemporal({geometry,vertexShader,rawFragmentShader:rawHabitatAtmosphereFragment});
  let temporalEntry=null;
  const rockyShadows=options.rockySurfaceField?createRockyContactShadows():null;
  const halo=options.haloTerrain?createRingHabitatRegionRenderer({
    terrainRegistry:options.haloTerrain,targetOwnsScissor:options.haloTargetOwnsScissor===true,habitatMapDefines,
  }):null;
  if(halo)group.add(halo);
  let currentCamera=null;
  const entries = [];
  const createEntry = () => {
    const uniforms = cosmicBodyUniforms(materialOptions);
    if(halo){Object.assign(uniforms,halo.userData.shadowUniforms,halo.userData.depthUniforms);uniforms.uVegetationShadowEnabled={value:0};}
    Object.assign(uniforms,rockyShadows?rockyShadows.uniforms:createRockyContactShadowUniforms());uniforms.uRockyShadowEnabled={value:0};
    const shadows=halo?null:createRingHabitatShadows({uniforms});
    uniforms.uInverseProjection = { value: new THREE.Matrix4() };
    uniforms.uCameraRotation = { value: new THREE.Matrix3() };
    uniforms.uViewRotation = { value: new THREE.Matrix3() };
    uniforms.uCameraNear = { value: .5 };
    uniforms.uPixelAngle = { value: .001 };
    uniforms.uScreenBounds = { value: new THREE.Vector4(-1, -1, 1, 1) };
    uniforms.uDensity={value:1};uniforms.uNaturalRingResolved={value:Boolean(options.naturalRingField)};
    uniforms.uSceneDepth={value:null};uniforms.uHasSceneDepth={value:0};
    uniforms.uDepthResolution={value:new THREE.Vector2(1,1)};
    uniforms.uCameraNearFar={value:new THREE.Vector2(.5,220000)};
    const opaqueMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms, vertexShader, fragmentShader: opaqueFragment,
      defines:observedDefines,
      depthTest: true, depthWrite: true, transparent: false,
    });
    const overlayMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms, vertexShader, fragmentShader: overlayFragment,
      depthTest: true, depthWrite: false, transparent: true,
    });
    const atmosphereMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms, vertexShader, fragmentShader: atmosphereFragment,
      defines:observedDefines,
      depthTest: true, depthWrite: false, transparent: true,
    });
    const opaque = new THREE.Mesh(geometry, opaqueMaterial), overlay = new THREE.Mesh(geometry, overlayMaterial);
    const atmosphere = new THREE.Mesh(geometry,atmosphereMaterial);
    atmosphere.name='Cosmic optical atmosphere';atmosphere.frustumCulled=false;
    const vegetation=createRingHabitatVegetation({shadowUniforms:uniforms,foliageMaterial:foliageMaterial??null,terrainRegistry:options.haloTerrain??null});
    const groundcover=createRingHabitatGroundcover({shadowUniforms:uniforms,terrainRegistry:options.haloTerrain??null});
    atmosphere.visible=false;opaque.add(atmosphere,vegetation,groundcover);
    // The existing volume pass owns the borrowed opaque-depth texture. Clip
    // scattering at actual foreground geometry, rather than using a distant
    // transparent carrier that can fight the floor or cover the ship.
    atmosphere.userData.setSceneDepth=(texture,width,height,viewCamera)=>{
      uniforms.uSceneDepth.value=texture;uniforms.uHasSceneDepth.value=texture?1:0;
      if(texture){uniforms.uDepthResolution.value.set(width,height);uniforms.uCameraNearFar.value.set(viewCamera.near,viewCamera.far);}
    };
    atmosphere.userData.prepareVolume=(renderer,width,height,viewCamera)=>{
      if(temporalEntry===entry)temporal.prepare(renderer,width,height,viewCamera);
    };
    // The depth-compositing pass alone can enable presentation. Ordinary
    // renderer/RenderPass consumers keep the complete direct optical integral.
    atmosphere.userData.setVolumePreparation=enabled=>{
      atmosphere.material=enabled&&temporalEntry===entry?temporal.material:atmosphereMaterial;
    };
    opaque.name = 'Cosmic solid surface'; overlay.name = 'Cosmic translucent rings and prominences';
    opaque.frustumCulled = false; overlay.frustumCulled = false;
    opaque.renderOrder = 2; overlay.renderOrder = 2;
    group.add(opaque, overlay);
    const entry = { uniforms, opaque, overlay, atmosphere, atmosphereMaterial, vegetation, groundcover, shadows,
      active:false,vegetationFrame:{body:null,camera:null,viewportHeight:1,pixelRatio:1,climate:0} };
    entries.push(entry);
    return entry;
  };
  createEntry();
  // One bounded near-field GPU owner per view, never per visited macro slot.
  const debris=options.naturalRingField?createNaturalRingDebris({field:options.naturalRingField}):null;
  const debrisFrame={body:null,bodies:null,camera:null,sectorIndex:0,viewportHeight:1,pixelRatio:1};
  if(debris)group.add(debris);
  const rocky=options.rockySurfaceField?createScannedRockySurface({field:options.rockySurfaceField,shadowUniforms:rockyShadows.uniforms}):null;
  if(rocky)group.add(rocky);
  let disposed = false;
  // Render-target contents belong to one GL context generation. Retain the
  // CPU-backed terrain/maps and rebuild only GPU-derived caches on next prepare.
  group.userData.invalidateGpuCaches=()=>{
    if(disposed)return;
    temporal.clear();temporalEntry=null;if(rockyShadows)rockyShadows.clear();if(halo)halo.userData.invalidateGpuCaches();
    for(const entry of entries){
      entry.atmosphere.material=entry.atmosphereMaterial;
      if(entry.shadows)entry.shadows.clear();entry.uniforms.uVegetationShadowEnabled.value=0;entry.uniforms.uRockyShadowEnabled.value=0;
    }
  };
  const retireEntry=entry=>{
    entry.opaque.visible=false;entry.overlay.visible=false;entry.atmosphere.visible=false;
    entry.atmosphere.material=entry.atmosphereMaterial;
    if(temporalEntry===entry){temporal.clear();temporalEntry=null;}
    if(entry.shadows)entry.shadows.clear();entry.uniforms.uVegetationShadowEnabled.value=0;entry.uniforms.uRockyShadowEnabled.value=0;
    delete entry.overlay.userData.setSceneDepth;
    if(!entry.active)return;
    entry.active=false;
    entry.vegetationFrame.body=null;entry.vegetation.userData.update(entry.vegetationFrame);
    entry.groundcover.userData.clear();
    const terrain=entry.uniforms.uHabitatTerrain.value;
    if(terrain.userData.isHabitatFull){terrain.dispose();entry.uniforms.uHabitatTerrain.value=createEmptyRingHabitatGeometryTexture();}
    entry.uniforms.uHabitatGroupCount.value=0;
  };
  const updateEntry = (entry, body, camera, viewportHeight, pixelRatio, celestialTime, gasWeatherTime) => {
    const { uniforms, opaque, overlay, atmosphere, atmosphereMaterial } = entry;
    const visibility = body.visibility ?? 1;
    if (visibility <= 0) { retireEntry(entry); return; }
    entry.active=true;
    const partial = visibility < 1;
    if (opaque.material.transparent !== partial) {
      opaque.material.transparent = partial;
      opaque.material.depthWrite = !partial;
      opaque.material.needsUpdate = true;
    }
    const distance = Math.hypot(body.center[0], body.center[1], body.center[2]);
    opaque.renderOrder = partial ? -distance : 2;
    overlay.renderOrder = -distance;
    // Habitat air is a foreground optical medium, including when the camera
    // is inside the ring. Sorting it by the remote ring centre puts ordinary
    // zero-order transparent stars on top of opaque clouds. Composite after
    // the scenery; its fragment depth still protects nearer opaque geometry.
    atmosphere.renderOrder = body.kind==='ring'||body.kind==='gas-giant'?3:-distance;
    uniforms.uViewRotation.value.setFromMatrix4(camera.matrixWorldInverse);
    const visible = screenBounds(body, camera, uniforms.uViewRotation.value, uniforms.uScreenBounds.value);
    opaque.visible = visible;
    overlay.visible = visible && (body.kind === 'gas-giant' && body.ringed === true || body.kind === 'stellar-giant' && body.prominences?.length > 0);
    const atmosphereBlending=body.kind==='stellar-giant'?THREE.AdditiveBlending:THREE.NormalBlending;
    if(atmosphereMaterial.blending!==atmosphereBlending){atmosphereMaterial.blending=atmosphereBlending;atmosphereMaterial.needsUpdate=true;}
    if(overlay.material.blending!==atmosphereBlending){overlay.material.blending=atmosphereBlending;overlay.material.needsUpdate=true;}
    atmosphere.visible=visible&&(body.kind==='stellar-giant'||body.kind==='gas-giant'||body.kind==='ring'&&body.shape.parts.length>=3);
    if (!visible) return;
    if(overlay.visible)overlay.userData.setSceneDepth=atmosphere.userData.setSceneDepth;
    else delete entry.overlay.userData.setSceneDepth;
    if(body.kind==='gas-giant'&&!materialOptions.cloudTexture){
      bindGasMacroIdentity(entry,body);
      bindGasMacroTime(entry,gasWeatherTime);
      setCosmicBody(uniforms,body,gasWeatherTime,entry.gasMacroProfile.microVelocity);
    }else setCosmicBody(uniforms,body);
    if(halo&&body.habitat?.terrainRecipes)halo.userData.updateBody(body,uniforms);
    const pixelAngle=2/(camera.projectionMatrix.elements[5]*viewportHeight*pixelRatio);
    if(body.kind==='ring'){
      // A continuous 30-minute visual wind path keeps its offset precise
      // even for the far-future timestamps carried by saved journeys.
      const angle=(celestialTime%1800)*(Math.PI/900),side=1-Math.cos(angle);
      uniforms.uHabitatWind.value.set(1800*Math.sin(angle),320*side,1400*side);
    }
    uniforms.uInverseProjection.value.copy(camera.projectionMatrixInverse);
    uniforms.uCameraRotation.value.setFromMatrix4(camera.matrixWorld);
    uniforms.uCameraNear.value = camera.near;
    uniforms.uRayMinimum.value = camera.near / body.radius;
    uniforms.uPixelAngle.value = pixelAngle;
    const vegetationFrame=entry.vegetationFrame;
    vegetationFrame.body=body;vegetationFrame.camera=camera;vegetationFrame.viewportHeight=viewportHeight;vegetationFrame.pixelRatio=pixelRatio;
    vegetationFrame.climate=uniforms.uHabitatClimate.value;
    entry.vegetation.userData.update(vegetationFrame);
    entry.groundcover.userData.update(vegetationFrame);
  };
  group.userData.prepareTerrain=frame=>halo?halo.userData.prepareTerrain(frame):Promise.resolve(true);
  group.userData.terrainReady=frame=>!halo||halo.userData.terrainReady(frame);
  group.userData.terrainPreparationNeeded=frame=>!!halo&&halo.userData.terrainPreparationNeeded(frame);
  group.userData.releaseTerrainView=()=>{for(const entry of entries)if(entry.vegetationFrame.body?.kind==='ring')retireEntry(entry);if(halo)halo.userData.clear();};
  group.userData.haloTerrainStats=halo?halo.userData.stats:null;
  group.userData.haloShadowStats=halo?halo.userData.shadowStats:null;
  group.userData.update = frame => {
    if (disposed) return;
    const {body=null,bodies=null,camera,viewportHeight,pixelRatio=1,sectorIndex=0,time=0,celestialTime=time,gasWeatherTime=celestialTime}=frame;
    if(halo&&!halo.userData.terrainReady(frame))throw new HaloTerrainUnavailable('halo-render-not-ready','Prepare the complete canonical terrain view before update');
    const count = bodies === null ? Number(body !== null) : bodies.length;
    if(count>0)camera.updateWorldMatrix(true, false);
    currentCamera=camera;if(halo)halo.userData.beginFrame(celestialTime,count>0?camera:null);
    group.visible = count > 0;
    if (count === 0) {for(const entry of entries)retireEntry(entry);if(debris)debris.userData.clear();if(rocky)rocky.userData.clear();if(rockyShadows)rockyShadows.clear();return;}
    for (let i = 0; i < count; i++) updateEntry(entries[i] || createEntry(), bodies === null ? body : bodies[i], camera, viewportHeight, pixelRatio, celestialTime, gasWeatherTime);
    for (let i = count; i < entries.length; i++)retireEntry(entries[i]);
    if(debris){debrisFrame.body=body;debrisFrame.bodies=bodies;debrisFrame.camera=camera;debrisFrame.sectorIndex=sectorIndex;debrisFrame.viewportHeight=viewportHeight;debrisFrame.pixelRatio=pixelRatio;debris.userData.update(debrisFrame);}
    const grainStats=debris?.userData.grains.userData.stats;
    for(const entry of entries)entry.uniforms.uNaturalRingGrainResolved.value=Boolean(entry.active&&grainStats&&grainStats.instances>0&&grainStats.bodyId===entry.vegetationFrame.body?.id);
    if(rocky){debrisFrame.body=body;debrisFrame.bodies=bodies;debrisFrame.camera=camera;debrisFrame.sectorIndex=sectorIndex;debrisFrame.viewportHeight=viewportHeight;debrisFrame.pixelRatio=pixelRatio;rocky.userData.update(debrisFrame);}
  };
  // Render directional vegetation depth before the main pass. A separate
  // prepare phase avoids recursively rendering from an object's draw callback.
  group.userData.prepare=renderer=>{
    if(disposed)return;
    for(const entry of entries)entry.uniforms.uRockyShadowEnabled.value=0;
    if(rockyShadows)rockyShadows.prepare(renderer,rocky);
    if(halo){
      halo.userData.prepareDepth(renderer,currentCamera);
      const id=halo.userData.getShadowBodyId();let selected=null;
      for(const entry of entries){entry.uniforms.uVegetationShadowEnabled.value=0;if(entry.active&&entry.opaque.visible&&entry.vegetationFrame.body.id===id)selected=entry;}
      if(selected){halo.userData.prepareShadows(renderer,selected.vegetation,selected.vegetationFrame.body.light);selected.uniforms.uVegetationShadowEnabled.value=halo.userData.shadowUniforms.uVegetationShadowEnabled.value;}
      else halo.userData.clearShadows();
    }
    let selected=null,nearest=Infinity;
    for(const entry of entries){
      entry.uniforms.uRockyShadowEnabled.value=Number(Boolean(rockyShadows&&rockyShadows.stats.enabled&&entry.active&&entry.vegetationFrame.body?.id===rockyShadows.stats.bodyId));
      entry.atmosphere.material=entry.atmosphereMaterial;
      if(entry.shadows){if(entry.active&&entry.opaque.visible&&entry.vegetation.visible)entry.shadows.prepare(renderer,entry.vegetation,entry.vegetationFrame.body.light);else entry.shadows.clear();}
      if(entry.active&&entry.atmosphere.visible&&entry.uniforms.uBodyKind.value===1
        &&isDepthVolumeVisible(entry.atmosphere,entry.vegetationFrame.camera)){
        const center=entry.uniforms.uBodyCenter.value,radius=entry.uniforms.uBodyRadius.value;
        const distance=center.length()*radius;
        if(distance<nearest){nearest=distance;selected=entry;}
      }
    }
    if(selected&&temporal.supported(renderer)){
      temporal.bind(selected.uniforms,selected.vegetationFrame.body.id);
      temporalEntry=selected;
    }else if(temporalEntry){temporal.clear();temporalEntry=null;}
  };
  Object.defineProperty(group.userData,'vegetationCount',{get(){
    let count=0;for(const entry of entries)if(entry.opaque.visible&&entry.vegetation.visible)count+=entry.vegetation.userData.stats.instances;
    return count;
  }});
  Object.defineProperty(group.userData,'groundcoverCount',{get(){
    let count=0;for(const entry of entries)if(entry.opaque.visible&&entry.groundcover.visible)count+=entry.groundcover.userData.stats.instances;
    return count;
  }});
  Object.defineProperty(group.userData,'shadowMapCount',{get(){
    let count=0;for(const entry of entries){
      const u=entry.uniforms;
      if(u.uVegetationShadowEnabled.value>0){count+=Number(u.uVegetationShadow.value!==null)+Number(u.uVegetationShadowNear.value!==null);}
    }
    return count;
  }});
  group.userData.rockySurfaceSnapshot=()=>rocky&&rocky.userData.stats.instances>0?[{...rocky.userData.snapshot(),shadow:{...rockyShadows.stats}}]:[];
  group.userData.naturalRingSnapshot=()=>debris&&(debris.userData.stats.instances>0||debris.userData.stats.grainInstances>0)?[debris.userData.snapshot()]:[];
  group.userData.habitatTemporal=temporal.stats;
  group.userData.dispose = () => {
    if (disposed) return;
    disposed = true;
    group.visible = false;
    temporalEntry=null;temporal.dispose();if(halo)halo.userData.dispose();currentCamera=null;
    if(rockyShadows)rockyShadows.dispose();
    geometry.dispose();
    for (const entry of entries) { if(entry.shadows)entry.shadows.dispose();entry.opaque.material.dispose(); entry.overlay.material.dispose(); entry.atmosphereMaterial.dispose();entry.vegetation.userData.dispose();entry.groundcover.userData.dispose();entry.vegetationFrame.body=null;entry.uniforms.uRingLattices.value.dispose();entry.uniforms.uHabitatTerrain.value.dispose();entry.uniforms.uStellar.value=null;entry.uniforms.uHasStellarPhotosphere.value=false;entry.uniforms.uSceneDepth.value=null;entry.uniforms.uClouds.value=null;entry.opaque.clear(); }
    if(debris)debris.userData.dispose();if(rocky)rocky.userData.dispose();debrisFrame.body=null;debrisFrame.bodies=null;
    entries.length = 0;
    group.clear();
  };
  return group;
}
