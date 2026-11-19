struct Pick {
  model: mat4x4f,
  start: vec3f,
  maxU: f32,
  dir: vec2f,
  slope: f32,
  curve: f32,
  count: u32,
  width: f32,
  minAlpha: f32,
  pad: f32,
}

struct SplatA { pos: vec3f, color: u32 }

@group(0) @binding(0) var<uniform> P: Pick;
@group(0) @binding(1) var<storage, read> A: array<SplatA>;
@group(0) @binding(2) var<storage, read> activeIds: array<u32>;
@group(0) @binding(3) var<storage, read_write> result: atomic<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let a = A[activeIds[i]];
  if (unpack4x8unorm(a.color).a < P.minAlpha) { return; }
  let w = (P.model * vec4f(a.pos, 1.0)).xyz;
  let d = w.xz - P.start.xz;
  let u = dot(d, P.dir);
  if (u <= 0.0 || u > P.maxU) { return; }
  if (abs(d.x * P.dir.y - d.y * P.dir.x) > P.width) { return; }
  let dy = w.y - (P.start.y + P.slope * u - P.curve * u * u);
  let tangent = P.slope - 2.0 * P.curve * u;
  if (abs(dy) > P.width * sqrt(1.0 + tangent * tangent)) { return; }
  atomicMin(&result, bitcast<u32>(u));
}
