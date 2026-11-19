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

## Release

Bump `version` in `package.json` and push to `main`; GitHub Actions publishes it.
