struct Overlay {
  viewProj: mat4x4f,
  srgbOut: u32,
}

@group(0) @binding(0) var<uniform> K: Overlay;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
}

@vertex
fn vs(@location(0) p: vec3f, @location(1) color: vec4f) -> VOut {
  var out: VOut;
  out.pos = K.viewProj * vec4f(p, 1.0);
  out.color = color;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  var c = in.color.rgb;
  if (K.srgbOut != 0u) { c = pow(c, vec3f(2.2)); }
  return vec4f(c * in.color.a, in.color.a);
}
