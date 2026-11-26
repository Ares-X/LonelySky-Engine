/** Shared admission for the depth-compositing pass and optical preparation.
 * Scene traversal/owners separately establish object and ancestor visibility.
 */
export function isDepthVolumeVisible(object,camera){
  return Boolean(object.userData.setSceneDepth&&object.layers.test(camera.layers)
    &&object.material?.visible!==false&&object.material.uniforms.uVisibility.value>.001
    &&object.material.uniforms.uDensity.value>0
    &&object.parent?.userData.isInView?.(camera)!==false);
}
