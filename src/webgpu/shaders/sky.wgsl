struct Sky {
  invViewProj: mat4x4f,
  zenith: vec4f,
  horizon: vec4f,
  ground: vec4f,
  srgbOut: u32,
}

@group(0) @binding(0) var<uniform> K: Sky;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) ndc: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var out: VOut;
  out.pos = vec4f(p, 0.0, 1.0);
  out.ndc = p;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let a = K.invViewProj * vec4f(in.ndc, 0.0, 1.0);
  let b = K.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let dir = normalize(b.xyz / b.w - a.xyz / a.w);
  let e = dir.y;
  var c: vec3f;
  if (e >= 0.0) {
    c = mix(K.horizon.rgb, K.zenith.rgb, pow(e, 0.55));
  } else {
    c = mix(K.horizon.rgb, K.ground.rgb, smoothstep(0.0, 0.25, -e));
  }
  if (K.srgbOut != 0u) { c = pow(c, vec3f(2.2)); }
  return vec4f(c, 1.0);
}
