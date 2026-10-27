import * as THREE from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

/** Render depth-writing surfaces once, then depth-limited nebulae and the usual
 * sorted translucent objects once. Intended before bloom/output in a composer.
 * This retains Three's object sorting for rings/glows and overlapping volumes;
 * it is not order-independent transparency or volumetric light transport.
 */
export class NebulaRenderPass extends RenderPass {
  constructor(scene, camera) {
    super(scene, camera);
    this._hiddenMaterial = new THREE.Material();
    this._hiddenMaterial.visible = false;
    this._attachedDepth = new Map();
    this._depthTarget = null;
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const volumes = [];
    this.scene.traverseVisible(object => {
      if (object.userData.setSceneDepth && object.layers.test(this.camera.layers)
        && object.material?.visible !== false && object.material.uniforms.uVisibility.value > .001
        && object.material.uniforms.uDensity.value > 0
        && object.parent?.userData.isInView?.(this.camera) !== false) volumes.push(object);
    });
    // An ordinary scene keeps the single RenderPass path and allocates no depth
    // textures. Direct-to-screen callers also retain the normal RenderPass API.
    if (!volumes.length || this.renderToScreen || !readBuffer || this.overrideMaterial !== null) {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }

    const previousTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear, background = this.scene.background;
    const clearColor = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
    const overrideMaterial = this.scene.overrideMaterial;
    const resolveDepth = readBuffer.resolveDepthBuffer;
    const storeDepth = readBuffer.storeMultisampledDepthBuffer;
    const objects = [];
    this.scene.traverse(object => {
      if (object.material) objects.push([object, object.material]);
    });
    const filter = surfaces => {
      for (const [object, original] of objects) {
        const select = material => {
          if (!material) return material;
          const isSurface = !object.userData.setSceneDepth
            && (material.depthWrite || (object.renderOrder < 0 && material.depthTest === false));
          return isSurface === surfaces ? material : this._hiddenMaterial;
        };
        object.material = Array.isArray(original) ? original.map(select) : select(original);
      }
    };
    let completed = false;
    try {
      if (!readBuffer.depthTexture) {
        const depth = new THREE.DepthTexture(readBuffer.width, readBuffer.height,
          readBuffer.stencilBuffer ? THREE.UnsignedInt248Type : THREE.UnsignedIntType);
        if (readBuffer.stencilBuffer) depth.format = THREE.DepthStencilFormat;
        readBuffer.depthTexture = depth;
        this._attachedDepth.set(readBuffer, depth);
      }
      const sourceDepth = readBuffer.depthTexture;
      if (!this._depthTarget || this._depthTarget.depthTexture.type !== sourceDepth.type
        || this._depthTarget.depthTexture.format !== sourceDepth.format) {
        this._depthTarget?.dispose();
        const depth = new THREE.DepthTexture(readBuffer.width, readBuffer.height, sourceDepth.type);
        depth.format = sourceDepth.format;
        this._depthTarget = new THREE.WebGLRenderTarget(readBuffer.width, readBuffer.height, {
          depthTexture: depth, stencilBuffer: sourceDepth.format === THREE.DepthStencilFormat,
        });
      }
      this._depthTarget.setSize(readBuffer.width, readBuffer.height);
      readBuffer.resolveDepthBuffer = true;
      readBuffer.storeMultisampledDepthBuffer = true;
      filter(true);
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      // renderer.render resolves the MSAA depth attachment before this public
      // texture copy. Sampling a distinct target avoids a framebuffer feedback
      // loop while the colour and live depth buffers remain in place.
      renderer.initRenderTarget(this._depthTarget);
      renderer.copyTextureToTexture(sourceDepth, this._depthTarget.depthTexture);
      renderer.setRenderTarget(readBuffer);
      for (const volume of volumes) volume.userData.setSceneDepth(
        this._depthTarget.depthTexture, readBuffer.width, readBuffer.height, this.camera);
      filter(false);
      renderer.autoClear = false;
      this.scene.background = null;
      renderer.render(this.scene, this.camera);
      completed = true;
    } finally {
      for (const [object, material] of objects) object.material = material;
      for (const volume of volumes) volume.userData.setSceneDepth(null);
      this.scene.background = background;
      this.scene.overrideMaterial = overrideMaterial;
      renderer.autoClear = autoClear;
      renderer.setClearColor(clearColor, clearAlpha);
      readBuffer.resolveDepthBuffer = resolveDepth;
      readBuffer.storeMultisampledDepthBuffer = storeDepth;
      if (!completed) renderer.setRenderTarget(previousTarget);
    }
  }

  dispose() {
    this._hiddenMaterial.dispose();
    this._depthTarget?.dispose();
    this._depthTarget = null;
    for (const [target, depth] of this._attachedDepth) {
      if (target.depthTexture === depth) target.depthTexture = null;
      depth.dispose();
    }
    this._attachedDepth.clear();
  }
}
