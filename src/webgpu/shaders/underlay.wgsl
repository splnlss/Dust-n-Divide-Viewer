override SRGB_OUT: bool = false;

@group(0) @binding(0) var depthSource: texture_depth_2d;
@group(0) @binding(1) var colorSource: texture_2d<f32>;

struct Out {
  @builtin(frag_depth) depth: f32,
  @location(0) color: vec4f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn encodeSrgb(c: vec3f) -> vec3f {
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> Out {
  let p = vec2i(pos.xy);
  let linear = clamp(textureLoad(colorSource, p, 0).rgb, vec3f(0.0), vec3f(1.0));
  let rgb = select(encodeSrgb(linear), linear, SRGB_OUT);
  return Out(textureLoad(depthSource, p, 0), vec4f(rgb, 1.0));
}
