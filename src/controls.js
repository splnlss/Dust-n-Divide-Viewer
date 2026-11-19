export class FlyControls {
    position = [0, 0, 0];
    yaw = 0;
    pitch = 0;
    speed = 4;
    keys = new Set();
    pointers = new Map();
    pair = null;

    constructor(el, opts = {}) {
        const signal = opts.signal;
        this.el = el;
        this.fov = opts.fov ?? Math.PI / 3;
        el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
        el.addEventListener(
            'pointerdown',
            (e) => {
                el.setPointerCapture(e.pointerId);
                const touch = e.pointerType === 'touch';
                this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, touch, mode: touch || e.button === 0 ? 'look' : 'pan' });
                this.resetPair();
            },
            { signal },
        );
        const end = (e) => {
            this.pointers.delete(e.pointerId);
            this.resetPair();
        };
        el.addEventListener('pointerup', end, { signal });
        el.addEventListener('pointercancel', end, { signal });
        el.addEventListener(
            'pointermove',
            (e) => {
                const p = this.pointers.get(e.pointerId);
                if (!p) return;
                const dx = e.clientX - p.x,
                    dy = e.clientY - p.y;
                p.x = e.clientX;
                p.y = e.clientY;
                if (this.pair) {
                    const next = this.measurePair();
                    if (next.dist > 0 && this.pair.dist > 0) {
                        this.pan(next.x - this.pair.x, next.y - this.pair.y);
                        this.move(Math.log(next.dist / this.pair.dist) * this.speed * 1.5, 0, 0);
                    }
                    this.pair = next;
                } else if (this.pointers.size === 1) {
                    if (p.mode === 'pan') {
                        this.pan(dx, dy);
                    } else {
                        const k = p.touch ? -0.005 : 0.003;
                        this.yaw -= dx * k;
                        this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - dy * k));
                    }
                }
            },
            { signal },
        );
        el.addEventListener(
            'wheel',
            (e) => {
                e.preventDefault();
                const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
                const k = e.ctrlKey ? 0.005 : 0.00125;
                this.move(-px * k * this.speed, 0, 0);
            },
            { passive: false, signal },
        );
        addEventListener(
            'keydown',
            (e) => {
                if (e.metaKey || e.ctrlKey) return;
                if (e.code === 'BracketLeft') this.speed = Math.max(0.1, this.speed / 1.5);
                else if (e.code === 'BracketRight') this.speed = Math.min(500, this.speed * 1.5);
                else this.keys.add(e.code);
            },
            { signal },
        );
        addEventListener('keyup', (e) => this.keys.delete(e.code), { signal });
        addEventListener(
            'blur',
            () => {
                this.keys.clear();
                this.pointers.clear();
                this.pair = null;
            },
            { signal },
        );
    }

    resetPair() {
        const touches = [...this.pointers.values()].filter((p) => p.touch);
        this.pair = touches.length === 2 && this.pointers.size === 2 ? this.measurePair() : null;
    }

    measurePair() {
        const [a, b] = [...this.pointers.values()];
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
    }

    pan(dx, dy) {
        const h = this.el.clientHeight || 1;
        const unitsPerPixel = (this.speed * 2 * Math.tan(this.fov / 2)) / h;
        const cy = Math.cos(this.yaw),
            sy = Math.sin(this.yaw);
        const cp = Math.cos(this.pitch),
            sp = Math.sin(this.pitch);
        const r = -dx * unitsPerPixel,
            u = dy * unitsPerPixel;
        this.position[0] += cy * r + sy * sp * u;
        this.position[1] += cp * u;
        this.position[2] += -sy * r + cy * sp * u;
    }

    move(f, r, u) {
        const cy = Math.cos(this.yaw),
            sy = Math.sin(this.yaw);
        const cp = Math.cos(this.pitch),
            sp = Math.sin(this.pitch);
        this.position[0] += -sy * cp * f + cy * r;
        this.position[1] += sp * f + u;
        this.position[2] += -cy * cp * f - sy * r;
    }

    update(dt) {
        const k = this.keys;
        const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
        const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
        const u = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
        if (!f && !r && !u) return;
        const step = this.speed * dt * (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1);
        this.move(f * step, r * step, u * step);
    }
}
