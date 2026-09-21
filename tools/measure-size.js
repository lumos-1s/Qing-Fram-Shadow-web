// 测量:拖动卡顿到底跟「源图尺寸」有关还是跟「导入的 Logo 尺寸」有关
// 用法: npx electron tools/measure-size.js
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);
ipcMain.handle('list-presets', () => fs.readdirSync(path.join(ROOT, 'shared', 'presets')).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'shared', 'presets', n + '.json'), 'utf8')));
for (const c of ['list-logos', 'list-textures', 'list-templates']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

const BODY = `
async () => {
    const App = window.App;
    await App.loadPresets();

    // 造指定尺寸、带噪点的测试图(噪点避免取色/模糊走捷径)
    function makeImg(W, H) {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d');
        const grd = g.createLinearGradient(0, 0, W, H);
        grd.addColorStop(0, '#1d3f60'); grd.addColorStop(0.5, '#a8743c'); grd.addColorStop(1, '#2f6045');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        let seed = 7;
        const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const n = Math.min(12000, Math.round(W * H / 500));
        for (let i = 0; i < n; i++) {
            g.fillStyle = 'rgba(255,255,255,' + (0.05 + rnd() * 0.2) + ')';
            g.fillRect(rnd() * W, rnd() * H, 3 + rnd() * 30, 3 + rnd() * 20);
        }
        return c;
    }

    // 造指定尺寸的 Logo 图(带文字的透明 PNG)
    function makeLogo(W, H) {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d');
        g.fillStyle = '#e8442a'; g.fillRect(W * 0.05, H * 0.1, W * 0.9, H * 0.8);
        g.fillStyle = '#ffffff'; g.font = 'bold ' + Math.round(H * 0.5) + 'px Arial';
        g.fillText('LOGO', W * 0.12, H * 0.72);
        return c.toDataURL('image/png');
    }

    async function loadImg(canvasEl) {
        const im = new Image();
        await new Promise(r => { im.onload = r; im.onerror = r; im.src = canvasEl.toDataURL('image/jpeg', 0.88); });
        return im;
    }

    // 一次测量:给定源图与 logo 图,返回 {bg: 建背景一帧, ov: 拖动每帧}
    async function measure(srcCanvas, logoDataUrl, presetName) {
        const img = await loadImg(srcCanvas);
        const im = { el: img, name: 't.jpg', w: img.naturalWidth, h: img.naturalHeight, exif: {}, customSettings: null };
        App.images = [im]; App.image = im; App.currentIdx = 0; App.selectedIdx = [];
        App.imageTemplates = new Map();
        const p = (App.presets || []).find(x => (x._fileName || '') === presetName);
        App.template = JSON.parse(JSON.stringify(p));
        const el = { name: 'L', dataUrl: logoDataUrl, x: 0, y: 0, size: 260, offsetX: 0, offsetY: 0, opacity: 100 };
        App.template.logoElements = [el];
        App.normalizeTemplate();
        App.invalidateStyleCaches();
        await new Promise(r => { App.renderPreview(); setTimeout(r, 450); });
        const cw = App.dom.canvas.width, ch = App.dom.canvas.height;
        el.x = Math.round(cw * 0.45); el.y = Math.round(ch * 0.55);

        const body = (drag) => {
            if (!drag) { App._dragEl = null; App._skipUserEl = null; App._dropDragBase(); }
            App.normalizeTemplate();
            const ctx = App.dom.canvas.getContext('2d');
            window.__render(App, false);
            try { ctx.getImageData(0, 0, 1, 1); } catch (e) {}
        };
        const med = (a) => { const b = a.slice().sort((x, y) => x - y); return Math.round(b[b.length >> 1] * 10) / 10; };

        // 建背景一帧(拖动首帧)
        App._dragEl = { kind: 'logo', ref: el, sx: 0, sy: 0, x: 0, y: 0, moved: true };
        App._skipUserEl = el;
        App._dropDragBase();
        const bt = [];
        for (let i = 0; i < 3; i++) { const s = performance.now(); body(true); App._dragBaseBuild(); bt.push(performance.now() - s); }

        // 拖动每帧(叠加层)
        const ot = [];
        for (let i = 0; i < 8; i++) {
            el.x = Math.round(cw * 0.45) + i * 9; el.y = Math.round(ch * 0.55) + i * 6;
            App.normalizeTemplate();
            const s = performance.now();
            App._blitDragBase();
            App._drawDraggedEl(App.dom.canvas.getContext('2d'), el, 'logo', cw, ch);
            try { App.dom.canvas.getContext('2d').getImageData(0, 0, 1, 1); } catch (e) {}
            ot.push(performance.now() - s);
        }
        // 对照:全量合成一帧
        App._dragEl = null; App._skipUserEl = null; App._dropDragBase();
        const ft = [];
        for (let i = 0; i < 3; i++) { const s = performance.now(); body(false); ft.push(performance.now() - s); }
        return { cw, ch, mp: Math.round(cw * ch / 1e6 * 10) / 10, bg: med(bt), ov: med(ot), full: med(ft) };
    }

    const P = '极简细线';
    const out = { srcTest: [], logoTest: [], dpr: window.devicePixelRatio, capTest: [] };
    const LOGO_SMALL = makeLogo(400, 160);
    const SRC_MID = makeImg(4000, 3000);

    // ① 变量:源图尺寸(Logo 固定 400x160)
    for (const [w, h] of [[1600, 1200], [3000, 2000], [4000, 3000], [6000, 4000], [8000, 6000]]) {
        const r = await measure(makeImg(w, h), LOGO_SMALL, P);
        out.srcTest.push(Object.assign({ src: w + 'x' + h, srcMP: Math.round(w * h / 1e6 * 10) / 10 }, r));
    }
    // ② 变量:Logo 尺寸(源图固定 4000x3000)
    for (const [w, h] of [[200, 80], [400, 160], [1000, 400], [2000, 800], [4000, 1600], [8000, 3200]]) {
        const r = await measure(SRC_MID, makeLogo(w, h), P);
        out.logoTest.push(Object.assign({ logo: w + 'x' + h, logoMP: Math.round(w * h / 1e6 * 10) / 10 }, r));
    }

    // ③ 验证解法:拖动期间把 displayMax 降到 900(代码里已有的手势降级机制),画布随之变小
    const capSrc = makeImg(4000, 3000);
    for (const cap of [1800, 1200, 900, 600]) {
        const img = await loadImg(capSrc);
        const im = { el: img, name: 't.jpg', w: img.naturalWidth, h: img.naturalHeight, exif: {}, customSettings: null };
        App.images = [im]; App.image = im; App.currentIdx = 0; App.selectedIdx = [];
        App.imageTemplates = new Map();
        const p = (App.presets || []).find(x => (x._fileName || '') === P);
        App.template = JSON.parse(JSON.stringify(p));
        const el = { name: 'L', dataUrl: LOGO_SMALL, x: 0, y: 0, size: 260, offsetX: 0, offsetY: 0, opacity: 100 };
        App.template.logoElements = [el];
        App.normalizeTemplate();
        App.displayMax = cap;                 // ← 模拟拖动降级
        App.invalidateStyleCaches();
        await new Promise(r => { App.renderPreview(); setTimeout(r, 450); });
        const cw = App.dom.canvas.width, ch = App.dom.canvas.height;
        el.x = Math.round(cw * 0.45); el.y = Math.round(ch * 0.55);
        App._dragEl = { kind: 'logo', ref: el, sx: 0, sy: 0, x: 0, y: 0, moved: true };
        App._skipUserEl = el;
        App._dropDragBase();
        App.normalizeTemplate();
        window.__render(App, false);
        App._dragBaseBuild();
        const ot = [];
        for (let i = 0; i < 8; i++) {
            el.x = Math.round(cw * 0.45) + i * 6;
            const s = performance.now();
            App._blitDragBase();
            App._drawDraggedEl(App.dom.canvas.getContext('2d'), el, 'logo', cw, ch);
            try { App.dom.canvas.getContext('2d').getImageData(0, 0, 1, 1); } catch (e) {}
            ot.push(performance.now() - s);
        }
        App._dragEl = null; App._skipUserEl = null; App._dropDragBase();
        delete App.displayMax;
        const med2 = (a) => { const b = a.slice().sort((x, y) => x - y); return Math.round(b[b.length >> 1] * 10) / 10; };
        out.capTest.push({ cap, cw, ch, mp: Math.round(cw * ch / 1e6 * 10) / 10, ov: med2(ot) });
    }
    return out;
}
`;

app.whenReady().then(async () => {
    protocol.handle('qflocal', (req) => {
        try { const u = new URL(req.url); const p = u.searchParams.get('p');
            if (!p || !fs.existsSync(p)) return new Response('NF', { status: 404 });
            return net.fetch(pathToFileURL(p).href);
        } catch (e) { return new Response('NF', { status: 404 }); }
    });
    const win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (_e, l, m) => { if (l >= 2) console.log('  [renderer] ' + String(m).slice(0, 200)); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && window.App.presets)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    const r = await win.webContents.executeJavaScript(`(${BODY})()`);

    console.log(`清框影 · 拖动开销归因(预设「极简细线」, devicePixelRatio=${r.dpr})`);
    console.log('═'.repeat(78));
    console.log('① 变量 = 源图尺寸(Logo 固定 400x160)');
    console.log('─'.repeat(78));
    console.log('源图'.padEnd(14) + '源图MP'.padStart(8) + '画布'.padStart(14) + '画布MP'.padStart(8) + '全量合成'.padStart(11) + '建背景'.padStart(10) + '拖动每帧'.padStart(11));
    for (const x of r.srcTest) {
        console.log(
            x.src.padEnd(12) + String(x.srcMP).padStart(8) + (x.cw + 'x' + x.ch).padStart(14) + String(x.mp).padStart(8) +
            (x.full + 'ms').padStart(11) + (x.bg + 'ms').padStart(10) + (x.ov + 'ms').padStart(11));
    }
    console.log('═'.repeat(78));
    console.log('② 变量 = Logo 图片尺寸(源图固定 4000x3000)');
    console.log('─'.repeat(78));
    console.log('Logo图'.padEnd(14) + 'LogoMP'.padStart(8) + '画布'.padStart(14) + '画布MP'.padStart(8) + '全量合成'.padStart(11) + '建背景'.padStart(10) + '拖动每帧'.padStart(11));
    for (const x of r.logoTest) {
        console.log(
            x.logo.padEnd(12) + String(x.logoMP).padStart(8) + (x.cw + 'x' + x.ch).padStart(14) + String(x.mp).padStart(8) +
            (x.full + 'ms').padStart(11) + (x.bg + 'ms').padStart(10) + (x.ov + 'ms').padStart(11));
    }
    console.log('═'.repeat(78));
    console.log('③ 验证解法:拖动期间降低渲染上限 displayMax(源图 4000x3000,Logo 400x160)');
    console.log('─'.repeat(78));
    console.log('displayMax'.padEnd(14) + '画布'.padStart(14) + '画布MP'.padStart(8) + '拖动每帧'.padStart(12) + '  达标');
    for (const x of r.capTest) {
        const okMark = x.ov <= 16.7 ? '✓ 60fps' : (x.ov <= 33.3 ? '~ 30fps' : '✗ 掉帧');
        console.log(String(x.cap).padEnd(14) + (x.cw + 'x' + x.ch).padStart(14) + String(x.mp).padStart(8) + (x.ov + 'ms').padStart(12) + '  ' + okMark);
    }
    console.log('═'.repeat(78));
    console.log('参考:60fps 预算 16.7ms/帧,30fps 预算 33.3ms/帧。');
    app.quit();
}).catch(e => { console.error(e); process.exit(1); });
