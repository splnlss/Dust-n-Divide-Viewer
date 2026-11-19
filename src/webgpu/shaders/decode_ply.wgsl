struct SplatA { pos: vec3f, color: u32 }
struct SplatB { c0: u32, c1: u32, c2: u32, scale: f32 }
struct Params { base: u32, count: u32, pad0: u32, pad1: u32 }

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> raw: array<f32>;
@group(0) @binding(2) var<storage, read_write> A: array<SplatA>;
@group(0) @binding(3) var<storage, read_write> B: array<SplatB>;

const SH_C0 = 0.28209479177387814;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let r = i * 14u;
  let pos = vec3f(raw[r], raw[r + 1u], raw[r + 2u]);
  let dc = vec3f(raw[r + 3u], raw[r + 4u], raw[r + 5u]);
  let logit = raw[r + 6u];
  let s = exp(clamp(vec3f(raw[r + 7u], raw[r + 8u], raw[r + 9u]), vec3f(-30.0), vec3f(15.0)));
  var q = vec4f(raw[r + 10u], raw[r + 11u], raw[r + 12u], raw[r + 13u]);
  let ql = length(q);
  q = select(vec4f(1.0, 0.0, 0.0, 0.0), q / ql, ql > 1e-12);

  let w = q.x; let x = q.y; let y = q.z; let z = q.w;
  let sMax = max(s.x, max(s.y, s.z));
  let sn = s / sMax;
  let M = mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)) * sn.x,
    vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)) * sn.y,
    vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)) * sn.z,
  );
  let S = M * transpose(M);

  let rgb = vec3f(0.5) + SH_C0 * dc;
  let alpha = 1.0 / (1.0 + exp(-clamp(logit, -30.0, 30.0)));

  let o = P.base + i;
  A[o] = SplatA(pos, pack4x8unorm(vec4f(rgb, alpha)));
  B[o] = SplatB(
    pack2x16float(vec2f(S[0][0], S[0][1])),
    pack2x16float(vec2f(S[0][2], S[1][1])),
    pack2x16float(vec2f(S[1][2], S[2][2])),
    sMax * sMax,
  );
}
