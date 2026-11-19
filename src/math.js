export function mat4() {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}
export function multiply(out, a, b) {
    const a00 = a[0],
        a01 = a[1],
        a02 = a[2],
        a03 = a[3];
    const a10 = a[4],
        a11 = a[5],
        a12 = a[6],
        a13 = a[7];
    const a20 = a[8],
        a21 = a[9],
        a22 = a[10],
        a23 = a[11];
    const a30 = a[12],
        a31 = a[13],
        a32 = a[14],
        a33 = a[15];
    for (let c = 0; c < 4; c++) {
        const b0 = b[c * 4],
            b1 = b[c * 4 + 1],
            b2 = b[c * 4 + 2],
            b3 = b[c * 4 + 3];
        out[c * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
        out[c * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
        out[c * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
        out[c * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
    }
    return out;
}
export function invert(out, m) {
    const a00 = m[0],
        a01 = m[1],
        a02 = m[2],
        a03 = m[3];
    const a10 = m[4],
        a11 = m[5],
        a12 = m[6],
        a13 = m[7];
    const a20 = m[8],
        a21 = m[9],
        a22 = m[10],
        a23 = m[11];
    const a30 = m[12],
        a31 = m[13],
        a32 = m[14],
        a33 = m[15];
    const b00 = a00 * a11 - a01 * a10,
        b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10,
        b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11,
        b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30,
        b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30,
        b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31,
        b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    det = det ? 1 / det : 0;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
}
export function perspective(out, fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = far / (near - far);
    out[11] = -1;
    out[14] = (near * far) / (near - far);
    return out;
}
export function cameraWorld(out, pos, yaw, pitch) {
    const cy = Math.cos(yaw),
        sy = Math.sin(yaw);
    const cp = Math.cos(pitch),
        sp = Math.sin(pitch);
    out[0] = cy;
    out[1] = 0;
    out[2] = -sy;
    out[3] = 0;
    out[4] = sy * sp;
    out[5] = cp;
    out[6] = cy * sp;
    out[7] = 0;
    out[8] = sy * cp;
    out[9] = -sp;
    out[10] = cy * cp;
    out[11] = 0;
    out[12] = pos[0];
    out[13] = pos[1];
    out[14] = pos[2];
    out[15] = 1;
    return out;
}
export function rotationXYZ(out, rx, ry, rz, scale = 1) {
    const cx = Math.cos(rx),
        sx = Math.sin(rx);
    const cy = Math.cos(ry),
        sy = Math.sin(ry);
    const cz = Math.cos(rz),
        sz = Math.sin(rz);
    out[0] = cz * cy * scale;
    out[1] = sz * cy * scale;
    out[2] = -sy * scale;
    out[3] = 0;
    out[4] = (cz * sy * sx - sz * cx) * scale;
    out[5] = (sz * sy * sx + cz * cx) * scale;
    out[6] = cy * sx * scale;
    out[7] = 0;
    out[8] = (cz * sy * cx + sz * sx) * scale;
    out[9] = (sz * sy * cx - cz * sx) * scale;
    out[10] = cy * cx * scale;
    out[11] = 0;
    out[12] = 0;
    out[13] = 0;
    out[14] = 0;
    out[15] = 1;
    return out;
}
export function transformPoint(m, p) {
    const x = p[0],
        y = p[1],
        z = p[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
}
export function transformDir(m, d) {
    const x = d[0],
        y = d[1],
        z = d[2];
    return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}
