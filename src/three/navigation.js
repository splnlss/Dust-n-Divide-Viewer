import { BufferGeometry, DoubleSide, DynamicDrawUsage, InterleavedBuffer, InterleavedBufferAttribute, Mesh, NodeMaterial, NormalBlending } from 'three/webgpu';
import { attribute, vec4 } from 'three/tsl';
import { mat4, multiply } from '../math.js';
import { TeleportAim } from '../teleport.js';
import { drawBudgetReadout } from '../budgetReadout.js';

const DEADZONE = 0.15;
const SNAP_ANGLE = Math.PI / 6;
const SMOOTH_TURN_SPEED = Math.PI / 2;
const FLOATS_PER_VERTEX = 7;

export function applyFlyControls(camera, controls) {
    camera.position.fromArray(controls.position);
    camera.rotation.set(controls.pitch, controls.yaw, 0, 'YXZ');
}

export class OverlayMesh extends Mesh {
    constructor(overlay) {
        const buffer = new InterleavedBuffer(overlay.data, FLOATS_PER_VERTEX).setUsage(DynamicDrawUsage);
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0));
        geometry.setAttribute('color', new InterleavedBufferAttribute(buffer, 4, 3));
        const material = new NodeMaterial();
        const color = attribute('color', 'vec4');
        material.fragmentNode = vec4(color.rgb.pow(2.2), color.a);
        material.transparent = true;
        material.blending = NormalBlending;
        material.depthTest = false;
        material.side = DoubleSide;
        material.depthWrite = false;
        super(geometry, material);
        this.overlay = overlay;
        this.buffer = buffer;
        this.frustumCulled = false;
        this.renderOrder = 1000;
    }
    sync() {
        const count = this.overlay.count;
        this.visible = count > 0;
        this.geometry.setDrawRange(0, count);
        if (count === 0) return;
        this.buffer.clearUpdateRanges();
        this.buffer.addUpdateRange(0, count * FLOATS_PER_VERTEX);
        this.buffer.needsUpdate = true;
    }
}

export class XRNavigation {
    budgetDir = 0;
    budgetSource = null;
    budget = 0;
    snapArmed = true;
    placed = false;
    aiming = new Map();
    headWorldMat = mat4();

    constructor(renderer, rig, opts) {
        this.renderer = renderer;
        this.rig = rig;
        this.opts = opts;
        this.aim = new TeleportAim(opts.teleportSpeed, opts.teleportCancel);
        this.overlay = new OverlayMesh(this.aim.overlay);
        renderer.xr.addEventListener('sessionstart', () => this.start());
    }

    start() {
        const session = this.renderer.xr.getSession();
        this.placed = false;
        this.aiming.clear();
        if (this.opts.teleport !== false) {
            session.addEventListener('selectstart', (e) => this.aiming.set(e.inputSource, { hit: null, release: false }));
            session.addEventListener('selectend', (e) => {
                const aim = this.aiming.get(e.inputSource);
                if (aim) aim.release = true;
            });
        }
        requestFrameRate(session, this.opts.frameRate);
    }

    update(dt) {
        const xr = this.renderer.xr;
        const frame = xr.getFrame();
        const space = xr.getReferenceSpace();
        this.aim.begin();
        if (!frame || !space) return;
        const pose = frame.getViewerPose(space);
        if (!pose) return;
        const p = pose.transform.position;
        const head = [p.x, p.y, p.z];
        if (!this.placed) {
            this.placed = true;
            this.rig.rotation.set(0, this.opts.startYaw, 0);
            this.setOriginForHead(head, this.opts.startPosition);
        }
        this.locomotion(dt, head, pose.transform.orientation);
        this.teleport(frame, space, head);
        this.rig.updateMatrixWorld();
        if (this.opts.budgetReadout && this.budget > 0) {
            drawBudgetReadout(this.aim.overlay, multiply(this.headWorldMat, this.rig.matrixWorld.elements, pose.transform.matrix), this.budget, this.opts.budgetReadout);
        }
        this.overlay.sync();
    }

    pulse() {
        try {
            this.budgetSource?.gamepad?.hapticActuators?.[0]?.pulse?.(0.25, 15);
        } catch {}
    }

    get yaw() {
        return this.rig.rotation.y;
    }

    setOriginForHead(headLocal, headWorld) {
        const c = Math.cos(this.yaw),
            s = Math.sin(this.yaw);
        this.rig.position.set(headWorld[0] - (c * headLocal[0] + s * headLocal[2]), headWorld[1] - headLocal[1], headWorld[2] - (-s * headLocal[0] + c * headLocal[2]));
    }

    headWorld(headLocal) {
        const c = Math.cos(this.yaw),
            s = Math.sin(this.yaw);
        const o = this.rig.position;
        return [o.x + c * headLocal[0] + s * headLocal[2], o.y + headLocal[1], o.z - s * headLocal[0] + c * headLocal[2]];
    }

    teleport(frame, space, headLocal) {
        const session = this.renderer.xr.getSession();
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
            if (!Array.from(session.inputSources).includes(src)) {
                this.aiming.delete(src);
                continue;
            }
            const m = frame.getPose(src.targetRaySpace, space)?.transform.matrix;
            aim.hit = m ? this.aim.aim(src, [m[12], m[13], m[14]], [-m[8], -m[9], -m[10]], headLocal, (q) => this.headWorld(q), this.yaw) : null;
        }
    }

    locomotion(dt, headLocal, q) {
        let mx = 0,
            mz = 0,
            turn = 0,
            my = 0;
        this.budgetDir = 0;
        for (const src of this.renderer.xr.getSession().inputSources) {
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
                this.rig.rotation.y -= Math.sign(turn) * k * SMOOTH_TURN_SPEED * dt;
                this.setOriginForHead(headLocal, world);
            }
        } else if (Math.abs(turn) < 0.3) {
            this.snapArmed = true;
        } else if (this.snapArmed && Math.abs(turn) > 0.6) {
            this.snapArmed = false;
            const world = this.headWorld(headLocal);
            this.rig.rotation.y -= Math.sign(turn) * SNAP_ANGLE;
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
            const c = Math.cos(this.yaw),
                s = Math.sin(this.yaw);
            const step = this.opts.moveSpeed * dt;
            this.rig.position.x += (c * lx + s * lz) * step;
            this.rig.position.z += (-s * lx + c * lz) * step;
            this.rig.position.y += my * step;
        }
    }
}

// Not awaited: the browser may only settle this once frames flow, so awaiting stalls the session.
function requestFrameRate(session, rate) {
    if (!rate || !session.updateTargetFrameRate) return;
    try {
        const supported = session.supportedFrameRates;
        if (supported && !Array.from(supported).some((r) => Math.abs(r - rate) < 0.5)) return;
        session.updateTargetFrameRate(rate).catch((e) => console.warn('Could not change frame rate', e));
    } catch (e) {
        console.warn('Could not change frame rate', e);
    }
}
