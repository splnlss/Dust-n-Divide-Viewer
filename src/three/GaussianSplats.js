import { BufferAttribute, BufferGeometry, CustomBlending, IndirectStorageBufferAttribute, Mesh, NodeMaterial, OneFactor, OneMinusSrcAlphaFactor, StorageBufferAttribute, Vector2, Vector3, WebGPURenderer } from 'three/webgpu';
import { cameraProjectionMatrix, modelViewMatrix, storage, uniform, varying, vec4, vertexIndex, wgslFn } from 'three/tsl';
import { invert, mat4, transformDir, transformPoint } from '../math.js';
import { closePly, isPlyName, openPly } from '../scene/ply.js';
import { SplatScene } from '../scene/SplatScene.js';
import { SplatRenderer } from '../webgpu/SplatRenderer.js';
import { standalone } from '../platform.js';
import { enableWebGpuHelp } from '../webgpuHelp.js';

const DEFAULTS = {
    budget: standalone ? 1_000_000 : 3_000_000,
    capacity: standalone ? 8_000_000 : 12_000_000,
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

const splatVertex = (maxR2, alphaCut, antialiased) =>
    wgslFn(`
fn splatVertex(a: vec4f, b: vec4<u32>, vidx: u32, modelView: mat4x4f, proj: mat4x4f, viewport: vec2f, params: vec4f) -> mat4x4f {
  let MAX_R2 = ${maxR2.toFixed(6)};
  let ALPHA_CUT = ${alphaCut.toFixed(8)};
  let LOWPASS = 0.3;
  let near = params.x;
  let minTrace = params.y;
  let maxExtent = params.z;
  let culled = mat4x4f(vec4f(0.0, 0.0, 2.0, 1.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
  let vi = vidx & 3u;
  let vp = (modelView * vec4f(a.xyz, 1.0)).xyz;
  let depth = -vp.z;
  if (depth < near) { return culled; }
  var col = unpack4x8unorm(bitcast<u32>(a.w));
  if (col.a < ALPHA_CUT) { return culled; }
  let c0 = unpack2x16float(b.x);
  let c1 = unpack2x16float(b.y);
  let c2 = unpack2x16float(b.z);
  let scale = bitcast<f32>(b.w);
  let S = mat3x3f(c0.x, c0.y, c1.x, c0.y, c1.y, c2.x, c1.x, c2.x, c2.y);
  let focal = 0.5 * viewport * vec2f(proj[0].x, proj[1].y);
  let r0 = vec3f(modelView[0].x, modelView[1].x, modelView[2].x);
  let r1 = vec3f(modelView[0].y, modelView[1].y, modelView[2].y);
  let r2 = vec3f(modelView[0].z, modelView[1].z, modelView[2].z);
  let iz = 1.0 / depth;
  let t0 = focal.x * iz * (r0 + (vp.x * iz) * r2);
  let t1 = focal.y * iz * (r1 + (vp.y * iz) * r2);
  let St0 = S * t0;
  let St1 = S * t1;
  var ca = dot(t0, St0) * scale;
  let cb = dot(t0, St1) * scale;
  var cc = dot(t1, St1) * scale;
  if (ca + cc < minTrace) { return culled; }
  if (${antialiased}) {
    let detOrig = ca * cc - cb * cb;
    let detBlur = (ca + LOWPASS) * (cc + LOWPASS) - cb * cb;
    col.a *= sqrt(max(detOrig / detBlur, 0.0));
  }
  ca += LOWPASS;
  cc += LOWPASS;
  let mid = 0.5 * (ca + cc);
  let rad = length(vec2f(0.5 * (ca - cc), cb));
  let l1 = mid + rad;
  let l2 = max(mid - rad, 0.1);
  var ax = vec2f(cb, l1 - ca);
  let axl = dot(ax, ax);
  ax = select(vec2f(1.0, 0.0), ax * inverseSqrt(axl), axl > 1e-12);
  let kc = exp(-0.5 * MAX_R2);
  let kEdge = kc + ALPHA_CUT * (1.0 - kc) / col.a;
  let r = sqrt(clamp(-2.0 * log(min(kEdge, 1.0)), 0.0, MAX_R2));
  let e1 = min(r * sqrt(l1), maxExtent);
  let e2 = min(r * sqrt(l2), maxExtent);
  let clip = proj * vec4f(vp, 1.0);
  let pxToClip = 2.0 / viewport * clip.w;
  if (any(abs(clip.xy) > vec2f(clip.w) + max(e1, e2) * pxToClip)) { return culled; }
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  let off = corner.x * e1 * ax + corner.y * e2 * vec2f(-ax.y, ax.x);
  let linear = select(pow((col.rgb + 0.055) / 1.055, vec3f(2.4)), col.rgb / 12.92, col.rgb <= vec3f(0.04045));
  let pos = vec4f(clip.xy + off * pxToClip, clamp(clip.z, 0.0, clip.w), clip.w);
  return mat4x4f(pos, vec4f(corner * r, 0.0, 0.0), vec4f(linear, col.a), vec4f(0.0));
}`);

const splatFragment = (maxR2, alphaCut) =>
    wgslFn(`
fn splatFragment(q: vec2f, color: vec4f) -> vec4f {
  let kc = exp(-0.5 * ${maxR2.toFixed(6)});
  let a = color.a * (exp(-0.5 * dot(q, q)) - kc) / (1.0 - kc);
  if (a < ${alphaCut.toFixed(8)}) { discard; }
  return vec4f(color.rgb * a, a);
}`);

function borrowedAttribute(three, attribute, gpuBuffer) {
    three.backend.get(attribute).buffer = gpuBuffer;
    return attribute;
}

export class GaussianSplats extends Mesh {
    isGaussianSplats = true;
    scene = null;
    splatRenderer = null;
    pick = null;
    #three;
    #options;
    #ply = null;
    #invModel = mat4();
    #eyeWorld = mat4();
    #views = [];
    #size = new Vector2();
    #viewport = uniform(new Vector2(1, 1));
    #params = uniform(new Vector3(0.05, 0.04, 1024));
    #lastFrame = -1;

    constructor(renderer, options = {}) {
        super(new BufferGeometry(), new NodeMaterial());
        if (!renderer.backend?.isWebGPUBackend) throw new Error('GaussianSplats needs a WebGPURenderer running on WebGPU; create it with createWebGPURenderer().');
        if (renderer.logarithmicDepthBuffer) throw new Error('GaussianSplats does not support logarithmicDepthBuffer.');
        this.#three = renderer;
        this.#options = { ...DEFAULTS, ...options };
        this.rotation.set(0, 0, Math.PI);
        this.frustumCulled = false;
        this.visible = false;
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
        const three = this.#three;
        const isPly = isPlyName(source instanceof Blob ? source.name : source);
        if (isPly) this.#ply = await openPly(source);
        const renderer = new SplatRenderer(three.backend.device, {
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
        this.#buildMesh(renderer);
        this.visible = true;
        return this;
    }

    #buildMesh(renderer) {
        const three = this.#three;
        const order = storage(borrowedAttribute(three, new StorageBufferAttribute(new Uint32Array(4), 1), renderer.order), 'uint', renderer.maxDraw).toReadOnly();
        const splatA = storage(borrowedAttribute(three, new StorageBufferAttribute(new Float32Array(4), 4), renderer.splatA), 'vec4', renderer.capacity).toReadOnly();
        const splatB = storage(borrowedAttribute(three, new StorageBufferAttribute(new Uint32Array(4), 4), renderer.splatB), 'uvec4', renderer.capacity).toReadOnly();
        const geometry = new BufferGeometry();
        geometry.setIndex(borrowedAttribute(three, new BufferAttribute(new Uint32Array(6), 1), renderer.indexBuffer));
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(3), 3));
        const indirect = borrowedAttribute(three, new IndirectStorageBufferAttribute(new Uint32Array(8), 1), renderer.drawArgs);
        geometry.setIndirect(
            indirect,
            Array.from({ length: renderer.drawBatches }, (_, k) => 32 + 20 * k),
        );
        const maxR2 = renderer.maxSigma * renderer.maxSigma;
        const id = order.element(vertexIndex.shiftRight(2));
        const packed = splatVertex(
            maxR2,
            renderer.alphaCut,
            this.scene.antialiased,
        )({
            a: splatA.element(id),
            b: splatB.element(id),
            vidx: vertexIndex,
            modelView: modelViewMatrix,
            proj: cameraProjectionMatrix,
            viewport: this.#viewport,
            params: vec4(this.#params, 0),
        });
        const material = new NodeMaterial();
        material.vertexNode = packed.element(0);
        material.fragmentNode = splatFragment(maxR2, renderer.alphaCut)({ q: varying(packed.element(1).xy), color: varying(packed.element(2)) });
        material.transparent = true;
        material.depthWrite = false;
        material.depthTest = true;
        material.blending = CustomBlending;
        material.blendSrc = OneFactor;
        material.blendDst = OneMinusSrcAlphaFactor;
        material.blendSrcAlpha = OneFactor;
        material.blendDstAlpha = OneMinusSrcAlphaFactor;
        this.geometry.dispose();
        this.geometry = geometry;
        this.material.dispose();
        this.material = material;
    }

    onBeforeRender(three, scene, camera) {
        const renderer = this.splatRenderer;
        if (!renderer) return;
        const frame = three.info.calls;
        if (frame === this.#lastFrame) return;
        this.#lastFrame = frame;
        const cameras = three.xr.isPresenting ? three.xr.getCamera().cameras : [camera];
        const views = this.#views;
        views.length = cameras.length;
        for (let i = 0; i < cameras.length; i++) {
            const c = cameras[i];
            const v = (views[i] ??= { viewport: [0, 0, 1, 1] });
            v.view = c.matrixWorldInverse.elements;
            v.proj = c.projectionMatrix.elements;
        }
        if (three.xr.isPresenting) this.#size.set(cameras[0].viewport.z, cameras[0].viewport.w);
        else three.getDrawingBufferSize(this.#size);
        this.#viewport.value.copy(this.#size);
        const near = three.xr.isPresenting ? three.xr.getCamera().near : camera.near;
        this.#params.value.set(near, this.#options.minPixel ** 2, Math.min(1024, this.#size.x, this.#size.y));
        this.updateWorldMatrix(true, false);
        const model = this.matrixWorld.elements;
        invert(this.#invModel, model);
        let x = 0,
            y = 0,
            z = 0;
        for (const v of views) {
            invert(this.#eyeWorld, v.view);
            x += this.#eyeWorld[12] / views.length;
            y += this.#eyeWorld[13] / views.length;
            z += this.#eyeWorld[14] / views.length;
        }
        const view = views[0].view;
        this.scene.update(transformPoint(this.#invModel, [x, y, z]), transformDir(this.#invModel, [-view[2], -view[6], -view[10]]), performance.now());
        renderer.render({ views, model, near, antialiased: this.scene.antialiased, minTrace: this.#options.minPixel ** 2, pick: this.pick, computeOnly: true });
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
        this.geometry.dispose();
        this.material.dispose();
        this.splatRenderer?.destroy();
        this.splatRenderer = null;
        this.scene = null;
    }
}
