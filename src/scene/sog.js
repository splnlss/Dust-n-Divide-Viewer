async function decodeImage(blob) {
    return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}
function checkMeta(meta) {
    if (meta.version !== 2 && meta.version !== 3) {
        throw new Error(`Unsupported SOG version ${meta.version ?? '(legacy v1)'}; only v2 and v3 are supported`);
    }
    if (meta.model === '2dgs') throw new Error('2DGS SOG scenes are not supported');
}
async function buildChunk(meta, get, signal) {
    checkMeta(meta);
    const names = [meta.means.files[0], meta.means.files[1], meta.scales.files[0], meta.sh0.files[0]];
    if (meta.version === 2) names.push(meta.quats.files[0]);
    const bitmaps = await Promise.all(names.map(async (n) => decodeImage(await get(n))));
    if (signal?.aborted) {
        for (const b of bitmaps) b.close();
        throw new DOMException('aborted', 'AbortError');
    }
    const [meansL, meansU, scales, sh0, quats] = bitmaps;
    if (meta.count > meansL.width * meansL.height) throw new Error('SOG count exceeds texture size');
    return { version: meta.version, count: meta.count, width: meansL.width, height: meansL.height, mins: meta.means.mins, maxs: meta.means.maxs, scalesCodebook: meta.scales.codebook, sh0Codebook: meta.sh0.codebook, meansL, meansU, scales, sh0, quats: quats ?? null };
}
export function httpError(r, url) {
    return new Error(`${r.status} ${r.statusText} for ${url}`);
}
export async function fetchJson(url, signal) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw httpError(r, url);
    return r.json();
}
export async function loadSogChunk(metaUrl, signal, meta) {
    const m = meta ?? (await fetchJson(metaUrl, signal));
    const chunk = await buildChunk(
        m,
        async (name) => {
            const url = new URL(name, metaUrl).href;
            const r = await fetch(url, { signal });
            if (!r.ok) throw httpError(r, url);
            return r.blob();
        },
        signal,
    );
    return { meta: m, chunk };
}
export async function loadSogBundle(url) {
    let bytes;
    if (url instanceof Blob) {
        bytes = new Uint8Array(await url.arrayBuffer());
    } else {
        const r = await fetch(url);
        if (!r.ok) throw httpError(r, url);
        bytes = new Uint8Array(await r.arrayBuffer());
    }
    const files = await unzip(bytes);
    const metaBytes = files.get('meta.json');
    if (!metaBytes) throw new Error('.sog archive has no meta.json');
    const meta = JSON.parse(new TextDecoder().decode(metaBytes));
    const chunk = await buildChunk(meta, async (name) => {
        const bytes = files.get(name);
        if (!bytes) throw new Error(`.sog archive is missing ${name}`);
        return new Blob([bytes], { type: 'image/webp' });
    });
    return { meta, chunk };
}
export function unlog(v) {
    return Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
}
async function unzip(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let eocd = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive');
    const entries = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = new Map();
    const dec = new TextDecoder();
    for (let e = 0; e < entries; e++) {
        if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
        const method = dv.getUint16(p + 10, true);
        const compSize = dv.getUint32(p + 20, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const local = dv.getUint32(p + 42, true);
        const name = dec.decode(data.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        const raw = data.subarray(start, start + compSize);
        if (method === 0) {
            out.set(name, raw);
        } else if (method === 8) {
            const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
        } else {
            throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
        }
    }
    return out;
}
