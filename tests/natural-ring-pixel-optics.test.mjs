import test from'node:test';import assert from'node:assert/strict';import * as T from'three';
import{NATURAL_RING,NATURAL_RING_GRAIN_LOD,NATURAL_RING_GLSL as glsl,naturalRingVisualSigma,naturalRingArtTint,naturalRingPhase,naturalRingTransfer,createNaturalRingOpticalWorkspace,NATURAL_RING_OPTICS as O}from'../src/natural-ring.js';
import{describeCosmicBody}from'../src/cosmic-bodies.js';
const smooth=(a,b,x)=>{x=Math.max(0,Math.min(1,(x-a)/(b-a)));return x*x*(3-2*x);};
const body=describeCosmicBody({x:-30,y:28,z:-21},'lonely-universe-v2'),R=body.radius,L=body.light,F=body.frame;
function functionBody(name){const start=glsl.indexOf(name+'('),open=glsl.indexOf('{',start);let depth=1,i=open+1;for(;depth;i++)depth+=(glsl[i]==='{')-(glsl[i]==='}');assert.ok(start>=0&&depth===0);return glsl.slice(open+1,i-1);}
const js=source=>source.replace(/\bfloat\b|\bint\b|\bvec2\b|\bvec4\b/g,'let').replace(/\bexp\(/g,'Math.exp(').replace(/\babs\(/g,'Math.abs(');
// Run the actual point-field GLSL arithmetic in JS double precision. Native
// compile/float precision is a separate browser boundary; no density replica.
const vectors=(name,type)=>[...glsl.match(new RegExp('const '+type+' '+name+'\\[64\\]='+type+'\\[\\]\\((.*?)\\);','s'))[1].matchAll(new RegExp(type+'\\(([^)]+)\\)','g'))].map(m=>m[1].split(',').map(Number));
const bands=vectors('ringArtBands','vec4'),materials=vectors('ringArtMaterials','vec2');
const fields=source=>source.replaceAll('row.x','row[0]').replaceAll('row.y','row[1]').replaceAll('row.z','row[2]').replaceAll('row.w','row[3]').replaceAll('material.x','material[0]').replaceAll('material.y','material[1]').replaceAll('ringArtMaterials[index].y','ringArtMaterials[index][1]').replace(/\bsin\(/g,'Math.sin(').replace(/\bcos\(/g,'Math.cos(');
const indexProgram=new Function('u','ringArtBands',js(functionBody('naturalRingArtIndex')).replace('(low+high)/2','Math.trunc((low+high)/2)').replace('ringArtBands[middle].y','ringArtBands[middle][1]')),index=u=>indexProgram(u,bands);
const lobeProgram=new Function('s','seed','levels','footprint','fract','smoothstep',js(functionBody('naturalRingArtLobe'))),lobe=(s,seed,levels,footprint)=>lobeProgram(s,seed,levels,footprint,v=>v-Math.floor(v),smooth);
const densityProgram=new Function('point','uBodyRadius','uPhase','smoothstep','naturalRingArtIndex','ringArtBands','ringArtMaterials','naturalRingArtLobe',fields(js(functionBody('naturalRingSigma'))).replace('length(point.xz)','Math.hypot(point[0],point[2])').replaceAll('point.y','point[1]'));
const sigmaProgram=(point,radius,phase,smoothstep)=>densityProgram(point,radius,phase,smoothstep,index,bands,materials,lobe);
const tintProgram=new Function('r','phase','footprintR','naturalRingArtIndex','ringArtBands','ringArtMaterials','naturalRingArtLobe','clamp','mix',fields(js(functionBody('naturalRingArtTint'))).replaceAll('vec3(.76,.92,1.12)','[.76,.92,1.12]').replaceAll('vec3(1.07,.78,.56)','[1.07,.78,.56]').replace('dust)*(1.+.06*coarse+.04*fine);','dust).map(v=>v*(1.+.06*coarse+.04*fine));'));
const tint=(r,phase,footprint)=>tintProgram(r,phase,footprint,index,bands,materials,lobe,(x,a,b)=>Math.max(a,Math.min(b,x)),(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t));
const radialScale=Number(glsl.match(/float quarterPeriod=([0-9.]+)\*uBodyRadius\*\.25;/)[1]);

const expRelative=new Function('z',js(functionBody('naturalRingExpRelative'))),solarStart=glsl.indexOf('if(qRay.y*uLight.y<0.)'),solarEnd=glsl.indexOf('float along=',solarStart),solarProgram=new Function('sigmaColumn','qMu','muSun','qRay','uLight','naturalRingExpRelative',`let solarPower,qT=Math.exp(-sigmaColumn/qMu);${js(glsl.slice(solarStart,solarEnd))}return solarPower;`);
const solar=(tau,eye,sun)=>solarProgram(tau,Math.abs(eye),Math.abs(sun),{y:eye},{y:sun},expRelative);
const table=n=>{const values=name=>glsl.match(new RegExp(name+n+'\\['+n+'\\]=float\\[\\]\\(([^)]*)\\)'))[1].split(',').map(Number);return{nodes:values('ringPixelNodes'),weights:values('ringPixelWeights')};};

test('executed GLSL density matches the CPU field across body size, phase, edges and compact support',()=>{
 let maximum=0;for(const radius of[350000,R,1200000])for(const phase of[0,.125,.67,body.phase])for(let i=0;i<512;i++){
  const a=i*.061,r=1.24+.87*(i%127)/126,y=-65+130*(i%97)/96,x=r*Math.cos(a),z=r*Math.sin(a),cpu=naturalRingVisualSigma(x*radius,y,z*radius,radius,phase),gpu=sigmaProgram([x,y/radius,z],radius,phase,smooth);
  maximum=Math.max(maximum,Math.abs(cpu-gpu));
 }assert.ok(maximum<1e-12,`CPU/GLSL density difference ${maximum}`);
});

test('executed GLSL radial material matches CPU tint for resolved and subpixel footprints',()=>{
 let maximum=0;for(const phase of [0,.125,.67,body.phase])for(const footprint of [0,1e-5,.001,.01])for(let i=0;i<1024;i++){
  const r=1.25+.85*i/1023,cpu=naturalRingArtTint(r,phase,[0,0,0],footprint),gpu=tint(r,phase,footprint);
  for(let k=0;k<3;k++)maximum=Math.max(maximum,Math.abs(cpu[k]-gpu[k]));
 }assert.ok(maximum<1e-12,`CPU/GLSL radial material difference ${maximum}`);
});

test('actual GLSL solar algebra is positive for both faces and finite grazing angles, and matches independent quartic volume integration',()=>{
 let worst=0;for(const tau of[0,.001,.1,.95,3.4307])for(const eye of[-.8,-.31283847678326615,-.03,.03,.31283847678326615,.8])for(const sun of[-.8,-.1,.1,.8]){
  const value=solar(tau,eye,sun);let reference=0;const n=8192;
  for(let i=0;i<n;i++){const v=-1+(i+.5)*2/n,massUp=tau*(.5-15/16*(v-2*v**3/3+v**5/5)),fromEye=eye<0?massUp:tau-massUp,fromSun=sun>0?massUp:tau-massUp;reference+=Math.exp(-fromEye/Math.abs(eye)-fromSun/Math.abs(sun))*tau*15/16*(1-v*v)**2/Math.abs(eye)*2/n;}
  assert.ok(value>=0&&value<=1);worst=Math.max(worst,Math.abs(value-reference));
 }
 for(const tau of[0,1e-8,.001,.1,1,6])for(const eye of[-1,-.001,-1e-6,1e-6,.001,1])for(const sun of[-1,-.001,-1e-6,1e-6,.001,1]){const value=solar(tau,eye,sun);assert.ok(Number.isFinite(value)&&value>=0&&value<=1+1e-12);}
 assert.ok(worst<1e-8,`quartic Sun integral error ${worst}`);
});

const poses=[{camera:[-1826978.63954389,1010999.9423625414,2304813.181129181],q:[-.69215608107978,-.3557077719023636,.2482763628756355,.5768455495795931],pixels:[[1100,900],[300,375],[400,375],[1100,600]]},{camera:[-942035.8610148182,321681.7998426268,1188419.296519734],q:[-.6525767417481706,-.3561903751496672,.2853220299545384,.6048663918607996],pixels:[[200,900],[200,825],[200,750],[1400,750]]}];
function ray(pose,x,y){const v=new T.Vector3((2*x/1600-1)*1.6*Math.tan(65*Math.PI/360),(1-2*y/1000)*Math.tan(65*Math.PI/360),-1).normalize().applyQuaternion(new T.Quaternion(...pose.q));return[F[0]*v.x+F[3]*v.y+F[6]*v.z,F[1]*v.x+F[4]*v.y+F[7]*v.z,F[2]*v.x+F[5]*v.y+F[8]*v.z];}
function plane(pose,x,y){const d=ray(pose,x,y),t=-pose.camera[1]/d[1],p=pose.camera.map((a,i)=>a+d[i]*t);return{d,t,p,r:Math.hypot(p[0],p[2])};}
function thin(pose,x,y){const{d,p}=plane(pose,x,y),tau=naturalRingVisualSigma(p[0],0,p[2],R,body.phase)*1024/15,T=Math.exp(-tau/Math.abs(d[1])),a=p[0]*L[0]+p[1]*L[1]+p[2]*L[2],shadow=a<0&&p[0]**2+p[1]**2+p[2]**2-a*a<R*R,solarPower=shadow?0:solar(tau,d[1],L[1]),phase=naturalRingPhase(d[0]*L[0]+d[1]*L[1]+d[2]*L[2]);return{T,C:O.albedo*.85*(O.ambientRadiance*(1-T)+O.incidentIrradiance*phase*solarPower),tau};}
const work=createNaturalRingOpticalWorkspace();
function mean(pose,x,y,n,gauss,volume=false){const t=gauss?table(n):{nodes:Array.from({length:n},(_,i)=>(i+.5)/n-.5),weights:Array(n).fill(1/n)};let T=0,C=0,mass=0;for(let j=0;j<n;j++)for(let i=0;i<n;i++){const px=x+t.nodes[i],py=y+t.nodes[j],weight=t.weights[i]*t.weights[j],point=thin(pose,px,py);if(volume){const v=naturalRingTransfer(pose.camera,ray(pose,px,py),R,.5,1e15,body.phase,L,false,work,128,32,Infinity,false);T+=weight*v.transmission;C+=weight*v.radiance;}else{T+=weight*point.T;C+=weight*point.C;}mass+=weight*point.tau;}return{T,C,mass};}

test('positive pixel-cone T/C preserves optical mass and matches the finite volume within its measured far/thin domain',()=>{
 for(const n of[8,16]){const a=table(n);assert.ok(a.weights.every(w=>w>0));assert.ok(Math.abs(a.weights.reduce((s,w)=>s+w,0)-1)<1e-12);}
 let maxT=0,maxC=0,maxMass=0,maxVolumeT=0,maxVolumeC=0;const points=[];
 for(const pose of poses)for(const[x,y]of pose.pixels){const p=plane(pose,x,y),dx=plane(pose,x+.5,y).p.map((v,i)=>v-plane(pose,x-.5,y).p[i]),dy=plane(pose,x,y+.5).p.map((v,i)=>v-plane(pose,x,y-.5).p[i]),rx=p.p[0]/p.r,rz=p.p[2]/p.r,width=Math.abs(rx*dx[0]+rz*dx[2])+Math.abs(rx*dy[0]+rz*dy[2]),walk=128*(Math.abs(rx*p.d[0]+rz*p.d[2])/Math.abs(p.d[1])+Math.abs(rx*L[0]+rz*L[2])/Math.abs(L[1])),quarter=radialScale*R*.25,blend=smooth(quarter,2*quarter,width)*(1-smooth(.2,.3,walk/width)),actual=mean(pose,x,y,width>1.5*radialScale*R?16:8,true),reference=mean(pose,x,y,96,false),volume=mean(pose,x,y,16,false,true);
  maxT=Math.max(maxT,Math.abs(actual.T-reference.T));maxC=Math.max(maxC,Math.abs(actual.C-reference.C));maxMass=Math.max(maxMass,Math.abs(actual.mass-reference.mass));maxVolumeT=Math.max(maxVolumeT,Math.abs(reference.T-volume.T));maxVolumeC=Math.max(maxVolumeC,Math.abs(reference.C-volume.C));points.push({width,ratio:walk/width,blend,T:actual.T,C:actual.C});
 }
 assert.ok(maxT<.001&&maxC<.0003&&maxMass<.002,`pixel quadrature T${maxT}/C${maxC}/mass${maxMass}`);
 assert.ok(maxVolumeT<.002&&maxVolumeC<.002,`thin vs actual finite volume T${maxVolumeT}/C${maxVolumeC}`);
 assert.ok(points.slice(0,4).every(p=>p.blend===1));assert.equal(points[4].blend,0);assert.ok(points.slice(5,7).every(p=>p.blend>0&&p.blend<1));assert.equal(points[7].blend,1);
 console.log(JSON.stringify({kind:'finalRingOpticalReference',maxT,maxC,maxMass,maxVolumeT,maxVolumeC,points}));
});


// Execute the shipped display GLSL arithmetic; the test does not introduce a
// second density or transfer owner. Native compilation remains a separate gate.
const nearHandoffProgram=new Function('origin','uBodyRadius','length','vec2','max','abs','smoothstep',functionBody('naturalRingNearHandoff').replace(/\bfloat\b/g,'let'));
const nearHandoff=(r,y)=>nearHandoffProgram({xz:[r/R,0],y:y/R},R,v=>Math.hypot(...v),(x,y)=>[x,y],Math.max,Math.abs,smooth);
test('near-ring observer handoff is continuous and leaves the far observer unchanged',()=>{
 const r=1.5*R,H=NATURAL_RING.halfHeight,start=NATURAL_RING_GRAIN_LOD.fadeStart,end=NATURAL_RING_GRAIN_LOD.fadeEnd;
 assert.equal(nearHandoff(r,H),1);assert.equal(nearHandoff(r,H+start-1),1);
 assert.equal(nearHandoff(r,H+end+1),0);assert.equal(nearHandoff(r,H+119000),0);
 for(const d of[start,end])assert.ok(Math.abs(nearHandoff(r,H+d-.001)-nearHandoff(r,H+d+.001))<1e-9);
 const midpoint=(start+end)/2;
 assert.ok(Math.abs(nearHandoff(r,H+midpoint)-.5)<1e-12);
 // The same distance rule covers radial entry into the finite annulus.
 assert.ok(Math.abs(nearHandoff(NATURAL_RING.inner*R-midpoint,0)-.5)<1e-10);
});

const nearCellStart=glsl.indexOf('float nearLength='),nearCellEnd=glsl.indexOf('nearSolar+=nearWeight*sunTransmission;',nearCellStart)+'nearSolar+=nearWeight*sunTransmission;'.length;
assert.ok(nearCellStart>=0&&nearCellEnd>nearCellStart);
const nearCellProgram=new Function('start','end','sigma','transmission','sunTransmission','uBodyRadius','max','min','exp',`let nearAbsorption=0,nearSolar=0;${glsl.slice(nearCellStart,nearCellEnd).replace(/\bfloat\b/g,'let')}return{alpha:nearAbsorption,solar:nearSolar};`);
const linearRadiance=new Function('alpha','solarPower','response','albedo',functionBody('naturalRingLinearRadiance'));
const compositionStart=glsl.indexOf('float nearRadiance=naturalRingLinearRadiance('),compositionEnd=glsl.indexOf('alpha=nearAbsorption+coverage*(alpha-nearAbsorption);',compositionStart)+'alpha=nearAbsorption+coverage*(alpha-nearAbsorption);'.length;
assert.ok(compositionStart>=0&&compositionEnd>compositionStart);
const displayProgram=new Function('alpha','radiance','nearAbsorption','nearSolar','response','albedo','coverage','naturalRingLinearRadiance',glsl.slice(compositionStart,compositionEnd).replace(/\bfloat\b/g,'let')+'return{alpha,radiance};');
test('near-ring display preserves near transfer and positively mixes the same far color and opacity',()=>{
 const cutoff=NATURAL_RING_GRAIN_LOD.fadeEnd,sigma=.003,Tin=.8,illumination=.6,response=.08,albedo=.85;
 // Independent serial-slab reference: cells before, crossing and beyond the
 // grain handoff, including finite endpoints before all unresolved material.
 for(const[start,end]of[[cutoff-100,cutoff-20],[cutoff-50,cutoff+50],[cutoff+20,cutoff+100]]){
  const whole=Tin*-Math.expm1(-sigma*(end-start)),nearLength=Math.max(0,Math.min(cutoff,end)-start),nearExpected=Tin*-Math.expm1(-sigma*nearLength),farExpected=(Tin-nearExpected)*-Math.expm1(-sigma*(end-start-nearLength));
  const near=nearCellProgram(start/R,end/R,sigma,Tin,illumination,R,Math.max,Math.min,Math.exp);
  assert.ok(Math.abs(near.alpha-nearExpected)<1e-14);assert.ok(Math.abs(near.solar-nearExpected*illumination)<1e-14);
  const C=linearRadiance(whole,whole*illumination,response,albedo),Cnear=linearRadiance(nearExpected,nearExpected*illumination,response,albedo),Cfar=linearRadiance(farExpected,farExpected*illumination,response,albedo);
  for(const w of[0,.2,1]){
   const actual=displayProgram(whole,C,near.alpha,near.solar,response,albedo,w,linearRadiance);
   assert.ok(actual.alpha>=0&&actual.alpha<=whole+1e-14&&actual.radiance>=0);
   assert.ok(Math.abs(actual.alpha-(nearExpected+w*farExpected))<1e-14);
   assert.ok(Math.abs(actual.radiance-(Cnear+w*Cfar))<1e-14);
  }
 }
});
