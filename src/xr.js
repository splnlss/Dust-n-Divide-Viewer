import { invert, mat4, multiply } from './math.js';
import { TeleportAim } from './teleport.js';
import { drawBudgetReadout } from './budgetReadout.js';

const DEADZONE = 0.15;
const SNAP_ANGLE = Math.PI / 6;
const SMOOTH_TURN_SPEED = Math.PI / 2;
export async function xrSupport() {
    if (!navigator.xr) return 'no-webxr';
    if (!(await navigator.xr.isSessionSupported('immersive-vr').catch(() => false))) return 'no-vr';
    return 'ok';
}
export class XRViewer {
    session;
    opts;
    surface;
    format;
    frameRate;
    onEnd = null;
    budget = 0;
    budgetDir = 0;
    budgetSource = null;
    viewportScale = 1;
    canScaleViewport = typeof XRView !== 'undefined' && 'requestViewportScale' in XRView.prototype;
    refSpace;
    originPos = [0, 0, 0];
    originYaw = 0;
    placed = false;
    snapArmed = true;
    lastTime = 0;
    views = [];
    aiming = new Map();
    aim;
    viewMats = [mat4(), mat4()];
    origin = mat4();
    originInv = mat4();
    headWorldMat = mat4();
    constructor(session, surface, opts) {
        this.session = session;
        this.opts = opts;
        this.surface = surface;
        this.format = surface.format;
        this.frameRate = session.frameRate ?? 72;
        session.addEventListener('frameratechange', () => {
            if (session.frameRate) this.frameRate = session.frameRate;
        });
        this.originYaw = opts.startYaw;
        this.aim = new TeleportAim(opts.teleportSpeed, opts.teleportCancel);
        if (opts.teleport !== false) {
            session.addEventListener('selectstart', (e) => this.aiming.set(e.inputSource, { hit: null, release: false }));
            session.addEventListener('selectend', (e) => {
                const aim = this.aiming.get(e.inputSource);
                if (aim) aim.release = true;
            });
        }
    }
    static async start(backendXr, opts) {
        const session = await navigator.xr.requestSession('immersive-vr', backendXr.sessionInit());
        try {
            const viewer = new XRViewer(session, await backendXr.createSurface(session, opts), opts);
            viewer.refSpace = await session.requestReferenceSpace('local-floor').catch(() => session.requestReferenceSpace('local'));
            session.addEventListener('end', () => viewer.onEnd?.());
            viewer.requestFrameRate(opts.frameRate);
            return viewer;
        } catch (err) {
            session.end().catch(() => {});
            throw err;
        }
    }
    // Not awaited: the browser may only settle this once frames flow, so awaiting stalls the session.
    requestFrameRate(rate) {
        const session = this.session;
        if (!rate || !session.updateTargetFrameRate) return;
        try {
            const supported = session.supportedFrameRates;
            if (supported && !Array.from(supported).some((r) => Math.abs(r - rate) < 0.5)) {
                console.warn(`xrFrameRate ${rate} is not offered by this headset (${Array.from(supported).join(', ')})`);
                return;
            }
            session.updateTargetFrameRate(rate).then(
                () => {
                    this.frameRate = rate;
                },
                (e) => console.warn('Could not change frame rate', e),
            );
        } catch (e) {
            console.warn('Could not change frame rate', e);
        }
    }
    run(draw) {
        const onFrame = (time, frame) => {
            this.session.requestAnimationFrame(onFrame);
            const pose = frame.getViewerPose(this.refSpace);
            if (!pose) return;
            const dt = this.lastTime ? Math.min((time - this.lastTime) / 1000, 0.1) : 0;
            this.lastTime = time;
            const head = pose.transform.position;
            if (!this.placed) {
                this.placed = true;
                this.setOriginForHead([head.x, head.y, head.z], this.opts.startPosition);
            }
            this.locomotion(dt, [head.x, head.y, head.z], pose.transform.orientation);
            this.teleport(frame, [head.x, head.y, head.z]);
            const c = Math.cos(this.originYaw),
                s = Math.sin(this.originYaw);
            const o = this.origin;
            o[0] = c;
            o[1] = 0;
            o[2] = -s;
            o[3] = 0;
            o[4] = 0;
            o[5] = 1;
            o[6] = 0;
            o[7] = 0;
            o[8] = s;
            o[9] = 0;
            o[10] = c;
            o[11] = 0;
            o[12] = this.originPos[0];
            o[13] = this.originPos[1];
            o[14] = this.originPos[2];
            o[15] = 1;
            invert(this.originInv, o);
            if (this.opts.budgetReadout && this.budget > 0) {
                drawBudgetReadout(this.aim.overlay, multiply(this.headWorldMat, o, pose.transform.matrix), this.budget, this.opts.budgetReadout);
            }
            this.views.length = 0;
            this.surface.beginFrame();
            for (let i = 0; i < pose.views.length && i < 2; i++) {
                const view = pose.views[i];
                if (this.canScaleViewport) view.requestViewportScale(this.viewportScale);
                const { target, viewport, clear } = this.surface.view(view, i);
                this.views.push({ view: multiply(this.viewMats[i], view.transform.inverse.matrix, this.originInv), proj: view.projectionMatrix, target, viewport, clear });
            }
            draw({ views: this.views, format: this.format, dt, time, overlay: this.aim.overlay, pick: this.aim.pick });
        };
        this.session.requestAnimationFrame(onFrame);
    }
    pulse() {
        try {
            this.budgetSource?.gamepad?.hapticActuators?.[0]?.pulse?.(0.25, 15);
        } catch {}
    }
    setOriginForHead(headLocal, headWorld) {
        const c = Math.cos(this.originYaw),
            s = Math.sin(this.originYaw);
        this.originPos = [headWorld[0] - (c * headLocal[0] + s * headLocal[2]), headWorld[1] - headLocal[1], headWorld[2] - (-s * headLocal[0] + c * headLocal[2])];
    }
    headWorld(headLocal) {
        const c = Math.cos(this.originYaw),
            s = Math.sin(this.originYaw);
        return [this.originPos[0] + c * headLocal[0] + s * headLocal[2], this.originPos[1] + headLocal[1], this.originPos[2] - s * headLocal[0] + c * headLocal[2]];
    }
    teleport(frame, headLocal) {
        this.aim.begin();
        for (const [src, aim] of this.aiming) {
            if (aim.release) {
                this.aiming.delete(src);
                if (aim.hit) {
                    const target = this.headWorld(aim.hit);
                    this.setOriginForHead(headLocal, [target[0], target[1] + headLocal[1], target[2]]);
                    try {
                        src.gamepad?.hapticActuators?.[0]?.pulse?.(0.4, 40);
                    } catch {}
                }
                continue;
            }
            if (!Array.from(this.session.inputSources).includes(src)) {
                this.aiming.delete(src);
                continue;
            }
            const m = frame.getPose(src.targetRaySpace, this.refSpace)?.transform.matrix;
            aim.hit = m ? this.aim.aim(src, [m[12], m[13], m[14]], [-m[8], -m[9], -m[10]], headLocal, (p) => this.headWorld(p), this.originYaw) : null;
        }
    }
    locomotion(dt, headLocal, q) {
        let mx = 0,
            mz = 0,
            turn = 0,
            my = 0;
        this.budgetDir = 0;
        for (const src of this.session.inputSources) {
            const buttons = src.gamepad?.buttons;
            if (src.handedness === 'right' && buttons?.length > 5) {
                this.budgetDir = buttons[5].pressed ? 1 : buttons[4].pressed ? -1 : 0;
                this.budgetSource = src;
            }
            const axes = src.gamepad?.axes;
            if (!axes || axes.length < 4) continue;
            const x = axes[2],
                y = axes[3];
            if (src.handedness === 'left') {
                const m = Math.hypot(x, y);
                if (m > DEADZONE) {
                    const k = Math.min(1, (m - DEADZONE) / (1 - DEADZONE));
                    mx += (x / m) * k * k;
                    mz += (y / m) * k * k;
                }
            } else if (Math.abs(x) >= Math.abs(y)) {
                turn = x;
            } else if (Math.abs(y) > DEADZONE) {
                const k = (Math.abs(y) - DEADZONE) / (1 - DEADZONE);
                my = -Math.sign(y) * k * k;
            }
        }
        if (this.opts.smoothTurn) {
            if (Math.abs(turn) > DEADZONE) {
                const world = this.headWorld(headLocal);
                const k = (Math.abs(turn) - DEADZONE) / (1 - DEADZONE);
                this.originYaw -= Math.sign(turn) * k * SMOOTH_TURN_SPEED * dt;
                this.setOriginForHead(headLocal, world);
            }
        } else if (Math.abs(turn) < 0.3) {
            this.snapArmed = true;
        } else if (this.snapArmed && Math.abs(turn) > 0.6) {
            this.snapArmed = false;
            const world = this.headWorld(headLocal);
            this.originYaw -= Math.sign(turn) * SNAP_ANGLE;
            this.setOriginForHead(headLocal, world);
        }
        if (mx || mz || my) {
            const fx = -2 * (q.x * q.z + q.w * q.y);
            const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
            const len = Math.hypot(fx, fz) || 1;
            const hx = fx / len,
                hz = fz / len;
            const lx = hx * -mz + -hz * mx;
            const lz = hz * -mz + hx * mx;
            const c = Math.cos(this.originYaw),
                s = Math.sin(this.originYaw);
            const step = this.opts.moveSpeed * dt;
            this.originPos[0] += (c * lx + s * lz) * step;
            this.originPos[2] += (-s * lx + c * lz) * step;
            this.originPos[1] += my * step;
        }
    }
}
