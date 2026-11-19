export const enableWebGpuHelp = [
    'This viewer needs WebGPU, which is not enabled in this browser.',
    '',
    'Chrome or Edge: update to version 113 or newer. If it is still off, open chrome://flags, enable "Unsafe WebGPU Support", then relaunch.',
    'Firefox: open about:config and set dom.webgpu.enabled to true, then restart.',
    'Safari: Settings → Advanced → Feature Flags, enable WebGPU (on by default from Safari 26).',
    'Quest Browser: open chrome://flags, enable WebGPU and "WebXR experimental features", then press Relaunch.',
].join('\n');
