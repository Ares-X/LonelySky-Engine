// Weather samples the translated body-fixed geographic domain in world lengths.
export const HABITAT_WEATHER_SCALE=6500;
export const RING_HABITAT_WEATHER_FIELD_GLSL=/* glsl */`
vec3 habitatWeatherSeed(float phase){return phase*vec3(19013.,7301.,11027.);}
vec2 habitatWeatherClimate(int climate){
  if(climate==1)return vec2(.67,.76);
  if(climate==2)return vec2(.73,.82);
  if(climate==3)return vec2(.60,.69);
  return vec2(.64,.73);
}
vec2 habitatWeatherField(vec3 geography,int climate){
  vec3 p=geography/${HABITAT_WEATHER_SCALE}.;
  // Across the inhabited strip a system spans one weather cell. Along the
  // circumference it extends farther, with a slowly bending front. Keeping
  // the circular xz embedding preserves the longitude seam and wind path.
  float bend=1.65*sin(dot(p.xz,vec2(.16,-.20))+.72*sin(dot(p.xz,vec2(.17,.09))));
  vec2 along=mat2(.46,.21,-.21,.46)*p.xz;
  float raw=bodyNoise(vec3(along.x,p.y+bend,along.y));
  vec2 limits=habitatWeatherClimate(climate);
  return vec2(raw,smoothstep(limits.x,limits.y,raw));
}
`;
