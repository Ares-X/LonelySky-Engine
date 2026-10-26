import * as THREE from 'three';

const FAMILIES = ['brown-dwarf', 'white-dwarf', 'neutron-star', 'pulsar', 'red-giant'];
const COLORS = [0xa05a38, 0xe5efff, 0x93ceff, 0x9bcfff, 0xff9a55];
const clamp = value => Number.isFinite(value) ? THREE.MathUtils.clamp(value, 0, 1) : 0;
const sphereVertex = `
  varying vec3 vLocal,vNormal,vWorld;
  void main(){vLocal=normalize(position);vNormal=normalize(mat3(modelMatrix)*normal);
    vWorld=(modelMatrix*vec4(position,1.)).xyz;
    gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);}
`;
const surfaceFragment = `
  uniform vec3 tint;uniform float time,visibility,seed;uniform int family;
  varying vec3 vLocal,vNormal,vWorld;
  float cells(vec3 p){return sin(p.x*1.31+sin(p.y*1.7))*sin(p.y*1.53+sin(p.z*1.4))*sin(p.z*1.17+sin(p.x*1.8))*.5+.5;}
  float hash31(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
  float valueNoise(vec3 p){
    vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
    return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x),
      mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),
      mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x),
      mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
  void main(){if(visibility<=0.)discard;
    vec3 p=vLocal;float view=clamp(dot(normalize(vNormal),normalize(cameraPosition-vWorld)),0.,1.);
    float coarse=cells(p*9.+vec3(seed,time*.018,0.));
    float fine=cells(p*38.+vec3(time*.01,seed,0.));
    float brightness=1.;vec3 base=tint;
    if(family==0){float belt=sin(p.y*32.+coarse*3.5+seed)*.5+.5;
      base=mix(tint*.2,tint*.74,belt*.65+fine*.35);brightness=.42+.58*pow(view,.5);}
    else if(family==4){
      vec3 drift=vec3(seed,time*.018,seed*.17);
      float convection=valueNoise(p*11.+drift);
      float granulation=valueNoise(p*27.+drift)*.48+valueNoise(p*67.+drift)*.32+valueNoise(p*153.+drift)*.2;
      float grain=smoothstep(.23,.77,granulation);
      base=mix(tint*.5,tint*1.55,convection*.25+grain*.75);
      brightness=(.84+grain*.2)*(.42+.58*pow(view,.34));}
    else if(family==1){brightness=(2.15+fine*.12)*(.76+.24*pow(view,.35));}
    else{brightness=(1.65+fine*.035)*(.82+.18*pow(view,.4));}
    gl_FragColor=vec4(base*brightness,visibility);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
const haloFragment = `
  uniform vec3 tint;uniform float visibility,strength,haloScale;
  varying vec3 vLocal,vNormal,vWorld;
  void main(){float facing=abs(dot(normalize(vNormal),normalize(cameraPosition-vWorld)));
    float radial=sqrt(max(0.,1.-facing*facing))*haloScale;
    // The corona peaks beside the photosphere and vanishes before its outer
    // silhouette, so the geometry boundary never becomes an opaque polygon.
    float outer=1.-smoothstep(1.,haloScale,radial);
    float inner=smoothstep(.75,1.,radial);
    gl_FragColor=vec4(tint,outer*inner*strength*visibility);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
const prominenceVertex = `
  varying vec2 vUv;varying vec3 vProminenceNormal,vProminenceWorld;
  void main(){vUv=uv;vProminenceNormal=normalize(mat3(modelMatrix)*normal);
    vProminenceWorld=(modelMatrix*vec4(position,1.)).xyz;
    gl_Position=projectionMatrix*viewMatrix*vec4(vProminenceWorld,1.);}
`;
const prominenceFragment = `
  uniform float visibility,seed;uniform vec3 tint;
  varying vec2 vUv;varying vec3 vProminenceNormal,vProminenceWorld;
  void main(){float facing=clamp(abs(dot(normalize(vProminenceNormal),normalize(cameraPosition-vProminenceWorld))),0.,1.);
    float ends=pow(max(0.,sin(vUv.x*3.14159265)),.45);
    float filament=.68+.32*pow(.5+.5*sin(vUv.x*39.+seed),2.);
    gl_FragColor=vec4(tint,visibility*.2*pow(facing,.8)*ends*filament);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
const beamVertex = `
  varying vec2 vUv;varying vec3 vBeamNormal,vBeamWorld;
  void main(){vUv=uv;vBeamNormal=normalize(mat3(modelMatrix)*normal);
    vBeamWorld=(modelMatrix*vec4(position,1.)).xyz;
    gl_Position=projectionMatrix*viewMatrix*vec4(vBeamWorld,1.);}
`;
const beamFragment = `
  uniform float visibility,seed;uniform vec3 tint;
  varying vec2 vUv;varying vec3 vBeamNormal,vBeamWorld;
  void main(){
    // Interpolated cone normals soften the actual projected silhouette. There
    // is no angular UV seam or flat half-cone patch in this optical envelope.
    float facing=clamp(abs(dot(normalize(vBeamNormal),normalize(cameraPosition-vBeamWorld))),0.,1.);
    float silhouette=smoothstep(.025,.52,facing);
    float envelope=pow(facing,1.6)*.027;
    float axial=pow(facing,11.)*.13;
    float ends=smoothstep(0.,.045,vUv.y)*(1.-smoothstep(.35,1.,vUv.y));
    float ribbon=.92+.08*sin(vUv.y*31.+seed);
    float alpha=visibility*silhouette*(envelope+axial)*ends*ribbon;
    gl_FragColor=vec4(tint*(.58+pow(facing,8.)*.85),alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/** A bounded local illustration; radii/beam dimensions use caller scene units.
 * Core sphere radius exactly equals body.radius. Halo, prominence and two beams
 * are non-solid artwork. Time is supplied by the caller's celestial clock.
 * update(time, camera, visibility, quality, reducedMotion) and dispose() are also
 * exposed on userData, following the other optional engine renderer adapters.
 */
export function createStellarRemnant(body, { quality = 'high', reducedMotion = false } = {}) {
  const family = FAMILIES.indexOf(body?.stellarFamily);
  if (family < 0 || !Number.isFinite(body.radius) || body.radius <= 0) {
    throw new TypeError('stellar renderer needs a supported family and positive radius');
  }
  const radius = body.radius, tint = new THREE.Color(body.color ?? COLORS[family]);
  const group = new THREE.Group(); group.name = `stellar-${body.id ?? body.stellarFamily}`;
  const geometries = [], materials = [];
  const ownGeometry = geometry => (geometries.push(geometry), geometry);
  const ownMaterial = material => (materials.push(material), material);
  const nearSphere = ownGeometry(new THREE.SphereGeometry(radius, 48, 32));
  const farSphere = ownGeometry(new THREE.SphereGeometry(radius, 20, 12));
  const surface = ownMaterial(new THREE.ShaderMaterial({
    uniforms: { tint: {value:tint}, time:{value:0}, visibility:{value:1}, family:{value:family}, seed:{value:(body.seed ?? 0) % 997} },
    vertexShader:sphereVertex, fragmentShader:surfaceFragment, transparent:true, depthWrite:true,
  }));
  const core = new THREE.Mesh(nearSphere, surface); core.name = 'stellar-core'; group.add(core);
  const haloScale=family === 0 ? 1.04 : family === 4 ? 1.15 : 1.1;
  const haloMaterial = ownMaterial(new THREE.ShaderMaterial({
    uniforms:{tint:{value:tint},visibility:{value:1},strength:{value:family === 0 ? .035 : family === 4 ? .18 : .16},haloScale:{value:haloScale}},
    vertexShader:sphereVertex,fragmentShader:haloFragment,transparent:true,depthWrite:false,
    side:THREE.BackSide,blending:THREE.AdditiveBlending,
  }));
  const halo = new THREE.Mesh(nearSphere, haloMaterial); halo.scale.setScalar(haloScale);
  halo.name = 'stellar-corona'; group.add(halo);
  const details = [], beamRotor = new THREE.Group(), spinFrame = new THREE.Group();
  if (family === 4) {
    for (let i = 0; i < 2; i++) {
      const geometry = ownGeometry(new THREE.TorusGeometry(radius*.22, radius*.014, 5, 24, Math.PI));
      const material = ownMaterial(new THREE.ShaderMaterial({
        uniforms:{tint:{value:new THREE.Color(0xffa556)},visibility:{value:1},seed:{value:(body.seed??0)%997+i*3.7}},
        vertexShader:prominenceVertex,fragmentShader:prominenceFragment,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending}));
      const arc = new THREE.Mesh(geometry,material); arc.position.set(i ? -.58*radius : .65*radius, radius*.76, i ? radius*.18 : -radius*.12);
      arc.rotation.set(i ? -.35 : .5, i ? -.6 : .6, i ? -.45 : -.5);
      arc.name='stellar-prominence'; group.add(arc); details.push(arc);
    }
  }
  if (family === 3) {
    // The spin axis and magnetic axis differ: rotation sweeps the inclined
    // antipodal cones through space. Opacity never pulses the entire star.
    spinFrame.rotation.z = Number.isFinite(body.spinTilt) ? body.spinTilt : .38;
    const magneticFrame = new THREE.Group(); magneticFrame.rotation.z = Number.isFinite(body.magneticTilt) ? body.magneticTilt : .65;
    group.add(spinFrame); spinFrame.add(beamRotor); beamRotor.add(magneticFrame);
    const beamLength = Math.min(2600, radius*54), beamWidth = radius*3.2;
    const beamGeometry = ownGeometry(new THREE.CylinderGeometry(beamWidth,radius*.14,beamLength,16,1,true));
    const beamMaterial = ownMaterial(new THREE.ShaderMaterial({uniforms:{visibility:{value:1},tint:{value:tint},seed:{value:(body.seed??0)%997}},
      vertexShader:beamVertex,fragmentShader:beamFragment,transparent:true,depthWrite:false,side:THREE.DoubleSide,forceSinglePass:true,blending:THREE.AdditiveBlending}));
    for (const sign of [-1,1]) {
      const beam = new THREE.Mesh(beamGeometry,beamMaterial); beam.position.y=sign*(beamLength*.5+radius*.8);
      if(sign<0)beam.rotation.z=Math.PI;
      beam.name='stellar-magnetic-beam'; magneticFrame.add(beam);details.push(beam);
    }
  }
  const center = new THREE.Vector3(), cameraPosition = new THREE.Vector3();
  let disposed = false;
  const stats = {family:body.stellarFamily,lod:'near',drawCalls:2+details.length,beams:family===3?2:0,reducedMotion:Boolean(reducedMotion),visibility:1};
  const phase = Number.isFinite(body.phase) ? body.phase : 0;
  const spinRate = Number.isFinite(body.visualSpinRate) ? Math.min(1,Math.max(0,body.visualSpinRate)) : .48;
  function update(time=0,camera,visibility=1,nextQuality=quality,nextReducedMotion=reducedMotion) {
    if(disposed)return;
    const t=Number.isFinite(time)?time:0;
    const motion=Boolean(nextReducedMotion), v=clamp(visibility);
    let distance=0;
    if(camera?.getWorldPosition){group.getWorldPosition(center);camera.getWorldPosition(cameraPosition);distance=center.distanceTo(cameraPosition);}
    const lod=nextQuality==='low'||distance>radius*90?'far':'near';
    core.geometry=lod==='far'?farSphere:nearSphere;
    halo.geometry=core.geometry;
    surface.uniforms.time.value=motion?0:t;
    surface.uniforms.visibility.value=v;surface.depthWrite=v===1;
    haloMaterial.uniforms.visibility.value=v;
    group.visible=v>0;
    beamRotor.rotation.y=phase+(motion?0:t*spinRate);
    const detailFade=1-THREE.MathUtils.smoothstep(distance, radius*70, radius*190);
    for(const detail of details){detail.visible=v>0&&detailFade>.005&&!(nextQuality==='low'&&family===4);
      if(detail.material.uniforms)detail.material.uniforms.visibility.value=v*detailFade;
      else detail.material.opacity=.2*v*detailFade;}
    stats.lod=lod;stats.visibility=v;stats.reducedMotion=motion;
    stats.drawCalls=v>0?2+details.filter(detail=>detail.visible).length:0;
  }
  function dispose(){if(disposed)return;disposed=true;for(const geometry of geometries)geometry.dispose();for(const material of materials)material.dispose();}
  group.userData={body,bodyRadius:radius,bodyName:body.name??body.stellarFamily,update,dispose,stats};
  update(0,undefined,1,quality,reducedMotion);
  return group;
}
