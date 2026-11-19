# Dust-n-Divide-Viewer

A vanilla WebGPU viewer for PlayCanvas **streamed SOG** gaussian splats, built for
performance first: the target is a Quest 3 in VR. A WebGL 2 backend is planned (see [Backends](#backends)).

No framework, no TypeScript, no build step. The browser loads the ES modules in
`src/` directly. The dev dependencies are Vite (dev server only) and `puppeteer-core` for the
headless smoke test.

## Run

```sh
pnpm install
pnpm dev          # or pnpm start; prints https://localhost:5183/ and https://<lan-ip>:5183/
```

Vite serves the page over **HTTPS**, because WebGPU and WebXR only work in a secure context
(plain HTTP is allowed on `localhost` only). The certificate is self-signed, so the browser warns
once: choose *Advanced → Proceed*. The server listens on all interfaces, so the LAN URL works on a
headset.

The splat data is not served locally. It lives in the public `demo-assets` R2 bucket
(`https://pub-dd92ae5131ec49f1bbd411b51a858249.r2.dev/`), which sends
`Access-Control-Allow-Origin: *`. The scene is `config.scene` in `src/config.js` (RondaLobato by
default), or `?scene=<url>` to load another, e.g.
`?scene=https://pub-dd92ae5131ec49f1bbd411b51a858249.r2.dev/06_ARK_Bob/20261110_ARK-WaterPump/web/lod/lod-meta.json`.
It accepts:

- `lod-meta.json` — streamed SOG (LOD tree + chunks)
- `meta.json` — a single unbundled SOG
- `*.sog` — a bundled SOG
- `*.ply` — a raw 3D Gaussian Splatting PLY (see below)

A local `.ply` or `.sog` can also be dropped onto the page; it replaces the current scene.

### PLY files

Meant for previewing a capture's full quality on desktop before converting it to SOG.

- Reads the standard layout written by 3DGS training and most tools (`x y z`, `f_dc_*`,
  `opacity`, `scale_*`, `rot_*`), binary little-endian, any numeric property types. Point-cloud
  style `red/green/blue` colours are accepted in place of `f_dc_*`.
- The file is streamed: rows are reduced to the 14 values the renderer needs and decoded on the
  GPU with the same maths as SOG, in 3.7 MB batches. A 1.2 GB, 4.9M-splat PLY opens in about 1.5 s
  in Chrome and 4 s in Firefox, and renders the same as the SOG made from it (mean difference
  1.6/255, the SOG's compression).
- Every splat is drawn: a PLY has no levels of detail, so GPU memory is sized from its splat count
  (32 + 36 bytes per splat, about 330 MB for 4.9M) and `budget`/`lod*` do not apply.
- Not supported: higher-order SH (`f_rest_*` is skipped, as for SOG), ASCII PLYs, and SuperSplat's
  compressed PLY. These are reported with a message rather than drawn wrong.
- It works in VR too, but a multi-million-splat PLY without LOD is far too heavy for a Quest.

### Controls

| Device | Look | Move |
|---|---|---|
| Mouse + keyboard | left drag | wheel forward/back, right (or middle) drag pans, `WASD` / arrows, `Q`/`E` down/up, `Shift` faster, `[`/`]` change speed, `+`/`-` change the splat budget; double-click the scene to teleport to that point |
| Touch | one-finger drag | two fingers: drag to pan, spread to go forward, pinch to go back (both at once works) |
| Quest controllers | your head | left stick moves where you look; right stick left/right turns, up/down flies; hold the trigger to aim a teleport arc at the ground, release to jump there; right controller `B`/`A` raise/lower the splat budget |

Right-stick turning in VR snaps 30° per flick by default (`smoothTurn` in the config for continuous turning).
Panning grabs the scene, so what's under the cursor or fingers follows them; a point `speed` units
away tracks exactly. Speed (`[`/`]`) also scales scroll, pan and pinch distances.

The splat budget changes live: a press steps it (250k on desktop, 100k in VR), holding keeps
stepping until the limit. Limits are 3M–6M on desktop and 500k–3M in VR (`budgetRange`,
`xrBudgetRange` in the config). The desktop HUD's `budget` line and the VR readout show it.

In VR, the right stick does one thing at a time, so a diagonal push turns without also flying.
Movement speed is `xrSpeed` metres per second. A head-locked readout in the top left of the view shows the splat budget (`xrBudgetReadout`).
The teleport arc lands where it meets the scene itself (the first reasonably opaque splats along it), and you stand there: your floor moves to that point. It turns red with no ring when it meets nothing within range. To cancel a jump, point the controller up into the air (more than 60° above the horizon, `teleportCancel`): the arc is replaced by a red cancel sign, and releasing the trigger then does nothing.

### Quest 3

VR runs through the WebXR/WebGPU binding (`XRGPUBinding`), which is still experimental:

1. Quest Browser 146 or newer. Open `chrome://flags`, enable **WebXR experimental features**
   (and the WebGPU entries), then press **Relaunch**. Closing the window is not enough.
2. Run `pnpm dev` and open the printed `https://<lan-ip>:5183/` URL in the
   headset, accepting the certificate warning. (Over USB, `adb reverse tcp:5183 tcp:5183` and
   `https://localhost:5183/` also works.)
3. Press **Enter VR**. Left stick moves, right stick turns and flies up/down.

## Backends

The renderer is WebGPU (`src/webgpu/`). When the browser has no WebGPU, or no adapter, the page
shows how to enable it in Chrome/Edge, Firefox, Safari and Quest Browser instead of a scene.

`src/webgl/backend.js` is a placeholder for a WebGL 2 backend: `?backend=webgl` selects it and
currently only shows a message. A backend exports `createBackend(canvas, host)`, returning the
object `src/webgpu/backend.js` returns; everything above it (LOD selection, streaming, controls,
VR locomotion, teleport) is shared.

## Settings

Everything is set in [`src/config.js`](src/config.js), commented in place. A few settings can
also be changed from the URL, to compare on a device without editing code:

| Parameter | Default (desktop / headset) | Meaning |
|---|---|---|
| `backend` | `webgpu` | `webgpu`, or `webgl` for the placeholder (see [Backends](#backends)) |
| `scene` | `config.scene` | URL of a `lod-meta.json`, `meta.json`, `.sog` or `.ply` |
| `xrbudget` | 1 000 000 | Starting splat budget in VR (clamped to `xrBudgetRange`; `B`/`A` change it live) |

**Start view.** Unless `pos` is given, the camera starts back and up from the scene's centre
(20° above it) and looks down at it, from 2.5× the radius that holds 80% of the splats. That radius
comes from the LOD tree and ignores floaters, which can make the bounds several times bigger
than the real scene. The default sample has a hand-picked overview instead.

**Reveal.** When a scene first shows, its splats grow in outwards from where the camera starts, in a
wave that speeds up as it spreads. The idea comes from PlayCanvas's `gsplatRevealRadial` and runs
somewhat faster. Ahead of the wave nothing is drawn. As the front arrives, each splat appears as a
small dot that bobs up and down, then grows to full size over the next 2 m. The effect lives in the
render vertex shader and costs nothing once the wave has passed the scene bounds. It is tuned with
`reveal` in `src/config.js` and switched off with `reveal: null`.

The HUD shows frame rate, GPU time for compute (sort and projection) and draw (when `timestamp-query` is available),
visible/active splats, the current budget, chunks loaded and GPU memory.

## How it works

```
lod-meta.json ─► SplatScene (CPU, ~10 Hz)          picks one LOD level per leaf within the budget,
                   │                                streams the chunk files that needs
                   ▼
chunk WebPs ──► decode.wgsl (once per chunk)        WebP textures → render-ready splat buffers, on the GPU
                   ▼
                expand.wgsl (when selection changes) active runs → flat list of splat ids
                   ▼
                sort.wgsl (every frame)             frustum cull + counting sort by distance
                   ▼
                render.wgsl (once per eye)          one indexed indirect draw, back to front;
                                                    both eyes share one render pass
```

- **Nothing is decoded on the CPU.** WebP files are decoded by the browser, copied straight into
  textures, and a compute pass dequantises them into two 16-byte-per-splat buffers
  (position + colour, and a half-float covariance). The main thread never touches splat data,
  so streaming does not stall VR frames. At most one chunk is uploaded per frame.
- **Sorting is a single-pass GPU counting sort**: quantise log-distance to a bin, count with
  atomics, a three-level parallel prefix sum, scatter. No readback, no worker, no sort lag.
  A final pass orders splats that share a bin so the result does not flicker.
- **Keys are radial distance from the head**, not view depth, so the order is unaffected by head
  rotation, and both eyes share one sort.
- **Frustum culling happens in the sort**, so only visible splats are sorted and drawn; the visible
  count goes directly into the indirect draw arguments.
- **Fill rate is the limit on a Quest**, so each splat uses a gaussian renormalised to reach zero
  at 1.7σ (`maxSigma`; no faint halo, and quads are shrunk further for faint splats), splats under
  5% opacity (`minOpacity`) and under a pixel are dropped, and all splats go out as indexed draws
  that share one small index buffer.
- **LOD selection** is by distance to each leaf's bounds. Leaves within about 53° of the view
  direction are unpenalised; beyond that they count as progressively farther, up to 3× behind you,
  so the budget goes where you are looking.
  If the result exceeds the budget, distances are scaled up until it fits. The coarsest level of
  every leaf stays resident, so there is always something to draw while finer chunks stream in.

### Why vanilla WebGPU rather than three.js

three.js r186 can render WebXR through `XRGPUBinding`, and like any WebGPU renderer it draws each
eye in its own pass. For this workload the GPU cost would be the same, but its WebGPU XR path is
new, and it decides the render targets, pass setup and per-frame bookkeeping. Going direct keeps
the frame to one compute pass and one draw per eye with no depth buffer, no MSAA and no
intermediate target, and the page loads about 40 kB of source instead of a ~1 MB bundle.
`SplatRenderer` only needs a `GPUDevice` and view/projection matrices, so it can be embedded in
another engine that exposes its device.

## Performance on a Quest 3

Measured in VR on the headset (Quest Browser 154, RondaLobato scene, a heavy view near the
ground, 0.22M visible splats, 1344×1408 per eye unless noted). Driving the headset over adb is
the only way to get these; see *Testing on the headset* below.

| Change | Draw time | fps |
|---|---|---|
| Instanced quads (the original) | 15.2–15.7 ms | 51 |
| **One indexed draw, no instancing** (now the only path) | 12.4–13.1 ms | 59–60 |
| Half-float fragment shader on/off | no change | |
| Simpler fragment shaders, even one with no maths | no change | |
| Reusing the sort across frames | no change | |
| Projecting splats once per eye in compute (removed) | slightly worse | 47 |
| **Renormalised 2σ kernel** instead of a 2.8σ tail cut at 1/255 (now the default) | full res 21.2 → 14.8 ms; 0.8 scale 14.3 → 10.2 ms | 41 → 52; 53 → 66 |
| `minpx=1` instead of 0.3 | | +3 |
| Eye buffer scale 1.0 / 0.8 / 0.6 (instanced) | 21.6 / 15.6 / 11.7 ms | 39 / 51 / 62 |
| Splat budget 0.35M → 0.21M | about −8% | |
| Fixed foveation 0 vs 1 | no change (not applied to WebGPU layers) | |
| Octagons instead of quads for splats ≥1–4 px (removed; this and the rows below at a 1M budget, 1680×1760) | 29 → 52–54 ms | 34 → 19 |
| `maxSigma` 2 → 1.8 / 1.7 (image differs 2.5 / 3.6 of 255) | 29 → 27.7 / 26.8 ms | 34 → 36 / 37 |
| `minOpacity` 0.05 (drops 1% of splats; image differs 2.5 of 255) | 29 → 28 ms | 34 → 36 |
| Splat indices for 64k splats reused by batched indirect draws, instead of one index list for all | no change | |

What that says about where the time goes:

- **Vertex work is not free either.** Octagons cover about 17% fewer pixels than quads but run
  twice the vertices, each doing the full splat setup: the frame nearly doubled.
- **Covered pixels dominate.** The fragment shader's contents are irrelevant; what costs is how
  many pixels the splats cover, times the overdraw. Only resolution and splat extent move it.
- **Splat count matters little** beyond a floor: even the coarsest LOD covers the same pixels.
- **Instancing is expensive on this GPU.** The same quads as one indexed draw are 18% cheaper.
- **Splat setup is cheap.** With the quads shrunk to nothing, 0.2M splats draw in 3.8 ms at full
  resolution: the rest is fill.
- **Overdraw is high, but rarely behind opaque surfaces.** At the Quest's per-eye size, a heavy
  view shades 29 fragments per pixel on average (p90 61, p99 124). A depth pre-pass that lets
  nearly opaque splat cores (≥95%) hide what is behind them would skip only 4–6% of those, and
  21% even at a lossy 80% threshold: less than the extra vertex pass would cost. Most layers are
  semi-transparent, so the fixed-function blend cannot skip them.
- **The refresh-rate target changes the GPU clock.** With identical settings the headset gave 66
  fps at a 72 Hz target and 76 fps at 90 Hz: compare settings at the same target.

So in VR the automatic control changes **render resolution**, between `xrMinScale` and `xrScale`,
using measured GPU time, and leaves detail alone. `requestViewportScale` makes this free: the
browser hands out a smaller viewport of the same eye texture. It is off by default
(`xrMinScale: 1`, fixed full resolution, 1M budget), which favours detail over frame rate; with
a 500k budget and resolution floating between 0.8 and 1 the test scene ran at 66–68 fps.

On desktop the renormalised kernel is also what makes the image as sharp as Gaussian Splat Lite's
on the same data (mean edge gradient 10.3 vs 10.0; the old 2.8σ tail gave 7.0, a visible haze).

### Compared with three.js + Gaussian Splat Lite

Same data (the threejs-webxr-sog-test repack), same head position, 450k budget, 1680×1760 per eye,
120 Hz target, frame times from the XR session for both:

| | fps |
|---|---|
| three.js as shipped (SH band 3, foveation on) | 27 |
| three.js, SH off, foveation on / off | 55 / 48 |
| this viewer, full resolution (no SH) | 46 |
| this viewer, auto resolution 0.8–1 | 54 |

The three.js viewer (WebGL) benefits from fixed foveation (about 15% here), which WebGPU layers do not get on
Quest Browser 154. On a desktop RTX 4090 this viewer is 2.5× (1080p) to 7× (4K) faster.

### Testing on the headset

With developer mode on and the headset connected over USB (`adb devices` must list it):

- `adb reverse tcp:PORT tcp:PORT` makes the dev server reachable at `https://localhost:PORT` on the
  headset without going over Wi-Fi (accept the certificate warning once).
- `adb forward tcp:9333 localabstract:chrome_devtools_remote` exposes Quest Browser's debugger, so
  the page can be loaded, clicked and inspected from this machine (e.g. with puppeteer).
- `adb exec-out screencap -p` captures what the headset displays, including VR.
- `log: true` in the config posts the HUD, GPU info and any errors to the dev server's terminal.

## Status and limits

- Verified on desktop Chrome (headless, RTX 4090) with streamed SOG v2 data: mono, the
  side-by-side stereo path, streaming, eviction and the budget.
- Verified in VR on a Quest 3 (Quest Browser 154, with the WebXR experimental flag): correct
  colours, 67–72 fps on the test scene with the default settings.
- Also runs in Firefox 158 on desktop (WebGPU, no VR: Firefox does not support WebXR with WebGPU yet).
- Colour is SH band 0 only. Higher-order SH in the files is ignored (no view-dependent shading).
- SOG v2 and v3 are supported (v3 opacity above 1 is clamped); legacy v1 and 2DGS are not.
- LOD changes pop; there is no cross-fade.
- GPU memory is fixed at `capacity`. Chunks are ~0.5M splats each and load whole, so `capacity`
  should be a few times `budget`.

## Publishing (Netlify)

The site is static and has no compile step; `pnpm build` (`scripts/build.mjs`) copies
`index.html` and `src/` into `dist/`. The scene loads from R2, so no data is deployed.

GitLab CI (`.gitlab-ci.yml`) builds every push and deploys `dist/` to Netlify with `netlify-cli`
on pushes to `main` only. The Netlify project was created by uploading files, so Netlify itself
never builds. The pipeline needs two CI/CD variables, both protected: `NETLIFY_AUTH_TOKEN` (a
Netlify personal access token) and `NETLIFY_SITE_ID` (the project ID). Netlify serves HTTPS, which
WebGPU and WebXR need; `netlify.toml` sets cache headers.

To deploy by hand instead:

```sh
pnpm build
npx netlify-cli deploy --dir dist            # draft URL, to check on the headset
npx netlify-cli deploy --dir dist --prod
```

## Smoke test

```sh
pnpm smoke "" 12 shot
```

Starts Vite, loads the viewer in headless Chrome with WebGPU, prints the HUD and writes `.smoke/shot.png`.
`scene=<url>` in the query string tests another scene. `SMOKE_EVAL="c.position[2] += 45"` moves the camera first; `SMOKE_DIFF=1` compares two
consecutive frames; `CHROME` overrides the browser path.

## Layout

```
index.html            page shell
src/config.js         all settings (and the two URL overrides)
src/main.js           demo app: backend choice, desktop loop, VR entry, HUD
src/budgetReadout.js  head-locked VR budget readout
src/budgetControl.js  live budget stepping (+/- keys, A/B buttons)
src/scene/            SplatScene (LOD selection, streaming), RangeAllocator, sog.js (SOG/zip loading), ply.js (PLY streaming)
src/xr.js             VR session, thumbstick locomotion, teleport input (both backends)
src/teleport.js       teleport arc and landing ring
src/controls.js       desktop and touch camera
src/math.js           4x4 matrix helpers
src/webgpuHelp.js     how to enable WebGPU, shown when it is unavailable

src/webgpu/           the WebGPU backend
  backend.js            device and canvas setup; what main.js talks to
  SplatRenderer.js      pipelines, per-frame encode
  xr.js                 XRGPUBinding layer
  shaders/*.wgsl        decode (SOG), decode_ply, expand, sort, render, sky, overlay, pick

src/webgl/backend.js  placeholder for the WebGL 2 backend
vite.config.js        dev server (HTTPS, and the /log endpoint for `log: true`)
scripts/              build.mjs (copy to dist/ for publishing), smoke.mjs (headless test)
```

## References

- [SOG format](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/) and
  [Streamed SOG](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/streamed-sog/)
- [WebXR/WebGPU binding explainer](https://github.com/immersive-web/WebXR-WebGPU-Binding/blob/main/explainer.md)
- [quest-webgpu-webxr-experiment](https://github.com/Mandalorian007/quest-webgpu-webxr-experiment) (Quest 3 setup notes)
