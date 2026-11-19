const GRAVITY = 9.8;
const ARC_STEP = 1 / 45;
const ARC_MAX_STEPS = 140;
const ARC_WIDTH = 0.007;
const RING_RADIUS = 0.3;
const RING_SEGMENTS = 48;
const AIM_OK = [1, 1, 1, 0.9];
const AIM_MISS = [1, 0.4, 0.35, 0.55];
const AIM_MISS_ICON = [1, 0.3, 0.25, 0.95];
const FLOATS_PER_VERTEX = 7;
const CANCEL_DISTANCE = 0.5;
const CANCEL_RADIUS = 0.06;

export function arcParams(p, d, speed) {
    const h = Math.hypot(d[0], d[2]);
    if (h < 0.02) return null;
    const vh = speed * h;
    return { start: [p[0], p[1], p[2]], dir: [d[0] / h, d[2] / h], slope: d[1] / h, curve: GRAVITY / (2 * vh * vh), maxU: vh * ARC_STEP * ARC_MAX_STEPS };
}

export function arcPoint(arc, u) {
    return [arc.start[0] + arc.dir[0] * u, arc.start[1] + arc.slope * u - arc.curve * u * u, arc.start[2] + arc.dir[1] * u];
}

export function arcPoints(arc, u) {
    const points = [];
    const n = Math.max(1, Math.ceil((u / arc.maxU) * ARC_MAX_STEPS));
    for (let i = 0; i <= n; i++) points.push(...arcPoint(arc, (u * i) / n));
    return points;
}

export class TeleportAim {
    pick = { active: false, token: 0, result: null, start: [0, 0, 0], dir: [0, 0], slope: 0, curve: 0, maxU: 0 };
    pickSource = null;
    overlay = { data: new Float32Array(4096 * FLOATS_PER_VERTEX), count: 0 };
    toWorld = (p) => p;

    cancelling = false;

    constructor(speed = 7.5, cancelAngle = (60 * Math.PI) / 180) {
        this.speed = speed;
        this.cancelAngle = cancelAngle;
    }
    begin() {
        this.overlay.count = 0;
        this.pick.active = false;
    }
    aim(source, p, d, eye, toWorld = (q) => q, yaw = 0) {
        this.toWorld = toWorld;
        this.cancelling = Math.asin(Math.max(-1, Math.min(1, d[1]))) > this.cancelAngle;
        if (this.cancelling) {
            this.drawCancel([p[0] + d[0] * CANCEL_DISTANCE, p[1] + d[1] * CANCEL_DISTANCE, p[2] + d[2] * CANCEL_DISTANCE], eye);
            return null;
        }
        const arc = arcParams(p, d, this.speed);
        if (!arc) return null;
        if (source === this.pickSource || !this.pick.active) this.requestPick(source, arc, toWorld, yaw);
        const r = this.pick.result;
        const u = source === this.pickSource && r && r.token === this.pick.token && r.u !== null ? Math.min(r.u, arc.maxU) : null;
        const hit = u !== null ? arcPoint(arc, u) : null;
        this.draw(arcPoints(arc, u ?? arc.maxU), hit, eye);
        return hit;
    }
    aimRay(source, eye, d, hand, maxDistance = 300) {
        this.toWorld = (q) => q;
        const h = Math.hypot(d[0], d[2]);
        if (h < 0.02) return null;
        const ray = { start: [eye[0], eye[1], eye[2]], dir: [d[0] / h, d[2] / h], slope: d[1] / h, curve: 0, maxU: maxDistance * h };
        if (source === this.pickSource || !this.pick.active) this.requestPick(source, ray, this.toWorld, 0);
        const r = this.pick.result;
        const hit = source === this.pickSource && r && r.token === this.pick.token && r.u !== null ? arcPoint(ray, r.u) : null;
        const end = hit ?? arcPoint(ray, 8 * h);
        const dist = Math.hypot(end[0] - hand[0], end[1] - hand[1], end[2] - hand[2]);
        const lift = 0.2 * dist;
        const points = [];
        const n = 48;
        for (let i = 0; i <= n; i++) {
            const t = i / n,
                bump = 4 * lift * t * (1 - t);
            points.push(hand[0] + (end[0] - hand[0]) * t, hand[1] + (end[1] - hand[1]) * t + bump, hand[2] + (end[2] - hand[2]) * t);
        }
        this.draw(points, hit, eye);
        return hit;
    }
    requestPick(source, arc, toWorld, yaw) {
        const pk = this.pick;
        if (source !== this.pickSource) {
            this.pickSource = source;
            pk.token++;
            pk.result = null;
        }
        pk.active = true;
        const c = Math.cos(yaw),
            s = Math.sin(yaw);
        pk.start = toWorld(arc.start);
        pk.dir = [c * arc.dir[0] + s * arc.dir[1], -s * arc.dir[0] + c * arc.dir[1]];
        pk.slope = arc.slope;
        pk.curve = arc.curve;
        pk.maxU = arc.maxU;
    }
    draw(points, hit, eye) {
        const color = hit ? AIM_OK : AIM_MISS;
        const n = points.length / 3;
        for (let i = 0; i + 1 < n; i++) {
            const a = i * 3,
                b = a + 3;
            const tx = points[b] - points[a],
                ty = points[b + 1] - points[a + 1],
                tz = points[b + 2] - points[a + 2];
            const vx = eye[0] - points[a],
                vy = eye[1] - points[a + 1],
                vz = eye[2] - points[a + 2];
            let sx = ty * vz - tz * vy,
                sy = tz * vx - tx * vz,
                sz = tx * vy - ty * vx;
            const sl = Math.hypot(sx, sy, sz) || 1;
            const w = (ARC_WIDTH * Math.max(1, Math.hypot(vx, vy, vz) / 2.5)) / sl;
            sx *= w;
            sy *= w;
            sz *= w;
            const fade = Math.min(1, (i + 1) / 6);
            const c = [color[0], color[1], color[2], color[3] * fade];
            this.quad([points[a] - sx, points[a + 1] - sy, points[a + 2] - sz], [points[a] + sx, points[a + 1] + sy, points[a + 2] + sz], [points[b] - sx, points[b + 1] - sy, points[b + 2] - sz], [points[b] + sx, points[b + 1] + sy, points[b + 2] + sz], c);
        }
        if (!hit) return;
        const y = hit[1] + 0.01;
        const radius = Math.max(RING_RADIUS, 0.04 * Math.hypot(hit[0] - eye[0], hit[1] - eye[1], hit[2] - eye[2]));
        const disc = [color[0], color[1], color[2], 0.18];
        for (let i = 0; i < RING_SEGMENTS; i++) {
            const a0 = (i / RING_SEGMENTS) * 2 * Math.PI,
                a1 = ((i + 1) / RING_SEGMENTS) * 2 * Math.PI;
            const c0 = Math.cos(a0),
                s0 = Math.sin(a0),
                c1 = Math.cos(a1),
                s1 = Math.sin(a1);
            const ro = radius,
                ri = radius * 0.82;
            const at = (r, c, s) => [hit[0] + r * c, y, hit[2] + r * s];
            this.quad(at(ri, c0, s0), at(ro, c0, s0), at(ri, c1, s1), at(ro, c1, s1), color);
            this.tri(hit[0], y, hit[2], at(ri, c0, s0), at(ri, c1, s1), disc);
        }
    }
    drawCancel(c, eye) {
        let vx = eye[0] - c[0],
            vy = eye[1] - c[1],
            vz = eye[2] - c[2];
        const vl = Math.hypot(vx, vy, vz) || 1;
        vx /= vl;
        vy /= vl;
        vz /= vl;
        let rx = vz,
            ry = 0,
            rz = -vx;
        const rl = Math.hypot(rx, rz);
        if (rl < 1e-4) {
            rx = 1;
            rz = 0;
        } else {
            rx /= rl;
            rz /= rl;
        }
        const ux = vy * rz - vz * ry,
            uy = vz * rx - vx * rz,
            uz = vx * ry - vy * rx;
        const at = (r, a) => [c[0] + r * (Math.cos(a) * rx + Math.sin(a) * ux), c[1] + r * (Math.cos(a) * ry + Math.sin(a) * uy), c[2] + r * (Math.cos(a) * rz + Math.sin(a) * uz)];
        const color = AIM_MISS_ICON;
        const ro = CANCEL_RADIUS,
            ri = CANCEL_RADIUS * 0.78;
        for (let i = 0; i < RING_SEGMENTS; i++) {
            const a0 = (i / RING_SEGMENTS) * 2 * Math.PI,
                a1 = ((i + 1) / RING_SEGMENTS) * 2 * Math.PI;
            this.quad(at(ri, a0), at(ro, a0), at(ri, a1), at(ro, a1), color);
        }
        const t = (ro - ri) / 2,
            a = (3 * Math.PI) / 4,
            n = a + Math.PI / 2;
        const off = (p, s) => [p[0] + s * (Math.cos(n) * rx + Math.sin(n) * ux), p[1] + s * (Math.cos(n) * ry + Math.sin(n) * uy), p[2] + s * (Math.cos(n) * rz + Math.sin(n) * uz)];
        const p0 = at(ri, a),
            p1 = at(ri, a + Math.PI);
        this.quad(off(p0, -t), off(p0, t), off(p1, -t), off(p1, t), color);
    }
    quad(a, b, c, d, color) {
        this.vertex(a, color);
        this.vertex(b, color);
        this.vertex(c, color);
        this.vertex(c, color);
        this.vertex(b, color);
        this.vertex(d, color);
    }
    tri(x, y, z, b, c, color) {
        this.vertex([x, y, z], color);
        this.vertex(b, color);
        this.vertex(c, color);
    }
    vertex(p, color) {
        const o = this.overlay;
        if ((o.count + 1) * FLOATS_PER_VERTEX > o.data.length) return;
        const w = this.toWorld(p);
        const k = o.count * FLOATS_PER_VERTEX;
        o.data[k] = w[0];
        o.data[k + 1] = w[1];
        o.data[k + 2] = w[2];
        o.data[k + 3] = color[0];
        o.data[k + 4] = color[1];
        o.data[k + 5] = color[2];
        o.data[k + 6] = color[3];
        o.count++;
    }
}
