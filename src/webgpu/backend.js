import { SplatRenderer } from './SplatRenderer.js';
import { enableWebGpuHelp } from '../webgpuHelp.js';
import { XRSurface, bindingSupported, sessionInit } from './xr.js';

export async function createBackend(canvas, host) {
    if (!navigator.gpu) throw new Error(enableWebGpuHelp);
    // Without an XR runtime an xrCompatible request returns no adapter.
    const base = { powerPreference: 'high-performance' };
    let xrCompatible = true;
    let adapter = await navigator.gpu.requestAdapter({ ...base, xrCompatible: true });
    if (!adapter) {
        xrCompatible = false;
        adapter = await navigator.gpu.requestAdapter(base);
    }
    if (!adapter) throw new Error(`No WebGPU adapter found.\n\n${enableWebGpuHelp}`);
    const device = await adapter.requestDevice(SplatRenderer.deviceDescriptor(adapter));
    device.lost.then((info) => {
        if (!host.alive()) return;
        host.fatal(`WebGPU device lost: ${info.message}${host.memoryReport()}`);
    });
    let gpuErrors = 0;
    device.addEventListener('uncapturederror', (e) => {
        if (e.error instanceof GPUOutOfMemoryError) console.error(`WebGPU out of memory: ${e.error.message}${host.memoryReport()}`);
        if (gpuErrors++ < 5) host.log(`GPU ERROR ${e.error.message}`);
    });
    host.log(`GPU ${adapter.info?.vendor} ${adapter.info?.architecture} ${adapter.info?.description ?? ''} | features: ${[...device.features].join(', ')}`);
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('This canvas cannot be used for WebGPU.');
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
    return {
        kind: 'webgpu',
        label: 'WebGPU',
        info: `${adapter.info?.vendor ?? ''} ${adapter.info?.architecture ?? ''}`.trim(),
        canvasFormat,
        defaults: { sortBits: host.standalone ? 18 : 20, capacity: 8_000_000 },
        createRenderer: (opts) => new SplatRenderer(device, opts),
        canvasTarget: () => context.getCurrentTexture().createView(),
        xr: { sessionInit, support: async () => (!xrCompatible ? 'no-vr' : bindingSupported() ? 'ok' : 'no-binding'), createSurface: async (session, opts) => new XRSurface(session, device, opts) },
        dispose() {
            device.destroy();
        },
    };
}
