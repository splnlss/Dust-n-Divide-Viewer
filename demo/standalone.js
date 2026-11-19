import { FlyControls } from '../src/controls.js';
import { cameraWorld, invert, mat4, multiply, perspective, rotationXYZ, transformDir, transformPoint } from '../src/math.js';
import { closePly, isPlyName, openPly } from '../src/scene/ply.js';
import { SplatScene } from '../src/scene/SplatScene.js';
import { XRViewer, xrSupport } from '../src/xr.js';
import { TeleportAim } from '../src/teleport.js';
import { backendChoice, config, standalone } from '../src/config.js';
import { BudgetControl } from '../src/budgetControl.js';
const SKATEPARK_URL = 'https://code.playcanvas.com/examples_data/example_skatepark_03/lod-meta.json';

const PRESETS = [{ match: /code\.playcanvas\.com\/examples_data\//, rot: [-90, 0, 0] }];
const SKATEPARK = { rot: [-90, 0, 0], pos: [64, 20, 4], lookAt: [0, 0, 0] };
const RONDA = { match: /RondaLobato/i, totalSplats: 8_171_666, pos: [0, 2.8, 12], lookAt: [0, 2.4, 0] };
const deg = Math.PI / 180;
const settings = { ...config, url: config.scene, backend: backendChoice, teleportCancel: config.teleportCancel * deg, bg: config.background };
const budgetControl = new BudgetControl(config.budgetRange, config.budgetStep, config.budget);
const xrBudgetControl = new BudgetControl(config.xrBudgetRange, config.xrBudgetStep, config.xrBudget);
settings.budget = budgetControl.value;
settings.xrBudget = xrBudgetControl.value;
function presetFor(source) {
    if (typeof source !== 'string') return {};
    if (source === SKATEPARK_URL) return SKATEPARK;
    if (RONDA.match.test(source)) return RONDA;
    return PRESETS.find((p) => p.match.test(source)) ?? {};
}
function presetForScene(scene) {
    return scene.totalSplats === RONDA.totalSplats ? RONDA : null;
}

function remoteLog(text) {
    if (settings.log) fetch('/log', { method: 'POST', body: String(text).slice(0, 1900), keepalive: true }).catch(() => {});
}
if (settings.log) {
    addEventListener('error', (e) => remoteLog(`ERROR ${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`));
    addEventListener('unhandledrejection', (e) => remoteLog(`ERROR ${e.reason?.message ?? e.reason}`));
    remoteLog(`PAGE ${navigator.userAgent}`);
}

const canvas = document.getElementById('canvas');
const hud = document.getElementById('hud');
const msg = document.getElementById('msg');
const note = document.getElementById('note');
const vrButton = document.getElementById('vr');
let current = null;

async function openBackend(host) {
    return (await import(`../src/${settings.backend ?? 'webgpu'}/backend.js`)).createBackend(canvas, host);
}

async function start(source) {
    if (current) await current.dispose();
    const run = { alive: true, abort: new AbortController(), cleanup: [] };
    run.dispose = async () => {
        run.alive = false;
        run.abort.abort();
        for (const fn of run.cleanup.splice(0)) await fn();
    };
    current = run;
    hud.textContent = '';
    note.textContent = '';
    msg.textContent = 'Loading…';
    try {
        await main(source, run);
    } catch (err) {
        if (!run.alive) return;
        console.error(err);
        remoteLog(`ERROR ${err?.message ?? err}`);
        if (!run.fatal) msg.textContent = String(err?.message ?? err);
        msg.style.whiteSpace = 'pre-line';
    }
}

async function main(source, run) {
    const signal = run.abort.signal;
    let preset = presetFor(source);
    const rot = settings.rot ?? preset.rot ?? [0, 0, 180];
    const isPly = isPlyName(source instanceof Blob ? source.name : source);
    let memoryReport = () => '';
    const backend = await openBackend({
        standalone,
        log: remoteLog,
        alive: () => run.alive,
        memoryReport: () => memoryReport(),
        fatal: (text) => {
            run.fatal = true;
            msg.textContent = text;
            msg.style.whiteSpace = 'pre-line';
            console.error(text);
            remoteLog(`ERROR ${text}`);
        },
    });
    run.cleanup.push(() => backend.dispose());
    const canvasFormat = backend.canvasFormat;
    let ply = null;
    if (isPly) {
        msg.textContent = 'Reading PLY header…';
        ply = await openPly(source);
        run.cleanup.push(() => closePly(ply));
        if (standalone && ply.count > 2_000_000) {
            note.textContent = `This PLY has ${(ply.count / 1e6).toFixed(1)}M splats with no LOD: expect it to be slow on this device.`;
        }
    }
    const renderer = backend.createRenderer({
        capacity: Math.max(settings.capacity || backend.defaults.capacity, ply?.count ?? 0),
        maxDraw: Math.max(ply?.count ?? 0, Math.ceil(Math.max(budgetControl.max, xrBudgetControl.max) * 1.5)),
        sortBits: settings.sortBits || backend.defaults.sortBits,
        tieBreak: settings.tieBreak,
        f16: settings.f16,
        alphaCut: settings.splatCut / 255,
        maxSigma: settings.maxSigma,
        minOpacity: settings.minOpacity,
        sortSkip: settings.sortSkip,
    });
    await renderer.init([canvasFormat], false);
    const sceneOptions = { budget: settings.budget, lodBase: settings.lodBase, lodMult: settings.lodMult, gazePenalty: settings.gazePenalty };
    let scene;
    if (ply) {
        const t0 = performance.now();
        let shown = 0;
        scene = await SplatScene.loadPly(ply, renderer, sceneOptions, (done, total) => {
            const now = performance.now();
            if (now - shown < 100 && done < total) return;
            shown = now;
            msg.textContent = `Loading ${String(ply.name).split('/').pop()}: ${Math.floor((100 * done) / total)}%  (${(done / 1e6).toFixed(1)}M of ${(total / 1e6).toFixed(1)}M splats)`;
        });
        console.info(`PLY: ${ply.count} splats in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    } else {
        scene = await SplatScene.load(source, renderer, sceneOptions);
    }
    if (!run.alive) return;
    if (scene.antialiased) await renderer.prepare(canvasFormat, true);
    memoryReport = () => {
        const mb = (b) => `${(b / 2 ** 20).toFixed(0)} MB`;
        return (
            `\nallocated by the viewer: ${mb(renderer.allocatedBytes)} (splats in use ${mb(scene.residentSplats * renderer.constructor.bytesPerSplat)}, capacity ${(renderer.capacity / 1e6).toFixed(1)}M, chunks ${scene.loadedFiles}/${scene.fileCount})` +
            `\ncanvas ${canvas.width}x${canvas.height}${xr ? `, in VR: ${xr.surface.size}` : ''}` +
            `\n${navigator.userAgent.match(/(OculusBrowser|Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? ''} ${backend.label} ${backend.info}`
        );
    };
    msg.textContent = '';
    const model = rotationXYZ(mat4(), rot[0] * deg, rot[1] * deg, rot[2] * deg, settings.scale);
    const invModel = invert(mat4(), model);
    const controls = new FlyControls(canvas, { fov: settings.fov * deg, signal });
    if (!preset.pos) preset = { ...preset, ...presetForScene(scene) };
    const focus = transformPoint(model, scene.center);
    const reach = scene.radius * settings.scale * 2.5;
    const elevation = 20 * deg;
    const startPos = preset.pos?.slice() ?? [focus[0], focus[1] + reach * Math.sin(elevation), focus[2] + reach * Math.cos(elevation)];
    const lookAt = preset.pos ? preset.lookAt : focus;
    controls.position = settings.pos?.slice() ?? startPos;
    controls.speed = settings.speed ?? Math.max(0.5, scene.radius * settings.scale * 0.25);
    let startYaw = 0,
        startPitch = 0;
    if (lookAt && !settings.pos) {
        const [px, py, pz] = controls.position,
            [tx, ty, tz] = lookAt;
        startYaw = Math.atan2(-(tx - px), -(tz - pz)) / deg;
        startPitch = Math.atan2(ty - py, Math.hypot(tx - px, tz - pz)) / deg;
    }
    controls.yaw = (settings.yaw ?? startYaw) * deg;
    controls.pitch = (settings.pitch ?? startPitch) * deg;
    const camWorld = mat4();
    const viewMat = mat4();
    const viewMatR = mat4();
    const proj = mat4();
    const tmp = mat4();
    const tmpB = mat4();
    const clearColor = { r: settings.bg[0], g: settings.bg[1], b: settings.bg[2], a: 1 };
    const sky = settings.sky && { zenith: [...settings.sky.zenith, 1], horizon: [...settings.sky.horizon, 1], ground: [...settings.sky.ground, 1] };
    const minTrace = settings.minPixel * settings.minPixel;
    const reveal = settings.reveal && makeReveal(settings.reveal, transformPoint(invModel, controls.position), transformDir(invModel, [0, 1, 0]), settings.scale, scene);
    let xr = null;
    let frames = 0;
    let frameMs = 0;
    let lastHud = performance.now();
    let slowTime = 0;
    let fastTime = 0;
    let lastLog = 0;
    let capture = null;
    function draw(views, format, now, overlay = null, pick = null) {
        let px = 0,
            py = 0,
            pz = 0;
        for (const v of views) {
            const inv = invert(tmp, v.view);
            px += inv[12] / views.length;
            py += inv[13] / views.length;
            pz += inv[14] / views.length;
        }
        const v0 = views[0].view;
        const cam = transformPoint(invModel, [px, py, pz]);
        const fwd = transformDir(invModel, [-v0[2], -v0[6], -v0[10]]);
        scene.update(cam, fwd, now);
        const revealState = reveal?.at(performance.now(), renderer.activeSplats > 0) ?? null;
        renderer.render({ views, model, format, clearColor, near: 0.1, antialiased: scene.antialiased, minTrace, sky, overlay, pick, reveal: revealState });
        frames++;
    }
    function govern(dtMs, targetMs, maxBudget) {
        if (dtMs > targetMs * 1.2) {
            slowTime += dtMs;
            fastTime = 0;
        } else {
            fastTime += dtMs;
            slowTime = Math.max(0, slowTime - dtMs);
        }
        const o = scene.options;
        if (slowTime > 400) {
            o.budget = Math.max(Math.round(maxBudget * 0.6), Math.round(o.budget * 0.85));
            slowTime = 0;
        } else if (fastTime > 4000 && o.budget < maxBudget && scene.loadingFiles === 0) {
            o.budget = Math.min(maxBudget, Math.round(o.budget * 1.1));
            fastTime = 0;
        }
    }
    let resCheck = 0;
    function governResolution(viewer, dtMs, now) {
        if (!viewer.canScaleViewport) return govern(dtMs, 1000 / viewer.frameRate, settings.xrBudget);
        if (now - resCheck < 400) return;
        resCheck = now;
        const interval = 1000 / viewer.frameRate;
        const min = Math.min(1, settings.xrMinScale / settings.xrScale);
        const t = renderer.timings;
        let ratio;
        if (t) {
            ratio = (interval - 3.5) / (t.computeMs + t.drawMs);
        } else {
            ratio = frameMs > interval * 1.15 ? 0.85 : frameMs < interval * 1.03 ? 1.03 : 1;
        }
        if (ratio > 0.95 && ratio < 1.12) return;
        const step = Math.min(1.06, Math.max(0.8, Math.sqrt(ratio)));
        // measured on Quest 3: cutting the splat budget 40% saved only ~8% draw time, so only resolution is scaled
        viewer.viewportScale = Math.min(1, Math.max(min, viewer.viewportScale * step));
    }
    function updateHud(now) {
        if (now - lastHud < 500) return;
        const fps = (frames * 1000) / (now - lastHud);
        frames = 0;
        lastHud = now;
        const m = (n) => (n / 1e6).toFixed(2) + 'M';
        const t = renderer.timings;
        const lines = [
            `${fps.toFixed(0)} fps  ${frameMs.toFixed(1)} ms${xr ? '  (VR)' : ''}`,
            t ? (backend.kind === 'webgpu' ? `gpu  compute ${t.computeMs.toFixed(2)} ms  draw ${t.drawMs.toFixed(2)} ms` : `gpu  draw ${t.drawMs.toFixed(2)} ms`) : null,
            `splats  ${m(renderer.visibleSplats)} ${backend.kind === 'webgpu' ? 'visible' : 'drawn'} / ${m(renderer.activeSplats)} active`,
            scene.isPly ? `budget  all splats (PLY, no LOD)${xr ? `  res ${(settings.xrScale * xr.viewportScale).toFixed(2)}` : ''}` : `budget  ${m(scene.options.budget)}  lod x${scene.lodScale.toFixed(2)}${xr ? `  res ${(settings.xrScale * xr.viewportScale).toFixed(2)}` : ''}`,
            scene.isPly ? `file    ${scene.sourceName}${ply.shBands > 0 ? `  (SH bands 1-${ply.shBands} not rendered)` : ''}` : `chunks  ${scene.loadedFiles}/${scene.fileCount}${scene.loadingFiles ? `  (+${scene.loadingFiles} loading)` : ''}`,
            `gpu mem ${((scene.residentSplats * renderer.constructor.bytesPerSplat) / 2 ** 20).toFixed(0)} MB in use, ${(renderer.allocatedBytes / 2 ** 20).toFixed(0)} MB allocated`,
            `scene   ${m(scene.totalSplats)} splats`,
            `render  ${renderer.info}`,
        ].filter(Boolean);
        hud.textContent = lines.join('\n');
        if (settings.log && now - lastLog > 2000) {
            lastLog = now;
            remoteLog([...lines.slice(0, 4), lines[lines.length - 1]].join(' | '));
        }
    }
    const desktopAim = new TeleportAim(settings.teleportSpeed);
    const teleportGiveUpFrames = 90;
    let teleportClick = null;
    canvas.addEventListener(
        'dblclick',
        (e) => {
            if (!settings.teleport) return;
            const r = canvas.getBoundingClientRect();
            teleportClick = { source: {}, x: e.clientX - r.left, y: e.clientY - r.top, eye: null, dir: null, frames: 0 };
        },
        { signal },
    );
    function desktopTeleport() {
        desktopAim.begin();
        const t = teleportClick;
        if (!t) return;
        if (!t.dir) {
            const ivp = invert(tmp, multiply(tmpB, proj, viewMat));
            const nx = (t.x / canvas.clientWidth) * 2 - 1,
                ny = 1 - (t.y / canvas.clientHeight) * 2;
            const a = transformPoint(ivp, [nx, ny, 0]),
                b = transformPoint(ivp, [nx, ny, 1]);
            const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const l = Math.hypot(...d);
            t.eye = [...controls.position];
            t.dir = [d[0] / l, d[1] / l, d[2] / l];
        }
        const hit = desktopAim.aimRay(t.source, t.eye, t.dir, t.eye);
        desktopAim.overlay.count = 0;
        const result = desktopAim.pick.result;
        const answered = desktopAim.pickSource === t.source && result?.token === desktopAim.pick.token;
        if (hit) controls.position = [hit[0], hit[1] + 1.6, hit[2]];
        if (hit || answered || ++t.frames > teleportGiveUpFrames) teleportClick = null;
    }
    let last = performance.now();
    let wanderHome = null;
    function desktopFrame(now) {
        if (!run.alive) return;
        requestAnimationFrame(desktopFrame);
        if (xr) return;
        const dtMs = now - last;
        last = now;
        frameMs += (dtMs - frameMs) * 0.1;
        controls.update(Math.min(dtMs / 1000, 0.1));
        const k = controls.keys;
        const dir = k.has('Equal') || k.has('NumpadAdd') ? 1 : k.has('Minus') || k.has('NumpadSubtract') ? -1 : 0;
        if (budgetControl.update(dir, now)) settings.budget = scene.options.budget = budgetControl.value;
        if (settings.wander) {
            wanderHome ??= [...controls.position];
            const t = now / 1000;
            controls.position[0] = wanderHome[0] + Math.sin(t * 1.3) * settings.wander;
            controls.position[2] = wanderHome[2] + Math.sin(t * 0.9) * settings.wander;
        }
        if (settings.auto === 'all') govern(dtMs, 1000 / 60, settings.budget);
        const dpr = Math.min(devicePixelRatio, settings.maxDpr);
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const target = backend.canvasTarget();
        invert(viewMat, cameraWorld(camWorld, controls.position, controls.yaw, controls.pitch));
        const views = [];
        if (settings.stereo) {
            const half = w >> 1;
            perspective(proj, settings.fov * deg, half / h, 0.05, 1000);
            const ipd = 0.064;
            viewMatR.set(viewMat);
            for (let eye = 0; eye < 2; eye++) {
                const m = eye === 0 ? viewMat : viewMatR;
                m[12] += eye === 0 ? ipd / 2 : -ipd / 2;
                views.push({ view: m, proj, target, viewport: [eye * half, 0, half, h], clear: eye === 0 });
            }
        } else {
            perspective(proj, settings.fov * deg, w / h, 0.05, 1000);
            views.push({ view: viewMat, proj, target, viewport: [0, 0, w, h] });
        }
        if (!settings.stereo) desktopTeleport();
        draw(views, canvasFormat, now, desktopAim.overlay, desktopAim.pick);
        updateHud(now);
        if (capture) {
            // the canvas can only be read back in the frame it was drawn
            capture(canvas.toDataURL('image/png'));
            capture = null;
        }
    }
    requestAnimationFrame(desktopFrame);
    Object.assign(window, {
        __capture: () =>
            new Promise((resolve) => {
                capture = resolve;
            }),
        __controls: controls,
        __renderer: renderer,
        __backend: backend.kind,
        __scene: scene,
    });
    Object.defineProperty(window, '__xr', { get: () => xr, configurable: true });
    run.cleanup.push(async () => {
        if (xr) await xr.session.end().catch(() => {});
        vrButton.textContent = 'Enter VR';
        vrButton.disabled = true;
    });
    let support = await xrSupport();
    if (support === 'ok') support = await backend.xr.support();
    if (!run.alive) return;
    if (support === 'ok') {
        vrButton.disabled = false;
    } else {
        note.textContent = support === 'no-binding' ? 'VR with WebGPU needs WebGPU in WebXR. In Quest Browser 146+, open chrome://flags, enable "WebXR experimental features", then relaunch the browser.' : support === 'no-vr' ? 'No VR headset available to this browser.' : '';
    }
    vrButton.addEventListener(
        'click',
        async () => {
            if (xr) {
                void xr.session.end();
                return;
            }
            vrButton.disabled = true;
            try {
                const viewer = await XRViewer.start(backend.xr, {
                    scaleFactor: settings.xrScale,
                    foveation: settings.foveation,
                    frameRate: settings.xrFrameRate || undefined,
                    budgetReadout: settings.xrBudgetReadout.show ? settings.xrBudgetReadout : null,
                    startPosition: [...controls.position],
                    startYaw: controls.yaw,
                    moveSpeed: settings.xrSpeed,
                    smoothTurn: settings.smoothTurn,
                    teleport: settings.teleport,
                    teleportSpeed: settings.teleportSpeed,
                    teleportCancel: settings.teleportCancel,
                });
                await renderer.prepare(viewer.format, scene.antialiased);
                remoteLog(`XR session started: format ${viewer.format}, ${viewer.frameRate} Hz`);
                scene.options.budget = settings.xrBudget;
                xr = viewer;
                vrButton.textContent = 'Exit VR';
                viewer.onEnd = () => {
                    xr = null;
                    scene.options.budget = settings.budget;
                    vrButton.textContent = 'Enter VR';
                    last = performance.now();
                };
                viewer.run((f) => {
                    if (!run.alive) return;
                    if (f.dt > 0) {
                        frameMs += (f.dt * 1000 - frameMs) * 0.1;
                        if (settings.auto !== 'off') governResolution(viewer, f.dt * 1000, f.time);
                    }
                    if (xrBudgetControl.update(viewer.budgetDir, f.time)) {
                        settings.xrBudget = scene.options.budget = xrBudgetControl.value;
                        viewer.pulse();
                    }
                    viewer.budget = scene.options.budget;
                    draw(f.views, f.format, f.time, f.overlay, f.pick);
                    updateHud(performance.now());
                });
            } catch (err) {
                note.textContent = `Could not start VR: ${err.message}`;
                remoteLog(`ERROR could not start VR: ${err.message}`);
            } finally {
                vrButton.disabled = !run.alive;
            }
        },
        { signal },
    );
}
function makeReveal({ speed, acceleration, lift }, center, up, metersPerUnit, scene) {
    let farthest = 0;
    for (let corner = 0; corner < 8; corner++) {
        const p = [0, 1, 2].map((i) => ((corner >> i) & 1 ? scene.boundsMax[i] : scene.boundsMin[i]));
        farthest = Math.max(farthest, Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]));
    }
    const endMeters = farthest * metersPerUnit + 2;
    let startMs = null;
    let done = false;
    const state = { center, up, metersPerUnit, lift, front: -1, time: 0 };
    return {
        at(nowMs, hasSplats) {
            if (done) return null;
            if (startMs === null) {
                if (!hasSplats) return state;
                startMs = nowMs;
            }
            const t = (nowMs - startMs) / 1000;
            state.time = t;
            state.front = speed * t + 0.5 * acceleration * t * t;
            if (state.front > endMeters) done = true;
            return done ? null : state;
        },
    };
}

const dropHint = document.getElementById('drop');
let dragDepth = 0;
addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (dragDepth++ === 0) dropHint.hidden = false;
});
addEventListener('dragleave', () => {
    if (--dragDepth === 0) dropHint.hidden = true;
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropHint.hidden = true;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.(ply|sog)$/i.test(file.name)) {
        note.textContent = `Cannot open ${file.name}: drop a .ply or .sog file (a streamed SOG is a folder; open its lod-meta.json by URL).`;
        return;
    }
    start(file);
});

start(settings.url);
