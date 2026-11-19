import { RangeAllocator } from './RangeAllocator.js';
import { fetchJson, loadSogBundle, loadSogChunk, unlog } from './sog.js';
import { PLY_BATCH, readBody } from './ply.js';
const FileState = { Idle: 0, Loading: 1, Fetched: 2, Loaded: 3 };

export const defaultSceneOptions = { budget: 2_000_000, lodBase: 5, lodMult: 3, gazePenalty: 3, maxConcurrent: 3 };
export class SplatScene {
    renderer;
    options;
    antialiased = false;
    boundsMin = [0, 0, 0];
    boundsMax = [0, 0, 0];
    center = [0, 0, 0];
    radius = 1;
    isPly = false;
    sourceName = '';
    levels = 1;
    numLeaves = 0;
    leafMin = new Float32Array(0);
    leafMax = new Float32Array(0);
    leafFile = new Int32Array(0);
    leafOffset = new Uint32Array(0);
    leafCount = new Uint32Array(0);
    desired = new Int8Array(0);
    dEff = new Float32Array(0);
    files = [];
    envFile = null;
    allocator;
    loading = 0;
    selectionGen = 0;
    rebuildGen = 0;
    lastSelect = -1e9;
    stateDirty = true;
    intervalData = new Uint32Array(1024);
    order = [];
    desiredSplats = 0;
    totalSplats = 0;
    lodScale = 1;
    constructor(renderer, options) {
        this.renderer = renderer;
        this.options = options;
        this.allocator = new RangeAllocator(renderer.capacity);
    }
    get residentSplats() {
        return this.allocator.used;
    }
    get loadedFiles() {
        return this.files.reduce((n, f) => n + (f.state === FileState.Loaded ? 1 : 0), 0);
    }
    get loadingFiles() {
        return this.loading;
    }
    get fileCount() {
        return this.files.length;
    }
    static async load(url, renderer, options = {}) {
        const scene = new SplatScene(renderer, { ...defaultSceneOptions, ...options });
        if (url instanceof Blob) {
            if (!/\.sog$/i.test(url.name ?? '')) throw new Error(`Cannot open ${url.name}: drop a .ply or .sog file`);
            scene.sourceName = url.name;
            const { meta, chunk } = await loadSogBundle(url);
            scene.initSingle(url.name, meta, chunk);
            renderer.boundsMin = scene.boundsMin;
            renderer.boundsMax = scene.boundsMax;
            return scene;
        }
        const abs = new URL(url, location.href).href;
        const path = new URL(abs).pathname.toLowerCase();
        scene.sourceName = abs.split('/').slice(-2).join('/');
        if (path.endsWith('.sog')) {
            const { meta, chunk } = await loadSogBundle(abs);
            scene.initSingle(abs, meta, chunk);
        } else {
            const json = await fetchJson(abs);
            if ('tree' in json) scene.initStreamed(abs, json);
            else {
                const { chunk } = await loadSogChunk(abs, undefined, json);
                scene.initSingle(abs, json, chunk);
            }
        }
        renderer.boundsMin = scene.boundsMin;
        renderer.boundsMax = scene.boundsMax;
        return scene;
    }
    static async loadPly(ply, renderer, options = {}, onProgress) {
        const scene = new SplatScene(renderer, { ...defaultSceneOptions, ...options });
        scene.isPly = true;
        scene.sourceName = String(ply.name).split('/').pop();
        const n = ply.count;
        if (n > renderer.capacity || n > renderer.maxDraw) {
            throw new Error(`This PLY has ${(n / 1e6).toFixed(1)}M splats; this device can hold at most ${(Math.min(renderer.capacity, renderer.maxDraw) / 1e6).toFixed(1)}M`);
        }
        const base = scene.allocator.alloc(n);
        const { min, max, sample } = await readBody(ply, (floats, first, rows) => renderer.uploadPly(floats, base + first, rows, PLY_BATCH), onProgress);
        renderer.finishPly();
        scene.allocLeaves(1, 1);
        scene.leafMin.set(min);
        scene.leafMax.set(max);
        scene.leafFile[0] = 0;
        scene.leafCount[0] = n;
        const file = scene.newFile(ply.name, n);
        file.state = FileState.Loaded;
        file.base = base;
        file.pinned = true;
        scene.files = [file];
        scene.boundsMin = min;
        scene.boundsMax = max;
        scene.totalSplats = n;
        const m = sample.length / 3;
        if (m > 0) {
            const axis = (a) => Float32Array.from({ length: m }, (_, i) => sample[i * 3 + a]).sort();
            scene.center = [0, 1, 2].map((a) => axis(a)[m >> 1]);
            const d = Float32Array.from({ length: m }, (_, i) => Math.hypot(sample[i * 3] - scene.center[0], sample[i * 3 + 1] - scene.center[1], sample[i * 3 + 2] - scene.center[2])).sort();
            scene.radius = Math.max(1e-3, d[Math.floor(m * 0.8)]);
        }
        renderer.boundsMin = scene.boundsMin;
        renderer.boundsMax = scene.boundsMax;
        return scene;
    }
    newFile(url, count) {
        return { url, count, state: FileState.Idle, base: -1, pinned: false, neededGen: -1, renderedGen: -1, priority: 0, lastNeeded: 0, src: null, abort: null, failed: false };
    }
    allocLeaves(n, levels) {
        this.numLeaves = n;
        this.levels = levels;
        this.leafMin = new Float32Array(n * 3);
        this.leafMax = new Float32Array(n * 3);
        this.leafFile = new Int32Array(n * levels).fill(-1);
        this.leafOffset = new Uint32Array(n * levels);
        this.leafCount = new Uint32Array(n * levels);
        this.desired = new Int8Array(n).fill(-1);
        this.dEff = new Float32Array(n);
    }
    initSingle(url, meta, chunk) {
        this.antialiased = meta.model === 'antialiased';
        const min = meta.means.mins.map(unlog);
        const max = meta.means.maxs.map(unlog);
        this.allocLeaves(1, 1);
        this.leafMin.set(min);
        this.leafMax.set(max);
        this.leafFile[0] = 0;
        this.leafCount[0] = meta.count;
        const file = this.newFile(url, meta.count);
        file.src = chunk;
        file.state = FileState.Fetched;
        file.pinned = true;
        this.files = [file];
        this.boundsMin = min;
        this.boundsMax = max;
        this.center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        this.radius = Math.max(1e-3, 0.25 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
        this.totalSplats = meta.count;
    }
    weightedRadius(weights, total, fraction) {
        const c = this.center;
        const d = [];
        for (let i = 0; i < this.numLeaves; i++) {
            if (!weights[i]) continue;
            let d2 = 0;
            for (let a = 0; a < 3; a++) {
                const m = (this.leafMin[i * 3 + a] + this.leafMax[i * 3 + a]) * 0.5 - c[a];
                d2 += m * m;
            }
            d.push([Math.sqrt(d2), weights[i]]);
        }
        d.sort((a, b) => a[0] - b[0]);
        let acc = 0;
        for (const [dist, w] of d) {
            acc += w;
            if (acc >= fraction * total) return Math.max(dist, 1e-3);
        }
        return 1;
    }
    initStreamed(url, meta) {
        if ((meta.version ?? 1) > 1) throw new Error(`Unsupported streamed SOG version ${meta.version}`);
        if (meta.model === '2dgs') throw new Error('2DGS scenes are not supported');
        this.antialiased = meta.model === 'antialiased';
        const leaves = [];
        const stack = [meta.tree];
        while (stack.length) {
            const n = stack.pop();
            if (n.children) stack.push(...n.children);
            else if (n.lods) leaves.push(n);
        }
        const L = meta.lodLevels;
        this.allocLeaves(leaves.length, L);
        this.files = meta.filenames.map((f) => this.newFile(new URL(f, url).href, 0));
        let wx = 0,
            wy = 0,
            wz = 0,
            wsum = 0;
        const weights = new Float64Array(leaves.length);
        leaves.forEach((leaf, i) => {
            this.leafMin.set(leaf.bound.min, i * 3);
            this.leafMax.set(leaf.bound.max, i * 3);
            let coarsest = -1;
            let finest = -1;
            for (let l = 0; l < L; l++) {
                const e = leaf.lods[l];
                if (!e || e.count === 0) continue;
                const k = i * L + l;
                this.leafFile[k] = e.file;
                this.leafOffset[k] = e.offset;
                this.leafCount[k] = e.count;
                const file = this.files[e.file];
                file.count = Math.max(file.count, e.offset + e.count);
                this.totalSplats += e.count;
                coarsest = l;
                if (finest < 0) finest = l;
            }
            if (coarsest < 0) return;
            this.files[this.leafFile[i * L + coarsest]].pinned = true;
            const w = this.leafCount[i * L + finest];
            weights[i] = w;
            wx += w * (leaf.bound.min[0] + leaf.bound.max[0]) * 0.5;
            wy += w * (leaf.bound.min[1] + leaf.bound.max[1]) * 0.5;
            wz += w * (leaf.bound.min[2] + leaf.bound.max[2]) * 0.5;
            wsum += w;
        });
        this.boundsMin = meta.tree.bound.min.slice(0, 3);
        this.boundsMax = meta.tree.bound.max.slice(0, 3);
        this.center = wsum > 0 ? [wx / wsum, wy / wsum, wz / wsum] : [0, 0, 0];
        this.radius = this.weightedRadius(weights, wsum, 0.8);
        if (meta.environment) {
            const env = this.newFile(new URL(meta.environment, url).href, 0);
            env.pinned = true;
            this.envFile = env;
            this.startFetch(env);
        }
    }
    startFetch(file) {
        file.state = FileState.Loading;
        file.abort = new AbortController();
        if (file !== this.envFile) this.loading++;
        loadSogChunk(file.url, file.abort.signal)
            .then(
                ({ meta, chunk }) => {
                    file.src = chunk;
                    file.count = meta.count;
                    file.state = FileState.Fetched;
                    if (file === this.envFile) {
                        for (let i = 0; i < 3; i++) {
                            this.boundsMin[i] = Math.min(this.boundsMin[i], unlog(meta.means.mins[i]));
                            this.boundsMax[i] = Math.max(this.boundsMax[i], unlog(meta.means.maxs[i]));
                        }
                    }
                },
                (err) => {
                    file.state = FileState.Idle;
                    if (err?.name !== 'AbortError') {
                        file.failed = true;
                        console.warn(`Failed to load chunk ${file.url}`, err);
                    }
                },
            )
            .finally(() => {
                file.abort = null;
                if (file !== this.envFile) this.loading--;
                this.stateDirty = true;
            });
    }
    existingLevel(leaf, level) {
        const L = this.levels;
        for (let l = level; l < L; l++) if (this.leafFile[leaf * L + l] >= 0) return l;
        for (let l = level - 1; l >= 0; l--) if (this.leafFile[leaf * L + l] >= 0) return l;
        return -1;
    }
    countAtScale(scale, assign) {
        const { lodBase, lodMult } = this.options;
        const L = this.levels;
        const invLog = 1 / Math.log(lodMult);
        let total = 0;
        for (let i = 0; i < this.numLeaves; i++) {
            const d = this.dEff[i] * scale;
            let level = d < lodBase ? 0 : Math.min(L - 1, Math.floor(Math.log(d / lodBase) * invLog) + 1);
            level = this.existingLevel(i, level);
            if (level >= 0) total += this.leafCount[i * L + level];
            if (assign) this.desired[i] = level;
        }
        return total;
    }
    select(cam, fwd, now) {
        const { gazePenalty } = this.options;
        const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
        for (let i = 0; i < this.numLeaves; i++) {
            let d2 = 0;
            let dot = 0;
            let c2 = 0;
            for (let a = 0; a < 3; a++) {
                const lo = this.leafMin[i * 3 + a],
                    hi = this.leafMax[i * 3 + a];
                const c = cam[a];
                const dd = c < lo ? lo - c : c > hi ? c - hi : 0;
                d2 += dd * dd;
                dot += ((lo + hi) * 0.5 - c) * fwd[a];
                c2 += ((lo + hi) * 0.5 - c) ** 2;
            }
            const d = Math.sqrt(d2);
            const floored = Math.max(d, this.options.lodBase * 0.1);
            const cos = c2 > 0 ? dot / (Math.sqrt(c2) * fl) : 1;
            const t = d > 0 ? Math.min(1, Math.max(0, (0.6 - cos) / 1.2)) : 0;
            this.dEff[i] = floored * (1 + (gazePenalty - 1) * t * t * (3 - 2 * t));
        }
        const budget = Math.max(0, this.options.budget - (this.envFile?.state === FileState.Loaded ? this.envFile.count : 0));
        let scale = 1;
        if (this.countAtScale(1, false) > budget) {
            let lo = 0,
                hi = Math.log(1e5);
            for (let it = 0; it < 18; it++) {
                const mid = (lo + hi) / 2;
                if (this.countAtScale(Math.exp(mid), false) > budget) lo = mid;
                else hi = mid;
            }
            scale = Math.exp(hi);
        }
        this.lodScale = scale;
        this.desiredSplats = this.countAtScale(scale, true);
        const gen = ++this.selectionGen;
        const L = this.levels;
        for (let i = 0; i < this.numLeaves; i++) {
            const level = this.desired[i];
            if (level < 0) continue;
            const file = this.files[this.leafFile[i * L + level]];
            if (file.neededGen !== gen) {
                file.neededGen = gen;
                file.priority = this.dEff[i];
                file.lastNeeded = now;
            } else if (this.dEff[i] < file.priority) {
                file.priority = this.dEff[i];
            }
        }
        for (const file of this.files) {
            if (file.pinned && file.neededGen !== gen) {
                file.neededGen = gen;
                file.priority = -1;
                file.lastNeeded = now;
            } else if (file.pinned) {
                file.priority = -1;
            }
        }
        this.order = this.files.filter((f) => f.neededGen === gen).sort((a, b) => a.priority - b.priority);
        this.stateDirty = true;
    }
    evictFor(size) {
        const gen = this.selectionGen;
        const candidates = this.files
            .filter((f) => f.state === FileState.Loaded && !f.pinned && f.neededGen !== gen)
            .sort((a, b) => {
                const ar = a.renderedGen === this.rebuildGen ? 1 : 0;
                const br = b.renderedGen === this.rebuildGen ? 1 : 0;
                return ar - br || a.lastNeeded - b.lastNeeded;
            });
        for (const f of candidates) {
            this.allocator.release(f.base, f.count);
            f.state = FileState.Idle;
            f.base = -1;
            this.stateDirty = true;
            const base = this.allocator.alloc(size);
            if (base >= 0) {
                this.allocator.release(base, size);
                return true;
            }
        }
        return false;
    }
    tryUpload(file) {
        const src = file.src;
        let base = this.allocator.alloc(src.count);
        if (base < 0 && this.evictFor(src.count)) base = this.allocator.alloc(src.count);
        if (base < 0) return false;
        file.base = base;
        file.state = FileState.Loaded;
        file.src = null;
        this.renderer.queueDecode(src, base);
        this.stateDirty = true;
        return true;
    }
    stream(maxUploads) {
        let uploads = 0;
        if (this.envFile?.state === FileState.Fetched && this.tryUpload(this.envFile)) uploads++;
        const gen = this.selectionGen;
        let reserved = 0;
        for (const f of this.files) {
            if (f.state === FileState.Loading || f.state === FileState.Fetched) reserved += f.count;
            else if (f.state === FileState.Loaded && (f.pinned || f.neededGen === gen)) reserved += f.count;
        }
        if (this.envFile) reserved += this.envFile.count;
        for (const file of this.order) {
            if (file.state === FileState.Fetched && uploads < maxUploads) {
                if (this.tryUpload(file)) uploads++;
            } else if (file.state === FileState.Idle && !file.failed && this.loading < this.options.maxConcurrent) {
                if (reserved + file.count > this.allocator.capacity) continue;
                reserved += file.count;
                this.startFetch(file);
            }
        }
        for (const file of this.files) {
            if (file.neededGen === gen) continue;
            if (file.state === FileState.Loading) file.abort?.abort();
            else if (file.state === FileState.Fetched) {
                const s = file.src;
                for (const b of [s.meansL, s.meansU, s.scales, s.sh0, s.quats]) b?.close();
                file.src = null;
                file.state = FileState.Idle;
            }
        }
    }
    rebuild() {
        const L = this.levels;
        const gen = ++this.rebuildGen;
        let data = this.intervalData;
        const needed = (this.numLeaves + 1) * 2;
        if (data.length < needed) data = this.intervalData = new Uint32Array(needed * 2);
        let n = 0;
        let total = 0;
        let lastEnd = -1;
        const push = (src, count) => {
            if (src === lastEnd) {
            } else {
                data[n * 2] = total;
                data[n * 2 + 1] = src;
                n++;
            }
            total += count;
            lastEnd = src + count;
        };
        if (this.envFile?.state === FileState.Loaded) push(this.envFile.base, this.envFile.count);
        const loaded = (leaf, level) => {
            const fi = this.leafFile[leaf * L + level];
            return fi >= 0 && this.files[fi].state === FileState.Loaded;
        };
        for (let i = 0; i < this.numLeaves; i++) {
            const want = this.desired[i];
            let level = -1;
            if (want >= 0) {
                for (let l = want; l < L && level < 0; l++) if (loaded(i, l)) level = l;
                for (let l = want - 1; l >= 0 && level < 0; l--) if (loaded(i, l)) level = l;
            }
            if (level < 0) continue;
            const k = i * L + level;
            const file = this.files[this.leafFile[k]];
            file.renderedGen = gen;
            push(file.base + this.leafOffset[k], this.leafCount[k]);
        }
        this.renderer.setIntervals(data, n, total);
    }
    update(cam, fwd, now, maxUploads = 1) {
        if (now - this.lastSelect > 100) {
            this.lastSelect = now;
            this.select(cam, fwd, now);
        }
        this.stream(maxUploads);
        if (this.stateDirty) {
            this.stateDirty = false;
            this.rebuild();
            this.renderer.boundsMin = this.boundsMin;
            this.renderer.boundsMax = this.boundsMax;
        }
    }
}
