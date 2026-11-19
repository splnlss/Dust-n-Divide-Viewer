struct SplatA { pos: vec3f, color: u32 }

struct Frame {
  cull: array<mat4x4f, 2>,
  camPos: vec3f,
  numActive: u32,
  logFar: f32,
  keyScale: f32,
  minDist: f32,
  maxKey: f32,
  numViews: u32,
  near: f32,
  cullMargin: f32,
  minOpacity: f32,
}

const INVALID = 0xffffffffu;

#if STAGE == 0
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> A: array<SplatA>;
@group(0) @binding(2) var<storage, read> activeIds: array<u32>;
@group(0) @binding(3) var<storage, read_write> keys: array<u32>;
@group(0) @binding(4) var<storage, read_write> hist: array<atomic<u32>>;

@compute @workgroup_size(256)
fn key(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= F.numActive) { return; }
  let a = A[activeIds[i]];
  if (unpack4x8unorm(a.color).a < F.minOpacity) {
    keys[i] = INVALID;
    return;
  }
  let p = a.pos;
  let p4 = vec4f(p, 1.0);

  var visible = false;
  for (var v = 0u; v < F.numViews; v++) {
    let c = F.cull[v] * p4;
    let m = c.w * F.cullMargin;
    if (c.w > F.near && abs(c.x) <= m && abs(c.y) <= m) { visible = true; }
  }
  if (!visible) {
    keys[i] = INVALID;
    return;
  }

  let d = max(distance(p, F.camPos), F.minDist);
  let k = u32(clamp((F.logFar - log2(d)) * F.keyScale, 0.0, F.maxKey));
  keys[i] = k;
  atomicAdd(&hist[k], 1u);
}
#endif

#if STAGE == 1
override TOP: u32 = 64u;
override DRAW_BATCHES: u32 = 1u;
override DRAW_BATCH: u32 = 65536u;

@group(0) @binding(0) var<storage, read_write> hist: array<u32>;
@group(0) @binding(1) var<storage, read_write> sums: array<u32>;
@group(0) @binding(2) var<storage, read_write> drawArgs: array<u32>;

@compute @workgroup_size(64)
fn sumA(@builtin(global_invocation_id) gid: vec3u) {
  let g = gid.x;
  if (g >= TOP * 64u) { return; }
  let base = g * 64u;
  var sum = 0u;
  for (var j = 0u; j < 64u; j++) { sum += hist[base + j]; }
  sums[g] = sum;
}

@compute @workgroup_size(64)
fn sumB(@builtin(global_invocation_id) gid: vec3u) {
  let t = gid.x;
  if (t >= TOP) { return; }
  let base = t * 64u;
  var sum = 0u;
  for (var j = 0u; j < 64u; j++) { sum += sums[base + j]; }
  sums[TOP * 64u + t] = sum;
}

@compute @workgroup_size(1)
fn scanTop() {
  var running = 0u;
  for (var t = 0u; t < TOP; t++) {
    let v = sums[TOP * 64u + t];
    sums[TOP * 64u + t] = running;
    running += v;
  }
  drawArgs[1] = running;
  for (var k = 0u; k < DRAW_BATCHES; k++) {
    let o = 8u + 5u * k;
    let start = k * DRAW_BATCH;
    drawArgs[o] = (min(running, start + DRAW_BATCH) - min(running, start)) * 6u;
    drawArgs[o + 1u] = 1u;
    drawArgs[o + 2u] = 0u;
    drawArgs[o + 3u] = start * 4u;
    drawArgs[o + 4u] = 0u;
  }
}

@compute @workgroup_size(64)
fn scanB(@builtin(global_invocation_id) gid: vec3u) {
  let t = gid.x;
  if (t >= TOP) { return; }
  let base = t * 64u;
  var running = sums[TOP * 64u + t];
  for (var j = 0u; j < 64u; j++) {
    let v = sums[base + j];
    sums[base + j] = running;
    running += v;
  }
}

@compute @workgroup_size(64)
fn scanC(@builtin(global_invocation_id) gid: vec3u) {
  let g = gid.x;
  if (g >= TOP * 64u) { return; }
  let base = g * 64u;
  var running = sums[g];
  for (var j = 0u; j < 64u; j++) {
    let v = hist[base + j];
    hist[base + j] = running;
    running += v;
  }
}
#endif

#if STAGE == 2
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> activeIds: array<u32>;
@group(0) @binding(2) var<storage, read> keys: array<u32>;
@group(0) @binding(3) var<storage, read_write> hist: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> order: array<u32>;

@compute @workgroup_size(256)
fn scatter(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= F.numActive) { return; }
  let k = keys[i];
  if (k == INVALID) { return; }
  let slot = atomicAdd(&hist[k], 1u);
  order[slot] = activeIds[i];
}
#endif

#if STAGE == 3
override NUM_BINS: u32 = 262144u;
override MAX_RUN: u32 = 32u;

@group(0) @binding(0) var<storage, read> hist: array<u32>;
@group(0) @binding(1) var<storage, read_write> order: array<u32>;

@compute @workgroup_size(64)
fn tiebreak(@builtin(global_invocation_id) gid: vec3u) {
  let b = gid.x;
  if (b >= NUM_BINS) { return; }
  let end = hist[b];
  var start = 0u;
  if (b > 0u) { start = hist[b - 1u]; }
  let n = end - start;
  if (n < 2u || n > MAX_RUN) { return; }
  for (var i = start + 1u; i < end; i++) {
    let v = order[i];
    var j = i;
    while (j > start && order[j - 1u] > v) {
      order[j] = order[j - 1u];
      j--;
    }
    order[j] = v;
  }
}
#endif
