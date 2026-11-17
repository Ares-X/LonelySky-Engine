// Frequencies in the visual flow are 1 and 7/10 of this phase. Ten turns
// return both to their starting values. Wrap in double precision before GPU
// upload so a distant saved epoch still advances at normal frame intervals.
const FLOW_RATE = .006;
const FLOW_PERIOD = 20 * Math.PI / FLOW_RATE;
export const cloudFlowTime = seconds => seconds % FLOW_PERIOD;

// Body-space visual flow shared by mesh planets and ray-cast giants. The caller
// supplies noise3, linear cloud colours, a fixed seed and seconds of visual time.
export const gasCloudGLSL = /* glsl */`
mat2 cloudRotation(float angle){
  float c=cos(angle),s=sin(angle);
  return mat2(c,s,-s,c);
}
vec3 gasClouds(vec3 p,vec3 seed,vec3 deep,vec3 bright,int style,float time,float pixel){
  float latitude=p.y,phase=time*${FLOW_RATE};
  // A steadily travelling atmosphere plus bounded differential jet excursion
  // avoids unlimited shear/stretch during long flights.
  p.xz=cloudRotation(phase+.10*sin(phase*.7+latitude*17.))*p.xz;
  float longitude=seed.x*.173+seed.z*.23;
  vec2 axis=vec2(cos(longitude),sin(longitude));
  vec2 equator=vec2(-axis.y,axis.x);
  float along=dot(p.xz,axis),side=along>=0.?1.:-1.;
  float stormLatitude=side*(.15+.12*sin(seed.y*.4));
  vec2 oval=vec2(dot(p.xz,equator)*3.8,(latitude-stormLatitude)*9.);
  float radius=length(oval);
  float eye=exp(-dot(oval,oval)*2.);
  float influence=exp(-dot(oval,oval)*.85)*smoothstep(.2,.7,abs(along));
  vec2 curled=cloudRotation(side*influence*(3.4+.32*sin(phase)))*oval-oval;
  vec3 air=vec3(p.x+equator.x*curled.x/3.8,p.y+curled.y/9.,p.z+equator.y*curled.x/3.8);
  float eddy=noise3(air*vec3(6.,10.,6.)+seed);
  float tendril=noise3(air*vec3(22.,47.,22.)+seed+eddy*3.);
  float grain=noise3(air*vec3(65.,188.,65.)+seed+tendril*2.);
  grain=mix(grain,.5,smoothstep(.3,1.1,pixel*188.));
  float jets=air.y*(style==2?57.:39.)+1.2*sin(air.y*12.+seed.y)+
    (eddy-.5)*3.9+(tendril-.5)*1.9;
  float belt=.5+.5*sin(jets)*(1.-smoothstep(.45,1.5,pixel*54.));
  float filament=.5+.5*sin(jets*3.2+eddy*3.+grain)*(1.-smoothstep(.4,1.5,pixel*180.));
  float amount=.12+.59*belt+.17*filament+.12*tendril;
  if(style==3)amount=.10+.26*amount+.32*smoothstep(.69,.87,tendril);
  vec3 cloud=mix(deep,bright,amount)*(.86+.22*tendril+.10*grain);
  float rim=.5+.5*cos(radius*15.+tendril*3.);
  vec3 vortex=mix(deep*.84,bright,clamp(.32+rim*.52+grain*.14-eye*.25,0.,1.));
  return mix(cloud,vortex,influence*(style==1?.72:.34));
}
`;
