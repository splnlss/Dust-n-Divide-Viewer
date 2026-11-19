# Dust-n-Divide-Viewer

A WebGPU viewer for gaussian splats, built to run fast in VR on a Quest 3 as well as on desktop.

It streams PlayCanvas SOG scenes, loading the detail you need as you move around, and also
opens `.sog` and `.ply` files. Plain JavaScript modules, no framework and no build step.

## Install

The package is published to GitHub Packages. Add this `.npmrc` to the repo that uses it, with a
GitHub token that can read packages:

```
@splnlss:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```sh
pnpm add @splnlss/dust-n-divide-viewer
```

## Use

Import the modules you need by path:

```js
import { createBackend } from '@splnlss/dust-n-divide-viewer/webgpu/backend.js';
import { SplatScene } from '@splnlss/dust-n-divide-viewer/scene/SplatScene.js';
```

`src/main.js` is a complete example app that puts the pieces together: loading a scene, camera
controls, VR and the HUD.

### With three.js

`GaussianSplats` is a three.js mesh: three.js draws it in its own passes, sorted with the scene's
other transparent objects, and meshes in front of it hide it. Sorting and level of detail run on the
GPU before three.js draws.
three.js 0.187 is a peer dependency, so install it in your app:

```js
import { GaussianSplats, createWebGPURenderer } from '@splnlss/dust-n-divide-viewer/three/GaussianSplats.js';

const renderer = await createWebGPURenderer();
const splats = new GaussianSplats(renderer);
await splats.load('https://…/lod-meta.json');
scene.add(splats);

renderer.setAnimationLoop(() => renderer.render(scene, camera));

const point = await splats.hitTest(raycaster.ray);
```

For VR, `three/navigation.js` has `XRNavigation`, which moves a camera rig with the controllers,
and `applyFlyControls` for the desktop camera. `src/main.js` uses both. Splats are blended in three.js's linear colour space, so
faint overlapping splats look slightly hazier than in the standalone viewer, which blends in display
colour space.

Supported scenes:

- `lod-meta.json`: streamed SOG
- `meta.json` or `.sog`: a single SOG
- `.ply`: a standard 3D Gaussian Splatting file

## Browser support

Works in any browser with WebGPU. When WebGPU is off, the viewer shows how to enable it.

VR needs WebGPU inside WebXR, which so far only Quest Browser 146+ has, behind the
**WebXR experimental features** flag in `chrome://flags`.

A WebGL backend is planned; `src/webgl/backend.js` is a placeholder for it.

## Run the demo

```sh
pnpm install
pnpm dev
```

Open the printed `https://` URL (accept the self-signed certificate warning). Add
`?scene=<url>` to load another scene, or drop a `.ply` or `.sog` file onto the page.
Settings are in `src/config.js`.

| Device | Look | Move |
|---|---|---|
| Mouse + keyboard | left drag | `WASD` / arrows, `Q`/`E` down/up, wheel, right drag pans, `Shift` faster, `[`/`]` speed, `+`/`-` splat budget, double-click to jump there |
| Touch | one-finger drag | two fingers pan and pinch |
| Quest controllers | your head | left stick moves, right stick turns and flies, hold the trigger to aim the arc and release to jump, right `B`/`A` raise/lower the splat budget |

`demo/standalone.html` is the viewer without three.js, kept as the performance reference.

## Release

Bump `version` in `package.json` and push to `main`; GitHub Actions publishes it.
