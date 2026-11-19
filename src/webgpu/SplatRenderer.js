import { invert, mat4, multiply, transformPoint } from '../math.js';
const BYTES_PER_SPLAT = 32;
const BYTES_PER_DRAW = 12;
const DRAW_BATCH = 1 << 16;
const QUAD_INDICES = [0, 1, 2, 2, 1, 3];
const VIEW_STRIDE = 256;
const VIEW_SIZE = 208;
const MAX_VIEWS = 2;
const FRAME_SIZE = 176;
const OVERLAY_STRIDE = 28;
export const OVERLAY_MAX_VERTICES = 4096;
const PICK_SIZE = 112;
function preprocess(src, defines) {
    const out = [];
    let keep = true;
    for (const line of src.split('\n')) {
        const m = line.match(/^#if (\w+)(?: == (\d+))?/);
        if (m) keep = m[2] !== undefined ? defines[m[1]] === Number(m[2]) : !!defines[m[1]];
        else if (line.startsWith('#else')) keep = !keep;
        else if (line.startsWith('#endif')) keep = true;
        else if (keep) out.push(line);
    }
    return out.join('\n');
}
const stage = (src, n) => preprocess(src, { STAGE: n });
export class SplatRenderer {
    device;
    capacity;
    sortBins;
    top;
    splatA;
    splatB;
    activeIds;
    keys;
    order;
    hist;
    sums;
    drawArgs;
    frameUniform;
    viewUniform;
    expandUniform;
    intervals;
    intervalCapacity = 4096;
    dummyTex;
    decodePipeline;
    plyPipeline;
    plyStaging = null;
    plyParams = null;
    plyGroup = null;
    plyBatches = 0;
    expandPipeline;
    keyPipeline;
    prefixPipelines = [];
    tiebreakPipeline;
    tiebreakGroup;
    tieBreak;
    maxDraw;
    alphaCut;
    maxSigma;
    minOpacity;
    drawBatches;
    f16;
    sortSkip;
    indexBuffer;
    sortDirty = true;
    skipped = 0;
    lastSort = null;
    scatterPipeline;
    renderLayout;
    renderModule;
    renderPipelines = new Map();
    skyPipelines = new Map();
    skyModule;
    skyLayout;
    skyUniform;
    skyGroup;
    skyData = new Float32Array((VIEW_STRIDE * MAX_VIEWS) / 4);
    overlayPipelines = new Map();
    overlayModule;
    overlayLayout;
    overlayUniform;
    overlayGroup;
    overlayVertices;
    overlayData = new Float32Array((VIEW_STRIDE * MAX_VIEWS) / 4);
    pickPipeline;
    pickGroup;
    pickUniform;
    pickResult;
    pickRead;
    pickPending = false;
    pickData = new Float32Array(PICK_SIZE / 4);
    expandGroup;
    keyGroup;
    prefixGroup;
    scatterGroup;
    renderGroup;
    pendingDecodes = [];
    pendingIntervals = null;
    numActive = 0;
    boundsMin = [-1, -1, -1];
    boundsMax = [1, 1, 1];
    visibleSplats = 0;
    timings = null;
    statsBuf;
    statsPending = false;
    querySet = null;
    queryResolve = null;
    queryRead = null;
    queryPending = false;
    frameIndex = 0;
    frameData = new ArrayBuffer(FRAME_SIZE);
    frameF32 = new Float32Array(this.frameData);
    frameU32 = new Uint32Array(this.frameData);
    viewData = new Float32Array((VIEW_STRIDE * MAX_VIEWS) / 4);
    tmpA = mat4();
    tmpB = mat4();
    static bytesPerSplat = BYTES_PER_SPLAT;
    get info() {
        return `WebGPU, ${this.f16 ? 'f16' : 'f32'} fragment${this.sortSkip ? `, sortskip ${this.sortSkip}` : ''}`;
    }
    get allocatedBytes() {
        return this.capacity * BYTES_PER_SPLAT + this.maxDraw * BYTES_PER_DRAW + this.indexBuffer.size + this.sortBins * 4;
    }
    static deviceDescriptor(adapter) {
        const requiredFeatures = [];
        for (const f of ['timestamp-query', 'shader-f16']) {
            if (adapter.features.has(f)) requiredFeatures.push(f);
        }
        return { requiredFeatures, requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } };
    }
    static maxCapacity(device) {
        const bytes = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
        return Math.min(Math.floor(bytes / 16), device.limits.maxComputeWorkgroupsPerDimension * 256);
    }
    constructor(device, opts) {
        this.device = device;
        this.capacity = Math.min(opts.capacity, SplatRenderer.maxCapacity(device));
        const bits = Math.max(14, Math.min(22, Math.round(opts.sortBits ?? 18)));
        this.sortBins = 1 << bits;
        this.top = this.sortBins / 4096;
        this.tieBreak = opts.tieBreak ?? 32;
        this.f16 = (opts.f16 ?? true) && device.features.has('shader-f16');
        this.alphaCut = opts.alphaCut ?? 1 / 255;
        this.maxSigma = opts.maxSigma ?? 2;
        this.minOpacity = opts.minOpacity ?? 0;
        this.sortSkip = opts.sortSkip ?? 0;
        const perDraw = 4;
        const bindLimit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
        this.maxDraw = Math.max(1, Math.min(opts.maxDraw ?? this.capacity, this.capacity, Math.floor(bindLimit / perDraw)));
        const S = GPUBufferUsage.STORAGE;
        const buf = (label, size, usage) => device.createBuffer({ label, size, usage });
        this.splatA = buf('splatA', this.capacity * 16, S);
        this.splatB = buf('splatB', this.capacity * 16, S);
        this.activeIds = buf('activeIds', this.maxDraw * 4, S);
        this.keys = buf('keys', this.maxDraw * 4, S);
        this.order = buf('order', this.maxDraw * 4, S);
        // Indexed quads, not instances: 18% faster on Quest 3; indices built on GPU as uploading them OOMs Firefox WebGPU.
        this.indexBuffer = buf('indices', DRAW_BATCH * QUAD_INDICES.length * 4, GPUBufferUsage.INDEX | S);
        this.drawBatches = Math.ceil(this.maxDraw / DRAW_BATCH);
        this.hist = buf('hist', this.sortBins * 4, S | GPUBufferUsage.COPY_DST);
        this.sums = buf('sums', this.top * 65 * 4, S);
        this.drawArgs = buf('drawArgs', (8 + 5 * this.drawBatches) * 4, S | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC);
        this.statsBuf = buf('stats', 16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
        const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
        this.frameUniform = buf('frame', FRAME_SIZE, U);
        this.viewUniform = buf('views', VIEW_STRIDE * MAX_VIEWS, U);
        this.skyUniform = buf('sky', VIEW_STRIDE * MAX_VIEWS, U);
        this.overlayUniform = buf('overlay', VIEW_STRIDE * MAX_VIEWS, U);
        this.pickUniform = buf('pick', PICK_SIZE, U);
        this.pickResult = buf('pickResult', 4, S | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
        this.pickRead = buf('pickRead', 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
        this.overlayVertices = buf('overlayVertices', OVERLAY_MAX_VERTICES * OVERLAY_STRIDE, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        this.expandUniform = buf('expand', 16, U);
        this.intervals = buf('intervals', this.intervalCapacity * 8, S | GPUBufferUsage.COPY_DST);
        this.dummyTex = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
        if (device.features.has('timestamp-query')) {
            this.querySet = device.createQuerySet({ type: 'timestamp', count: 4 });
            this.queryResolve = buf('queryResolve', 32, GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC);
            this.queryRead = buf('queryRead', 32, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
        }
    }
    async init(formats, antialiased) {
        const [decodeSrc, expandSrc, sortSrc, renderSrc, plySrc, skySrc, overlaySrc, pickSrc] = await Promise.all(
            ['decode', 'expand', 'sort', 'render', 'decode_ply', 'sky', 'overlay', 'pick'].map(async (name) => {
                const r = await fetch(new URL(`./shaders/${name}.wgsl`, import.meta.url));
                if (!r.ok) throw new Error(`Could not load shader ${name}.wgsl`);
                return r.text();
            }),
        );
        const d = this.device;
        const C = GPUShaderStage.COMPUTE;
        const layout = (entries) => d.createBindGroupLayout({ entries });
        const ro = (binding, visibility = C) => ({ binding, visibility, buffer: { type: 'read-only-storage' } });
        const rw = (binding) => ({ binding, visibility: C, buffer: { type: 'storage' } });
        const un = (binding, visibility = C, dyn = false) => ({ binding, visibility, buffer: { type: 'uniform', hasDynamicOffset: dyn } });
        const tex = (binding) => ({ binding, visibility: C, texture: { sampleType: 'float' } });
        const decodeLayout = layout([un(0), tex(1), tex(2), tex(3), tex(4), tex(5), rw(6), rw(7)]);
        const expandLayout = layout([un(0), ro(1), rw(2)]);
        const keyLayout = layout([un(0), ro(1), ro(2), rw(3), rw(4)]);
        const prefixLayout = layout([rw(0), rw(1), rw(2)]);
        const tiebreakLayout = layout([ro(0), rw(1)]);
        const scatterLayout = layout([un(0), ro(1), ro(2), rw(3), rw(4)]);
        const V = GPUShaderStage.VERTEX;
        this.renderLayout = layout([un(0, V, true), ro(1, V), ro(2, V), ro(3, V)]);
        const compute = (label, code, entryPoint, bgl, constants) => d.createComputePipelineAsync({ label, layout: d.createPipelineLayout({ bindGroupLayouts: [bgl] }), compute: { module: d.createShaderModule({ label, code }), entryPoint, constants } });
        const prefixCode = stage(sortSrc, 1);
        const prefixConst = { TOP: this.top, DRAW_BATCHES: this.drawBatches, DRAW_BATCH };
        this.skyModule = d.createShaderModule({ label: 'sky', code: skySrc });
        this.skyLayout = layout([un(0, GPUShaderStage.FRAGMENT, true)]);
        this.overlayModule = d.createShaderModule({ label: 'overlay', code: overlaySrc });
        this.overlayLayout = layout([un(0, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, true)]);
        this.renderModule = d.createShaderModule({ label: 'render', code: preprocess(renderSrc, { F16: this.f16 }) });
        const pickLayout = layout([un(0), ro(1), ro(2), rw(3)]);
        [this.pickPipeline, this.decodePipeline, this.plyPipeline, this.expandPipeline, this.keyPipeline, this.scatterPipeline, this.tiebreakPipeline, ...this.prefixPipelines] = await Promise.all([
            compute('pick', pickSrc, 'main', pickLayout),
            compute('decode', decodeSrc, 'main', decodeLayout),
            compute('decode ply', plySrc, 'main', layout([un(0), ro(1), rw(2), rw(3)])),
            compute('expand', expandSrc, 'main', expandLayout),
            compute('key', stage(sortSrc, 0), 'key', keyLayout),
            compute('scatter', stage(sortSrc, 2), 'scatter', scatterLayout),
            compute('tiebreak', stage(sortSrc, 3), 'tiebreak', tiebreakLayout, { NUM_BINS: this.sortBins, MAX_RUN: Math.max(2, this.tieBreak) }),
            ...['sumA', 'sumB', 'scanTop', 'scanB', 'scanC'].map((e) => compute(e, prefixCode, e, prefixLayout, prefixConst)),
        ]);
        await Promise.all(formats.map((f) => this.prepare(f, antialiased)));
        const group = (bgl, buffers) => d.createBindGroup({ layout: bgl, entries: buffers.map((b, binding) => ({ binding, resource: 'buffer' in b ? b : { buffer: b } })) });
        this.keyGroup = group(keyLayout, [this.frameUniform, this.splatA, this.activeIds, this.keys, this.hist]);
        this.prefixGroup = group(prefixLayout, [this.hist, this.sums, this.drawArgs]);
        this.tiebreakGroup = group(tiebreakLayout, [this.hist, this.order]);
        this.scatterGroup = group(scatterLayout, [this.frameUniform, this.activeIds, this.keys, this.hist, this.order]);
        this.skyGroup = group(this.skyLayout, [{ buffer: this.skyUniform, offset: 0, size: 128 }]);
        this.pickGroup = group(pickLayout, [this.pickUniform, this.splatA, this.activeIds, this.pickResult]);
        this.overlayGroup = group(this.overlayLayout, [{ buffer: this.overlayUniform, offset: 0, size: 80 }]);
        this.renderGroup = group(this.renderLayout, [{ buffer: this.viewUniform, offset: 0, size: VIEW_SIZE }, this.order, this.splatA, this.splatB]);
        this.writeIndices();
        this.makeExpandGroup();
    }
    async uploadPly(floats, base, count, batchSplats) {
        const d = this.device;
        if (!this.plyStaging) {
            this.plyStaging = d.createBuffer({ label: 'ply staging', size: batchSplats * 56, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            this.plyParams = d.createBuffer({ label: 'ply params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            this.plyGroup = d.createBindGroup({
                layout: this.plyPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.plyParams } },
                    { binding: 1, resource: { buffer: this.plyStaging } },
                    { binding: 2, resource: { buffer: this.splatA } },
                    { binding: 3, resource: { buffer: this.splatB } },
                ],
            });
        }
        d.queue.writeBuffer(this.plyStaging, 0, floats.buffer, floats.byteOffset, count * 56);
        d.queue.writeBuffer(this.plyParams, 0, new Uint32Array([base, count, 0, 0]));
        const encoder = d.createCommandEncoder();
        const pass = encoder.beginComputePass({ label: 'decode ply' });
        pass.setPipeline(this.plyPipeline);
        pass.setBindGroup(0, this.plyGroup);
        pass.dispatchWorkgroups(Math.ceil(count / 256));
        pass.end();
        d.queue.submit([encoder.finish()]);
        if (++this.plyBatches % 8 === 0) await d.queue.onSubmittedWorkDone();
    }
    finishPly() {
        this.plyStaging?.destroy();
        this.plyParams?.destroy();
        this.plyStaging = this.plyParams = this.plyGroup = null;
    }
    writeIndices() {
        const d = this.device;
        const module = d.createShaderModule({
            label: 'indices',
            code: `
      override COUNT: u32 = 1u;
      const PATTERN = array<u32, 6>(${QUAD_INDICES.join(', ')});
      @group(0) @binding(0) var<storage, read_write> idx: array<u32>;
      @compute @workgroup_size(256)
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        let i = gid.x;
        if (i >= COUNT) { return; }
        let v = i * 4u;
        let o = i * 6u;
        for (var k = 0u; k < 6u; k++) { idx[o + k] = v + PATTERN[k]; }
      }`,
        });
        const pipeline = d.createComputePipeline({ label: 'indices', layout: 'auto', compute: { module, entryPoint: 'main', constants: { COUNT: DRAW_BATCH } } });
        const encoder = d.createCommandEncoder();
        const pass = encoder.beginComputePass({ label: 'indices' });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.indexBuffer } }] }));
        pass.dispatchWorkgroups(Math.ceil(DRAW_BATCH / 256));
        pass.end();
        d.queue.submit([encoder.finish()]);
    }
    makeExpandGroup() {
        this.expandGroup = this.device.createBindGroup({
            layout: this.expandPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.expandUniform } },
                { binding: 1, resource: { buffer: this.intervals } },
                { binding: 2, resource: { buffer: this.activeIds } },
            ],
        });
    }
    async prepare(format, antialiased) {
        const key = `${format}|${antialiased}`;
        let p = this.renderPipelines.get(key);
        if (!p) {
            p = await this.device.createRenderPipelineAsync(this.renderPipelineDesc(format, antialiased));
            this.renderPipelines.set(key, p);
        }
        if (!this.skyPipelines.has(format)) this.skyPipelines.set(format, await this.device.createRenderPipelineAsync(this.skyPipelineDesc(format)));
        if (!this.overlayPipelines.has(format)) this.overlayPipelines.set(format, await this.device.createRenderPipelineAsync(this.overlayPipelineDesc(format)));
        return p;
    }
    overlayPipelineDesc(format) {
        const blend = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
        return {
            label: `overlay ${format}`,
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.overlayLayout] }),
            vertex: {
                module: this.overlayModule,
                entryPoint: 'vs',
                buffers: [
                    {
                        arrayStride: OVERLAY_STRIDE,
                        attributes: [
                            { shaderLocation: 0, offset: 0, format: 'float32x3' },
                            { shaderLocation: 1, offset: 12, format: 'float32x4' },
                        ],
                    },
                ],
            },
            fragment: { module: this.overlayModule, entryPoint: 'fs', targets: [{ format, blend: { color: blend, alpha: blend } }] },
            primitive: { topology: 'triangle-list' },
        };
    }
    encodePick(encoder, frame) {
        const pk = frame.pick;
        const f = this.pickData;
        const u = new Uint32Array(f.buffer);
        f.set(frame.model, 0);
        f.set(pk.start, 16);
        f[19] = pk.maxU;
        f[20] = pk.dir[0];
        f[21] = pk.dir[1];
        f[22] = pk.slope;
        f[23] = pk.curve;
        u[24] = this.numActive;
        f[25] = pk.width ?? 0.15;
        f[26] = pk.minAlpha ?? 0.3;
        this.device.queue.writeBuffer(this.pickUniform, 0, f);
        this.device.queue.writeBuffer(this.pickResult, 0, new Uint32Array([0x7f800000]));
        const pass = encoder.beginComputePass({ label: 'pick' });
        pass.setPipeline(this.pickPipeline);
        pass.setBindGroup(0, this.pickGroup);
        pass.dispatchWorkgroups(Math.ceil(this.numActive / 256));
        pass.end();
        encoder.copyBufferToBuffer(this.pickResult, 0, this.pickRead, 0, 4);
        return { pick: pk, token: pk.token };
    }
    writeOverlay(frame) {
        const f = this.overlayData;
        const u = new Uint32Array(f.buffer);
        const n = Math.min(frame.views.length, MAX_VIEWS);
        for (let v = 0; v < n; v++) {
            const view = frame.views[v];
            const o = (v * VIEW_STRIDE) / 4;
            multiply(f.subarray(o, o + 16), view.proj, view.view);
            u[o + 16] = frame.format.endsWith('-srgb') ? 1 : 0;
        }
        this.device.queue.writeBuffer(this.overlayUniform, 0, f, 0, (n * VIEW_STRIDE) / 4);
        const count = Math.min(frame.overlay.count, OVERLAY_MAX_VERTICES);
        this.device.queue.writeBuffer(this.overlayVertices, 0, frame.overlay.data, 0, (count * OVERLAY_STRIDE) / 4);
        return count;
    }
    skyPipelineDesc(format) {
        return { label: `sky ${format}`, layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.skyLayout] }), vertex: { module: this.skyModule, entryPoint: 'vs' }, fragment: { module: this.skyModule, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } };
    }
    writeSkyUniforms(frame) {
        const f = this.skyData;
        const u = new Uint32Array(f.buffer);
        const n = Math.min(frame.views.length, MAX_VIEWS);
        const sky = frame.sky;
        for (let v = 0; v < n; v++) {
            const view = frame.views[v];
            const o = (v * VIEW_STRIDE) / 4;
            multiply(this.tmpA, view.proj, view.view);
            invert(f.subarray(o, o + 16), this.tmpA);
            f.set(sky.zenith, o + 16);
            f.set(sky.horizon, o + 20);
            f.set(sky.ground, o + 24);
            u[o + 28] = frame.format.endsWith('-srgb') ? 1 : 0;
        }
        this.device.queue.writeBuffer(this.skyUniform, 0, f, 0, (n * VIEW_STRIDE) / 4);
    }
    renderPipelineDesc(format, antialiased) {
        const constants = { AA: antialiased ? 1 : 0, SRGB_OUT: format.endsWith('-srgb') ? 1 : 0, ALPHA_CUT: this.alphaCut, MAX_R2: this.maxSigma * this.maxSigma };
        const blend = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
        return {
            label: `splats ${format}`,
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.renderLayout] }),
            vertex: { module: this.renderModule, entryPoint: 'vs', constants },
            fragment: { module: this.renderModule, entryPoint: 'fs', constants, targets: [{ format, blend: { color: blend, alpha: blend } }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
        };
    }
    queueDecode(src, base) {
        this.pendingDecodes.push({ src, base });
    }
    setIntervals(data, count, total) {
        this.pendingIntervals = { data, count, total };
    }
    get activeSplats() {
        return this.numActive;
    }
    encodeDecodes(encoder, trash) {
        const d = this.device;
        for (const { src, base } of this.pendingDecodes) {
            const upload = (bmp) => {
                if (!bmp) return this.dummyTex;
                const t = d.createTexture({ size: [bmp.width, bmp.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
                d.queue.copyExternalImageToTexture({ source: bmp }, { texture: t, premultipliedAlpha: false }, [bmp.width, bmp.height]);
                bmp.close();
                trash.push(t);
                return t;
            };
            const textures = [src.meansL, src.meansU, src.scales, src.quats, src.sh0].map(upload);
            const params = new ArrayBuffer(48 + 256 * 16);
            const f = new Float32Array(params);
            const u = new Uint32Array(params);
            f.set(src.mins, 0);
            u[3] = src.count;
            f.set(src.maxs, 4);
            u[7] = base;
            u[8] = src.width;
            u[9] = src.version;
            for (let i = 0; i < 256; i++) {
                f[12 + i * 4] = src.scalesCodebook[i] ?? 0;
                f[12 + i * 4 + 1] = src.sh0Codebook[i] ?? 0;
            }
            const ub = d.createBuffer({ size: params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            d.queue.writeBuffer(ub, 0, params);
            trash.push(ub);
            const bg = d.createBindGroup({
                layout: this.decodePipeline.getBindGroupLayout(0),
                entries: [{ binding: 0, resource: { buffer: ub } }, ...textures.map((t, i) => ({ binding: i + 1, resource: t.createView() })), { binding: 6, resource: { buffer: this.splatA } }, { binding: 7, resource: { buffer: this.splatB } }],
            });
            const pass = encoder.beginComputePass({ label: 'decode' });
            pass.setPipeline(this.decodePipeline);
            pass.setBindGroup(0, bg);
            pass.dispatchWorkgroups(Math.ceil(src.count / 256));
            pass.end();
        }
        this.pendingDecodes.length = 0;
    }
    encodeExpand(encoder) {
        const iv = this.pendingIntervals;
        if (!iv) return;
        this.pendingIntervals = null;
        this.sortDirty = true;
        this.numActive = Math.min(iv.total, this.maxDraw);
        if (iv.count === 0 || this.numActive === 0) {
            this.numActive = 0;
            return;
        }
        const d = this.device;
        if (iv.count > this.intervalCapacity) {
            this.intervals.destroy();
            while (this.intervalCapacity < iv.count) this.intervalCapacity *= 2;
            this.intervals = d.createBuffer({ size: this.intervalCapacity * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            this.makeExpandGroup();
        }
        d.queue.writeBuffer(this.intervals, 0, iv.data.buffer, iv.data.byteOffset, iv.count * 8);
        d.queue.writeBuffer(this.expandUniform, 0, new Uint32Array([iv.count, this.numActive, 0, 0]));
        const pass = encoder.beginComputePass({ label: 'expand' });
        pass.setPipeline(this.expandPipeline);
        pass.setBindGroup(0, this.expandGroup);
        pass.dispatchWorkgroups(Math.ceil(this.numActive / 256));
        pass.end();
    }
    writeFrameUniform(frame) {
        const f = this.frameF32;
        const u = this.frameU32;
        const invModel = invert(this.tmpB, frame.model);
        let ox = 0,
            oy = 0,
            oz = 0;
        const n = Math.min(frame.views.length, MAX_VIEWS);
        for (let v = 0; v < n; v++) {
            const view = frame.views[v];
            multiply(this.tmpA, view.view, frame.model);
            multiply(f.subarray(v * 16, v * 16 + 16), view.proj, this.tmpA);
            const inv = invert(this.tmpA, view.view);
            ox += inv[12] / n;
            oy += inv[13] / n;
            oz += inv[14] / n;
        }
        this.lastSort = this.sortPose(frame);
        const cam = transformPoint(invModel, [ox, oy, oz]);
        let far2 = 0,
            near2 = 0;
        for (let i = 0; i < 3; i++) {
            const lo = this.boundsMin[i],
                hi = this.boundsMax[i];
            const dd = Math.max(Math.abs(cam[i] - lo), Math.abs(cam[i] - hi));
            far2 += dd * dd;
            const nd = cam[i] < lo ? lo - cam[i] : cam[i] > hi ? cam[i] - hi : 0;
            near2 += nd * nd;
        }
        const far = Math.max(Math.sqrt(far2), 1e-3) * 1.01;
        const nearModel = frame.near / Math.hypot(frame.model[0], frame.model[1], frame.model[2]);
        const minDist = Math.min(Math.max(Math.sqrt(near2) * 0.99, nearModel, far * 2 ** -16), far * 0.5);
        const octaves = Math.log2(far / minDist);
        f[32] = cam[0];
        f[33] = cam[1];
        f[34] = cam[2];
        u[35] = this.numActive;
        f[36] = Math.log2(far);
        f[37] = this.sortBins / octaves;
        f[38] = minDist;
        f[39] = this.sortBins - 1;
        u[40] = n;
        f[41] = frame.near;
        f[42] = 1.3;
        f[43] = this.minOpacity;
        this.device.queue.writeBuffer(this.frameUniform, 0, this.frameData);
    }
    sortPose(frame) {
        const n = Math.min(frame.views.length, MAX_VIEWS);
        const pose = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 0, views: n };
        for (let v = 0; v < n; v++) {
            const inv = invert(this.tmpA, frame.views[v].view);
            pose.x += inv[12] / n;
            pose.y += inv[13] / n;
            pose.z += inv[14] / n;
        }
        const v0 = frame.views[0].view;
        pose.fx = -v0[2];
        pose.fy = -v0[6];
        pose.fz = -v0[10];
        return pose;
    }
    canReuseSort(frame) {
        const last = this.lastSort;
        if (this.sortDirty || !last || this.skipped >= this.sortSkip) return false;
        const now = this.sortPose(frame);
        if (now.views !== last.views) return false;
        const moved = Math.hypot(now.x - last.x, now.y - last.y, now.z - last.z);
        const cos = now.fx * last.fx + now.fy * last.fy + now.fz * last.fz;
        return moved < 0.01 && cos > 0.9976;
    }
    writeViewUniforms(frame) {
        const f = this.viewData;
        const n = Math.min(frame.views.length, MAX_VIEWS);
        for (let v = 0; v < n; v++) {
            const view = frame.views[v];
            const o = (v * VIEW_STRIDE) / 4;
            multiply(f.subarray(o, o + 16), view.view, frame.model);
            f.set(view.proj, o + 16);
            const w = view.viewport[2],
                h = view.viewport[3];
            f[o + 32] = w;
            f[o + 33] = h;
            f[o + 34] = 0.5 * w * view.proj[0];
            f[o + 35] = 0.5 * h * view.proj[5];
            f[o + 36] = frame.near;
            f[o + 37] = frame.minTrace;
            f[o + 38] = Math.min(1024, Math.min(w, h));
            const rv = frame.reveal;
            if (rv) {
                f.set(rv.center, o + 40);
                f[o + 43] = rv.front;
                f.set(rv.up, o + 44);
                f[o + 47] = rv.metersPerUnit;
                f[o + 48] = rv.time;
                f[o + 49] = rv.lift;
            }
            f[o + 50] = rv ? 1 : 0;
        }
        this.device.queue.writeBuffer(this.viewUniform, 0, f, 0, (n * VIEW_STRIDE) / 4);
    }
    render(frame) {
        const d = this.device;
        const key = `${frame.format}|${frame.antialiased}`;
        let pipeline = this.renderPipelines.get(key);
        if (!pipeline) {
            pipeline = d.createRenderPipeline(this.renderPipelineDesc(frame.format, frame.antialiased));
            this.renderPipelines.set(key, pipeline);
        }
        let skyPipeline = null;
        if (frame.sky) {
            skyPipeline = this.skyPipelines.get(frame.format);
            if (!skyPipeline) {
                skyPipeline = d.createRenderPipeline(this.skyPipelineDesc(frame.format));
                this.skyPipelines.set(frame.format, skyPipeline);
            }
            this.writeSkyUniforms(frame);
        }
        let overlayPipeline = null,
            overlayCount = 0;
        if (frame.overlay?.count > 0) {
            overlayPipeline = this.overlayPipelines.get(frame.format);
            if (!overlayPipeline) {
                overlayPipeline = d.createRenderPipeline(this.overlayPipelineDesc(frame.format));
                this.overlayPipelines.set(frame.format, overlayPipeline);
            }
            overlayCount = this.writeOverlay(frame);
        }
        const trash = [];
        const encoder = d.createCommandEncoder();
        this.encodeDecodes(encoder, trash);
        this.encodeExpand(encoder);
        const picking = frame.pick?.active && !this.pickPending && this.numActive > 0 ? this.encodePick(encoder, frame) : null;
        const nViews = Math.min(frame.views.length, MAX_VIEWS);
        const sorting = !this.canReuseSort(frame);
        if (sorting) {
            this.writeFrameUniform(frame);
            this.sortDirty = false;
            this.skipped = 0;
        } else {
            this.skipped++;
        }
        this.writeViewUniforms(frame);
        const timing = this.querySet && !this.queryPending && this.frameIndex % 8 === 0 ? this.querySet : null;
        const n = this.numActive;
        if (sorting) encoder.clearBuffer(this.hist);
        if (sorting) {
            const pass = encoder.beginComputePass({ label: 'sort', timestampWrites: timing ? { querySet: timing, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } : undefined });
            const groups = Math.ceil(n / 256);
            if (sorting && groups > 0) {
                pass.setPipeline(this.keyPipeline);
                pass.setBindGroup(0, this.keyGroup);
                pass.dispatchWorkgroups(groups);
            }
            if (sorting) {
                pass.setBindGroup(0, this.prefixGroup);
                const counts = [this.top, Math.ceil(this.top / 64), 1, Math.ceil(this.top / 64), this.top];
                for (let i = 0; i < 5; i++) {
                    pass.setPipeline(this.prefixPipelines[i]);
                    pass.dispatchWorkgroups(counts[i]);
                }
            }
            if (sorting && groups > 0) {
                pass.setPipeline(this.scatterPipeline);
                pass.setBindGroup(0, this.scatterGroup);
                pass.dispatchWorkgroups(groups);
                if (this.tieBreak > 0) {
                    pass.setPipeline(this.tiebreakPipeline);
                    pass.setBindGroup(0, this.tiebreakGroup);
                    pass.dispatchWorkgroups(this.sortBins / 64);
                }
            }
            pass.end();
        }
        for (let first = 0; first < nViews; ) {
            let end = first + 1;
            while (end < nViews && frame.views[end].clear === false) end++;
            const pass = encoder.beginRenderPass({
                label: 'splats',
                colorAttachments: [{ view: frame.views[first].target, clearValue: frame.clearColor, loadOp: frame.views[first].clear === false ? 'load' : 'clear', storeOp: 'store' }],
                timestampWrites: timing && (first === 0 || end === nViews) ? { querySet: timing, ...(first === 0 && { beginningOfPassWriteIndex: 2 }), ...(end === nViews && { endOfPassWriteIndex: 3 }) } : undefined,
            });
            const eachView = (draw) => {
                for (let v = first; v < end; v++) {
                    const [x, y, w, h] = frame.views[v].viewport;
                    pass.setViewport(x, y, w, h, 0, 1);
                    draw(v);
                }
            };
            if (skyPipeline) {
                pass.setPipeline(skyPipeline);
                eachView((v) => {
                    pass.setBindGroup(0, this.skyGroup, [v * VIEW_STRIDE]);
                    pass.draw(3);
                });
            }
            pass.setPipeline(pipeline);
            pass.setIndexBuffer(this.indexBuffer, 'uint32');
            eachView((v) => {
                pass.setBindGroup(0, this.renderGroup, [v * VIEW_STRIDE]);
                for (let k = 0; k < this.drawBatches; k++) pass.drawIndexedIndirect(this.drawArgs, 32 + 20 * k);
            });
            if (overlayPipeline) {
                pass.setPipeline(overlayPipeline);
                pass.setVertexBuffer(0, this.overlayVertices);
                eachView((v) => {
                    pass.setBindGroup(0, this.overlayGroup, [v * VIEW_STRIDE]);
                    pass.draw(overlayCount);
                });
            }
            pass.end();
            first = end;
        }
        if (timing) encoder.resolveQuerySet(timing, 0, 4, this.queryResolve, 0);
        const readStats = !this.statsPending && this.frameIndex % 16 === 0;
        if (readStats) encoder.copyBufferToBuffer(this.drawArgs, 0, this.statsBuf, 0, 16);
        if (timing) encoder.copyBufferToBuffer(this.queryResolve, 0, this.queryRead, 0, 32);
        d.queue.submit([encoder.finish()]);
        if (picking) {
            this.pickPending = true;
            const { pick, token } = picking;
            this.pickRead.mapAsync(GPUMapMode.READ).then(
                () => {
                    const u = new Float32Array(this.pickRead.getMappedRange())[0];
                    this.pickRead.unmap();
                    this.pickPending = false;
                    pick.result = { u: Number.isFinite(u) ? u : null, token };
                },
                () => {
                    this.pickPending = false;
                },
            );
        }
        for (const t of trash) t.destroy();
        if (readStats) {
            this.statsPending = true;
            this.statsBuf.mapAsync(GPUMapMode.READ).then(
                () => {
                    this.visibleSplats = new Uint32Array(this.statsBuf.getMappedRange())[1];
                    this.statsBuf.unmap();
                    this.statsPending = false;
                },
                () => {
                    this.statsPending = false;
                },
            );
        }
        if (timing) {
            this.queryPending = true;
            const rb = this.queryRead;
            rb.mapAsync(GPUMapMode.READ).then(
                () => {
                    const t = new BigInt64Array(rb.getMappedRange());
                    const computeMs = Number(t[1] - t[0]) / 1e6;
                    const drawMs = Number(t[3] - t[2]) / 1e6;
                    if (computeMs >= 0 && drawMs >= 0) this.timings = { computeMs, drawMs };
                    rb.unmap();
                    this.queryPending = false;
                },
                () => {
                    this.queryPending = false;
                },
            );
        }
        this.frameIndex++;
    }
}
