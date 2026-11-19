export class RangeAllocator {
    capacity;
    free;
    used = 0;
    constructor(capacity) {
        this.capacity = capacity;
        this.free = [{ start: 0, size: capacity }];
    }
    alloc(size) {
        for (let i = 0; i < this.free.length; i++) {
            const f = this.free[i];
            if (f.size >= size) {
                const start = f.start;
                f.start += size;
                f.size -= size;
                if (f.size === 0) this.free.splice(i, 1);
                this.used += size;
                return start;
            }
        }
        return -1;
    }
    release(start, size) {
        let i = 0;
        while (i < this.free.length && this.free[i].start < start) i++;
        this.free.splice(i, 0, { start, size });
        this.used -= size;
        const next = this.free[i + 1];
        if (next && start + size === next.start) {
            this.free[i].size += next.size;
            this.free.splice(i + 1, 1);
        }
        const prev = this.free[i - 1];
        if (prev && prev.start + prev.size === start) {
            prev.size += this.free[i].size;
            this.free.splice(i, 1);
        }
    }
}
