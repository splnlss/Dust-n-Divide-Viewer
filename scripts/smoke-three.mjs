//   node scripts/smoke-three.mjs   writes .smoke/three.png and .smoke/three_meshes_only.png
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
const s = await createServer({ root: process.cwd(), configFile: false, logLevel: 'error', server: { port: 5193 } });
await s.listen();
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl', '--enable-features=Vulkan', '--use-vulkan=native', '--disable-vulkan-surface', '--window-size=1280,720'] });
try {
    const pg = await b.newPage();
    await pg.setViewport({ width: 1280, height: 720 });
    pg.on('console', (m) => ['error', 'warn', 'warning'].includes(m.type()) && console.log('[c]', m.text().slice(0, 300)));
    pg.on('pageerror', (e) => console.log('[err]', e.message));
    await pg.goto(s.resolvedUrls.local[0] + 'demo/three.html');
    await pg.waitForFunction('window.__splats || document.getElementById("msg").textContent.length > 20', { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 12000));
    console.log('MSG', await pg.$eval('#msg', (e) => e.textContent));
    console.log(await pg.$eval('#hud', (e) => e.textContent));
    const hit = await pg.evaluate(async () => {
        const c = window.__camera;
        const o = c.position,
            d = window.__controls.target.clone().sub(o).normalize();
        const p = await window.__splats.hitTest({ origin: o, direction: d });
        return p && [p.x, p.y, p.z].map((v) => v.toFixed(2));
    });
    console.log('hitTest toward target', hit);
    const shot = async (name, depthOff) => {
        const url = await pg.evaluate(
            (depthOff) =>
                new Promise((resolve) => {
                    const r = window.__renderer;
                    r.setAnimationLoop(null);
                    requestAnimationFrame(() => {
                        r.render(window.__scene, window.__camera);
                        if (!depthOff) window.__splats.render(window.__camera);
                        resolve(r.domElement.toDataURL('image/png'));
                    });
                }),
            depthOff,
        );
        const { writeFileSync } = await import('node:fs');
        writeFileSync(`.smoke/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
    };
    await shot('three', false);
    await shot('three_meshes_only', true);
} finally {
    await b.close();
    await s.close();
}
