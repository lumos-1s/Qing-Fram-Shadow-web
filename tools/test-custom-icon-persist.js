// 验证:删除/重命名自定义图标真实写回磁盘 json(不再重启复活)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
protocol.registerSchemesAsPrivileged([{ scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const PRESETS_DIR = path.join(ROOT, 'shared', 'presets');
const TMP = path.join(os.tmpdir(), 'qfs-test-icons.json');
fs.writeFileSync(TMP, JSON.stringify([
    { name: '甲', dataUrl: 'data:image/png;base64,AAAA', custom: true },
    { name: '乙', dataUrl: 'data:image/png;base64,BBBB', custom: true }
]));

ipcMain.handle('list-presets', () => fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
ipcMain.handle('load-preset', (_e, n) => JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, n + '.json'), 'utf8')));
ipcMain.handle('load-all-presets', () => fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).map(f => ({ name: f.replace(/\.json$/, ''), data: JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')) })));
for (const c of ['list-logos', 'list-textures', 'list-marks', 'list-templates']) ipcMain.handle(c, () => []);
ipcMain.handle('list-custom-icons', () => JSON.parse(fs.readFileSync(TMP, 'utf-8')));
ipcMain.handle('delete-custom-icon', (_e, d) => {
    const a = JSON.parse(fs.readFileSync(TMP, 'utf-8')).filter(c => c.dataUrl !== d);
    fs.writeFileSync(TMP, JSON.stringify(a));
    return { ok: true, removed: 1 };
});
ipcMain.handle('rename-custom-icon', (_e, d, n) => {
    const a = JSON.parse(fs.readFileSync(TMP, 'utf-8'));
    let changed = 0;
    a.forEach(c => { if (c.dataUrl === d) { c.name = n; changed++; } });
    fs.writeFileSync(TMP, JSON.stringify(a));
    return { ok: true, changed };
});
ipcMain.handle('get-prefs', () => ({}));
ipcMain.handle('get-user', () => null);
ipcMain.handle('save-prefs', () => ({ ok: true }));
for (const c of ['open-image', 'open-images', 'open-sticker-image', 'import-template', 'open-qfs', 'save-template', 'load-template', 'delete-template', 'rename-template', 'export-template', 'export-qfs', 'save-user', 'logout-user', 'read-exif', 'save-image-base64', 'save-images-batch', 'check-for-updates', 'start-update-download', 'quit-and-install']) {
    ipcMain.handle(c, () => (c.startsWith('open') ? { canceled: true } : { ok: true }));
}
ipcMain.handle('pick-export-location', () => ({ mode: 'dir', canceled: false, dir: 'TEST' }));
ipcMain.handle('write-export-files', () => ({ ok: 9, fail: 0 }));

const CHECK = `
async () => {
    const App = window.App;
    await App.loadPresets();
    await App.loadLogos();
    await new Promise(r => setTimeout(r, 300));
    const customs = App.logos.filter(l => l.custom);
    console.log('LOADED_CUSTOMS:', customs.length, customs.map(c => c.name).join(','));
    if (customs.length !== 2) { console.log('RESULT: FAIL 初始加载应为 2 个自定义图标'); return; }
    // 删除甲
    await App.deleteCustomIcon(customs[0]);
    const afterDel = await window.qingframe.listCustomIcons();
    console.log('AFTER_DEL:', afterDel.length, afterDel.map(c => c.name).join(','));
    // 重命名乙
    await window.qingframe.renameCustomIcon('data:image/png;base64,BBBB', '乙新名');
    const afterRen = await window.qingframe.listCustomIcons();
    console.log('AFTER_REN:', afterRen.length, afterRen.map(c => c.name).join(','));
    const ok = afterDel.length === 1 && afterDel[0].name === '乙' && afterRen.length === 1 && afterRen[0].name === '乙新名';
    console.log('RESULT: ' + (ok ? 'PASS 删除写盘+重命名写盘均生效' : 'FAIL'));
}
`;

app.whenReady().then(async () => {
    protocol.handle('qflocal', (request) => {
        try { const u = new URL(request.url); const fp = u.searchParams.get('p'); if (!fp || !fs.existsSync(fp)) return new Response('Not Found', { status: 404 }); return net.fetch(pathToFileURL(fp).href); }
        catch (e) { return new Response('Not Found', { status: 404 }); }
    });
    const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { preload: path.join(ROOT, 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    win.webContents.on('console-message', (_e, level, msg) => { console.log('[page][' + level + ']', msg); });
    await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
    try { await win.webContents.executeJavaScript('(' + CHECK + ')()'); }
    catch (e) { console.log('[main] executeJavaScript error:', e && e.message); }
    setTimeout(() => { app.quit(); }, 600);
});
