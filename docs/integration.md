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
