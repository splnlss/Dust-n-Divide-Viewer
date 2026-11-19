struct Interval { dst: u32, src: u32 }
struct Params { numIntervals: u32, total: u32, pad0: u32, pad1: u32 }

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> intervals: array<Interval>;
@group(0) @binding(2) var<storage, read_write> activeIds: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.total) { return; }
  var lo = 0u;
  var hi = P.numIntervals - 1u;
  while (lo < hi) {
    let mid = (lo + hi + 1u) >> 1u;
    if (intervals[mid].dst <= i) { lo = mid; } else { hi = mid - 1u; }
  }
  let iv = intervals[lo];
  activeIds[i] = iv.src + (i - iv.dst);
}
