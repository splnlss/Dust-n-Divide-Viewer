import { BoxGeometry, Color, DirectionalLight, Group, HemisphereLight, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster, Scene, SRGBColorSpace, TorusKnotGeometry, Vector2, Vector3 } from 'three/webgpu';
import { mix, positionWorldDirection, select, smoothstep, vec3 } from 'three/tsl';
import { FlyControls } from './controls.js';
import { BudgetControl } from './budgetControl.js';
import { config, standalone } from './config.js';
import { GaussianSplats, createWebGPURenderer } from './three/GaussianSplats.js';
import { XRNavigation, applyFlyControls } from './three/navigation.js';
import { isPlyName } from './scene/ply.js';

const SKATEPARK_URL = 'https://code.playcanvas.com/examples_data/example_skatepark_03/lod-meta.json';
const PRESETS = [{ match: /code\.playcanvas\.com\/examples_data\//, rot: [-90, 0, 0] }];
const SKATEPARK = { rot: [-90, 0, 0], pos: [64, 20, 4], lookAt: [0, 0, 0] };
const RONDA = { match: /RondaLobato/i, totalSplats: 8_171_666, pos: [0, 2.8, 12], lookAt: [0, 2.4, 0] };
const EYE_HEIGHT = 1.6;
const deg = Math.PI / 180;

const settings = { ...config, teleportCancel: config.teleportCancel * deg };
const budgetControl = new BudgetControl(config.budgetRange, config.budgetStep, config.budget);
const xrBudgetControl = new BudgetControl(config.xrBudgetRange, config.xrBudgetStep, config.xrBudget);

function presetFor(source) {
    if (typeof source !== 'string') return {};
    if (source === SKATEPARK_URL) return SKATEPARK;
    if (RONDA.match.test(source)) return RONDA;
    return PRESETS.find((p) => p.match.test(source)) ?? {};
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
const dropHint = document.getElementById('drop');

function skyNode({ zenith, horizon, ground }) {
    const e = positionWorldDirection.y;
    const up = mix(vec3(...horizon), vec3(...zenith), e.max(0).pow(0.55));
    const down = mix(vec3(...horizon), vec3(...ground), smoothstep(0, 0.25, e.negate()));
    return select(e.greaterThanEqual(0), up, down).pow(2.2);
}

function showError(err) {
    console.error(err);
    remoteLog(`ERROR ${err?.message ?? err}`);
    msg.textContent = String(err?.message ?? err);
    msg.style.whiteSpace = 'pre-line';
}

async function main() {
    const renderer = await createWebGPURenderer({ canvas });
    renderer.setPixelRatio(Math.min(devicePixelRatio, settings.maxDpr));
    renderer.setSize(innerWidth, innerHeight, false);
    renderer.xr.enabled = true;

    const scene = new Scene();
    if (settings.sky) scene.backgroundNode = skyNode(settings.sky);
    else scene.background = new Color().setRGB(...settings.background, SRGBColorSpace);

    const camera = new PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.05, 1000);
    const rig = new Group();
    rig.add(camera);
    scene.add(rig);

    const controls = new FlyControls(canvas, { fov: settings.fov * deg });
    const nav = new XRNavigation(renderer, rig, {
        moveSpeed: settings.xrSpeed,
        smoothTurn: settings.smoothTurn,
        teleport: settings.teleport,
        teleportSpeed: settings.teleportSpeed,
        teleportCancel: settings.teleportCancel,
        budgetReadout: settings.xrBudgetReadout.show ? settings.xrBudgetReadout : null,
        frameRate: settings.xrFrameRate || undefined,
        startPosition: [0, 0, 0],
        startYaw: 0,
    });
    scene.add(nav.overlay);

    const testObjects = [];
    let knot = null;
    if (settings.testObjects) {
        const sun = new DirectionalLight(0xffffff, 2);
        sun.position.set(3, 6, 4);
        scene.add(new HemisphereLight(0xffffff, 0x444455, 2), sun);
        const box = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0xd04040 }));
        box.position.set(-1.5, 2, 6);
        knot = new Mesh(new TorusKnotGeometry(0.4, 0.14, 128, 16), new MeshStandardMaterial({ color: 0x40a0e0, metalness: 0.3, roughness: 0.4 }));
        knot.position.set(1.5, 2.2, 3);
        scene.add(box, knot);
        testObjects.push(box, knot);
    }

    let current = null;

    async function open(source) {
        if (current) {
            scene.remove(current);
            current.dispose();
            current = null;
        }
        hud.textContent = '';
        note.textContent = '';
        msg.textContent = 'Loading…';
        const name = source instanceof Blob ? source.name : source;
        const splats = new GaussianSplats(renderer, {
            budget: renderer.xr.isPresenting ? xrBudgetControl.value : budgetControl.value,
            maxBudget: Math.max(budgetControl.max, xrBudgetControl.max),
            onProgress: (done, total) => {
                msg.textContent = `Loading ${String(name).split('/').pop()}: ${Math.floor((100 * done) / total)}%  (${(done / 1e6).toFixed(1)}M of ${(total / 1e6).toFixed(1)}M splats)`;
            },
        });
        const opening = splats;
        current = splats;
        if (isPlyName(name)) msg.textContent = 'Reading PLY header…';
        await splats.load(source);
        if (current !== opening) return splats.dispose();
        let preset = presetFor(source);
        const rot = settings.rot ?? preset.rot ?? [0, 0, 180];
        splats.rotation.set(rot[0] * deg, rot[1] * deg, rot[2] * deg, 'ZYX');
        splats.scale.setScalar(settings.scale);
        scene.add(splats);
        splats.updateMatrixWorld();
        const s = splats.scene;
        if (!preset.pos && s.totalSplats === RONDA.totalSplats) preset = { ...preset, ...RONDA };
        const focus = splats.localToWorld(new Vector3(...s.center)).toArray();
        const reach = s.radius * settings.scale * 2.5;
        const elevation = 20 * deg;
        const startPos = preset.pos?.slice() ?? [focus[0], focus[1] + reach * Math.sin(elevation), focus[2] + reach * Math.cos(elevation)];
        const lookAt = preset.pos ? preset.lookAt : focus;
        controls.position = settings.pos?.slice() ?? startPos;
        controls.speed = settings.speed ?? Math.max(0.5, s.radius * settings.scale * 0.25);
        let yaw = 0,
            pitch = 0;
        if (lookAt && !settings.pos) {
            const [px, py, pz] = controls.position,
                [tx, ty, tz] = lookAt;
            yaw = Math.atan2(-(tx - px), -(tz - pz)) / deg;
            pitch = Math.atan2(ty - py, Math.hypot(tx - px, tz - pz)) / deg;
        }
        controls.yaw = (settings.yaw ?? yaw) * deg;
        controls.pitch = (settings.pitch ?? pitch) * deg;
        if (s.isPly && standalone && s.totalSplats > 2_000_000) {
            note.textContent = `This PLY has ${(s.totalSplats / 1e6).toFixed(1)}M splats with no LOD: expect it to be slow on this device.`;
        }
        msg.textContent = '';
    }

    function openSafely(source) {
        open(source).catch(showError);
    }

    const raycaster = new Raycaster();
    canvas.addEventListener('dblclick', async (e) => {
        if (!settings.teleport || !current) return;
        const r = canvas.getBoundingClientRect();
        raycaster.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
        const meshHit = raycaster.intersectObjects(testObjects)[0]?.point ?? null;
        const splatHit = await current.hitTest(raycaster.ray);
        const distance = (p) => (p ? p.distanceTo(raycaster.ray.origin) : Infinity);
        const hit = distance(meshHit) < distance(splatHit) ? meshHit : splatHit;
        if (hit) controls.position = [hit.x, hit.y + EYE_HEIGHT, hit.z];
    });

    addEventListener('resize', () => {
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(innerWidth, innerHeight, false);
    });

    renderer.xr.addEventListener('sessionstart', () => {
        nav.opts.startPosition = [...controls.position];
        nav.opts.startYaw = controls.yaw;
        if (current) current.budget = xrBudgetControl.value;
        vrButton.textContent = 'Exit VR';
        remoteLog('XR session started');
    });
    renderer.xr.addEventListener('sessionend', () => {
        rig.position.set(0, 0, 0);
        rig.rotation.set(0, 0, 0);
        if (current) current.budget = budgetControl.value;
        vrButton.textContent = 'Enter VR';
        last = performance.now();
    });
    if (!(await navigator.xr?.isSessionSupported('immersive-vr').catch(() => false))) {
        note.textContent = 'No VR headset available to this browser.';
    } else if (typeof XRGPUBinding === 'undefined') {
        note.textContent = 'VR with WebGPU needs WebGPU in WebXR. In Quest Browser 146+, open chrome://flags, enable "WebXR experimental features", then relaunch the browser.';
    } else {
        vrButton.disabled = false;
    }
    vrButton.addEventListener('click', async () => {
        const session = renderer.xr.getSession();
        if (session) return void session.end();
        vrButton.disabled = true;
        try {
            await renderer.xr.setSession(await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['webgpu'], optionalFeatures: ['local-floor'] }));
        } catch (err) {
            note.textContent = `Could not start VR: ${err.message}`;
            remoteLog(`ERROR could not start VR: ${err.message}`);
        } finally {
            vrButton.disabled = false;
        }
    });

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
        openSafely(file);
    });

    let last = performance.now();
    let frames = 0;
    let frameMs = 0;
    let lastHud = performance.now();
    let lastLog = 0;
    let capture = null;

    function updateHud(now) {
        if (now - lastHud < 500) return;
        const fps = (frames * 1000) / (now - lastHud);
        frames = 0;
        lastHud = now;
        const splats = current?.scene ? current : null;
        if (!splats) return;
        const r = splats.splatRenderer;
        const s = splats.scene;
        const m = (n) => (n / 1e6).toFixed(2) + 'M';
        const xr = renderer.xr.isPresenting;
        const lines = [
            `${fps.toFixed(0)} fps  ${frameMs.toFixed(1)} ms${xr ? '  (VR)' : ''}`,
            r.timings ? `gpu  sort ${r.timings.computeMs.toFixed(2)} ms` : null,
            `splats  ${m(r.visibleSplats)} visible / ${m(r.activeSplats)} active`,
            s.isPly ? 'budget  all splats (PLY, no LOD)' : `budget  ${m(s.options.budget)}  lod x${s.lodScale.toFixed(2)}`,
            s.isPly ? `file    ${s.sourceName}` : `chunks  ${s.loadedFiles}/${s.fileCount}${s.loadingFiles ? `  (+${s.loadingFiles} loading)` : ''}`,
            `gpu mem ${((s.residentSplats * r.constructor.bytesPerSplat) / 2 ** 20).toFixed(0)} MB in use, ${(r.allocatedBytes / 2 ** 20).toFixed(0)} MB allocated`,
            `scene   ${m(s.totalSplats)} splats`,
            'render  three.js WebGPU',
        ].filter(Boolean);
        hud.textContent = lines.join('\n');
        if (settings.log && now - lastLog > 2000) {
            lastLog = now;
            remoteLog(lines.slice(0, 4).join(' | '));
        }
    }

    renderer.setAnimationLoop(() => {
        const now = performance.now();
        if (knot) knot.rotation.y = now / 1000;
        const dtMs = now - last;
        last = now;
        frameMs += (dtMs - frameMs) * 0.1;
        const splats = current?.scene ? current : null;
        if (renderer.xr.isPresenting) {
            nav.update(Math.min(dtMs / 1000, 0.1));
            if (splats && xrBudgetControl.update(nav.budgetDir, now)) {
                splats.budget = xrBudgetControl.value;
                nav.pulse();
            }
            nav.budget = splats?.budget ?? 0;
            if (splats) splats.pick = nav.aim.pick;
        } else {
            controls.update(Math.min(dtMs / 1000, 0.1));
            const k = controls.keys;
            const dir = k.has('Equal') || k.has('NumpadAdd') ? 1 : k.has('Minus') || k.has('NumpadSubtract') ? -1 : 0;
            if (splats && budgetControl.update(dir, now)) splats.budget = budgetControl.value;
            applyFlyControls(camera, controls);
            nav.overlay.visible = false;
            if (splats) splats.pick = null;
        }
        renderer.render(scene, camera);
        frames++;
        updateHud(now);
        if (capture) {
            // the canvas can only be read back in the frame it was drawn
            capture(canvas.toDataURL('image/png'));
            capture = null;
        }
    });

    Object.assign(window, {
        __capture: () =>
            new Promise((resolve) => {
                capture = resolve;
            }),
        __controls: controls,
        __renderer: renderer,
        __scene: scene,
        __camera: camera,
        __nav: nav,
    });
    Object.defineProperty(window, '__splats', { get: () => current, configurable: true });

    openSafely(settings.scene);
}

main().catch(showError);
