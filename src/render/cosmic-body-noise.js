// Canonical value-noise field shared by body materials and weather.
export const COSMIC_BODY_NOISE_GLSL = /* glsl */`
float bodyHash(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
float bodyNoise(vec3 p){
  vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(mix(bodyHash(i),bodyHash(i+vec3(1,0,0)),f.x),mix(bodyHash(i+vec3(0,1,0)),bodyHash(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(bodyHash(i+vec3(0,0,1)),bodyHash(i+vec3(1,0,1)),f.x),mix(bodyHash(i+vec3(0,1,1)),bodyHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float filteredBodyNoise(vec3 p,float footprint){return mix(bodyNoise(p),.5,smoothstep(.3,1.1,footprint));}
`;
