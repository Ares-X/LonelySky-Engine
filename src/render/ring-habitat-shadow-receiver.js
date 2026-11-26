import * as THREE from 'three';

export const RING_HABITAT_SHADOW_TRIANGLE_FETCH_GLSL=/* glsl */`vec4 habitatShadowIndexedVertex(highp sampler2D table,int width,int index){
  int face=index/3;
  vec3 addresses=texelFetch(table,ivec2(face%width,face/width),0).xyz;
  int vertex=int(addresses[index%3]);
  return texelFetch(table,ivec2(vertex%width,vertex/width),0);
}
uint habitatShadowULPBits(float value){
  uint exponent=(floatBitsToUint(abs(value))>>23u)&255u;
  return exponent>23u?(exponent-23u)<<23u:1u<<(exponent>0u?exponent-1u:0u);
}
vec3 habitatShadowResidual(vec4 encoded){
  if(encoded.w==0.)return vec3(0.);
  uint word=uint(encoded.w)-1u;
  vec3 q=vec3(float(word&255u),float((word>>8u)&255u),float((word>>16u)&255u))-128.;
  vec3 ulp=vec3(uintBitsToFloat(habitatShadowULPBits(encoded.x)),uintBitsToFloat(habitatShadowULPBits(encoded.y)),uintBitsToFloat(habitatShadowULPBits(encoded.z)));
  return q*(ulp/255.);
}`;


/** Body-local positions in scene units, NOT radius-normalized body coordinates.
 * Only direct illumination is multiplied by this actual-mesh shadow visibility.
 * Each selected cascade uses four bilinearly weighted depth comparisons. Only
 * the transition band samples both maps (eight taps); inner/outer regions use four.
 */
export const RING_HABITAT_SHADOW_GLSL=/* glsl */`
uniform float uVegetationShadowTriangleAware;
uniform highp sampler2D uVegetationShadow,uVegetationShadowNear,uVegetationShadowTriangles;
uniform int uVegetationShadowTriangleWidth;
uniform mat3 uVegetationShadowTriangleBasis;
uniform vec3 uVegetationShadowTriangleOffset;
uniform vec3 uVegetationShadowReceiverHi,uVegetationShadowReceiverLo;
uniform vec3 uVegetationShadowNearCameraProjected,uVegetationShadowFarCameraProjected;
uniform float uVegetationShadowWorldBias,uVegetationShadowReversed;
${RING_HABITAT_SHADOW_TRIANGLE_FETCH_GLSL}
vec4 habitatShadowTriangleVertex(int index){return habitatShadowIndexedVertex(uVegetationShadowTriangles,uVegetationShadowTriangleWidth,index);}
float habitatShadowTerrainVisibility(float id,vec3 receiverHi,vec3 receiverLo,vec3 receiverSmall,vec3 tapDelta,float receiverError){
  int first=(int(id+.5)-1)*3;
  vec4 av=habitatShadowTriangleVertex(first),bv=habitatShadowTriangleVertex(first+1),cv=habitatShadowTriangleVertex(first+2);
  // Never form a ring-scale receiver or reconstruct hi+lo before subtraction.
  vec3 a=(av.xyz-receiverHi)+(habitatShadowResidual(av)-receiverLo)-receiverSmall;
  vec3 b=(bv.xyz-receiverHi)+(habitatShadowResidual(bv)-receiverLo)-receiverSmall;
  vec3 c=(cv.xyz-receiverHi)+(habitatShadowResidual(cv)-receiverLo)-receiverSmall;
  vec2 aa=a.xy-tapDelta.xy,bb=b.xy-tapDelta.xy,cc=c.xy-tapDelta.xy;
  float wa=bb.x*cc.y-bb.y*cc.x,wb=cc.x*aa.y-cc.y*aa.x,wc=aa.x*bb.y-aa.y*bb.x;
  if((wa<0.||wb<0.||wc<0.)&&(wa>0.||wb>0.||wc>0.))return 1.;
  float determinant=wa+wb+wc;
  // A light-parallel zero-area projection cannot intersect this finite ray.
  if(determinant==0.)return 1.;
  float casterZ=(wa*a.z+wb*b.z+wc*c.z)/determinant;
  return casterZ>tapDelta.z+uVegetationShadowWorldBias+receiverError?0.:1.;
}
float habitatShadowTapVisibility(vec2 depthAndId,float receiverDepth,vec3 receiverHi,vec3 receiverLo,vec3 receiverSmall,vec3 tapDelta,float receiverError){
  if(depthAndId.y>0.)return habitatShadowTerrainVisibility(depthAndId.y,receiverHi,receiverLo,receiverSmall,tapDelta,receiverError);
  float depth=mix(depthAndId.x,1.-depthAndId.x,uVegetationShadowReversed);
  return step(receiverDepth,depth);
}
uniform mat4 uVegetationShadowMatrix,uVegetationShadowNearMatrix;
uniform vec3 uVegetationShadowOrigin,uVegetationShadowLight,uVegetationShadowCameraRelative;
uniform vec2 uVegetationShadowTexel;
uniform float uVegetationShadowEnabled,uVegetationShadowBias;
// Orthographic rows are orthogonal scaled light axes. Transform the actual
// geometric plane normal by the inverse transpose without a matrix inverse:
// nShadow_i = dot(row_i,nBody)/dot(row_i,row_i). Its depth gradients predict
// the SAME physical receiver plane at each PCF texel centre.
vec2 habitatReceiverPlaneGradient(mat4 matrix,vec3 geometricNormal){
  vec3 x=vec3(matrix[0].x,matrix[1].x,matrix[2].x);
  vec3 y=vec3(matrix[0].y,matrix[1].y,matrix[2].y);
  vec3 z=vec3(matrix[0].z,matrix[1].z,matrix[2].z);
  float depthNormal=dot(z,geometricNormal);
  // Exactly light-parallel faces have zero projected plane area and no finite
  // z(x,y) graph. No arbitrary clamp or unbounded bias invents such a graph.
  if(depthNormal==0.)return vec2(0.);
  float reciprocal=dot(z,z)/depthNormal;
  return -vec2(dot(x,geometricNormal)/dot(x,x),dot(y,geometricNormal)/dot(y,y))*reciprocal;
}
float habitatVegetationPCF(highp sampler2D shadowMap,vec3 projected,float receiver,vec2 planeGradient,vec3 receiverHi,vec3 receiverLo,vec3 receiverSmall,mat4 matrix,vec3 geometricNormal,bool closeReceiver){
  vec2 pixel=projected.xy/uVegetationShadowTexel-.5;
  vec2 weight=fract(pixel),base=(floor(pixel)+.5)*uVegetationShadowTexel;
  vec2 a=texture(shadowMap,base).rg;
  vec2 b=texture(shadowMap,base+vec2(uVegetationShadowTexel.x,0.)).rg;
  vec2 c=texture(shadowMap,base+vec2(0.,uVegetationShadowTexel.y)).rg;
  vec2 d=texture(shadowMap,base+uVegetationShadowTexel).rg;
  float first=receiver+dot(planeGradient,base-projected.xy);
  vec3 x=vec3(matrix[0].x,matrix[1].x,matrix[2].x);
  vec3 y=vec3(matrix[0].y,matrix[1].y,matrix[2].y);
  vec3 z=vec3(matrix[0].z,matrix[1].z,matrix[2].z);
  // The bilinear4-tap footprint reaches at most one texel diagonal in
  // lightXY. A bounded slope-weighted terrain error band contains the local
  // piecewise-planar receiver discretization; it vanishes with texel size.
  // It is an optical sampling approximation, not a curvature solver. Do not
  // divide by NdotL: grazing faces must not erase distant mountain blockers.
  float footprint=length(uVegetationShadowTexel/vec2(length(x),length(y)));
  float incidence=dot(normalize(geometricNormal),uVegetationShadowLight);
  float receiverError=closeReceiver?footprint*sqrt(max(0.,1.-incidence*incidence)):0.;
  vec3 stepX=vec3(0.),stepY=vec3(0.);
  // The existing exactly light-parallel boundary has no finite receiver-plane
  // graph. Preserve its centre-ray semantics without an epsilon or slope clamp.
  if(dot(z,geometricNormal)!=0.){
    stepX=uVegetationShadowTriangleBasis*(x/dot(x,x)+z*(planeGradient.x/dot(z,z)));
    stepY=uVegetationShadowTriangleBasis*(y/dot(y,y)+z*(planeGradient.y/dot(z,z)));
  }
  vec3 firstDelta=stepX*(base.x-projected.x)+stepY*(base.y-projected.y);
  vec3 deltaX=stepX*uVegetationShadowTexel.x,deltaY=stepY*uVegetationShadowTexel.y;
  vec4 visible=vec4(habitatShadowTapVisibility(a,first,receiverHi,receiverLo,receiverSmall,firstDelta,receiverError),
    habitatShadowTapVisibility(b,first+planeGradient.x*uVegetationShadowTexel.x,receiverHi,receiverLo,receiverSmall,firstDelta+deltaX,receiverError),
    habitatShadowTapVisibility(c,first+planeGradient.y*uVegetationShadowTexel.y,receiverHi,receiverLo,receiverSmall,firstDelta+deltaY,receiverError),
    habitatShadowTapVisibility(d,first+dot(planeGradient,uVegetationShadowTexel),receiverHi,receiverLo,receiverSmall,firstDelta+deltaX+deltaY,receiverError));
  return mix(mix(visible.x,visible.y,weight.x),mix(visible.z,visible.w,weight.x),weight.y);
}
float habitatVegetationPCFLegacy(highp sampler2D shadowMap,vec3 projected,float receiver){
  vec2 pixel=projected.xy/uVegetationShadowTexel-.5;
  vec2 weight=fract(pixel),base=(floor(pixel)+.5)*uVegetationShadowTexel;
  float a=texture(shadowMap,base).r;
  float b=texture(shadowMap,base+vec2(uVegetationShadowTexel.x,0.)).r;
  float c=texture(shadowMap,base+vec2(0.,uVegetationShadowTexel.y)).r;
  float d=texture(shadowMap,base+uVegetationShadowTexel).r;
  vec4 depth=mix(vec4(a,b,c,d),vec4(1.)-vec4(a,b,c,d),uVegetationShadowReversed);
  vec4 visible=step(vec4(receiver),depth);
  return mix(mix(visible.x,visible.y,weight.x),mix(visible.z,visible.w,weight.x),weight.y);
}
float habitatVegetationVisibilityLegacy(vec3 bodyLocalPoint,vec3 groundNormal){
  if(uVegetationShadowEnabled<.5)return 1.;
  // Both cascades and the depth vertices subtract this identical local origin
  // before the tree offsets or projection matrix can lose sub-unit precision.
  vec3 relative=bodyLocalPoint-uVegetationShadowOrigin;
  vec3 nearPoint=(uVegetationShadowNearMatrix*vec4(relative,1.)).xyz;
  float slope=1.-max(dot(groundNormal,uVegetationShadowLight),0.);
  float bias=uVegetationShadowBias*(1.+slope*2.);
  float nearWeight=0.;
  if(all(greaterThan(nearPoint,vec3(0.)))&&all(lessThan(nearPoint,vec3(1.)))){
    vec2 edge=min(nearPoint.xy,vec2(1.)-nearPoint.xy);
    nearWeight=smoothstep(.025,.125,min(edge.x,edge.y));
  }
  float nearVisibility=1.;
  if(nearWeight>0.)nearVisibility=habitatVegetationPCFLegacy(uVegetationShadowNear,nearPoint,nearPoint.z-bias);
  if(nearWeight>=1.)return nearVisibility;
  vec3 farPoint=(uVegetationShadowMatrix*vec4(relative,1.)).xyz;
  float farVisibility=1.;
  if(all(greaterThan(farPoint,vec3(0.)))&&all(lessThan(farPoint,vec3(1.)))){
    vec2 edge=min(farPoint.xy,vec2(1.)-farPoint.xy);
    float coverage=smoothstep(0.,.015,min(edge.x,edge.y));
    farVisibility=mix(1.,habitatVegetationPCFLegacy(uVegetationShadow,farPoint,farPoint.z-bias),coverage);
  }
  return mix(farVisibility,nearVisibility,nearWeight);
}
float habitatVegetationVisibilityProjected(vec3 nearPoint,vec3 bodyOffset,bool cameraAnchored,vec3 groundNormal,vec3 receiverHi,vec3 receiverLo,vec3 receiverSmall){
  float bias=uVegetationShadowBias;
  float nearWeight=0.;
  if(all(greaterThan(nearPoint,vec3(0.)))&&all(lessThan(nearPoint,vec3(1.)))){
    vec2 edge=min(nearPoint.xy,vec2(1.)-nearPoint.xy);
    nearWeight=smoothstep(.025,.125,min(edge.x,edge.y));
  }
  float nearVisibility=1.;
  if(nearWeight>0.)nearVisibility=habitatVegetationPCF(uVegetationShadowNear,nearPoint,nearPoint.z-bias,habitatReceiverPlaneGradient(uVegetationShadowNearMatrix,groundNormal),receiverHi,receiverLo,receiverSmall,uVegetationShadowNearMatrix,groundNormal,true);
  if(nearWeight>=1.)return nearVisibility;
  vec3 farPoint=cameraAnchored?uVegetationShadowFarCameraProjected+mat3(uVegetationShadowMatrix)*bodyOffset:(uVegetationShadowMatrix*vec4(bodyOffset,1.)).xyz;
  float farVisibility=1.;
  if(all(greaterThan(farPoint,vec3(0.)))&&all(lessThan(farPoint,vec3(1.)))){
    vec2 edge=min(farPoint.xy,vec2(1.)-farPoint.xy);
    float coverage=smoothstep(0.,.015,min(edge.x,edge.y));
    farVisibility=mix(1.,habitatVegetationPCF(uVegetationShadow,farPoint,farPoint.z-bias,habitatReceiverPlaneGradient(uVegetationShadowMatrix,groundNormal),receiverHi,receiverLo,receiverSmall,uVegetationShadowMatrix,groundNormal,false),coverage);
  }
  return mix(farVisibility,nearVisibility,nearWeight);
}
float habitatVegetationVisibilityRelative(vec3 relative,vec3 groundNormal){
  if(uVegetationShadowTriangleAware<.5)return habitatVegetationVisibilityLegacy(relative+uVegetationShadowOrigin,groundNormal);
  if(uVegetationShadowEnabled<.5)return 1.;
  vec3 receiverLight=uVegetationShadowTriangleBasis*(relative+uVegetationShadowTriangleOffset);
  vec3 nearPoint=(uVegetationShadowNearMatrix*vec4(relative,1.)).xyz;
  return habitatVegetationVisibilityProjected(nearPoint,relative,false,groundNormal,receiverLight,vec3(0.),vec3(0.));
}
float habitatVegetationVisibility(vec3 bodyLocalPoint,vec3 geometricNormal){
  if(uVegetationShadowTriangleAware<.5)return habitatVegetationVisibilityLegacy(bodyLocalPoint,geometricNormal);
  return habitatVegetationVisibilityRelative(bodyLocalPoint-uVegetationShadowOrigin,geometricNormal);
}
float habitatVegetationVisibilityCameraRelative(vec3 cameraOffset,vec3 geometricNormal){
  if(uVegetationShadowTriangleAware<.5)return habitatVegetationVisibilityRelative(uVegetationShadowCameraRelative+cameraOffset,geometricNormal);
  if(uVegetationShadowEnabled<.5)return 1.;
  vec3 nearPoint=uVegetationShadowNearCameraProjected+mat3(uVegetationShadowNearMatrix)*cameraOffset;
  return habitatVegetationVisibilityProjected(nearPoint,cameraOffset,true,geometricNormal,uVegetationShadowReceiverHi,uVegetationShadowReceiverLo,uVegetationShadowTriangleBasis*cameraOffset);
}
`;

/** Disabled defaults are shared by generic body shaders and the map owner. */
export function createRingHabitatShadowUniforms(mapSize=2048){
  return {
    uVegetationShadowTriangleAware:{value:0},uVegetationShadow:{value:null},uVegetationShadowNear:{value:null},
    uVegetationShadowTriangles:{value:null},uVegetationShadowTriangleWidth:{value:1},
    uVegetationShadowTriangleBasis:{value:new THREE.Matrix3()},uVegetationShadowTriangleOrigin:{value:new THREE.Vector3()},uVegetationShadowTriangleOffset:{value:new THREE.Vector3()},uVegetationShadowWorldBias:{value:.12},
    uVegetationShadowMatrix:{value:new THREE.Matrix4()},uVegetationShadowNearMatrix:{value:new THREE.Matrix4()},
    uVegetationShadowOrigin:{value:new THREE.Vector3()},uVegetationShadowLight:{value:new THREE.Vector3()},
    uVegetationShadowCameraRelative:{value:new THREE.Vector3()},
    uVegetationShadowReceiverHi:{value:new THREE.Vector3()},uVegetationShadowReceiverLo:{value:new THREE.Vector3()},
    uVegetationShadowNearCameraProjected:{value:new THREE.Vector3()},uVegetationShadowFarCameraProjected:{value:new THREE.Vector3()},
    uVegetationShadowTexel:{value:new THREE.Vector2(1/mapSize,1/mapSize)},
    uVegetationShadowEnabled:{value:0},uVegetationShadowBias:{value:0},uVegetationShadowReversed:{value:0},
  };
}
