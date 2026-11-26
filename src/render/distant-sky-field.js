import {Vector4} from 'three';

// Shared angular population for radiant haze and unresolved point sources.
// Planes and wedges are in world axes, independent of camera and pixel grid.
export const DISTANT_SKY_FIELD_GLSL = /* glsl */`
uniform float uDistantFieldBlend;
uniform vec4 uDistantFieldPlane,uDistantFieldFacing,uDistantFieldStyle;
float skyHash(vec3 p) { p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z); }
float skyNoise(vec3 p) {
  vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(mix(skyHash(i),skyHash(i+vec3(1,0,0)),f.x),mix(skyHash(i+vec3(0,1,0)),skyHash(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(skyHash(i+vec3(0,0,1)),skyHash(i+vec3(1,0,1)),f.x),mix(skyHash(i+vec3(0,1,1)),skyHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
// A moving window on the immutable angular catalogue. The triangular rank
// stays continuous at phase wrap and preserves a uniform rank distribution.
float distantStarRank(float rank) {
  return abs(2.*fract(rank+uDistantFieldStyle.z*.159154943)-1.);
}
float distantSkyPattern(vec3 ray) {
  float along=dot(ray,uDistantFieldFacing.xyz);
  float crosswise=dot(ray,uDistantFieldPlane.xyz);
  float phase=uDistantFieldStyle.z;
  float bend=uDistantFieldStyle.w;
  float latitude=(crosswise-bend*(along*along-.38))/uDistantFieldPlane.w;
  float broken=smoothstep(-.67,.73,sin(along*7.+ray.z*5.+phase));
  float stream=exp(-latitude*latitude)*(.25+.75*broken)*smoothstep(-.87,.46,along);
  float irregularity=sin(dot(ray,vec3(3.1,-5.3,4.6))+phase)*.14;
  float banks=smoothstep(.18,.85,along+irregularity)
    +.48*smoothstep(.38,.92,-.69*along+.72*crosswise-irregularity);
  float islands=banks*smoothstep(-.62,.62,sin(dot(ray,vec3(-7.4,4.3,8.1))-phase));
  return mix(stream,islands,uDistantFieldFacing.w);
}
float distantStellarKnots(vec3 ray,float field) {
  float phase=uDistantFieldStyle.z;
  float population=skyNoise(ray*27.+vec3(phase,-4.,1.6));
  return field*smoothstep(.35,.72,population);
}
vec3 distantStellarTint(float knots,float field) {
  // Cool, dispersed associations and a warm ridge both retain neutral light.
  float cores=smoothstep(.08,.62,knots);
  vec3 stream=mix(vec3(.58,.77,1.18),vec3(1.14,.68,.39),.52+cores*.48);
  vec3 islands=mix(vec3(.39,.68,1.21),vec3(.93,1.01,1.16),cores);
  vec3 tint=mix(stream,islands,uDistantFieldFacing.w);
  return mix(tint,mix(vec3(.51,.74,1.12),vec3(1.07,.66,.49),uDistantFieldStyle.y),.21+.12*clamp(field,0.,1.));
}
`;

export function distantSkyFieldUniforms() {
  return {uDistantFieldBlend:{value:0},uDistantFieldPlane:{value:new Vector4(0,1,0,1)},
    uDistantFieldFacing:{value:new Vector4(1,0,0,0)},uDistantFieldStyle:{value:new Vector4()}};
}

export function setDistantSkyField(uniforms, field) {
  uniforms.uDistantFieldBlend.value=field?.blend??0;
  if (uniforms.uDistantFieldBlend.value>0) {
    uniforms.uDistantFieldPlane.value.fromArray(field.plane);
    uniforms.uDistantFieldFacing.value.fromArray(field.facing);
    uniforms.uDistantFieldStyle.value.fromArray(field.style);
  }
}
