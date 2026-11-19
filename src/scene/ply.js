import { httpError } from './sog.js';

export const PLY_FLOATS = 14;
export const PLY_BATCH = 65536;

const SH_C0 = 0.28209479177387814;
const TYPES = {
    char: [1, 'getInt8'],
    int8: [1, 'getInt8'],
    uchar: [1, 'getUint8'],
    uint8: [1, 'getUint8'],
    short: [2, 'getInt16'],
    int16: [2, 'getInt16'],
    ushort: [2, 'getUint16'],
    uint16: [2, 'getUint16'],
    int: [4, 'getInt32'],
    int32: [4, 'getInt32'],
    uint: [4, 'getUint32'],
    uint32: [4, 'getUint32'],
    float: [4, 'getFloat32'],
    float32: [4, 'getFloat32'],
    double: [8, 'getFloat64'],
    float64: [8, 'getFloat64'],
};

export function isPlyName(name) {
    return /\.ply$/i.test(name.split(/[?#]/)[0]);
}

export async function openPly(source) {
    let stream, total, name;
    if (source instanceof Blob) {
        stream = source.stream();
        total = source.size;
        name = source.name ?? 'file.ply';
    } else {
        const r = await fetch(source);
        if (!r.ok) throw httpError(r, source);
        stream = r.body;
        total = Number(r.headers.get('content-length')) || 0;
        name = source;
    }
    const reader = stream.getReader();

    let head = new Uint8Array(0);
    let end = -1;
    while (end < 0) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Not a PLY file: no end_header');
        const merged = new Uint8Array(head.length + value.length);
        merged.set(head);
        merged.set(value, head.length);
        head = merged;
        end = findHeaderEnd(head);
        if (end < 0 && head.length > 1 << 20) throw new Error('Not a PLY file: header too long');
    }
    const text = new TextDecoder().decode(head.subarray(0, end));
    const header = parseHeader(text);
    header.name = name;
    header.total = total;
    header.reader = reader;
    header.leftover = head.subarray(end);
    header.headerBytes = end;
    return header;
}

function findHeaderEnd(bytes) {
    const marker = 'end_header';
    const limit = bytes.length - marker.length;
    outer: for (let i = 0; i < limit; i++) {
        for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker.charCodeAt(j)) continue outer;
        let k = i + marker.length;
        if (bytes[k] === 13) k++;
        if (k < bytes.length && bytes[k] === 10) return k + 1;
        return -1;
    }
    return -1;
}

function parseHeader(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    if (lines[0] !== 'ply') throw new Error('Not a PLY file');
    let format = null;
    const elements = [];
    for (const line of lines.slice(1)) {
        const p = line.split(/\s+/);
        if (p[0] === 'format') format = p[1];
        else if (p[0] === 'element') elements.push({ name: p[1], count: Number(p[2]), props: [] });
        else if (p[0] === 'property') {
            const el = elements[elements.length - 1];
            if (!el) throw new Error('PLY property before any element');
            if (p[1] === 'list') throw new Error(`PLY list properties are not supported (${p.slice(-1)[0]})`);
            if (!TYPES[p[1]]) throw new Error(`Unknown PLY property type ${p[1]}`);
            el.props.push({ name: p[2], type: p[1] });
        }
    }
    if (format !== 'binary_little_endian') {
        throw new Error(`PLY format "${format}" is not supported; export it as binary_little_endian`);
    }
    if (elements.some((e) => e.name === 'chunk') || elements.some((e) => e.props.some((p) => p.name.startsWith('packed_')))) {
        throw new Error('This is a compressed PLY (SuperSplat). Export an uncompressed PLY, or convert it to SOG.');
    }
    const vertexIndex = elements.findIndex((e) => e.name === 'vertex');
    if (vertexIndex < 0) throw new Error('PLY has no vertex element');
    if (elements.slice(0, vertexIndex).some((e) => e.count > 0)) {
        throw new Error('PLY elements before the vertices are not supported');
    }
    const vertex = elements[vertexIndex];

    let offset = 0;
    const byName = {};
    for (const prop of vertex.props) {
        const [size, getter] = TYPES[prop.type];
        prop.offset = offset;
        prop.getter = getter;
        offset += size;
        byName[prop.name] = prop;
    }
    const has = (...names) => names.every((n) => byName[n]);
    if (!has('x', 'y', 'z')) throw new Error('PLY vertices have no x/y/z');
    if (!has('scale_0', 'scale_1', 'scale_2')) {
        throw new Error('This PLY has no scale_0..2: it looks like a point cloud, not gaussian splats');
    }
    const colorFrom = has('f_dc_0', 'f_dc_1', 'f_dc_2') ? 'sh' : has('red', 'green', 'blue') ? 'rgb' : null;
    if (!colorFrom) throw new Error('PLY has no colour (f_dc_0..2 or red/green/blue)');

    const allFloat = vertex.props.every((p) => p.type === 'float' || p.type === 'float32');
    return { count: vertex.count, stride: offset, props: byName, colorFrom, hasOpacity: has('opacity'), hasRotation: has('rot_0', 'rot_1', 'rot_2', 'rot_3'), allFloat: allFloat && offset % 4 === 0, shBands: Math.round(Math.sqrt(vertex.props.filter((p) => p.name.startsWith('f_rest_')).length / 3 + 1) - 1) };
}

export async function readBody(ply, onBatch, onProgress) {
    const { count, stride, reader } = ply;
    const out = new Float32Array(PLY_BATCH * PLY_FLOATS);
    const work = new Uint8Array(PLY_BATCH * stride);
    const workF32 = ply.allFloat ? new Float32Array(work.buffer) : null;
    const workView = new DataView(work.buffer);
    const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
    const sampleEvery = Math.max(1, Math.floor(count / 200_000));
    const sample = [];

    const P = ply.props;
    const fields = ['x', 'y', 'z', ...(ply.colorFrom === 'sh' ? ['f_dc_0', 'f_dc_1', 'f_dc_2'] : ['red', 'green', 'blue']), 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'].map((n) => P[n] ?? null);
    const floatIndex = fields.map((f) => (f ? f.offset / 4 : -1));
    const rgbScale = (t) => (t === 'float' || t === 'float32' || t === 'double' || t === 'float64' ? 1 : t.includes('16') || t === 'ushort' || t === 'short' ? 1 / 65535 : 1 / 255);
    const colorScale = ply.colorFrom === 'rgb' ? rgbScale(P.red.type) : 1;

    let done = 0;
    let filled = 0;
    let pending = ply.leftover;
    let finished = false;

    const flush = async (rows) => {
        for (let r = 0; r < rows; r++) {
            const o = r * PLY_FLOATS;
            for (let k = 0; k < PLY_FLOATS; k++) {
                const f = fields[k];
                let v;
                if (!f) v = k === 6 ? 10 : k === 10 ? 1 : 0;
                else if (workF32) v = workF32[r * (stride >> 2) + floatIndex[k]];
                else v = workView[f.getter](r * stride + f.offset, true);
                out[o + k] = v;
            }
            if (ply.colorFrom === 'rgb') {
                for (let k = 3; k < 6; k++) out[o + k] = (out[o + k] * colorScale - 0.5) / SH_C0;
            }
            const x = out[o],
                y = out[o + 1],
                z = out[o + 2];
            if (x < min[0]) min[0] = x;
            if (x > max[0]) max[0] = x;
            if (y < min[1]) min[1] = y;
            if (y > max[1]) max[1] = y;
            if (z < min[2]) min[2] = z;
            if (z > max[2]) max[2] = z;
            if ((done + r) % sampleEvery === 0) sample.push(x, y, z);
        }
        await onBatch(out.subarray(0, rows * PLY_FLOATS), done, rows);
        done += rows;
        onProgress?.(done, count);
    };

    while (done < count) {
        while (pending.length && filled < work.length) {
            const take = Math.min(pending.length, work.length - filled);
            work.set(pending.subarray(0, take), filled);
            filled += take;
            pending = pending.subarray(take);
        }
        const rowsReady = Math.min(Math.floor(filled / stride), count - done);
        if (rowsReady === PLY_BATCH || (finished && rowsReady > 0) || rowsReady === count - done) {
            if (rowsReady > 0) {
                await flush(rowsReady);
                const used = rowsReady * stride;
                work.copyWithin(0, used, filled);
                filled -= used;
                continue;
            }
        }
        if (finished) throw new Error(`PLY ended early: ${done} of ${count} splats`);
        const { value, done: eof } = await reader.read();
        if (eof) finished = true;
        else pending = pending.length ? concat(pending, value) : value;
    }
    reader.cancel().catch(() => {});
    return { min, max, sample: new Float32Array(sample) };
}

function concat(a, b) {
    const c = new Uint8Array(a.length + b.length);
    c.set(a);
    c.set(b, a.length);
    return c;
}

export function closePly(ply) {
    ply?.reader?.cancel().catch(() => {});
}
