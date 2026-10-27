import * as THREE from 'three';
import { COSMIC_DEPTH_GLSL } from '../cosmic-structures.js';
import { COSMIC_BODY_INTERSECTIONS_GLSL, COSMIC_BODY_SURFACE_GLSL, cosmicBodyUniforms, setCosmicBody } from './distant-landmark.js';

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
const commonFragment = /* glsl */`
precision highp float;
in vec3 worldRay;
out vec4 bodyColor;
#define gl_FragColor bodyColor
uniform mat4 projectionMatrix;
uniform mat3 uViewRotation;
uniform float uCameraNear;
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
const opaqueFragment = commonFragment + COSMIC_BODY_SURFACE_GLSL + /* glsl */`
void main(){
  vec3 direction=normalize(worldRay),ray=uBodyFrame*direction,origin=-uBodyFrame*uBodyCenter;
  float minimum=uCameraNear/uBodyRadius/max(-(uViewRotation*direction).z,1.e-8);
  vec3 point,normal;float distance;
  if(!bodyCast(origin,ray,minimum,point,normal,distance))discard;
  bodyDepth(direction,distance*uBodyRadius);
  vec3 color=uBodyKind==1?ringSurface(point,normal,ray,distance):sphereSurface(point,normal,ray,distance);
  bodyColor=vec4(color,uVisibility);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const overlayFragment = commonFragment + /* glsl */`
void main(){
  vec3 direction=normalize(worldRay),ray=uBodyFrame*direction,origin=-uBodyFrame*uBodyCenter;
  vec3 point;float distance,alpha;vec3 color;
  if(uBodyKind==2){
    alpha=gasRingCast(origin,ray,point,distance);
    float along=dot(-point,uLight);
    float shadow=along>0.?1.-smoothstep(.97,1.02,length(cross(point,uLight))):0.;
    color=uTint*(.045+.5*abs(uLight.y))*(1.-shadow*.95);
  }else{
    alpha=plasmaCast(origin,ray,distance);
    color=mix(vec3(1.,.55,.25),vec3(.35,.6,1.),step(uTint.r,uTint.b))*.7;
  }
  float minimum=uCameraNear/uBodyRadius/max(-(uViewRotation*direction).z,1.e-8);
  if(alpha<=.002||distance<=minimum)discard;
  // The far transparent LOD no longer writes the photosphere's depth. Retain
  // its own occultation of far-side decorations within this same entity.
  if(uVisibility<1.){
    vec3 solidPoint,solidNormal;float solidDistance;
    if(bodyCast(origin,ray,minimum,solidPoint,solidNormal,solidDistance)&&solidDistance<distance)discard;
  }
  bodyDepth(direction,distance*uBodyRadius);
  bodyColor=vec4(color,alpha*uVisibility);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function supportRadius(body) {
  if (body.kind === 'gas-giant' && body.ringed) return body.radius * 2.1;
  if (body.shape.type === 'compound') {
    let support = 0;
    for (const part of body.shape.parts) support = Math.max(support, Math.hypot(part.outerRadius, Math.max(Math.abs(part.minY), Math.abs(part.maxY))));
    return support;
  }
  let support = body.shape.radius;
  if (body.kind === 'stellar-giant' && body.prominences) for (const prominence of body.prominences)
    support = Math.max(support, body.radius * Math.hypot(.996 + prominence.radii[1], prominence.radii[0]));
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
  const group = new THREE.Group();
  group.name = 'Physical cosmic body';
  group.visible = false;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const entries = [];
  const createEntry = () => {
    const uniforms = cosmicBodyUniforms(options);
    uniforms.uInverseProjection = { value: new THREE.Matrix4() };
    uniforms.uCameraRotation = { value: new THREE.Matrix3() };
    uniforms.uViewRotation = { value: new THREE.Matrix3() };
    uniforms.uCameraNear = { value: .5 };
    uniforms.uPixelAngle = { value: .001 };
    uniforms.uScreenBounds = { value: new THREE.Vector4(-1, -1, 1, 1) };
    const opaqueMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms, vertexShader, fragmentShader: opaqueFragment,
      depthTest: true, depthWrite: true, transparent: false,
    });
    const overlayMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, uniforms, vertexShader, fragmentShader: overlayFragment,
      depthTest: true, depthWrite: false, transparent: true,
    });
    const opaque = new THREE.Mesh(geometry, opaqueMaterial), overlay = new THREE.Mesh(geometry, overlayMaterial);
    opaque.name = 'Cosmic solid surface'; overlay.name = 'Cosmic translucent rings and prominences';
    opaque.frustumCulled = false; overlay.frustumCulled = false;
    opaque.renderOrder = 2; overlay.renderOrder = 2;
    group.add(opaque, overlay);
    const entry = { uniforms, opaque, overlay };
    entries.push(entry);
    return entry;
  };
  createEntry();
  let disposed = false;
  const updateEntry = (entry, body, camera, viewportHeight, pixelRatio) => {
    const { uniforms, opaque, overlay } = entry;
    const visibility = body.visibility ?? 1;
    if (visibility <= 0) { opaque.visible = false; overlay.visible = false; return; }
    const partial = visibility < 1;
    if (opaque.material.transparent !== partial) {
      opaque.material.transparent = partial;
      opaque.material.depthWrite = !partial;
      opaque.material.needsUpdate = true;
    }
    const distance = Math.hypot(body.center[0], body.center[1], body.center[2]);
    opaque.renderOrder = partial ? -distance : 2;
    overlay.renderOrder = -distance;
    uniforms.uViewRotation.value.setFromMatrix4(camera.matrixWorldInverse);
    const visible = screenBounds(body, camera, uniforms.uViewRotation.value, uniforms.uScreenBounds.value);
    opaque.visible = visible;
    overlay.visible = visible && (body.kind === 'gas-giant' && body.ringed === true || body.kind === 'stellar-giant' && body.prominences?.length > 0);
    if (!visible) return;
    setCosmicBody(uniforms, body);
    uniforms.uInverseProjection.value.copy(camera.projectionMatrixInverse);
    uniforms.uCameraRotation.value.setFromMatrix4(camera.matrixWorld);
    uniforms.uCameraNear.value = camera.near;
    uniforms.uRayMinimum.value = camera.near / body.radius;
    uniforms.uPixelAngle.value = 2 / (camera.projectionMatrix.elements[5] * viewportHeight * pixelRatio);
  };
  group.userData.update = ({ body = null, bodies = null, camera, viewportHeight, pixelRatio = 1 }) => {
    if (disposed) return;
    const count = bodies === null ? Number(body !== null) : bodies.length;
    group.visible = count > 0;
    if (count === 0) return;
    camera.updateWorldMatrix(true, false);
    for (let i = 0; i < count; i++) updateEntry(entries[i] || createEntry(), bodies === null ? body : bodies[i], camera, viewportHeight, pixelRatio);
    for (let i = count; i < entries.length; i++) { entries[i].opaque.visible = false; entries[i].overlay.visible = false; }
  };
  group.userData.dispose = () => {
    if (disposed) return;
    disposed = true;
    group.visible = false;
    geometry.dispose();
    for (const entry of entries) { entry.opaque.material.dispose(); entry.overlay.material.dispose(); }
    entries.length = 0;
    group.clear();
  };
  return group;
}
