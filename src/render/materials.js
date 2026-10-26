import * as THREE from 'three';

const noise = /* glsl */`
float hash(vec3 p){p=fract(p*.3183099+vec3(.1,.2,.3));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){float n=0.,a=.5;for(int i=0;i<5;i++){n+=noise3(p)*a;p=p*2.03+vec3(5.2,1.3,2.8);a*=.5;}return n;}
`;
const sphereVertex = /* glsl */`
varying vec3 vLocal,vNormalWorld,vWorld,vCenter;varying vec2 vUV;
void main(){vLocal=position;vUV=uv;vNormalWorld=normalize(mat3(modelMatrix)*normal);vWorld=(modelMatrix*vec4(position,1.)).xyz;vCenter=modelMatrix[3].xyz;gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);}
`;
// A zero-coverage body must not write depth. Intermediate distances blend smoothly.
const visibilityDiscard = /* glsl */`
uniform float visibility;
void applyVisibility(){
  if(visibility<=0.)discard;
}
`;

export function planetMaterial(planet,{textures={},lightDirection=new THREE.Vector3(-1,.4,.35)}={}){
  const kinds={gas:0,ocean:1,ice:2,rock:3,lava:4};
  const textureKey=planet.proceduralSurface ? null : planet.texture || (planet.kind==='gas' ? (planet.seed%2?'jupiter':'saturn') : planet.kind==='ocean'?'earth':planet.kind==='ice'||planet.kind==='rock'?'moon':null);
  // Three exactly representable integer coordinates retain every bit of the
  // 32-bit saved seed; the older shader's seed%1000 stays untouched for v1.
  const surfaceSeed=planet.seed>>>0;
  const seedOffset=new THREE.Vector3(surfaceSeed&2047,(surfaceSeed>>>11)&2047,surfaceSeed>>>22);
  return new THREE.ShaderMaterial({
    uniforms:{visibility:{value:1},surface:{value:textures[textureKey]||textures.moon},hasSurface:{value:Boolean(textureKey&&textures[textureKey])},proceduralSurface:{value:Boolean(planet.proceduralSurface)},seedOffset:{value:seedOffset},bodyRadius:{value:planet.radius},paletteMix:{value:planet.paletteMix || 0},colorA:{value:new THREE.Color(planet.colorA)},colorB:{value:new THREE.Color(planet.colorB)},kind:{value:kinds[planet.kind]??0},seed:{value:planet.seed%1000},lightDir:{value:lightDirection.clone().normalize()}},
    vertexShader:sphereVertex,
    fragmentShader:/* glsl */`
      uniform sampler2D surface;uniform bool hasSurface,proceduralSurface;uniform vec3 colorA,colorB,lightDir,seedOffset;uniform int kind;uniform float seed,paletteMix,bodyRadius;
      varying vec3 vLocal,vNormalWorld,vWorld,vCenter;varying vec2 vUV;${noise}${visibilityDiscard}
      void main(){
        applyVisibility();
        vec3 p=normalize(vLocal),n=normalize(vNormalWorld),view=normalize(cameraPosition-vWorld);
        vec3 base;
        if(proceduralSurface){
          // Local sphere coordinates pin coastlines and bands to this sphere.
          // No view direction, clock or mutable scene state enters the pattern.
          vec3 terrain=p*5.1+seedOffset;
          if(kind==1){
            float land=fbm(terrain)+.12*(noise3(terrain*3.1)-.5);
            float shore=smoothstep(.48,.55,land);
            float shelf=smoothstep(.43,.50,land);
            vec3 sea=colorA*(.57+.43*noise3(terrain*2.2));
            vec3 ground=colorB*(.7+.55*noise3(terrain*3.7));
            base=mix(sea,ground,shore);
            base=mix(base,colorB*1.16,(shelf-shore)*.5);
            float clouds=smoothstep(.72,.84,noise3(terrain*4.6+vec3(19.)));
            base=mix(base,vec3(.8,.87,.88),clouds*.27);
          }else if(kind==0){
            float warp=fbm(terrain*.85)-.5;
            float shear=noise3(terrain*2.8)-.5;
            float fine=noise3(terrain*8.6)-.5;
            float latitude=p.y*36.+warp*5.+shear*1.4;
            float belts=sin(latitude+sin(latitude*.44)*.6)*.5+.5;
            float jets=pow(max(0.,sin(latitude*2.7+fine*2.)*.5+.5),9.);
            float wisps=noise3(vec3(p.x*22.,p.y*118.,p.z*22.)+seedOffset+vec3(warp*3.));
            base=mix(colorA,colorB,clamp(.1+belts*.66+shear*.16+jets*.16+fine*.13,0.,1.))*(.82+.26*wisps);
            vec3 stormDir=normalize(vec3(sin(seedOffset.x*.073+seedOffset.z*.017),sin(seedOffset.y*.11)*.25,cos(seedOffset.z*.047+seedOffset.x*.013)));
            vec3 delta=p-stormDir;
            float oval=exp(-dot(delta.xz,delta.xz)*65.-delta.y*delta.y*420.);
            float eye=exp(-dot(delta.xz,delta.xz)*220.-delta.y*delta.y*1050.);
            base=mix(base,colorB*1.08,(oval-eye)*.25);
            base=mix(base,colorA*.84,eye*.25);
            vec3 opposite=p+stormDir;
            float distantOval=exp(-dot(opposite.xz,opposite.xz)*95.-opposite.y*opposite.y*600.);
            base=mix(base,colorB*.9,distantOval*.12);
          }else{
            float relief=fbm(terrain*1.7);
            float detail=noise3(terrain*5.3);
            float polar=kind==2?smoothstep(.55,.88,abs(p.y))*.32:0.;
            base=mix(colorA,colorB,clamp(relief*.83+polar,0.,1.))*(.72+.45*detail);
          }
        }
        else if(hasSurface){base=texture2D(surface,vUV).rgb;if(kind==2)base=mix(base,base*vec3(.78,.9,1.1),.45);}
        else if(kind==4){float f=fbm(p*5.+seed);float crack=pow(1.-abs(sin(f*32.)),23.);base=colorA*.25+colorB*crack*3.;}
        else{base=mix(colorA,colorB,smoothstep(.25,.75,fbm(p*16.+seed)));}
        // Photographic maps remain authoritative at orbital distances. Resolve
        // additional stationary cloud structure continuously near the surface.
        if(kind==0){
          float altitude=max(0.,length(cameraPosition-vCenter)-bodyRadius)/max(bodyRadius,1.);
          float nearDetail=1.-smoothstep(.025,.4,altitude);
          if(nearDetail>0.){
            float flow=fbm(p*31.+seed);
            vec3 cloud=p*vec3(170.,580.,170.)+vec3(flow*7.,seed,flow*4.);
            float curl=noise3(cloud)*.65+noise3(cloud*3.07)*.35;
            float ribbons=sin(p.y*430.+flow*11.+seed)*.5+.5;
            base*=1.+nearDetail*((curl-.5)*.22+(ribbons-.5)*.075);
          }
        }
        if(hasSurface&&!proceduralSurface&&paletteMix>0.){float level=dot(base,vec3(.2126,.7152,.0722));vec3 tinted=mix(colorA,colorB,smoothstep(.08,.7,level))*(.4+level*1.3);base=mix(base,tinted,paletteMix);}
        float light=dot(n,normalize(lightDir));float day=smoothstep(-.1,.16,light);
        float diffuse=max(light,0.);vec3 color=base*(.0025+day*(.045+pow(diffuse,.8)*1.15));
        if(kind==4&&!hasSurface)color+=colorB*pow(1.-abs(sin(fbm(p*5.+seed)*32.)),23.)*.3;
        if(kind==1){float spec=pow(max(dot(reflect(-normalize(lightDir),n),view),0.),75.);color+=spec*.12*day;}
        // Normalized float vectors can still produce a dot slightly above one.
        float limb=pow(1.-clamp(dot(n,view),0.,1.),4.5)*day;
        if(kind==1||kind==0)color+=vec3(.13,.27,.39)*limb*.5;
        gl_FragColor=vec4(color,visibility);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `, transparent:true, depthWrite:true,
  });
}

export function atmosphereMaterial(color,lightDirection=new THREE.Vector3(-1,.4,.35)){
  return new THREE.ShaderMaterial({uniforms:{visibility:{value:1},tint:{value:new THREE.Color(color).lerp(new THREE.Color(0x72bded),.15)},lightDir:{value:lightDirection.clone().normalize()}},vertexShader:sphereVertex,
    fragmentShader:/* glsl */`
      varying vec3 vNormalWorld,vWorld;uniform vec3 tint,lightDir;uniform float visibility;
      void main(){vec3 n=normalize(vNormalWorld);float facing=clamp(abs(dot(n,normalize(cameraPosition-vWorld))),0.,1.);float optical=pow(1.-facing,4.);float day=smoothstep(-.2,.4,dot(n,lightDir));gl_FragColor=vec4(tint*(.4+day*.8),optical*day*.18*visibility);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,side:THREE.BackSide,blending:THREE.AdditiveBlending,transparent:true,depthWrite:false});
}

export function ringMaterial(color,seed,{texture=null,planetRadius=1,lightDirection=new THREE.Vector3(-1,.4,.35)}={}){
  return new THREE.ShaderMaterial({uniforms:{visibility:{value:1},tint:{value:new THREE.Color(color)},ringMap:{value:texture},useMap:{value:Boolean(texture)},seed:{value:seed%100},planetCenter:{value:new THREE.Vector3()},planetRadius:{value:planetRadius},lightDir:{value:lightDirection.clone().normalize()}},
    vertexShader:/* glsl */`varying vec3 localPoint,worldPoint;void main(){localPoint=position;worldPoint=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(worldPoint,1.);}`,
    fragmentShader:/* glsl */`
      varying vec3 localPoint,worldPoint;uniform sampler2D ringMap;uniform bool useMap;uniform vec3 tint,planetCenter,lightDir;uniform float seed,planetRadius,visibility;
      void main(){
        float r=length(localPoint.xy),v=(r-1.18)/1.08;
        float band=.6+.12*sin(r*163.+seed)+.08*sin(r*391.)+.05*sin(r*1087.);
        float alpha=band*smoothstep(0.,.012,v)*(1.-smoothstep(.96,1.,v));vec3 color=tint;
        if(useMap){vec4 sampleColor=texture2D(ringMap,vec2(v,.5));color=sampleColor.rgb;alpha*=sampleColor.a;}
        float cassini=1.-smoothstep(.008,.018,abs(v-.65));alpha*=1.-cassini*.88;
        vec3 p=worldPoint-planetCenter;float t=dot(-p,lightDir);float shadow=1.;
        if(t>0.)shadow=smoothstep(planetRadius*.98,planetRadius*1.03,length(p+lightDir*t));
        gl_FragColor=vec4(color*(.035+shadow*.72),alpha*.7*visibility);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,transparent:true,side:THREE.DoubleSide,depthWrite:false});
}

export function starMaterial(color){
  return new THREE.ShaderMaterial({uniforms:{visibility:{value:1},tint:{value:new THREE.Color(color)},time:{value:0}},vertexShader:sphereVertex,
    fragmentShader:/* glsl */`
      varying vec3 vLocal,vNormalWorld,vWorld;uniform vec3 tint;uniform float time;${noise}${visibilityDiscard}
      void main(){applyVisibility();vec3 p=normalize(vLocal);float n=fbm(p*24.+time*.04);float cells=noise3(p*95.+n*2.);float view=pow(max(dot(normalize(vNormalWorld),normalize(cameraPosition-vWorld)),0.),.3);vec3 surface=tint*(1.9+n*1.4+cells*.3)*(.32+view*.68);gl_FragColor=vec4(surface,visibility);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,transparent:true,depthWrite:true});
}
