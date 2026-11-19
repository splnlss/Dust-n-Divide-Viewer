import { Object3D, Vector2, Vector3, WebGPURenderer } from 'three/webgpu';
import { invert, mat4, transformDir, transformPoint } from '../math.js';
import { closePly, isPlyName, openPly } from '../scene/ply.js';
import { SplatScene } from '../scene/SplatScene.js';
import { SplatRenderer } from '../webgpu/SplatRenderer.js';
import { standalone } from '../platform.js';
import { enableWebGpuHelp } from '../webgpuHelp.js';

const DEFAULTS = {
    budget: standalone ? 1_000_000 : 3_000_000,
    capacity: standalone ? 4_000_000 : 12_000_000,
    sortBits: standalone ? 18 : 20,
    lodBase: 5,
    lodMult: 3,
    gazePenalty: 3,
    minPixel: standalone ? 1 : 0.2,
    maxSigma: 1.7,
    minOpacity: 0.05,
    f16: true,
    tieBreak: standalone ? 0 : 32,
    sortSkip: standalone ? 1 : 0,
};

export async function createWebGPURenderer(parameters = {}) {
    if (!navigator.gpu) throw new Error(enableWebGpuHelp);
    const base = { powerPreference: 'high-performance' };
    const adapter = (await navigator.gpu.requestAdapter({ ...base, xrCompatible: true })) ?? (await navigator.gpu.requestAdapter(base));
    if (!adapter) throw new Error(`No WebGPU adapter found.\n\n${enableWebGpuHelp}`);
    const splatNeeds = SplatRenderer.deviceDescriptor(adapter);
    const device = await adapter.requestDevice({
        requiredFeatures: [...adapter.features],
        requiredLimits: { ...parameters.requiredLimits, ...splatNeeds.requiredLimits },
    });
    const renderer = new WebGPURenderer({ antialias: false, ...parameters, device });
    await renderer.init();
    if (!renderer.backend.isWebGPUBackend) throw new Error(enableWebGpuHelp);
    return renderer;
}

export class GaussianSplats extends Object3D {
    isGaussianSplats = true;
    scene = null;
    splatRenderer = null;
    #three;
    #options;
    #ply = null;
    #invModel = mat4();
    #views = [{ view: null, proj: null, target: null, viewport: [0, 0, 1, 1], clear: false }];
    #depth = { view: null, format: '', compare: 'less-equal' };
    #depthTexture = null;
    #size = new Vector2();
    #preparing = null;
    #warnedXr = false;

    constructor(renderer, options = {}) {
        super();
        if (!renderer.backend?.isWebGPUBackend) throw new Error('GaussianSplats needs a WebGPURenderer running on WebGPU; create it with createWebGPURenderer().');
        if (renderer.samples > 0) throw new Error('GaussianSplats needs the renderer created with antialias: false.');
        if (renderer.logarithmicDepthBuffer) throw new Error('GaussianSplats does not support logarithmicDepthBuffer.');
        this.#three = renderer;
        this.#options = { ...DEFAULTS, ...options };
        this.rotation.set(0, 0, Math.PI);
    }

    get budget() {
        return this.scene?.options.budget ?? this.#options.budget;
    }
    set budget(splats) {
        this.#options.budget = splats;
        if (this.scene) this.scene.options.budget = splats;
    }

    async load(source) {
        const o = this.#options;
        const device = this.#three.backend.device;
        const isPly = isPlyName(source instanceof Blob ? source.name : source);
        if (isPly) this.#ply = await openPly(source);
        const renderer = new SplatRenderer(device, {
            capacity: Math.max(o.capacity, this.#ply?.count ?? 0),
            maxDraw: Math.max(this.#ply?.count ?? 0, Math.ceil(o.budget * 1.5)),
            sortBits: o.sortBits,
            tieBreak: o.tieBreak,
            f16: o.f16,
            maxSigma: o.maxSigma,
            minOpacity: o.minOpacity,
            sortSkip: o.sortSkip,
        });
        await renderer.init([], false);
        const sceneOptions = { budget: o.budget, lodBase: o.lodBase, lodMult: o.lodMult, gazePenalty: o.gazePenalty };
        this.scene = this.#ply ? await SplatScene.loadPly(this.#ply, renderer, sceneOptions, o.onProgress) : await SplatScene.load(source, renderer, sceneOptions);
        this.splatRenderer = renderer;
        return this;
    }

    render(camera) {
        const three = this.#three;
        const renderer = this.splatRenderer;
        if (!renderer) return;
        if (three.xr.isPresenting) {
            if (!this.#warnedXr) console.warn('GaussianSplats does not render in WebXR yet.');
            this.#warnedXr = true;
            return;
        }
        const depth = this.#currentDepth();
        const format = three.backend.utils.getPreferredCanvasFormat();
        const antialiased = this.scene.antialiased;
        if (!renderer.isPrepared(format, antialiased, depth)) {
            this.#preparing ??= renderer.prepare(format, antialiased, depth).finally(() => (this.#preparing = null));
            return;
        }
        this.updateWorldMatrix(true, false);
        const model = this.matrixWorld.elements;
        const view = camera.matrixWorldInverse.elements;
        invert(this.#invModel, model);
        const cam = transformPoint(this.#invModel, [camera.matrixWorld.elements[12], camera.matrixWorld.elements[13], camera.matrixWorld.elements[14]]);
        const fwd = transformDir(this.#invModel, [-view[2], -view[6], -view[10]]);
        const now = performance.now();
        this.scene.update(cam, fwd, now);
        const v = this.#views[0];
        v.view = view;
        v.proj = camera.projectionMatrix.elements;
        v.target = three.backend.context.getCurrentTexture().createView();
        const size = three.getDrawingBufferSize(this.#size);
        v.viewport[2] = size.width;
        v.viewport[3] = size.height;
        renderer.render({ views: this.#views, model, format, near: camera.near, antialiased, minTrace: this.#options.minPixel ** 2, depth });
    }

    async hitTest(ray, maxDistance = 300) {
        if (!this.splatRenderer) return null;
        const o = ray.origin,
            d = ray.direction;
        const h = Math.hypot(d.x, d.z);
        if (h < 0.02) return null;
        const pick = { start: [o.x, o.y, o.z], dir: [d.x / h, d.z / h], slope: d.y / h, curve: 0, maxU: maxDistance * h };
        const u = await this.splatRenderer.hitTest(pick);
        return u === null ? null : new Vector3(o.x + pick.dir[0] * u, o.y + pick.slope * u, o.z + pick.dir[1] * u);
    }

    dispose() {
        if (this.#ply) closePly(this.#ply);
        this.#ply = null;
        this.splatRenderer?.destroy();
        this.splatRenderer = null;
        this.scene = null;
    }

    #currentDepth() {
        const three = this.#three;
        if (!three.depth) return null;
        const target = three._getFrameBufferTarget();
        const depthTexture = target ? three._textures.get(target).depthTexture : three.getCanvasTarget().depthTexture;
        const gpuTexture = depthTexture && three.backend.get(depthTexture).texture;
        if (!gpuTexture) return null;
        if (gpuTexture !== this.#depthTexture) {
            this.#depthTexture = gpuTexture;
            this.#depth.view = gpuTexture.createView();
            this.#depth.format = gpuTexture.format;
            this.#depth.compare = three.reversedDepthBuffer ? 'greater-equal' : 'less-equal';
        }
        return this.#depth;
    }
}
