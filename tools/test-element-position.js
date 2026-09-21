// 跨照片尺寸的元素位置一致性回归测试
// 背景:元素坐标原为「绝对画布像素」,同一套模板套到尺寸不同的照片上会跑出画布。
// 现改为按「基准画布」相对比例(rel + rx/ry)存储,本测试锁定该行为不回退。
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
ipcMain.handle('list-logos', () => []);
ipcMain.handle('list-textures', () => []);
ipcMain.handle('list-templates', () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}

const CHECK = `
async () => {
    const App = window.App;
    await App.loadPresets();
    const cases = [];

    async function mkImg(W, H) {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d');
        const grd = g.createLinearGradient(0, 0, W, H);
        grd.addColorStop(0, '#2b4a63'); grd.addColorStop(1, '#a8703c');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        for (let i = 0; i < 30; i++) { g.fillStyle = 'rgba(255,255,255,0.2)'; g.fillRect((i*97)%W, (i*53)%H, 40, 24); }
        const im = new Image();
        await new Promise(r => { im.onload = r; im.src = c.toDataURL('image/jpeg', 0.9); });
        return { el: im, name: 'p.jpg', w: im.naturalWidth, h: im.naturalHeight, exif: {}, customSettings: null };
    }
    const lc = document.createElement('canvas'); lc.width = 300; lc.height = 120;
    const lg = lc.getContext('2d');
    lg.fillStyle = '#e8442a'; lg.fillRect(0, 0, 300, 120);
    lg.fillStyle = '#fff'; lg.font = 'bold 48px Arial'; lg.fillText('LOGO', 40, 80);
    const LOGO = lc.toDataURL('image/png');

    // 尺寸刻意让基准画布不同(大图 1800 基准 / 小图 800 基准),才能暴露绝对像素的问题
    const big = await mkImg(1800, 1350);
    const small = await mkImg(800, 500);
    App.images = [big, small]; App.imageTemplates = new Map();
    App.currentIdx = 0; App.image = big; App.selectedIdx = [0];
    App.template = App.defaultTemplate();
    App.template.logoElements = [];
    App.normalizeTemplate();
    App.invalidateStyleCaches();
    App.scheduleRender(true);
    await new Promise(r => setTimeout(r, 800));

    // 在基准画布坐标下放到 80%, 85%
    const b0 = App.logoBaseSize();
    const el = { name: 'L', dataUrl: LOGO, x: 0, y: 0, size: 200, ratio: 0.4, opacity: 100, z: 10 };
    App.template.logoElements.push(el);
    App.setLogoPixelPos(el, (b0 ? b0.w : 1800) * 0.80, (b0 ? b0.h : 1350) * 0.85);
    App.saveCurrentTemplate();
    big.customSettings = JSON.parse(JSON.stringify(App.template));
    App.imageTemplates.set(big, big.customSettings);
    App.scheduleRender(true);
    await new Promise(r => setTimeout(r, 700));

    function sample(label) {
        const cv = App.dom.canvas;
        const base = App.logoBaseSize();
        const e = (App.template.logoElements || [])[0];
        if (!e) return { label, ok: false, why: '元素丢失' };
        const p = App.logoPos(e, cv.width, cv.height, e.size);
        const rel = [p.cx / cv.width, p.cy / cv.height];
        return {
            label, ok: true,
            base: base ? base.w + 'x' + base.h : 'null',
            stored: 'rel=' + e.rel + ' rx=' + (e.rx != null ? e.rx.toFixed(3) : '-') + ' ry=' + (e.ry != null ? e.ry.toFixed(3) : '-'),
            px: Math.round(p.cx) + ',' + Math.round(p.cy),
            rel,
            offscreen: p.cx > cv.width || p.cy > cv.height,
        };
    }

    cases.push(sample('大图 1800x1350'));

    // 走真实「同步边框」→ 切到小图
    App.currentIdx = 0; App.image = big; App.selectedIdx = [0, 1];
    App.syncBorderTo(1);
    await new Promise(r => setTimeout(r, 700));
    App.selectImage(1);
    await new Promise(r => setTimeout(r, 900));
    cases.push(sample('小图 800x500(同步后)'));

    // 旧模板兼容:元素只有绝对像素、没有 rel,应仍按像素定位(不崩、不偏到 0)
    {
        App.template = App.defaultTemplate();
        App.template.logoElements = [{ name: 'OLD', dataUrl: LOGO, x: 400, y: 300, size: 120, ratio: 0.4, opacity: 100, z: 10 }];
        App.normalizeTemplate();
        const e = App.template.logoElements[0];
        const p = App.logoPos(e, 1600, 1000, e.size);
        cases.push({ label: '旧模板(纯像素坐标)', ok: p.cx === 400 && p.cy === 300, base: '-', stored: '无 rel', px: Math.round(p.cx) + ',' + Math.round(p.cy), rel: [0.25, 0.3] });
    }
    // 锚点元素兼容:字符串 x/y 仍走锚点分支
    {
        const e = { name: 'A', dataUrl: LOGO, x: 'right', y: 'bottom', size: 100, ratio: 0.4, offsetX: 20, offsetY: 20 };
        const p = App.logoPos(e, 1000, 800, 100);
        // dw = size = 100 → 半宽 50;dh = size*ratio = 40 → 半高 20;留边 20
        const ex = 1000 - 20 - 50, ey = 800 - 20 - 20;
        const okAnchor = Math.abs(p.cx - ex) < 0.01 && Math.abs(p.cy - ey) < 0.01;
        cases.push({
            label: '锚点元素(字符串坐标,含纵横比)', ok: okAnchor,
            base: '-', stored: "x='right' y='bottom'", px: Math.round(p.cx) + ',' + Math.round(p.cy),
            rel: [p.cx / 1000, p.cy / 800], expect: '期望 ' + ex + ',' + ey,
        });
    }
    return cases;
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
    win.webContents.on('console-message', (_e, l, m) => { const s = String(m); if (l >= 2 && !/willReadFrequently/.test(s)) console.log('  [renderer] ' + s.slice(0, 200)); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    for (let i = 0; i < 120; i++) {
        if (await win.webContents.executeJavaScript('!!(window.App && window.App.dom && window.App.dom.canvas && window.App.presets)')) break;
        await new Promise(r => setTimeout(r, 250));
    }
    const cases = await win.webContents.executeJavaScript(`(${CHECK})()`);
    let fail = 0;
    console.log('跨照片尺寸的元素位置一致性');
    console.log('─'.repeat(84));
    for (const c of cases) {
        if (!c.ok) fail++;
        console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.label}`);
        console.log(`       基准=${c.base}  ${c.stored}  像素=${c.px}  相对=${c.rel[0].toFixed(3)},${c.rel[1].toFixed(3)}${c.offscreen ? '  ← 画布外!' : ''}${c.expect ? '   期望: ' + c.expect : ''}`);
    }
    console.log('─'.repeat(84));
    // 核心断言:大图与小图的相对位置应一致(容差 0.02)
    const a = cases[0], b = cases[1];
    if (a.ok && b.ok) {
        const dx = Math.abs(a.rel[0] - b.rel[0]), dy = Math.abs(a.rel[1] - b.rel[1]);
        const same = dx < 0.02 && dy < 0.02 && !a.offscreen && !b.offscreen;
        if (!same) fail++;
        console.log(`  跨尺寸漂移: Δx=${dx.toFixed(3)} Δy=${dy.toFixed(3)}  → ${same ? '一致 ✓' : '不一致 ✖'}`);
    }
    console.log('─'.repeat(84));
    console.log(fail ? `✖ ${fail} 项未通过` : `✓ 全部 ${cases.length} 项通过`);
    app.quit();
}).catch(e => { console.error(e); process.exit(1); });
