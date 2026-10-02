// 九宫格增强:预览 modal + 批量切图链路验证(断言在主进程侧)
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

const PRESETS_DIR = path.join(ROOT, 'shared', 'presets');
ipcMain.handle('list-presets', () => fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, n + '.json'), 'utf8')));
ipcMain.handle('load-all-presets', () => fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => ({ name: f.replace(/\.json$/, ''), data: JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')) })));
for (const c of ['list-logos', 'list-textures', 'list-marks', 'list-templates', 'list-custom-icons']) ipcMain.handle(c, () => []);
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif', 'save-image-base64', 'save-images-batch', 'check-for-updates', 'start-update-download', 'quit-and-install']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}
ipcMain.handle('pick-export-location', () => ({ mode: 'dir', canceled: false, path: 'TEST-DIR' }));

let batchNames = [];
ipcMain.handle('write-export-files', (_e, payload) => {
    const files = (payload && payload.files) || [];
    const names = files.map(f => f.filename);
    for (const n of names) { if (!n) throw new Error('FAIL: f.filename 缺失'); }
    const sizes = files.map(f => f.data ? f.data.length : 0);
    if (sizes.some(s => s <= 0)) throw new Error('存在空 data');
    batchNames = batchNames.concat(names);
    return { ok: files.length, fail: 0 };
});

const CHECK = `
async () => {
    const App = window.App;
    await App.loadPresets();
    await new Promise(r => setTimeout(r, 300));

    function mkImg(w, h, color, ch) {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = color; g.fillRect(0, 0, w, h);
        g.fillStyle = '#fff'; g.font = 'bold 90px Arial'; g.fillText(ch, 40, 80);
        const img = new Image();
        return new Promise(r => { img.onload = () => r({ el: img, w, h }); img.src = c.toDataURL('image/png'); });
    }
    const a = await mkImg(600, 800, '#c06030', 'A');
    const b = await mkImg(600, 800, '#3060c0', 'B');
    App.images = [
        { el: a.el, name: '图A.png', w: a.w, h: a.h, exif: {}, customSettings: null },
        { el: b.el, name: '图B.png', w: b.w, h: b.h, exif: {}, customSettings: null }
    ];
    App.currentIdx = 0; App.image = App.images[0];
    App.template = App.defaultTemplate ? App.defaultTemplate() : { style: 'NONE', exif: { brand: 'TEST' } };

    // ① 预览路径
    await App.renderGridPreview();
    await new Promise(r => setTimeout(r, 400));
    const modal = document.getElementById('gridPreviewModal');
    const grid = document.getElementById('gridPreviewGrid');
    const cells = grid.querySelectorAll('.grid-preview-cell');
    if (modal.style.display !== 'flex') { console.log('FAIL①: 预览 modal 未显示'); return; }
    if (cells.length !== 9) { console.log('FAIL①: 预览格数=' + cells.length + '(期望9)'); return; }
    const cap0 = cells[0].querySelector('.grid-preview-cap');
    if (!/\\d+×\\d+/.test(cap0.textContent)) { console.log('FAIL①: 格尺寸提示缺失'); return; }
    console.log('PASS① 预览 modal: 9 格缩略图 + 每格尺寸提示 ✓');
    console.log('STEP:1');

    // ② 预览后直接导出(复用缓存)
    await App.exportGridCrop();
    await new Promise(r => setTimeout(r, 400));
    console.log('STEP:2');

    // ③ 批量:selectedIdx=[0,1] → 18 张
    App.selectedIdx = [0, 1];
    await App.exportGridCrop();
    await new Promise(r => setTimeout(r, 500));
    console.log('STEP:3');
}
`;

let checked = 0;
app.whenReady().then(async () => {
    protocol.handle('qflocal', (request) => {
        try {
            const u = new URL(request.url);
            const fp = u.searchParams.get('p');
            if (!fp || !fs.existsSync(fp)) return new Response('Not Found', { status: 404 });
            return net.fetch(pathToFileURL(fp).href);
        } catch (e) { return new Response('Not Found', { status: 404 }); }
    });
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    win.webContents.on('console-message', (_e, level, msg) => {
        console.log('[page:' + level + ']', msg);
        if (level !== 1 || checked >= 3) return;
        if (msg === 'STEP:1') {
            checked++;
        } else if (msg === 'STEP:2') {
            checked++;
            const ex = batchNames.slice(0, 9);
            if (ex.length !== 9) { console.log('FAIL②: 预览导出张数=' + ex.length); return; }
            if (ex[0] !== '图A_九宫格_1.jpg' || ex[8] !== '图A_九宫格_9.jpg') { console.log('FAIL②: 命名错误: ' + ex[0] + '..' + ex[8]); return; }
            console.log('PASS② 预览导出: 复用缓存 9 张命名正确 ✓');
        } else if (msg === 'STEP:3') {
            checked++;
            const batch = batchNames.slice(9); // 本次批量增量(此前 STEP:2 已导出 9 张)
            if (batch.length !== 18) { console.log('FAIL③: 批量张数=' + batch.length + '(期望18)'); return; }
            const aN = batch.filter(n => n.indexOf('图A_') === 0).length;
            const bN = batch.filter(n => n.indexOf('图B_') === 0).length;
            if (aN !== 9 || bN !== 9) { console.log('FAIL③: 图A=' + aN + ' 图B=' + bN + '(期望各9)'); return; }
            console.log('PASS③ 批量切图: 2张×9=18 张,图A/图B 各 9 张命名正确 ✓');
            console.log('SMOKE-DONE');
        }
    });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    const r = await win.webContents.executeJavaScript('(' + CHECK + ')()').catch(e => 'EXEC-ERR: ' + (e && e.message));
    console.log('EXEC-RESULT:', typeof r === 'string' ? r : (r || '(undefined)'));
    setTimeout(() => { app.quit(); }, 2500);
});
