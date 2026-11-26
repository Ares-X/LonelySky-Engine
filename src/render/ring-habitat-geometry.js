import * as THREE from 'three';
// This fixed shader/texture transport is independent of the CPU mesh limit.
export const HABITAT_MESH_VERTEX_CAPACITY=2048,HABITAT_MESH_FACE_CAPACITY=4096,HABITAT_MESH_NODE_CAPACITY=2048;

const PATCH_CAPACITY = 32, VERTICES_PER_PATCH = HABITAT_MESH_VERTEX_CAPACITY, FACES_PER_PATCH = HABITAT_MESH_FACE_CAPACITY, NODES_PER_PATCH = HABITAT_MESH_NODE_CAPACITY;
const PATCH_TEXELS = PATCH_CAPACITY * 4;
const VERTEX_BASE = PATCH_TEXELS;
const FACE_BASE = VERTEX_BASE + PATCH_CAPACITY * VERTICES_PER_PATCH * 2;
const NODE_BASE = FACE_BASE + PATCH_CAPACITY * FACES_PER_PATCH;
const TEXTURE_TEXELS = NODE_BASE + PATCH_CAPACITY * NODES_PER_PATCH * 2;
const TEXTURE_WIDTH = 512, TEXTURE_HEIGHT = Math.ceil(TEXTURE_TEXELS / TEXTURE_WIDTH);
const EMPTY = Object.freeze([]);

/** One fixed texture per rendering slot; its renderer owns disposal.
 * Patch: center/radius, vertexFirst/count/faceFirst/count, nodeFirst/count/0/0.
 * Vertex: center-relative position, then smooth lighting normal.xyz / surfaceKind.w.
 * Missing surfaceKinds mean natural ground (0); 1 marks exposed rock.
 * Face: three global vertex indices, in triangleOrder (the CPU BVH leaf order).
 * Node: min.xyz/leftOrFirst, max.xyz/rightOrNegativeLeafCount.
 * Positions, bounds and radii are divided by the ring radius. Normals are not.
 */
function geometryTexture(width, height, full) {
  const texture = new THREE.DataTexture(new Float32Array(width * height * 4), width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.name = full ? 'Ring habitat mesh BVH' : 'Empty ring habitat geometry';
  texture.internalFormat = 'RGBA32F';
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.userData.isHabitatFull = full;
  texture.userData.habitatGroupCount = 0;
  texture.userData.habitatVertexCount = 0;
  texture.userData.habitatFaceCount = 0;
  texture.userData.habitatNodeCount = 0;
  texture.needsUpdate = true;
  return texture;
}

export function createRingHabitatGeometryTexture() {
  return geometryTexture(TEXTURE_WIDTH, TEXTURE_HEIGHT, true);
}

/** Borrow the same sampler interface for slots without terrain, using 16 bytes.
 * A renderer replaces/disposes textures when capacity changes; dimensions stay fixed.
 */
export function createEmptyRingHabitatGeometryTexture() {
  return geometryTexture(1, 1, false);
}

function writeTexel(data, offset, x, y, z, w) {
  x = Math.fround(x); y = Math.fround(y); z = Math.fround(z); w = Math.fround(w);
  if (data[offset] === x && data[offset + 1] === y && data[offset + 2] === z && data[offset + 3] === w) return false;
  data[offset] = x; data[offset + 1] = y; data[offset + 2] = z; data[offset + 3] = w;
  return true;
}

function clearTexels(data, first, end) {
  let changed = false;
  for (let i = first * 4; i < end * 4; i++) if (data[i] !== 0) { data[i] = 0; changed = true; }
  return changed;
}

/** Mesh geometry/BVHs are immutable and validated by their CPU owner.
 * The optional surfaceKinds channel is checked here before any texture write.
 * Check transport capacity before mutation. Reusing an immutable descriptor
 * skips all scans; numerically equal replacements also avoid another upload.
 */
export function setRingHabitatGeometry(texture, groups = EMPTY, radius) {
  const state = texture.userData;
  if (groups.length > 0 && !state.isHabitatFull) throw new RangeError('Ring habitat mesh requires a full geometry texture');
  if (state.habitatGroups === groups && state.habitatRadius === radius) return groups.length;
  if (groups.length > PATCH_CAPACITY) throw new RangeError('Ring habitat geometry exceeds 32 patches');
  let vertexCount = 0, faceCount = 0, nodeCount = 0;
  for (let i = 0; i < groups.length; i++) {
    const patch = groups[i];
    if (patch.vertices.length > VERTICES_PER_PATCH) throw new RangeError(`Ring habitat geometry exceeds ${VERTICES_PER_PATCH} vertices per patch`);
    if (patch.faces.length > FACES_PER_PATCH) throw new RangeError(`Ring habitat geometry exceeds ${FACES_PER_PATCH} faces per patch`);
    if (patch.nodes.length > NODES_PER_PATCH) throw new RangeError(`Ring habitat geometry exceeds ${NODES_PER_PATCH} BVH nodes per patch`);
    const kinds = patch.surfaceKinds;
    if (kinds !== undefined) {
      if (!Array.isArray(kinds) || kinds.length !== patch.vertices.length) throw new RangeError('Ring habitat surfaceKinds must match its vertices');
      for (let j = 0; j < kinds.length; j++)
        if (!Number.isFinite(kinds[j]) || kinds[j] < 0 || kinds[j] > 1) throw new RangeError('Ring habitat surfaceKinds must be finite values between 0 and 1');
    }
    vertexCount += patch.vertices.length;faceCount += patch.faces.length;nodeCount += patch.nodes.length;
  }
  const data = texture.image.data;
  let changed = false, firstVertex = 0, firstFace = 0, firstNode = 0;
  for (let i = 0; i < groups.length; i++) {
    const patch = groups[i], center = patch.center;
    if (writeTexel(data, i * 16, center[0] / radius, center[1] / radius, center[2] / radius, patch.radius / radius)) changed = true;
    if (writeTexel(data, i * 16 + 4, firstVertex, patch.vertices.length, firstFace, patch.faces.length)) changed = true;
    if (writeTexel(data, i * 16 + 8, firstNode, patch.nodes.length, 0, 0)) changed = true;
    for (let j = 0; j < patch.vertices.length; j++) {
      const vertex = patch.vertices[j], offset = (VERTEX_BASE + (firstVertex + j) * 2) * 4;
      const kind = patch.surfaceKinds === undefined ? 0 : patch.surfaceKinds[j];
      if (writeTexel(data, offset, vertex[0] / radius, vertex[1] / radius, vertex[2] / radius, 0)) changed = true;
      if (patch.normals) {
        const normal = patch.normals[j];
        if (writeTexel(data, offset + 4, normal[0], normal[1], normal[2], kind)) changed = true;
      } else if (writeTexel(data, offset + 4, 0, 0, 0, kind)) changed = true;
    }
    for (let j = 0; j < patch.faces.length; j++) {
      const face = patch.faces[patch.triangleOrder[j]];
      if (writeTexel(data, (FACE_BASE + firstFace + j) * 4, firstVertex + face[0], firstVertex + face[1], firstVertex + face[2], 0)) changed = true;
    }
    for (let j = 0; j < patch.nodes.length; j++) {
      const node = patch.nodes[j], offset = (NODE_BASE + (firstNode + j) * 2) * 4;
      const leftOrFirst = node.count > 0 ? firstFace + node.start : firstNode + node.left;
      const rightOrCount = node.count > 0 ? -node.count : firstNode + node.right;
      if (writeTexel(data, offset, node.min[0] / radius, node.min[1] / radius, node.min[2] / radius, leftOrFirst)) changed = true;
      if (writeTexel(data, offset + 4, node.max[0] / radius, node.max[1] / radius, node.max[2] / radius, rightOrCount)) changed = true;
    }
    firstVertex += patch.vertices.length;firstFace += patch.faces.length;firstNode += patch.nodes.length;
  }
  if (clearTexels(data, groups.length * 4, state.habitatGroupCount * 4)) changed = true;
  if (clearTexels(data, VERTEX_BASE + vertexCount * 2, VERTEX_BASE + state.habitatVertexCount * 2)) changed = true;
  if (clearTexels(data, FACE_BASE + faceCount, FACE_BASE + state.habitatFaceCount)) changed = true;
  if (clearTexels(data, NODE_BASE + nodeCount * 2, NODE_BASE + state.habitatNodeCount * 2)) changed = true;
  state.habitatGroupCount = groups.length;state.habitatVertexCount = vertexCount;
  state.habitatFaceCount = faceCount;state.habitatNodeCount = nodeCount;
  state.habitatGroups = groups;state.habitatRadius = radius;
  if (changed) texture.needsUpdate = true;
  return groups.length;
}

export const RING_HABITAT_GEOMETRY_GLSL = /* glsl */`
uniform highp sampler2D uHabitatTerrain;
uniform int uHabitatGroupCount;
vec3 habitatTerrainShadingNormal=vec3(0.);
float habitatTerrainOverflow=0.;
float habitatTerrainRockCoverage=0.;

vec4 habitatTerrainTexel(int index){
  return texelFetch(uHabitatTerrain,ivec2(index%${TEXTURE_WIDTH},index/${TEXTURE_WIDTH}),0);
}
float habitatAxis(float x,float y,float z,int axis){return axis==0?x:(axis==1?y:z);}

// Dominant-axis shear intersection. Shared triangle edges use the same endpoint
// products in reverse order, retaining the closed mesh at shared boundaries.
vec4 habitatTriangleRayHit(float ox,float oy,float oz,float dx,float dy,float dz,
 float ax,float ay,float az,float bx,float by,float bz,float cx,float cy,float cz,bool shadowRay,float minimum,float maximum){
  int kz=abs(dx)>abs(dy)?0:1;
  if(abs(dz)>abs(habitatAxis(dx,dy,dz,kz)))kz=2;
  int kx=(kz+1)%3;
  int ky=(kx+1)%3;
  if(habitatAxis(dx,dy,dz,kz)<0.){int swap=kx;kx=ky;ky=swap;}
  float sx=habitatAxis(dx,dy,dz,kx)/habitatAxis(dx,dy,dz,kz);
  float sy=habitatAxis(dx,dy,dz,ky)/habitatAxis(dx,dy,dz,kz);
  float sz=1./habitatAxis(dx,dy,dz,kz);
  float a0=ax-ox;
  float a1=ay-oy;
  float a2=az-oz;
  float b0=bx-ox;
  float b1=by-oy;
  float b2=bz-oz;
  float c0=cx-ox;
  float c1=cy-oy;
  float c2=cz-oz;
  float axp=habitatAxis(a0,a1,a2,kx)-sx*habitatAxis(a0,a1,a2,kz);
  float ayp=habitatAxis(a0,a1,a2,ky)-sy*habitatAxis(a0,a1,a2,kz);
  float bxp=habitatAxis(b0,b1,b2,kx)-sx*habitatAxis(b0,b1,b2,kz);
  float byp=habitatAxis(b0,b1,b2,ky)-sy*habitatAxis(b0,b1,b2,kz);
  float cxp=habitatAxis(c0,c1,c2,kx)-sx*habitatAxis(c0,c1,c2,kz);
  float cyp=habitatAxis(c0,c1,c2,ky)-sy*habitatAxis(c0,c1,c2,kz);
  float u=cxp*byp-cyp*bxp;
  float v=axp*cyp-ayp*cxp;
  float w=bxp*ayp-byp*axp;
  if((u<0.||v<0.||w<0.)&&(u>0.||v>0.||w>0.))return vec4(maximum,0.,0.,0.);
  float determinant=u+v+w;
  // Negative winding exits the source solid. Only entry faces can occlude its light.
  if(determinant==0.||(shadowRay&&determinant<0.))return vec4(maximum,0.,0.,0.);
  float time=(u*habitatAxis(a0,a1,a2,kz)+v*habitatAxis(b0,b1,b2,kz)+w*habitatAxis(c0,c1,c2,kz))*sz/determinant;
  if(time<=minimum||time>=maximum)return vec4(maximum,0.,0.,0.);
  return vec4(time,u/determinant,v/determinant,w/determinant);
}

vec2 habitatBoxInterval(float ox,float oy,float oz,float dx,float dy,float dz,
 float ax,float ay,float az,float bx,float by,float bz,float minimum,float maximum){
  float entry=minimum;
  float exit=maximum;
  for(int axis=0;axis<3;axis++){
    float origin=habitatAxis(ox,oy,oz,axis);
    float ray=habitatAxis(dx,dy,dz,axis);
    float low=habitatAxis(ax,ay,az,axis);
    float high=habitatAxis(bx,by,bz,axis);
    if(ray==0.){
      if(origin<low||origin>high)return vec2(maximum,-1.);
    }else{
      float a=(low-origin)/ray;
      float b=(high-origin)/ray;
      entry=max(entry,min(a,b));exit=min(exit,max(a,b));
      if(entry>exit)return vec2(maximum,-1.);
    }
  }
  return vec2(entry,exit);
}

// Conservative broadphase only: packed vertices can round outward while the
// stored radius rounds inward. Cross-product cancellation adds arithmetic error.
// Sum absolute cross products before squaring so that error is bounded even
// when their subtraction is tiny. Sixteen float32 epsilons cover that operation
// chain and radius packing; no triangle positions or hit distances are inflated.
// Finite/nearest clipping belongs to the subsequent exact node AABB traversal.
bool habitatBoundIntersects(vec3 relative,vec3 ray,float raySquared,float radius){
  float cx=relative.y*ray.z-relative.z*ray.y;
  float cy=relative.z*ray.x-relative.x*ray.z;
  float cz=relative.x*ray.y-relative.y*ray.x;
  float bx=abs(relative.y*ray.z)+abs(relative.z*ray.y);
  float by=abs(relative.z*ray.x)+abs(relative.x*ray.z);
  float bz=abs(relative.x*ray.y)+abs(relative.y*ray.x);
  float radial=raySquared*radius*radius;
  float discriminant=radial-(cx*cx+cy*cy+cz*cz);
  float errorBound=16.*1.1920928955078125e-7*(radial+bx*bx+by*by+bz*bz);
  return discriminant>=-errorBound;
}

vec2 habitatNodeInterval(int node,vec3 relative,vec3 ray,float minimum,float maximum){
  vec3 low=habitatTerrainTexel(${NODE_BASE}+node*2).xyz;
  vec3 high=habitatTerrainTexel(${NODE_BASE}+node*2+1).xyz;
  return habitatBoxInterval(relative.x,relative.y,relative.z,ray.x,ray.y,ray.z,low.x,low.y,low.z,high.x,high.y,high.z,minimum,maximum);
}

bool habitatTerrainCast(vec3 origin,vec3 ray,bool shadowRay,float minimum,float maximum,
 out vec3 point,out vec3 normal,out float nearest){
  nearest=maximum;point=vec3(0.);normal=vec3(0.);
  habitatTerrainShadingNormal=vec3(0.);habitatTerrainOverflow=0.;habitatTerrainRockCoverage=0.;
  float raySquared=dot(ray,ray);
  int stack[32];float stackNear[32];
  for(int patchIndex=0;patchIndex<${PATCH_CAPACITY};patchIndex++){
    if(patchIndex>=uHabitatGroupCount)break;
    vec4 bounds=habitatTerrainTexel(patchIndex*4);
    vec3 relative=origin-bounds.xyz;
    if(!habitatBoundIntersects(relative,ray,raySquared,bounds.w))continue;
    vec4 nodes=habitatTerrainTexel(patchIndex*4+2);
    int root=int(nodes.x);
    vec2 rootSpan=habitatNodeInterval(root,relative,ray,minimum,nearest);
    if(rootSpan.y<rootSpan.x||rootSpan.x>=nearest)continue;
    int stackCount=1;stack[0]=root;stackNear[0]=rootSpan.x;
    for(int visit=0;visit<${NODES_PER_PATCH};visit++){
      if(stackCount==0)break;
      stackCount--;
      int node=stack[stackCount];
      if(stackNear[stackCount]>=nearest)continue;
      vec4 low=habitatTerrainTexel(${NODE_BASE}+node*2);
      vec4 high=habitatTerrainTexel(${NODE_BASE}+node*2+1);
      if(high.w<0.){
        int first=int(low.w),count=-int(high.w);
        for(int item=0;item<4;item++){
          if(item>=count)break;
          vec3 indices=habitatTerrainTexel(${FACE_BASE}+first+item).xyz;
          int ia=${VERTEX_BASE}+int(indices.x)*2,ib=${VERTEX_BASE}+int(indices.y)*2,ic=${VERTEX_BASE}+int(indices.z)*2;
          vec3 a=habitatTerrainTexel(ia).xyz,b=habitatTerrainTexel(ib).xyz,c=habitatTerrainTexel(ic).xyz;
          vec4 hit=habitatTriangleRayHit(relative.x,relative.y,relative.z,ray.x,ray.y,ray.z,a.x,a.y,a.z,b.x,b.y,b.z,c.x,c.y,c.z,shadowRay,minimum,nearest);
          if(hit.x<nearest){
            nearest=hit.x;point=origin+ray*nearest;normal=normalize(cross(b-a,c-a));
            vec4 na=habitatTerrainTexel(ia+1),nb=habitatTerrainTexel(ib+1),nc=habitatTerrainTexel(ic+1);
            vec3 smoothNormal=na.xyz*hit.y+nb.xyz*hit.z+nc.xyz*hit.w;
            habitatTerrainRockCoverage=na.w*hit.y+nb.w*hit.z+nc.w*hit.w;
            habitatTerrainShadingNormal=dot(smoothNormal,smoothNormal)>0.?normalize(smoothNormal):normal;
          }
        }
      }else{
        int left=int(low.w),right=int(high.w);
        vec2 a=habitatNodeInterval(left,relative,ray,minimum,nearest),b=habitatNodeInterval(right,relative,ray,minimum,nearest);
        bool hitA=a.y>=a.x&&a.x<nearest,hitB=b.y>=b.x&&b.x<nearest;
        if(hitA&&hitB){
          if(stackCount+2>32){habitatTerrainOverflow=1.;break;}
          bool leftNear=a.x<=b.x;
          stack[stackCount]=leftNear?right:left;stackNear[stackCount]=leftNear?b.x:a.x;stackCount++;
          stack[stackCount]=leftNear?left:right;stackNear[stackCount]=leftNear?a.x:b.x;stackCount++;
        }else if(hitA||hitB){
          if(stackCount+1>32){habitatTerrainOverflow=1.;break;}
          stack[stackCount]=hitA?left:right;stackNear[stackCount]=hitA?a.x:b.x;stackCount++;
        }
      }
    }
    if(stackCount>0)habitatTerrainOverflow=1.;
  }
  return nearest<maximum;
}
`;
