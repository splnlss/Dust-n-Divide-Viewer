#if F16
enable f16;
#endif

struct SplatA { pos: vec3f, color: u32 }
struct SplatB { c0: u32, c1: u32, c2: u32, scale: f32 }

struct View {
  modelView: mat4x4f,
  proj: mat4x4f,
  viewport: vec2f,
  focal: vec2f,
  near: f32,
  minTrace: f32,
  maxExtent: f32,
  pad0: f32,
  revealCenter: vec3f,
  revealFront: f32,
  revealUp: vec3f,
  metersPerUnit: f32,
  revealTime: f32,
  revealLift: f32,
  revealOn: f32,
  pad1: f32,
}

override AA: bool = false;
override SRGB_OUT: bool = false;

@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var<storage, read> order: array<u32>;
@group(0) @binding(2) var<storage, read> A: array<SplatA>;
@group(0) @binding(3) var<storage, read> B: array<SplatB>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,
  @location(1) @interpolate(flat) color: vec4f,
}

const LOWPASS = 0.3;
// Kept close to the Quest 3-verified version: a restructured variant showed rainbow colours there.
override ALPHA_CUT: f32 = 0.00392156862745098;
override MAX_R2: f32 = 4.0;

@vertex
fn vs(@builtin(vertex_index) vidx: u32) -> VOut {
  let ii = vidx >> 2u;
  let vi = vidx & 3u;
  var out: VOut;
  out.pos = vec4f(0.0, 0.0, 2.0, 1.0);

  let id = order[ii];
  let a = A[id];
  var pos = a.pos;
  var dotWeight = 0.0;
  var fullWeight = 1.0;
  if (V.revealOn > 0.5) {
    let behindFront = V.revealFront - distance(pos, V.revealCenter) * V.metersPerUnit;
    if (behindFront < -1.0) { return out; }
    if (behindFront < 0.0) {
      let g = smoothstep(-1.0, 0.0, behindFront);
      dotWeight = g * g;
      fullWeight = 0.0;
    } else if (behindFront < 2.0) {
      fullWeight = 0.5 * behindFront;
      dotWeight = 1.0 - fullWeight;
    }
    let phase = fract(sin(dot(pos, vec3f(127.1, 311.7, 74.7))) * 43758.5453) * 6.28318;
    let frontGap = abs(behindFront);
    let bump = select(0.0, (1.0 - frontGap) * sin(frontGap * 3.14159) * 0.9, frontGap < 1.0);
    let wobble = sin(V.revealTime * 3.0 + phase) * 0.25 * (1.0 - smoothstep(0.5, 1.5, behindFront));
    pos += V.revealUp * (V.revealLift * (wobble + bump));
  }
  let vp = (V.modelView * vec4f(pos, 1.0)).xyz;
  let depth = -vp.z;
  if (depth < V.near) { return out; }

  var col = unpack4x8unorm(a.color);
  if (col.a < ALPHA_CUT) { return out; }

  let b = B[id];
  let c0 = unpack2x16float(b.c0);
  let c1 = unpack2x16float(b.c1);
  let c2 = unpack2x16float(b.c2);
  let S = mat3x3f(c0.x, c0.y, c1.x, c0.y, c1.y, c2.x, c1.x, c2.x, c2.y);

  let r0 = vec3f(V.modelView[0].x, V.modelView[1].x, V.modelView[2].x);
  let r1 = vec3f(V.modelView[0].y, V.modelView[1].y, V.modelView[2].y);
  let r2 = vec3f(V.modelView[0].z, V.modelView[1].z, V.modelView[2].z);
  let iz = 1.0 / depth;
  let t0 = V.focal.x * iz * (r0 + (vp.x * iz) * r2);
  let t1 = V.focal.y * iz * (r1 + (vp.y * iz) * r2);

  let St0 = S * t0;
  let St1 = S * t1;
  var ca = dot(t0, St0) * b.scale;
  var cb = dot(t0, St1) * b.scale;
  var cc = dot(t1, St1) * b.scale;

  if (ca + cc < V.minTrace) { return out; }

  if (fullWeight < 1.0) {
    let dotVariance = dotWeight * 0.01 / 3.0 * (c0.x + c1.y + c2.y) * b.scale;
    ca = ca * fullWeight + dotVariance * dot(t0, t0);
    cb = cb * fullWeight + dotVariance * dot(t0, t1);
    cc = cc * fullWeight + dotVariance * dot(t1, t1);
  }

  if (AA) {
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
  let e1 = min(r * sqrt(l1), V.maxExtent);
  let e2 = min(r * sqrt(l2), V.maxExtent);

  let clip = V.proj * vec4f(vp, 1.0);
  let pxToClip = 2.0 / V.viewport * clip.w;
  if (any(abs(clip.xy) > vec2f(clip.w) + max(e1, e2) * pxToClip)) { return out; }

  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  let off = corner.x * e1 * ax + corner.y * e2 * vec2f(-ax.y, ax.x);

  if (SRGB_OUT) { col = vec4f(pow(col.rgb, vec3f(2.2)), col.a); }

  out.pos = vec4f(clip.xy + off * pxToClip, clamp(clip.z, 0.0, clip.w), clip.w);
  out.q = corner * r;
  out.color = col;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
#if F16
  let q = vec2<f16>(in.q);
  let c = vec4<f16>(in.color);
  let kc = f16(exp(-0.5 * MAX_R2));
  let a = c.a * (exp(-0.5h * dot(q, q)) - kc) / (1.0h - kc);
  if (a < f16(ALPHA_CUT)) { discard; }
  return vec4f(vec4<f16>(c.rgb * a, a));
#else
  let kc = exp(-0.5 * MAX_R2);
  let a = in.color.a * (exp(-0.5 * dot(in.q, in.q)) - kc) / (1.0 - kc);
  if (a < ALPHA_CUT) { discard; }
  return vec4f(in.color.rgb * a, a);
#endif
}
