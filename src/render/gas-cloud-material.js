import {GAS_CLOUD_MACRO_GLSL} from './gas-cloud-macro.js';

// World-unit cells remain body-fixed as the camera moves. The CPU folds each
// layer's translated lattice origin modulo its hash period before GPU upload.
export const GAS_CLOUD_MATERIAL_SCALES=Object.freeze([16000,4000,1000]);

export const GAS_CLOUD_MATERIAL_GLSL = /* glsl */`
uniform vec3 uGasNoiseCells[3],uGasNoiseFractions[3];
${GAS_CLOUD_MACRO_GLSL}
float gcmHash(vec3 p){
  p=mod(p,256.);
  p=fract(p*vec3(.1031,.1030,.0973));
  p+=dot(p,p.yxz+33.33);
  return fract((p.x+p.y)*p.z);
}
float gcmNoise(vec3 relative,int layer,float size){
  vec3 q=uGasNoiseFractions[layer]+relative/size;
  vec3 cell=uGasNoiseCells[layer]+floor(q),f=fract(q);
  f=f*f*f*(f*(f*6.-15.)+10.);
  float a=mix(gcmHash(cell),gcmHash(cell+vec3(1,0,0)),f.x);
  float b=mix(gcmHash(cell+vec3(0,1,0)),gcmHash(cell+vec3(1,1,0)),f.x);
  float c=mix(gcmHash(cell+vec3(0,0,1)),gcmHash(cell+vec3(1,0,1)),f.x);
  float d=mix(gcmHash(cell+vec3(0,1,1)),gcmHash(cell+vec3(1,1,1)),f.x);
  return mix(mix(a,b,f.y),mix(c,d,f.y),f.z);
}
// Height and ripple structure share one analytic field across reflectance,
// view extinction and the cloud's own solar shadows.
vec3 gasCloudShape(vec3 relative,vec3 normal,float footprint){
  if(footprint>=12000.)return vec3(.5,1.,0.);
  float broad=mix(gcmNoise(relative,0,16000.),.5,smoothstep(4000.,12000.,footprint));
  vec3 tangent=cross(normal,vec3(.36,.81,.46));
  vec3 warped=relative+tangent*((broad-.5)*2500.);
  float middle=0.;
  if(footprint<4000.)middle=(gcmNoise(warped,1,4000.)-.5)*(1.-smoothstep(1000.,4000.,footprint));
  float billow=0.;
  if(footprint<500.)billow=(gcmNoise(warped,2,1000.)-.5)*(1.-smoothstep(120.,500.,footprint));
  float flank=smoothstep(.16,.38,broad)*(1.-smoothstep(.64,.86,broad));
  float density=broad+middle*.29*flank+billow*.09*flank;
  float height=.10+.82*smoothstep(.12,.90,density);
  float edge=(density-.49)/.16;
  return vec3(height,exp(-edge*edge),billow);
}
float gasCloudReflectance(vec3 cameraRelative,vec3 normal,float footprint){
  float resolved=1.-smoothstep(150.,450.,footprint);
  if(resolved<=0.)return 1.;
  vec3 shape=gasCloudShape(cameraRelative,normal,footprint);
  return mix(1.,mix(.85,1.10,shape.x)+shape.y*(.025+.29*shape.z),resolved);
}
`;
