import * as THREE from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

/** Render depth-writing surfaces once, then depth-limited nebulae and the usual
 * sorted translucent objects once. Intended before bloom/output in a composer.
 * This retains Three's object sorting for rings/glows and overlapping volumes;
 * it is not order-independent transparency or volumetric light transport.
 */
export class NebulaRenderPass extends RenderPass {
  constructor(scene, camera, { reuseWorldMatrices = false } = {}) {
    super(scene, camera);
    this.reuseWorldMatrices = reuseWorldMatrices;
    this._hiddenMaterial = new THREE.Material();
    this._hiddenMaterial.visible = false;
    this._attachedDepth = new Map();
    this._depthTarget = null;
    this._clearColor = new THREE.Color();
    this._volumes = [];
    this._objects = [];
    this._volumeCount = 0;
    this._objectCount = 0;
    this._collectVolume = object => {
      if (object.userData.setSceneDepth && object.layers.test(this.camera.layers)
        && object.material?.visible !== false && object.material.uniforms.uVisibility.value > .001
        && object.material.uniforms.uDensity.value > 0
        && object.parent?.userData.isInView?.(this.camera) !== false) this._volumes[this._volumeCount++] = object;
    };
    this._collectObject = object => {
      if (!object.material) return;
      const index = this._objectCount++;
      const record = this._objects[index] ?? (this._objects[index] = {object: null, original: null, filtered: []});
      record.object = object; record.original = object.material;
    };
  }

  _filterMaterials(surfaces) {
    for (let i = 0; i < this._objectCount; i++) {
      const {object, original, filtered} = this._objects[i];
      if (Array.isArray(original)) {
        filtered.length = original.length;
        for (let j = 0; j < original.length; j++) filtered[j] = this._selectMaterial(object, original[j], surfaces);
        object.material = filtered;
      } else object.material = this._selectMaterial(object, original, surfaces);
    }
  }

  _selectMaterial(object, material, surfaces) {
    if (!material) return material;
    const isSurface = !object.userData.setSceneDepth
      && (material.depthWrite || (object.renderOrder < 0 && material.depthTest === false));
    return isSurface === surfaces ? material : this._hiddenMaterial;
  }

  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const volumes = this._volumes;
    this._volumeCount = 0;
    this.scene.traverseVisible(this._collectVolume);
    volumes.length = this._volumeCount;
    // An ordinary scene keeps the single RenderPass path and allocates no depth
    // textures. Direct-to-screen callers also retain the normal RenderPass API.
    if (!volumes.length || this.renderToScreen || !readBuffer || this.overrideMaterial !== null) {
      this._objects.length = 0;
      volumes.fill(null);
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }

    const previousTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear, background = this.scene.background;
    const clearColor = renderer.getClearColor(this._clearColor), clearAlpha = renderer.getClearAlpha();
    const overrideMaterial = this.scene.overrideMaterial;
    const resolveDepth = readBuffer.resolveDepthBuffer;
    const storeDepth = readBuffer.storeMultisampledDepthBuffer;
    this._objectCount = 0;
    this.scene.traverse(this._collectObject);
    // Capacity follows this scene, and dropped objects are never retained by a
    // pass-owned record after a frame or a streaming/lifecycle change.
    this._objects.length = this._objectCount;
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
      this._filterMaterials(true);
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      // renderer.render resolves the MSAA depth attachment before this public
      // texture copy. Sampling a distinct target avoids a framebuffer feedback
      // loop while the colour and live depth buffers remain in place.
      renderer.initRenderTarget(this._depthTarget);
      renderer.copyTextureToTexture(sourceDepth, this._depthTarget.depthTexture);
      renderer.setRenderTarget(readBuffer);
      for (const volume of volumes) volume.userData.setSceneDepth(
        this._depthTarget.depthTexture, readBuffer.width, readBuffer.height, this.camera);
      this._filterMaterials(false);
      // The surface snapshot is complete. Translucency only changes colour;
      // retain MSAA depth for testing without resolving it a second time.
      readBuffer.resolveDepthBuffer = false;
      renderer.autoClear = false;
      this.scene.background = null;
      const matrixWorldAutoUpdate = this.scene.matrixWorldAutoUpdate;
      const reuseWorldMatrices = this.reuseWorldMatrices;
      try {
        // Opt-in callers keep transforms unchanged throughout both draws. The
        // next frame still propagates its scene changes in the first draw.
        if (reuseWorldMatrices) this.scene.matrixWorldAutoUpdate = false;
        renderer.render(this.scene, this.camera);
      } finally {
        if (reuseWorldMatrices) this.scene.matrixWorldAutoUpdate = matrixWorldAutoUpdate;
      }
      completed = true;
    } finally {
      for (let i = 0; i < this._objectCount; i++) {
        const record = this._objects[i];
        record.object.material = record.original;
        record.object = record.original = null;
        record.filtered.fill(null);
      }
      for (const volume of volumes) volume.userData.setSceneDepth(null);
      volumes.fill(null);
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
    this._objects.length = this._volumes.length = 0;
  }
}
