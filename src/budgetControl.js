const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 80;

export class BudgetControl {
    dir = 0;
    next = 0;
    constructor(range, step, value) {
        this.min = Math.min(range[0], range[1]);
        this.max = Math.max(range[0], range[1]);
        this.step = step;
        this.value = this.clamp(value);
    }
    clamp(v) {
        return Math.min(this.max, Math.max(this.min, Math.round(v)));
    }
    update(dir, now) {
        let steps = 0;
        if (dir !== this.dir) {
            this.dir = dir;
            if (dir) {
                steps = dir;
                this.next = now + REPEAT_DELAY;
            }
        } else if (dir && now >= this.next) {
            steps = dir;
            this.next = now + REPEAT_INTERVAL;
        }
        if (!steps) return false;
        const v = this.clamp(this.value + steps * this.step);
        if (v === this.value) return false;
        this.value = v;
        return true;
    }
}
