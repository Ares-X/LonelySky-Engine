# Engine and game integration

The reusable engine contains deterministic generation, spatial addressing,
physics and optional Three.js visuals. The main demo link points to the normal
[LonelySky game](https://lonelysky.app/), maintained separately.

There are two entry points:

- `src/index.js`: pure data, generation, streaming and physics; no DOM or Three.js.
- `src/three.js`: the optional renderer and individual celestial primitives.

An application can use the default generator or supply its own scene provider.
Game-specific seeds, names, authored compositions and asset choices stay with
that provider. Seed independent generators explicitly so adding a visual layer
does not change an existing world's body stream.

The original physics factories still accept sphere-array providers. With the
default generator, use `createGravityField({world: universe})` or
`createCollisionWorld({world: universe})`; `universe.sector` supplies spheres.
Rendering reads `universe.getSector` instead.

The renderer starts no input, flight controls, social features, identity, saving,
analytics or backend requests. Its procedural scene needs no artwork downloads.
Hosts can supply their own materials and separately licensed textures.

The full game has its own cinematic camera, compositions, planetary textures,
flight handling and UI. A gameplay screenshot shows the visual techniques;
the default embedding example produces its own world. [Image credits](showcase-credits.md).

Pin an engine commit in a Git submodule. Upgrade and validate the consumer before
changing its recorded revision. Avoid a moving branch in production builds.

The cosmos renderer retains particle buffers when a cell rebase stays inside
the same macro neighborhood and quality level. Only positions are uploaded;
colors and radii keep their existing storage. Population or quality changes
replace the buffers. Particle coordinates, counts, distance fades and volume
sampling budgets are unchanged.

Shaders skip work only when an existing contribution is exactly zero: fully
transparent points are clipped before rasterization, galaxy samples beyond the
existing visibility fade avoid density evaluation, and the two optional shell
families avoid microstructure queries outside their existing fronts. Deep-sky
band noise and resolved spark detail are also skipped when their weights are
zero. The geometry, integration nodes, sample counts and fade distances remain
unchanged; no additional density or opacity cutoff is introduced. Planet surfaces
also skip sphere/ring transmission queries when their geometric-normal finite-disc
horizon is exactly zero. The partial stellar disc, ocean specular term and lit
limb remain evaluated whenever that horizon is positive; intrinsic lava emission
is applied independently after the light loop.

The standalone view keeps device pixel ratio at the renderer boundary. Its
composer retains pixel ratio one and receives `CSS width * ratio` and
`CSS height * ratio` in one `setSize` call, preserving the previous fractional
target/pass dimensions and renderer canvas floor/viewport rounding. This avoids
`setPixelRatio` first resizing all targets and bloom mips at the old dimensions.
The renderer uses the public `setDrawingBufferSize` API; canvas CSS remains owned
by the container. No composer private field is modified.

## Procedural scenery appearance

The directional sky shares absorbing dust lanes with the black-hole lens. Galaxy
volumes use a shared, mip-filtered 64 by 64 periodic multiscale texture for dusty
complexes, uneven arm widths and small star-forming regions. Dust reduces the
galaxy's own emission; it does not cover unrelated foreground geometry or sky.
Descriptors, addresses, particle positions and quality prefixes are unchanged.

Nebula volumes fade to zero before their bounds, use one mip-filtered 64-cubed
noise texture, directional ray/pixel footprints and paired Gauss samples within
the existing 16/32/48-step budgets. Extinction follows the world-space optical
length through a scaled volume. Appearance profiles add tapered trunks, broad
seeded shear, depth-coherent dust erosion and two-point light-column shading.
An optional `rimColor` separates ionized skins from reflected dust light. Calls
without appearance descriptors retain their palette and source controls. The warm emission-cloud palette and optical galaxy populations draw
on NASA's [Cosmic Cliffs](https://science.nasa.gov/asset/webb/cosmic-cliffs-in-the-carina-nebula-nircam-image/),
[Pillars of Creation](https://science.nasa.gov/asset/webb/pillars-of-creation-nircam-image/)
and [Hubble M74](https://science.nasa.gov/asset/hubble/spiral-galaxy-m74/).
These are artistic display cues, not calibrated naked-eye colors or radiative
transfer. No reference photographs or additional dependencies are required.

## V3 large-scale structure catalogue

`src/cosmic-structures.js` is a separate deterministic scenery stream. It keeps
cell size 20,000, signed 32,768-cell wrapping and Morton addresses intact. It
contains no game names, saves, authored destinations or collision shells.
`describeCosmicStructures(gridCoordinate, seed)` returns a sparse parent galaxy
and two clusters plus a cloud complex nested within its support. Galaxies have
40–84 million-unit diameters, clusters 6–15 million and cloud complexes 10–26
million. These are navigable artistic scales, not astronomical SI distances or
N-body dynamics. Emission volumes and statistical star tracers have no solid
collision boundary; local bodies remain the physics world's responsibility.

Parents occupy a 4,096-cell grid (81.92 million units); at most one candidate in
each 2³ block survives its seeded density choice. A fixed 5³ neighborhood contains
at most 27 parents / 108 total structures. Removed supports lie beyond the
100-million-unit visibility limit, including the address seam. Visibility fades
from 80 to 100 million units. `cosmicStructureContext({sectorIndex,
cameraPosition, seed})` returns a containing parent's `{id, family, theme}`, or
null in a void. Body providers may consume that semantic theme without copying
the catalogue's positioning decisions or adding game content to this module.

The public renderer retains its original catalogue by default. Enable V3 with:

```js
import { describeCosmicStructures, COSMIC_GRID_CELLS } from './src/cosmic-structures.js';
import { createCosmos } from './src/render/cosmos.js';
const cosmos = createCosmos({ seed,
  descriptorProvider: describeCosmicStructures,
  gridCells: COSMIC_GRID_CELLS, structures: true });
```

`descriptorProvider(coordinate, seed)` can return one descriptor, an array, or
null. Descriptors specify their grid size, 3D offset and Euler XYZ orientation;
rendering and semantic context read the same positions. Star samples remain
quality prefixes; cell rebases retain GPU attributes and mesh/material instances.
Cloud complexes use three world-fixed texture planes to produce dusty depth;
galaxy arms have uneven emission, dark inter-arm gaps, a compact core and a dim
halo. Crossing the support changes the integrated ray interval continuously;
there is no collision surface, painted plane or camera-facing complete galaxy.
The unresolved emission continuum blends into the unchanged 3D star tracers
between 1.8 and 0.6 support radii, retaining only 0.4% of that continuum nearby.
This is a visual level-of-detail transition: a raw full-column emission integral
inside the galaxy otherwise becomes a screen-filling luminous fog. It does not
change physical travel, catalogue positions, star count or collision bounds.
The display palette is informed by NASA's [star clusters](https://science.nasa.gov/mission/hubble/science/universe-uncovered/hubble-star-clusters/),
[nebulae](https://science.nasa.gov/mission/hubble/science/universe-uncovered/hubble-nebulae/)
and [Whirlpool galaxy](https://science.nasa.gov/asset/hubble/the-two-faced-whirlpool-galaxy/).
It is an emission/dust approximation, not calibrated radiative transfer.

All V3 renderers share `cosmicDrawDistance`, `cosmicTrueDistance` and the exact
`COSMIC_DEPTH_GLSL` counterpart. Distance through 160,000 is unchanged; beyond it
a monotone rational map approaches 200,000 drawing units. Angular positions and
physical generation, travel and collision distances remain unchanged. The volume
vertex shader preserves physical perspective interpolation at a safe raster
depth. Its back face supplies ray coverage only; depth testing and depth writes
are disabled for that proxy, avoiding float32 far-plane clipping at huge scales. V3 volumes implement the existing `NebulaRenderPass` scene-depth
handshake: opaque depth is reconstructed along each view ray, uncompressed and
used to terminate the physical emission integral. Use that pass before bloom to
obtain opaque occlusion; an ordinary RenderPass has no depth texture for a volume
to read. Transparent glows still use the existing sorted/additive approximation.
The camera/depth-buffer precision still bounds distant occlusion accuracy; CPU
round-trip checks do not establish GPU precision, appearance or long-run frame
performance. Validate those at the host's actual camera and quality settings.

Hosts needing distant depth ordering can request Three's `reversedDepthBuffer`
and supply `FloatType` depth textures on their composer targets before first use.
Both are necessary: reversed projection alone retains 24-bit fixed depth if no
float attachment is supplied. Check `renderer.capabilities.reversedDepthBuffer`;
Three keeps ordinary projection when `EXT_clip_control` is unavailable. Optical
shaders support both conventions through Three's `USE_REVERSED_DEPTH_BUFFER`:
reverse depth clears to zero and uses zero-to-one NDC, while ordinary depth clears
to one and uses negative-one-to-one NDC. Custom optical depth reads the renderer's
active projection so its first reversed draw does not consume a stale cached
matrix. Frustum consumers must pass the camera coordinate system and reversed
flag to `setFromProjectionMatrix`. This preserves ordinary-depth compatibility;
it does not fix the ordinary path's far-distance precision on unsupported GPUs.

## Physical cosmic surfaces

The optional Three.js entry exports `createCosmicBodies({surfaceTexture,
cloudTexture, stellarTexture})`. Its group has `userData.update({bodies, camera,
viewportHeight, pixelRatio})` and `userData.dispose()`. Each input supplies
`id`, `kind` (`ring`, `gas-giant`, `dark-world`, `stellar-giant`, or `moon`),
`radius`, world-to-local orthonormal `frame`, camera-relative **physical** `center`,
local light direction, linear tint, phase and `shape`. Shapes use the exact
world-unit sphere or six-section annular compound from the physics catalogue.
Visibility zero hides the slot; one writes opaque surface depth; fractional
visibility uses a depth-tested transparent far LOD. Slots and the quad are reused.
Translucent gas rings and stellar prominences have separate depth-tested passes.
The host samples orbital descriptors at its simulation time before updating
moving moon surfaces. Rotating a moon's local frame towards its parent can keep
its material phase tidally locked without changing the sphere's collision.

Surface detail is fixed in body space and filtered by projected footprint.
Ring plate dimensions and continental detail do not change the analytic slab
geometry: its current inner terrain remains a flat radial deck. Material normals
are not real mountains. The stellar surface models a restrained photosphere,
not false-color chromospheric imagery. Texture inputs are optional host assets;
the engine does not package a game's art or reference photographs.

At million-unit radii, float32 intersection error is measurable even with
reversed Float32 depth. In the tested 1M-radius scene, a camera at 0.55 units
from the surface with a 0.5-unit near plane can miss the near face; separations
of at least one unit passed the bounded component cases. Hosts must preserve a
tested near-plane/intersection clearance, rather than claiming arbitrary close
precision. A host can keep two units of camera clearance for a 0.5-unit near
plane and verify its supported radius range. Physical body thickness is unchanged.

`createPlanetLod` owns a reusable unit-sphere pool. Projected screen coverage,
quality caps and hysteresis choose detail; surfaces and atmospheres borrow the
same level and the view disposes the pool once. `createUniverseView` uses this
for planetary surfaces while retaining its existing stellar geometry budget.

## Optional regional panorama

The sky and black-hole lens share an optional observational equirectangular map
supplied as `detailTexture`; ownership remains with the caller. A host can set
`environment.classicSkyStrength` in [0,1] and `classicSkyFrame`, a column-major
orthonormal 3×3 matrix mapping world directions to Galactic coordinates. The
shader converts to the map's equatorial coordinates and wraps the longitude
gradient at the seam. Missing controls retain the procedural background.

The host owns region selection, continuous position-dependent fading and
navigation. No application names, addresses or assets are bundled by this API.
Use the same environment for the sky and the lens. This is a distant directional
background, with no translational parallax or physical collision surface;
foreground geometry continues to supply its own depth and motion.
