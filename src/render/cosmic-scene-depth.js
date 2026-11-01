/** Opaque surface clipping in true cosmic distance. Requires the common
 * COSMIC_DEPTH_GLSL, shapeScale and worldOrientation of the volume's frame.
 * Reversed and ordinary perspective depth share the same physical limit.
 */
export const COSMIC_SCENE_DEPTH_GLSL = /* glsl */`
    uniform sampler2D uSceneDepth;uniform vec2 uDepthResolution;uniform vec2 uCameraNearFar;
    uniform float uHasSceneDepth;uniform float continuumWeight;uniform float structureKind;uniform mat3 worldOrientation;
    float scenePhysicalLimit(vec3 direction){
      if(uHasSceneDepth<.5) return 1.e15;
      float depth=texture2D(uSceneDepth,gl_FragCoord.xy/uDepthResolution).r;
      float near=uCameraNearFar.x,far=uCameraNearFar.y;
      #ifdef USE_REVERSED_DEPTH_BUFFER
        if(depth<=0.) return 1.e15;
        float forward=near*far/(near+depth*(far-near));
      #else
        if(depth>=1.) return 1.e15;
        float forward=near*far/(far-depth*(far-near));
      #endif
      vec3 worldDirection=normalize(worldOrientation*(direction*shapeScale));
      float cosine=-(viewMatrix*vec4(worldDirection,0.)).z;
      float drawDistance=forward/max(cosine,.000001);
      if(drawDistance>=200000.) return 1.e15;
      return cosmicTrueDistance(drawDistance);
    }
`;
