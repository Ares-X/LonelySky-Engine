// Continuous simplex adaptation of simplex noise by Ian McEwan / Ashima Arts, MIT.
// Source/provenance: https://github.com/ashima/webgl-noise (noise3D.glsl).
// Uses legacy +1 permutation for this game's existing gradient distribution;
// compact .5/105 kernel and deterministic x>y>z ranking are the tested changes.
// Copyright (C) 2011 Ashima Arts. MIT: ../../licenses/webgl-noise.MIT.txt.
export const SN_CONTINUOUS_SIMPLEX_GLSL = /* glsl */`
vec3 snMod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 snMod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 snPermute(vec4 x){return snMod289(((x*34.)+1.)*x);}
vec4 snTaylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
vec4 snNoiseD(vec3 v){
  const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  float bXY=step(x0.y,x0.x),bXZ=step(x0.z,x0.x),bYZ=step(x0.z,x0.y);
  vec3 rank=vec3(bXY+bXZ,1.-bXY+bYZ,2.-bXZ-bYZ);
  vec3 i1=step(vec3(1.5),rank),i2=step(vec3(.5),rank);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=snMod289(i);
  vec4 p=snPermute(snPermute(snPermute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=snTaylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
  vec4 m2=m*m,m3=m2*m,m4=m2*m2;
  vec4 projections=vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3));
  vec3 gradient=m4.x*p0+m4.y*p1+m4.z*p2+m4.w*p3
    -8.*(m3.x*projections.x*x0+m3.y*projections.y*x1+m3.z*projections.z*x2+m3.w*projections.w*x3);
  return 105.*vec4(dot(m4,projections),gradient);
}
float snNoise(vec3 p){return snNoiseD(p).x;}
`;
