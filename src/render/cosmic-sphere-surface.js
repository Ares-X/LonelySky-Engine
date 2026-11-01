/** Existing macro appearance plus body-local world-unit close-detail bands.
 * Bands filter their value and derivative together. Rock detail is material
 * relief; the shared analytic sphere and collision surface are not displaced.
 * Cloud and photospheric structure are visual approximations, not fluid physics.
 */
export const COSMIC_SPHERE_SURFACE_GLSL = /* glsl */`
vec3 sphereSurface(vec3 point,vec3 normal,vec3 ray,float distance){
  float facing=clamp(dot(normal,-ray),0.,1.),ndl=dot(normal,uLight),pixel=distance*uPixelAngle;
  float footprint=max(pixel,max(length(dFdx(point)),length(dFdy(point))))*uBodyRadius;
  vec3 world=point*uBodyRadius;
  vec3 seed=sin(vec3(17.17,31.7,47.1)*uPhase)*31.;
  float broad=filteredBodyNoise(normal*5.+seed,pixel*5.);
  if(uBodyKind==5){
    vec4 basin=ringWorldField(normal*uBodyRadius+seed*170.,1700.,footprint,true);
    vec4 rock=ringWorldField(normal*uBodyRadius+seed*13.,130.,footprint,true);
    vec4 grain=ringWorldField(normal*uBodyRadius+seed,3.,footprint,false);
    vec3 gradient=basin.yzw*130.+rock.yzw*11.+grain.yzw*.09;
    vec3 materialNormal=normalize(normal-(gradient-normal*dot(normal,gradient)));
    vec3 albedo=uTint*(.65+basin.x*.22+rock.x*.2+grain.x*.13);
    return albedo*(.018+max(dot(materialNormal,uLight),0.)*1.05);
  }
  if(uBodyKind==4){
    float granule=filteredBodyNoise(normal*340.+seed,pixel*340.);
    float fine=filteredBodyNoise(normal*920.+seed,pixel*920.);
    float micro=ringWorldField(world+seed*31.,80.,footprint,false).x-.5;
    float flecks=ringWorldField(world+seed,8.,footprint,false).x-.5;
    float activeRegion=smoothstep(.74,.88,filteredBodyNoise(normal*13.+seed,pixel*13.));
    float textureDetail=1.;
    if(uHasStellar){
      // Chromospheric source supplies restrained luminance only. Its false
      // colour never becomes the visible photosphere's red/yellow marbling.
      vec3 observed=bodyMap(uStellar,bodyUV(normal));
      textureDetail=.94+dot(observed,vec3(.2126,.7152,.0722))*.12;
    }
    float hot=step(uTint.r,uTint.b);
    vec3 white=mix(vec3(1.03,.86,.64),vec3(.72,.86,1.06),hot);
    return white*(.88+granule*.16+fine*.045+micro*.045+flecks*.012-activeRegion*.19)*textureDetail*(.27+.73*pow(facing,.43));
  }
  if(uBodyKind==2){
    float shear=filteredBodyNoise(normal*vec3(8.,16.,8.)+seed,pixel*16.);
    float cloud=filteredBodyNoise(normal*vec3(29.,72.,29.)+seed+shear,pixel*72.);
    float belt=normal.y*64.+(shear-.5)*3.2+(cloud-.5)*1.5;
    float stripe=.5+.5*sin(belt)*(1.-smoothstep(.4,1.5,pixel*64.));
    vec3 albedo=mix(uTint*vec3(.29,.26,.23),mix(uTint*.63,vec3(.47,.44,.38),.4),stripe*.64+cloud*.36);
    float filaments=ringWorldField(world+seed*31.,130.,footprint,true).x-.55;
    float wisps=ringWorldField(world+seed,8.,footprint,false).x-.5;
    albedo*=.84+cloud*.25;
    if(uHasClouds){vec3 observed=bodyMap(uClouds,bodyUV(normal)+vec2(shear-.5,cloud-.5)*.012);albedo=mix(albedo,observed*.48,.54);}
    albedo*=1.+filaments*.08+wisps*.025;
    float shadow=0.;
    if(uRinged){vec3 hit;float t;shadow=gasRingCast(point+normal*.000001,uLight,hit,t);}
    return albedo*(.014+pow(max(ndl,0.),.9)*1.12)*(1.-shadow*.8)+uTint*pow(1.-facing,5.)*max(ndl,0.)*.025;
  }
  vec4 surfaceRock=ringRockRidge(world+seed*13.,130.,footprint);
  vec4 surfaceGrain=ringWorldField(world+seed,1.2,footprint,false);
  vec3 gradient=surfaceRock.yzw*11.+surfaceGrain.yzw*.025;
  vec3 materialNormal=normalize(normal-(gradient-normal*dot(normal,gradient)));
  float relief=filteredBodyNoise(normal*19.+seed,pixel*19.)*.7+filteredBodyNoise(normal*83.+seed,pixel*83.)*.3;
  vec3 albedo=uTint*(.17+relief*.12+broad*.04);
  return albedo*(.018+max(dot(materialNormal,uLight),0.)*.7)+uTint*pow(1.-facing,7.)*smoothstep(-.1,.25,ndl)*.035;
}
`;
