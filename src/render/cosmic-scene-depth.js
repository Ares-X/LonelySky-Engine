/** Opaque surface clipping in true cosmic distance. Requires the common
 * COSMIC_DEPTH_GLSL. The volume-local wrapper also uses shapeScale and
 * worldOrientation of its caller's frame.
 * Reversed and ordinary perspective depth share the same physical limit.
 */
export const COSMIC_WORLD_SCENE_DEPTH_GLSL = /* glsl */`
    const float COSMIC_SCENE_DEPTH_UNBOUNDED=1.e15;
    uniform sampler2D uSceneDepth;uniform vec2 uDepthResolution;uniform vec2 uCameraNearFar;
    uniform float uHasSceneDepth;
    float sceneWorldPhysicalLimit(vec3 worldDirection){
      if(uHasSceneDepth<.5) return COSMIC_SCENE_DEPTH_UNBOUNDED;
      float depth=texture2D(uSceneDepth,gl_FragCoord.xy/uDepthResolution).r;
      float near=uCameraNearFar.x,far=uCameraNearFar.y;
      #ifdef USE_REVERSED_DEPTH_BUFFER
        if(depth<=0.) return COSMIC_SCENE_DEPTH_UNBOUNDED;
        float forward=near*far/(near+depth*(far-near));
      #else
        if(depth>=1.) return COSMIC_SCENE_DEPTH_UNBOUNDED;
        float forward=near*far/(far-depth*(far-near));
      #endif
      float cosine=-(viewMatrix*vec4(worldDirection,0.)).z;
      float drawDistance=forward/max(cosine,.000001);
      if(drawDistance>=200000.) return COSMIC_SCENE_DEPTH_UNBOUNDED;
      return cosmicTrueDistance(drawDistance);
    }
`;

/** Volume-local callers retain the established anisotropic frame mapping. */
export const COSMIC_SCENE_DEPTH_GLSL = /* glsl */`
${COSMIC_WORLD_SCENE_DEPTH_GLSL}
    uniform float continuumWeight;uniform float structureKind;uniform mat3 worldOrientation;
    float scenePhysicalLimit(vec3 direction){
      return sceneWorldPhysicalLimit(normalize(worldOrientation*(direction*shapeScale)));
    }
`;
