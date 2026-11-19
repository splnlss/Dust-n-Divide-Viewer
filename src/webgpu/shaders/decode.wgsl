struct SplatA { pos: vec3f, color: u32 }
struct SplatB { c0: u32, c1: u32, c2: u32, scale: f32 }

struct Params {
  mins: vec3f,
  count: u32,
  maxs: vec3f,
  base: u32,
  width: u32,
  version: u32,
  pad0: u32,
  pad1: u32,
  codebook: array<vec4f, 256>,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var meansL: texture_2d<f32>;
@group(0) @binding(2) var meansU: texture_2d<f32>;
@group(0) @binding(3) var scalesT: texture_2d<f32>;
@group(0) @binding(4) var quatsT: texture_2d<f32>;
@group(0) @binding(5) var sh0T: texture_2d<f32>;
@group(0) @binding(6) var<storage, read_write> A: array<SplatA>;
@group(0) @binding(7) var<storage, read_write> B: array<SplatB>;

const SH_C0 = 0.28209479177387814;
const SQRT2 = 1.4142135623730951;
const HALF_PI = 1.5707963267948966;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let uv = vec2i(i32(i % P.width), i32(i / P.width));

  let l = textureLoad(meansL, uv, 0);
  let u = textureLoad(meansU, uv, 0);
  let sc = textureLoad(scalesT, uv, 0);
  let c = textureLoad(sh0T, uv, 0);

  let n = (l.xyz + u.xyz * 256.0) / 257.0;
  let v = mix(P.mins, P.maxs, n);
  let pos = sign(v) * (exp(abs(v)) - 1.0);

  var q: vec4f;
  if (P.version >= 3u) {
    let b = floor(vec3f(l.w, u.w, sc.w) * 255.0 + 0.5);
    let p = (b - 128.0) / 127.0;
    let len = length(p);
    let t = len * HALF_PI;
    let xyz = select(p * HALF_PI, p * (sin(t) / len), len > 1e-6);
    q = vec4f(cos(t), xyz);
  } else {
    let qt = textureLoad(quatsT, uv, 0);
    let mode = u32(qt.w * 255.0 + 0.5) - 252u;
    let abc = (qt.xyz - 0.5) * SQRT2;
    let d = sqrt(max(0.0, 1.0 - dot(abc, abc)));
    if (mode == 0u) { q = vec4f(d, abc); }
    else if (mode == 1u) { q = vec4f(abc.x, d, abc.y, abc.z); }
    else if (mode == 2u) { q = vec4f(abc.x, abc.y, d, abc.z); }
    else { q = vec4f(abc.x, abc.y, abc.z, d); }
  }
  q = normalize(q);

  let si = vec3u(sc.xyz * 255.0 + 0.5);
  let s = exp(vec3f(P.codebook[si.x].x, P.codebook[si.y].x, P.codebook[si.z].x));

  let w = q.x; let x = q.y; let y = q.z; let z = q.w;
  let sMax = max(s.x, max(s.y, s.z));
  let sn = s / sMax;
  let M = mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)) * sn.x,
    vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)) * sn.y,
    vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)) * sn.z,
  );
  let S = M * transpose(M);

  let ci = vec3u(c.xyz * 255.0 + 0.5);
  let rgb = vec3f(0.5) + SH_C0 * vec3f(P.codebook[ci.x].y, P.codebook[ci.y].y, P.codebook[ci.z].y);
  var alpha = c.w;
  if (P.version >= 3u) {
    let o = 1.25 * c.w;
    alpha = min(o * o, 1.0);
  }

  let o = P.base + i;
  A[o] = SplatA(pos, pack4x8unorm(vec4f(rgb, alpha)));
  B[o] = SplatB(
    pack2x16float(vec2f(S[0][0], S[0][1])),
    pack2x16float(vec2f(S[0][2], S[1][1])),
    pack2x16float(vec2f(S[1][2], S[2][2])),
    sMax * sMax,
  );
}
