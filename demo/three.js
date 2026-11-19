import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GaussianSplats, createWebGPURenderer } from '../src/three/GaussianSplats.js';

const SCENE_URL = 'https://pub-dd92ae5131ec49f1bbd411b51a858249.r2.dev/01_SLV_RondaJoseph/20260820_RondaLobato/web/lod/lod-meta.json';
const msg = document.getElementById('msg');
const hud = document.getElementById('hud');

async function main() {
    const renderer = await createWebGPURenderer();
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    document.body.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0d);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 2));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(3, 6, 4);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 1000);
    camera.position.set(0, 2.8, 12);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 2.4, 0);
    controls.update();

    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xd04040 }));
    box.position.set(-1.5, 2, 6);
    const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.4, 0.14, 128, 16), new THREE.MeshStandardMaterial({ color: 0x40a0e0, metalness: 0.3, roughness: 0.4 }));
    knot.position.set(1.5, 2.2, 3);
    scene.add(box, knot);

    const splats = new GaussianSplats(renderer);
    await splats.load(new URLSearchParams(location.search).get('scene') ?? SCENE_URL);
    scene.add(splats);
    msg.textContent = '';

    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 12), new THREE.MeshStandardMaterial({ color: 0xffd040, emissive: 0x403000 }));
    marker.visible = false;
    scene.add(marker);
    const raycaster = new THREE.Raycaster();
    renderer.domElement.addEventListener('dblclick', async (e) => {
        const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        const meshHit = raycaster.intersectObjects([box, knot])[0]?.point ?? null;
        const splatHit = await splats.hitTest(raycaster.ray);
        const near = (p) => (p ? p.distanceTo(raycaster.ray.origin) : Infinity);
        const hit = near(meshHit) < near(splatHit) ? meshHit : splatHit;
        if (!hit) return;
        marker.position.copy(hit);
        marker.visible = true;
    });

    addEventListener('resize', () => {
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(innerWidth, innerHeight);
    });

    let frames = 0,
        last = performance.now();
    renderer.setAnimationLoop((time) => {
        knot.rotation.y = time / 1000;
        renderer.render(scene, camera);
        splats.render(camera);
        frames++;
        if (time - last > 500) {
            const r = splats.splatRenderer;
            const t = r.timings;
            hud.textContent = [`${((frames * 1000) / (time - last)).toFixed(0)} fps`, t ? `splats gpu  sort ${t.computeMs.toFixed(2)} ms  draw ${t.drawMs.toFixed(2)} ms` : '', `splats ${(r.visibleSplats / 1e6).toFixed(2)}M visible / ${(r.activeSplats / 1e6).toFixed(2)}M active`].filter(Boolean).join('\n');
            frames = 0;
            last = time;
        }
    });
    Object.assign(window, { __scene: scene, __splats: splats, __camera: camera, __renderer: renderer, __controls: controls });
}

main().catch((err) => {
    console.error(err);
    msg.textContent = String(err?.message ?? err);
});
