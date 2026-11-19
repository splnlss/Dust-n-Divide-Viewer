export const sessionInit = () => ({ requiredFeatures: ['webgpu'], optionalFeatures: ['local-floor'] });

export function bindingSupported() {
    return typeof XRGPUBinding !== 'undefined';
}

export class XRSurface {
    format;
    binding;
    layer;
    prevTexture = null;
    prevLayer = -1;
    constructor(session, device, opts) {
        this.binding = new XRGPUBinding(session, device);
        this.format = this.binding.getPreferredColorFormat();
        this.layer = this.binding.createProjectionLayer({ colorFormat: this.format, scaleFactor: opts.scaleFactor, textureType: 'texture' });
        session.updateRenderState({ layers: [this.layer] });
        if ('fixedFoveation' in this.layer) {
            try {
                this.layer.fixedFoveation = opts.foveation;
            } catch {}
        }
    }
    get size() {
        return `${this.layer.textureWidth}x${this.layer.textureHeight}`;
    }
    beginFrame() {
        this.prevTexture = null;
        this.prevLayer = -1;
    }
    view(view) {
        const sub = this.binding.getViewSubImage(this.layer, view);
        const desc = sub.getViewDescriptor();
        const layerIndex = desc.baseArrayLayer ?? 0;
        const clear = sub.colorTexture !== this.prevTexture || layerIndex !== this.prevLayer;
        this.prevTexture = sub.colorTexture;
        this.prevLayer = layerIndex;
        const vp = sub.viewport;
        return { target: sub.colorTexture.createView(desc), viewport: [vp.x, vp.y, vp.width, vp.height], clear };
    }
}
