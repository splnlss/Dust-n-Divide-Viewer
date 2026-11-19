//   node scripts/smoke.mjs [query-string] [seconds] [screenshot-name]
//   env: SMOKE_EVAL=<js run with the camera as c>
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const query = process.argv[2] ?? '';
const seconds = Number(process.argv[3] ?? 12);
const name = process.argv[4] ?? 'shot';
const chrome = process.env.CHROME ?? '/usr/bin/google-chrome';

const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, logLevel: 'error', server: { port: 5190, strictPort: false } });
await server.listen();
const url = `${server.resolvedUrls.local[0]}?${query}`;

const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=gl-egl', '--enable-features=Vulkan', '--use-vulkan=native', '--disable-vulkan-surface', '--window-size=1280,720'],
});
let failed = false;
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') {
            console.log(`[console.${m.type()}]`, m.text());
        }
    });
    page.on('pageerror', (e) => {
        failed = true;
        console.log('[pageerror]', e.message);
    });
    await page.goto(url);
    await page.waitForFunction('window.__controls', { timeout: 60000 });
    if (process.env.SMOKE_EVAL) await page.evaluate(`(() => { const c = window.__controls; ${process.env.SMOKE_EVAL}; return c.position.join(','); })()`).then((p) => console.log('camera', p));
    const steps = Math.max(1, Math.round(seconds / 2));
    for (let i = 0; i < steps; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const hud = await page.$eval('#hud', (e) => e.textContent);
        if (i === steps - 1 || process.env.SMOKE_VERBOSE) console.log(`--- t=${(i + 1) * 2}s\n${hud}`);
    }
    const msg = await page.$eval('#msg', (e) => e.textContent);
    if (msg) {
        failed = true;
        console.log('[msg]', msg);
    }
    console.log('[note]', await page.$eval('#note', (e) => e.textContent));
    mkdirSync('.smoke', { recursive: true });
    const dataUrl = await page.evaluate(() => window.__capture());
    if (process.env.SMOKE_DIFF) {
        const diff = await page.evaluate(async (first) => {
            const second = await window.__capture();
            const px = async (u) => {
                const img = new Image();
                img.src = u;
                await img.decode();
                const c = new OffscreenCanvas(img.width, img.height).getContext('2d');
                c.drawImage(img, 0, 0);
                return c.getImageData(0, 0, img.width, img.height).data;
            };
            const [a, b] = [await px(first), await px(second)];
            let changed = 0,
                max = 0;
            for (let i = 0; i < a.length; i++) {
                const d = Math.abs(a[i] - b[i]);
                if (d > 1) changed++;
                if (d > max) max = d;
            }
            return `channels differing by >1: ${((100 * changed) / a.length).toFixed(3)}%  max diff ${max}/255`;
        }, dataUrl);
        console.log('frame-to-frame', diff);
    }
    writeFileSync(`.smoke/${name}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`screenshot: .smoke/${name}.png`);
} finally {
    await browser.close();
    await server.close();
}
process.exit(failed ? 1 : 0);
