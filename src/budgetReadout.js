import { transformPoint } from './math.js';

const FLOATS_PER_VERTEX = 7;
const BACKGROUND = [0.06, 0.06, 0.08, 0.6];
const WHITE = [0.92, 0.92, 0.95, 1];

const GLYPHS = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', M: 'abcefm', '.': 'p' };
const WIDTH = 0.6;
const STROKE = 0.14;
const GAP = 0.25;
const PAD = 0.45;
const WIDTHS = { '.': STROKE, M: 0.8 };

function segmentRect(s, w) {
    const t = STROKE,
        m = 0.5;
    switch (s) {
        case 'p':
            return [0, 0, t, t];
        case 'm':
            return [w / 2 - t / 2, m, w / 2 + t / 2, 1];
        case 'a':
            return [0, 1 - t, w, 1];
        case 'g':
            return [0, m - t / 2, w, m + t / 2];
        case 'd':
            return [0, 0, w, t];
        case 'f':
            return [0, m, t, 1];
        case 'b':
            return [w - t, m, w, 1];
        case 'e':
            return [0, 0, t, m];
        case 'c':
            return [w - t, 0, w, m];
    }
}

export function drawBudgetReadout(overlay, head, budget, opts) {
    const text = `${Number((budget / 1e6).toFixed(2))}M`;
    const h = opts.size;
    const glyphWidth = (ch) => WIDTHS[ch] ?? WIDTH;
    const width = (text.split('').reduce((sum, ch) => sum + glyphWidth(ch) + GAP, 0) - GAP) * h;
    const left = opts.x,
        top = opts.y,
        z = -opts.distance;
    const rect = (x0, y0, x1, y1, c) => {
        const p = (x, y) => transformPoint(head, [x, y, z]);
        const a = p(x0, y0),
            b = p(x1, y0),
            cc = p(x0, y1),
            d = p(x1, y1);
        for (const v of [a, b, cc, cc, b, d]) vertex(overlay, v, c);
    };
    rect(left - PAD * h, top - h - PAD * h, left + width + PAD * h, top + PAD * h, BACKGROUND);
    let ox = left;
    const oy = top - h;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i],
            w = glyphWidth(ch);
        for (const s of GLYPHS[ch] ?? '') {
            const [x0, y0, x1, y1] = segmentRect(s, w);
            rect(ox + x0 * h, oy + y0 * h, ox + x1 * h, oy + y1 * h, WHITE);
        }
        ox += (w + GAP) * h;
    }
}

function vertex(o, p, c) {
    if ((o.count + 1) * FLOATS_PER_VERTEX > o.data.length) return;
    const k = o.count * FLOATS_PER_VERTEX;
    o.data[k] = p[0];
    o.data[k + 1] = p[1];
    o.data[k + 2] = p[2];
    o.data[k + 3] = c[0];
    o.data[k + 4] = c[1];
    o.data[k + 5] = c[2];
    o.data[k + 6] = c[3];
    o.count++;
}
