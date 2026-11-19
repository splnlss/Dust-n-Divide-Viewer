import { standalone } from './platform.js';

export { standalone };
const pick = (desktop, headset) => (standalone ? headset : desktop);

export const config = {
    // default scene; ?scene=<url> overrides it
    scene: 'https://pub-dd92ae5131ec49f1bbd411b51a858249.r2.dev/01_SLV_RondaJoseph/20260820_RondaLobato/web/lod/lod-meta.json',
    budget: pick(3_000_000, 1_000_000),
    xrBudget: 1_000_000,
    budgetRange: pick([3_000_000, 6_000_000], [1_000_000, 2_000_000]),
    budgetStep: pick(250_000, 100_000),
    xrBudgetRange: [500_000, 3_000_000],
    xrBudgetStep: 100_000,
    capacity: pick(12_000_000, 0),
    lodBase: 5,
    lodMult: 3,
    gazePenalty: 3,
    minPixel: pick(0.2, 1),
    splatCut: 1,
    maxSigma: 1.7,
    // splats fainter than this opacity (0–1) are not drawn; 0 draws all
    minOpacity: 0.05,
    f16: true,
    sortBits: 0,
    sortSkip: pick(0, 1),
    tieBreak: pick(32, 0),
    rot: null,
    scale: 1,
    pos: null,
    yaw: null,
    pitch: null,
    speed: null,
    fov: 60,
    maxDpr: pick(2, 1),
    xrScale: 1,
    xrMinScale: 1,
    foveation: 1,
    xrFrameRate: pick(0, 72),
    xrSpeed: 2.5,
    smoothTurn: false,
    auto: 'vr',
    xrBudgetReadout: { show: true, x: -0.3, y: 0.24, distance: 1, size: 0.03 },
    teleport: true,
    teleportSpeed: 7.5,
    teleportCancel: 60,
    // splats grow in from the camera start position on load (front at speed·t + ½·acceleration·t² metres; lift scales the wobble); null disables
    reveal: { speed: 3, acceleration: 8, lift: 1 },
    sky: { zenith: [0.24, 0.45, 0.78], horizon: [0.72, 0.83, 0.93], ground: [0.38, 0.38, 0.36] },
    background: [0.04, 0.04, 0.05],
    stereo: false,
    log: false,
    wander: 0,
};

const q = new URLSearchParams(location.search);
export const backendChoice = ['webgpu', 'webgl'].includes(q.get('backend')) ? q.get('backend') : null;
if (q.get('scene')) config.scene = q.get('scene');
const xrBudget = Number(q.get('xrbudget'));
if (q.get('xrbudget') && Number.isFinite(xrBudget) && xrBudget > 0) config.xrBudget = Math.round(xrBudget);
for (const [param, key] of [
    ['maxsigma', 'maxSigma'],
    ['minopacity', 'minOpacity'],
]) {
    const v = Number(q.get(param));
    if (q.get(param) && Number.isFinite(v) && v >= 0) config[key] = v;
}
