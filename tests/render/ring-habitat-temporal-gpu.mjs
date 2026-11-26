// Browser-only numerical test, deliberately separate from node:test's probes.
// The parent QA harness imports and runs this against its existing local origin.
import * as THREE from 'three';
import {createRingHabitatTemporal} from '../../src/render/ring-habitat-temporal.js';

const VERTEX=`out vec3 worldRay;uniform mat4 uInverseProjection;uniform mat3 uCameraRotation;uniform vec4 uScreenBounds;
void main(){vec2 ndc=mix(uScreenBounds.xy,uScreenBounds.zw,position.xy*.5+.5);worldRay=uCameraRotation*(uInverseProjection*vec4(ndc,1.,1.)).xyz;gl_Position=vec4(ndc,0.,1.);}`;
const RAW=`precision highp float;layout(location=0) out vec4 radiance;layout(location=1) out vec4 metadata;
uniform vec4 uTestRadiance;uniform float uTestMean,uTestEntry;
void main(){radiance=uTestRadiance;metadata=vec4(uTestEntry,uTestMean,1.e15,1.);}`;
const COPY_VERTEX=`void main(){gl_Position=vec4(position.xy,0.,1.);}`;
const COPY_FRAGMENT=`precision highp float;uniform sampler2D source;out vec4 result;
void main(){result=texelFetch(source,ivec2(gl_FragCoord.xy),0);}`;

/** Executes actual raw/resolve/presentation shaders and float readback. Owns and
 * disposes its 32x32 canvas context; never touches a game's renderer or scene.
 * Returns numerical evidence, throws on a mismatch. A requested reversed mode
 * reports unsupported explicitly when EXT_clip_control is absent.
 */
export function runRingHabitatTemporalGpuChecks({reversedDepthBuffer=false}={}){
  const canvas=document.createElement('canvas'),renderer=new THREE.WebGLRenderer({canvas,antialias:false,reversedDepthBuffer});
  const geometry=new THREE.PlaneGeometry(2,2),camera=new THREE.PerspectiveCamera(60,1,.5,220000),scene=new THREE.Scene();
  const initialMaterial=new THREE.MeshBasicMaterial(),initialMesh=new THREE.Mesh(geometry,initialMaterial);
  const copyMaterial=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,vertexShader:COPY_VERTEX,fragmentShader:COPY_FRAGMENT,
    uniforms:{source:{value:null}},depthWrite:false,depthTest:false,blending:THREE.NoBlending,toneMapped:false});
  const readback=new THREE.WebGLRenderTarget(32,32,{type:THREE.FloatType,format:THREE.RGBAFormat,internalFormat:'RGBA32F',depthBuffer:false,stencilBuffer:false});
  const depthValues=new Float32Array(32*32),depthTexture=new THREE.DataTexture(depthValues,32,32,THREE.RedFormat,THREE.FloatType);
  depthTexture.internalFormat='R32F';depthTexture.minFilter=depthTexture.magFilter=THREE.NearestFilter;
  const owner=createRingHabitatTemporal({geometry,vertexShader:VERTEX,rawFragmentShader:RAW}),pixel=new Float32Array(4),evidence=[];
  renderer.setSize(32,32,false);renderer.setPixelRatio(1);renderer.setClearColor(0,0);renderer.outputColorSpace=THREE.LinearSRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
  try{
    if(!owner.supported(renderer))return {supported:false,reason:owner.stats.reason,reversedDepthBuffer};
    if(reversedDepthBuffer&&!renderer.capabilities.reversedDepthBuffer)return {supported:false,reason:'EXT_clip_control required for requested reversed depth',reversedDepthBuffer};
    // Trigger Three's canonical camera projection setup before constructing the
    // body's borrowed inverse-projection uniforms (also needed for reversed Z).
    initialMesh.position.z=-2;scene.add(initialMesh);renderer.render(scene,camera);scene.remove(initialMesh);
    const uniforms={uBodyRadius:{value:900000},uBodyOrigin:{value:new THREE.Vector3()},uBodyFrame:{value:new THREE.Matrix3()},
      uCameraRotation:{value:new THREE.Matrix3()},uViewRotation:{value:new THREE.Matrix3()},uInverseProjection:{value:camera.projectionMatrixInverse.clone()},
      uCameraNear:{value:.5},uScreenBounds:{value:new THREE.Vector4(-1,-1,1,1)},uSceneDepth:{value:depthTexture},uHasSceneDepth:{value:1},
      uDepthResolution:{value:new THREE.Vector2(32,32)},uCameraNearFar:{value:new THREE.Vector2(.5,220000)},
      uTestRadiance:{value:new THREE.Vector4(.2,.3,.4,.5)},uTestMean:{value:200},uTestEntry:{value:10}};
    const quad=new THREE.Mesh(geometry,copyMaterial);quad.frustumCulled=false;scene.add(quad);
    function near(actual,expected,label,tolerance=.002){if(Math.abs(actual-expected)>tolerance)throw new Error(`${label}: ${actual} != ${expected}`);}
    function sample(texture){
      copyMaterial.uniforms.source.value=texture;quad.material=copyMaterial;
      renderer.setRenderTarget(readback);renderer.clear();renderer.render(scene,camera);
      renderer.readRenderTargetPixels(readback,16,16,1,1,pixel);renderer.setRenderTarget(null);return Array.from(pixel);
    }
    function history(){return {radiance:sample(owner.material.uniforms.uTemporalHistory.value),metadata:sample(owner.material.uniforms.uTemporalMetadata.value)};}
    function setOpaque(forward){
      if(forward===Infinity)depthValues.fill(renderer.capabilities.reversedDepthBuffer?0:1);
      else{
        const clip=new THREE.Vector3(0,0,-forward).applyMatrix4(camera.projectionMatrix);
        depthValues.fill(renderer.capabilities.reversedDepthBuffer?clip.z:clip.z*.5+.5);
      }
      depthTexture.needsUpdate=true;
    }
    setOpaque(Infinity);owner.bind(uniforms,'gpu-ring');owner.prepare(renderer,32,32,camera);
    let h=history();near(h.radiance[0],.2,'first raw');near(h.metadata[3],1,'first count');evidence.push({case:'first',...h});
    uniforms.uTestRadiance.value.set(0,0,0,0);uniforms.uTestMean.value=0;owner.prepare(renderer,32,32,camera);
    h=history();near(h.radiance[0],.1,'zero-sample mean');near(h.radiance[3],.25,'zero-sample alpha');near(h.metadata[1],200,'zero-sample keeps representative point',.01);near(h.metadata[3],2,'zero-sample count');evidence.push({case:'valid-zero-after-bright',...h});
    // A new opaque object must already clip presentation without relying on a
    // fresh sample or a global history reset to erase the previous cloud.
    setOpaque(100);quad.material=owner.material;renderer.setRenderTarget(readback);renderer.clear();renderer.render(scene,camera);
    renderer.readRenderTargetPixels(readback,16,16,1,1,pixel);near(pixel[3],0,'new foreground clips existing presentation');
    evidence.push({case:'foreground-presentation',rgba:Array.from(pixel)});renderer.setRenderTarget(null);
    owner.prepare(renderer,32,32,camera);h=history();near(h.radiance[3],0,'new foreground rejects history');near(h.metadata[3],1,'new foreground count reset');evidence.push({case:'foreground-reject',...h});
    // Reverse order proves transparent valid samples count toward the estimate,
    // rather than the first bright sample starting an upward-biased new mean.
    owner.clear();setOpaque(Infinity);owner.prepare(renderer,32,32,camera);
    uniforms.uTestRadiance.value.set(.2,.3,.4,.5);uniforms.uTestMean.value=200;owner.prepare(renderer,32,32,camera);
    h=history();near(h.radiance[0],.1,'bright-after-empty mean');near(h.metadata[3],2,'bright-after-empty count');evidence.push({case:'bright-after-valid-zero',...h});
    owner.clear();owner.prepare(renderer,32,32,camera);
    uniforms.uBodyOrigin.value.x=10/900000;owner.prepare(renderer,32,32,camera);
    h=history();near(h.metadata[3],2,'ordinary movement retains reprojected history');evidence.push({case:'body-local-motion',...h});
    // MC first-hit entry can move by an entire cell while the camera, body,
    // ray and density field remain unchanged. It must not discard this mean.
    owner.clear();uniforms.uBodyOrigin.value.set(0,0,0);uniforms.uTestMean.value=500;
    uniforms.uTestRadiance.value.set(.5,.5,.5,.5);uniforms.uTestEntry.value=10;
    owner.prepare(renderer,32,32,camera);uniforms.uTestEntry.value=250;owner.prepare(renderer,32,32,camera);
    h=history();near(h.metadata[3],2,'stationary MC entry change keeps history');near(h.metadata[0],250,'current MC entry');near(h.metadata[1],500,'stationary representative',.01);
    near(h.radiance[0],.5,'stationary entry change mean');evidence.push({case:'stationary-entry-cell-change',...h});
    // Keep current entry in front of the opaque limit, so this specifically
    // exercises rejection of the history centroid behind the new foreground.
    setOpaque(100);uniforms.uTestEntry.value=10;uniforms.uTestRadiance.value.set(0,0,0,0);uniforms.uTestMean.value=0;
    owner.prepare(renderer,32,32,camera);h=history();near(h.metadata[3],1,'stationary entry exception retains foreground rejection');
    near(h.radiance[3],0,'foreground rejects 500-unit stationary history');evidence.push({case:'stationary-entry-foreground-mean-reject',...h});
    owner.clear();setOpaque(Infinity);uniforms.uTestMean.value=500;uniforms.uTestRadiance.value.set(.5,.5,.5,.5);uniforms.uTestEntry.value=10;
    owner.prepare(renderer,32,32,camera);uniforms.uBodyOrigin.value.x=1/900000;uniforms.uTestEntry.value=250;
    owner.prepare(renderer,32,32,camera);h=history();near(h.metadata[3],1,'moving ray entry mismatch rejects history');
    evidence.push({case:'moving-entry-cell-mismatch-reject',...h});
    const gl=renderer.getContext(),error=gl.getError();if(error!==gl.NO_ERROR)throw new Error(`Temporal GPU GL error ${error}`);
    return {supported:true,reversedDepthBuffer:renderer.capabilities.reversedDepthBuffer,evidence,resourceBytes:owner.stats.resourceBytes,targets:owner.stats.targets};
  }finally{
    owner.dispose();scene.clear();geometry.dispose();initialMaterial.dispose();copyMaterial.dispose();readback.dispose();depthTexture.dispose();
    renderer.dispose();renderer.forceContextLoss();canvas.remove();
  }
}
