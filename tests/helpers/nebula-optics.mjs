// Execute the uploaded shader's scalar interpolation and node expressions on CPU.
// This is deliberately a narrow numerical fixture, not a GLSL/GPU emulator.
import assert from 'node:assert/strict';

export function functionBody(shader, name) {
  const at=shader.indexOf(`${name}(`),start=shader.indexOf('{',at);
  assert.ok(at>=0&&start>at, name);
  let depth=1,end=start+1;
  while(depth&&end<shader.length){if(shader[end]==='{')depth++;if(shader[end]==='}')depth--;end++;}
  assert.equal(depth,0);return shader.slice(start+1,end-1);
}
function argumentsOf(source, start) {
  let depth=1,index=start,part=start;const values=[];
  for(;depth&&index<source.length;index++){
    if(source[index]==='(')depth++;
    if(source[index]===')')depth--;
    if(source[index]===','&&depth===1||depth===0){values.push(source.slice(part,index));part=index+1;}
  }
  assert.equal(depth,0);return values;
}
const expression=s=>s.replace(/\b([ufd])\.([xyz])/g,(_,v,c)=>`${v}[${'xyz'.indexOf(c)}]`);
const mix=(a,b,t)=>a+(b-a)*t;
const wrap=x=>((x%96)+96)%96;

export function noiseEvaluator(shader, uniforms, scalar=false) {
  const body=functionBody(shader,scalar?'nebulaNoiseScalar':'nebulaNoiseVector');
  const interpolation=body.match(/(?:float|vec3) ab=([^;]+);/)[1];
  const constructor=scalar?'vec3(':'mat3(',assignment=scalar?'gradient=transpose(domain)*':'gradient=';
  const start=body.indexOf(constructor,body.indexOf(assignment))+constructor.length;
  const derivatives=argumentsOf(body,start);assert.equal(derivatives.length,3);
  const value=body.match(/return ([^;]+);/)[1];
  const evaluate=Function('a','b','c','e','g','h','j','k','u','d','mix','attenuation',
    `const ab=${expression(interpolation)};return {value:${expression(value)},gradient:[${derivatives.map(expression).join(',')}]} ;`);
  const hermite=Function('f',`return [${body.match(/u=([^,;]+),d=([^;]+);/).slice(1).join(',')}];`);
  const attenuationRule=Function('width','exp',`return ${body.match(/attenuation=([^;]+);/)[1]};`);
  const key=uniforms.nebulaSeed.value;
  // Reference the original world field on signed coordinates across period seams.
  const corner=(x,y,z)=>{
    let h=Math.imul(wrap(x),0x8da6b343)^Math.imul(wrap(y),0xd8163841)^Math.imul(wrap(z),0xcb1ab31f)^key;
    h=Math.imul(h^(h>>>16),0x7feb352d);h=Math.imul(h^(h>>>15),0x846ca68b);
    return (h^(h>>>16))>>>0;
  };
  return (point,frequency,level,footprint=0)=>{
    const domain=uniforms.nebulaNoiseDomain.value[level].elements,phase=uniforms.nebulaNoisePhase.value[level].toArray();
    const p=[0,1,2].map(r=>(domain[r]*point[0]+domain[r+3]*point[1]+domain[r+6]*point[2])*frequency);
    const cell=p.map(Math.floor),f=p.map((v,k)=>v-cell[k]),u=[],d=[];
    for(const value of f){const pair=hermite(value);u.push(pair[0]);d.push(pair[1]);}
    const fetch=(z,channel)=>corner(cell[0]+phase[0]+(channel&1),cell[1]+phase[1]+(channel>>1),cell[2]+phase[2]+z);
    const words=[fetch(0,0),fetch(0,1),fetch(0,2),fetch(0,3),fetch(1,0),fetch(1,1),fetch(1,2),fetch(1,3)];
    const attenuation=attenuationRule(frequency*footprint,Math.exp),value=[],gradient=[];
    for(let component=0;component<(scalar?1:3);component++){
      const corners=words.map(h=>((h>>>(10*component))&1023)*2/1023-1);
      const result=evaluate(...corners,u,d,mix,attenuation);value.push(result.value);
      for(let axis=0;axis<3;axis++)gradient[axis*3+component]=(result.gradient[0]*domain[axis*3]+result.gradient[1]*domain[axis*3+1]+result.gradient[2]*domain[axis*3+2])*frequency*attenuation;
    }
    return{value,gradient};
  };
}

export function hullInterval(shader) {
  const main=functionBody(shader,'main'),start=main.indexOf('    float b=dot(localCamera,direction)'),end=main.indexOf('    float rayRange=');
  let body=main.slice(start,end).replace(/^\s*#(?:ifdef|endif).*$/gm,'')
    .replace('float physicalSpeed=length(direction*shapeScale);','')
    .replace(/\bfloat\b/g,'let').replaceAll('discard;','return null;');
  assert.ok(body.includes('scenePhysicalLimit(direction)'));
  return Function('localCamera','direction','physicalSpeed','radius','scenePhysicalLimit','dot','sqrt','max','min',body+'return {entry,exit:exitDistance};');
}
export function fixedGrid(shader) {
  const main=functionBody(shader,'main'),start=main.indexOf('float stepLength=rayRange/'),body=main.slice(start);
  const capacity=Number(body.match(/for\(int cell=0;cell<(\d+);cell\+\+\)/)[1]);
  const step=Function('rayRange',`return ${body.match(/float stepLength=([^;]+);/)[1]};`);
  const cellRule=Function('entry','cell','stepLength',`const ${body.match(/float a=([^;]+);/)[1].replace('entry','a=entry').replaceAll('float(cell)','cell')};return {a,b};`);
  const fraction=Function('node',`return ${body.match(/float fraction=([^;]+);/)[1]};`);
  const distance=Function('a','fraction','stepLength',`return ${body.match(/float distanceAlongRay=([^;]+);/)[1]};`);
  const possible=Function('hasDust','dustSpan','hasIon','ionSpan','a','b',`const dustPossible=${body.match(/bool dustPossible=([^;]+);/)[1]},ionPossible=${body.match(/bool ionPossible=([^;]+);/)[1]};return {dustPossible,ionPossible};`);
  return (entry,exit,dust,ion)=>{
    const h=step(exit-entry),result=[];
    for(let cell=0;cell<capacity;cell++){
      const {a,b}=cellRule(entry,cell,h),flags=possible(Boolean(dust),dust??{x:exit,y:entry},Boolean(ion),ion??{x:exit,y:entry},a,b);
      if(!flags.dustPossible&&!flags.ionPossible)continue;
      for(let node=0;node<2;node++)result.push({distance:distance(a,fraction(node),h),weight:h*.5,...flags});
    }
    return result;
  };
}
export function absorptionRule(shader) {
  const body=functionBody(shader,'main');
  return Function('tau','exp',`return ${body.match(/float absorbed=([^;]+);/)[1]};`);
}
