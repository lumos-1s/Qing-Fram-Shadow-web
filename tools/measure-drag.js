// 基线测量:在真实 renderer 里测「拖动 Logo 时每帧的实际开销」
// 用法: npx electron tools/measure-drag.js
// 环境变量: STRESS_IN=照片目录(默认用项目内 shared 先凑一张)
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const IN_DIR = process.env.STRESS_IN || '';

protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// 最小 IPC 桥:只提供 loadPresets 与日志回传
ipcMain.handle('list-presets', () => {
    const d = path.join(ROOT, 'shared', 'presets');
    return fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
});
ipcMain.handle('load-preset', (_e, name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', name + '.json'), 'utf8')));
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const ch of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs']) {
    ipcMain.handle(ch, () => ({ canceled: true }));
}

// 造一张有内容的测试图(带噪点,避免纯色导致取色/模糊走捷径)
ipcMain.handle('measure:test-image', () => {
    const W = 4000, H = 3000; // 模拟典型高分辨率照片
    const c = Buffer.alloc(W * H * 3);
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 3;
            c[i] = (x * 255 / W | 0 * 0) + (rnd() * 40 | 0);
            c[i + 1] = (y * 255 / H | 0) + (rnd() * 40 | 0);
            c[i + 2] = ((x + y) * 255 / (W + H) | 0) + (rnd() * 40 | 0);
        }
    }
    return { w: W, h: H, raw: c.toString('base64') };
});

const MEASURE = `
async () => {
    const App = window.App;
    await App.loadPresets();
    const t0 = performance.now();
    const ti = await window.__measure.testImage();
    // 用 raw 像素造原图
    const c = document.createElement('canvas');
    c.width = ti.w; c.height = ti.h;
    const g = c.getContext('2d');
    const bin = atob(ti.raw);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const id = g.createImageData(ti.w, ti.h);
    for (let i = 0, j = 0; i < u8.length; i += 3, j += 4) { id.data[j] = u8[i]; id.data[j+1] = u8[i+1]; id.data[j+2] = u8[i+2]; id.data[j+3] = 255; }
    g.putImageData(id, 0, 0);
    const img = new Image();
    await new Promise(r => { img.onload = r; img.onerror = r; img.src = c.toDataURL('image/jpeg', 0.9); });
    const im = { el: img, name: 'test.jpg', w: img.naturalWidth, h: img.naturalHeight, exif: {}, customSettings: null };
    App.images = [im]; App.image = im; App.currentIdx = 0; App.selectedIdx = [];
    App.imageTemplates = new Map();
    const tLoad = performance.now() - t0;

    const results = [];
    // 挑几个代表性预设:简单图层 / 复杂图层 / 风格引擎 / 模糊
    const picks = ['极简细线','杂志封面','暗夜星空','3D卡片','背景模糊-经典','金箔奢华','撕纸相册','漫画分镜'];
    for (const name of picks) {
        const p = (App.presets || []).find(x => (x._fileName || '') === name);
        if (!p) { results.push({ name, err: 'preset not found' }); continue; }
        App.template = JSON.parse(JSON.stringify(p));
        // 放一个 logo 元素(复用一张小图当 logo)
        const lc = document.createElement('canvas'); lc.width = 400; lc.height = 160;
        const lg = lc.getContext('2d'); lg.fillStyle = '#111'; lg.fillRect(0,0,400,160); lg.fillStyle = '#fff'; lg.font = 'bold 60px Arial'; lg.fillText('BRAND', 30, 105);
        App.template.logoElements = [{ name: 'BRAND', dataUrl: lc.toDataURL('image/png'), x: 800, y: 600, size: 1, offsetX: 0, offsetY: 0 }];
        App.normalizeTemplate();
        App.invalidateStyleCaches();

        // 预热(建模糊底/取色缓存 + logo 位图)
        await new Promise(r => { App.renderPreview(); setTimeout(r, 500); });

        // 模拟真实拖动:带上 _dragEl / _skipUserEl / 背景缓存,走 renderPreview 的叠加层分支
        // 同时用 __render(App,false) 直接量一次「全量合成」作为对照(改动前的每帧成本)
        const N = 8;
        const overlay = [];
        const full = [];
        let cacheHit = false;
        const el0 = App.template.logoElements[0];

        // 拖动首帧预热:让 renderPreview 走一次正常整帧 + 建背景缓存
        App._dragEl = { kind: 'logo', ref: el0, sx: 0, sy: 0, x: 0, y: 0, moved: true };
        App._skipUserEl = el0;
        await new Promise(r => {
            App.renderToken++;
            App.renderPreview();
            requestAnimationFrame(() => requestAnimationFrame(r));
        });
        cacheHit = App._dragBaseValid();

        for (let k = 0; k < N; k++) {
            el0.x = 800 + k * 15; el0.y = 600 + k * 10;
            App._dragEl = { kind: 'logo', ref: el0, sx: 0, sy: 0, x: 0, y: 0, moved: true };
            App._skipUserEl = el0;
            App.normalizeTemplate();

            // 对照:改造前的路径 = 每帧全量合成
            const f0 = performance.now();
            App.renderToken++;
            window.__render(App, false);
            try { App.dom.canvas.getContext('2d').getImageData(0, 0, 1, 1); } catch (e) {}
            full.push(performance.now() - f0);

            // 新路径:renderPreview 在拖动分支做的实际工作(背景 blit + 重绘被拖元素 + 选择框/参考线)
            // 注意必须同步测:隐藏窗口里 rAF 被节流到 ~1fps,经 rAF 派发会量到等待时间而非渲染耗时
            const s = performance.now();
            App.normalizeTemplate();
            App._blitDragBase();
            App._drawDraggedEl(App.dom.canvas.getContext('2d'), el0, 'logo',
                App.dom.canvas.width, App.dom.canvas.height);
            App.drawSelectionBox();
            App.drawLogoGuides();
            const ctx2 = App.dom.canvas.getContext('2d');
            try { ctx2.getImageData(0, 0, 1, 1); } catch (e) {}
            overlay.push(performance.now() - s);
        }
        App._dragEl = null; App._skipUserEl = null; App._dropDragBase();

        const med = (a) => { const b = a.slice().sort((x, y) => x - y); return Math.round(b[b.length >> 1] * 10) / 10; };
        const canvas = App.dom.canvas;
        results.push({
            name, style: App.template.photoFrameStyle || '(图层模板)',
            renderMs: med(full),      // 改造前:每帧全量合成
            overlayMs: med(overlay),  // 改造后:叠加层
            cacheOk: cacheHit,
            canvasW: canvas.width, canvasH: canvas.height,
            mp: Math.round(canvas.width * canvas.height / 1e6 * 10) / 10,
        });
    }
    return { imgLoadMs: Math.round(tLoad), imgW: img.naturalWidth, imgH: img.naturalHeight, dpr: window.devicePixelRatio, results };
}
`;

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try {
            const u = new URL(req.url);
            const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });

    const win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload-measure.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
        },
    });
    win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('  [renderer] ' + String(msg).slice(0, 300)); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

    // 等 App 就绪
    for (let i = 0; i < 120; i++) {
        const ok = await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && window.App.presets)');
        if (ok) break;
        await new Promise(r => setTimeout(r, 250));
    }

    const r = await win.webContents.executeJavaScript(`(${MEASURE})()`);
    console.log('清框影 · 拖动 Logo 每帧开销(改造前 vs 改造后)');
    console.log('─'.repeat(86));
    console.log(`测试图 ${r.imgW}x${r.imgH} · devicePixelRatio=${r.dpr} · 造图耗时 ${r.imgLoadMs}ms`);
    console.log('─'.repeat(86));
    console.log('预设'.padEnd(14) + '风格'.padEnd(18) + '全量合成'.padStart(11) + '叠加层'.padStart(11) + '提速'.padStart(9) + '  画布');
    const ok = r.results.filter(x => !x.err);
    for (const x of ok) {
        const gain = x.overlayMs > 0 ? (x.renderMs / x.overlayMs) : 0;
        console.log(
            x.name.padEnd(12) +
            String(x.style).slice(0, 16).padEnd(18) +
            (x.renderMs + 'ms').padStart(11) +
            (x.overlayMs + 'ms').padStart(11) +
            (gain.toFixed(1) + 'x').padStart(9) +
            `  ${x.canvasW}x${x.canvasH} (${x.mp}MP)`
        );
    }
    for (const x of r.results.filter(y => y.err)) console.log(x.name.padEnd(12) + x.err);
    console.log('─'.repeat(86));
    if (ok.length) {
        const avgBefore = ok.reduce((s, x) => s + x.renderMs, 0) / ok.length;
        const avgAfter = ok.reduce((s, x) => s + x.overlayMs, 0) / ok.length;
        console.log(`平均: 全量合成 ${avgBefore.toFixed(1)}ms → 叠加层 ${avgAfter.toFixed(1)}ms  (提速 ${(avgBefore / avgAfter).toFixed(1)}x)`);
    }
    console.log('参考:60fps 预算 16.7ms/帧;30fps 预算 33.3ms/帧。');
    app.quit();
}).catch(e => { console.error(e); process.exit(1); });
