const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    const PRESETS_DIR = path.join(__dirname, '..', '..', 'shared', 'presets');
    const LOGOS_DIR = path.join(__dirname, '..', '..', 'shared', 'brandlogos');
    const TEXTURES_DIR = path.join(__dirname, '..', '..', 'shared', 'textures');
    const TEMPLATES_DIR = path.join(app.getPath('userData'), 'templates');

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 640,
        title: '清框影 · 照片加框',
        backgroundColor: '#181B1A',
        icon: path.join(__dirname, 'icon.png'),
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.once('ready-to-show', () => win.show());
    return win;
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('list-presets', () => {
    try {
        if (!fs.existsSync(PRESETS_DIR)) return [];
        return fs.readdirSync(PRESETS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace(/\.json$/, ''));
    } catch (e) { return []; }
});

ipcMain.handle('load-preset', (_e, name) => {
    try {
        const p = path.join(PRESETS_DIR, name + '.json');
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) { return null; }
});

function readImagesAsDataUrls(dir, exts) {
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(f => exts.some(ext => f.toLowerCase().endsWith(ext)))
            .map(f => {
                const full = path.join(dir, f);
                const buf = fs.readFileSync(full);
                const mime = f.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
                return { name: f.replace(/\.\w+$/, ''), dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
            });
    } catch (e) { return []; }
}

ipcMain.handle('list-logos', () => {
    return readImagesAsDataUrls(LOGOS_DIR, ['.png', '.jpg', '.jpeg']);
});

ipcMain.handle('list-textures', () => {
    return readImagesAsDataUrls(TEXTURES_DIR, ['.png', '.jpg', '.jpeg']);
});

function ensureTemplatesDir() {
    if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
    return TEMPLATES_DIR;
}

ipcMain.handle('save-template', (_e, { name, data }) => {
    try {
        if (!name) return { ok: false, error: '模板名称为空' };
        ensureTemplatesDir();
        const safe = String(name).replace(/[\/\\:*?"<>|]/g, '_');
        fs.writeFileSync(path.join(TEMPLATES_DIR, safe + '.json'), JSON.stringify(data, null, 2), 'utf-8');
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('list-templates', () => {
    try {
        ensureTemplatesDir();
        return fs.readdirSync(TEMPLATES_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace(/\.json$/, ''));
    } catch (e) { return []; }
});

ipcMain.handle('load-template', (_e, name) => {
    try {
        const p = path.join(TEMPLATES_DIR, name + '.json');
        if (!fs.existsSync(p)) return null;
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) { return null; }
});

ipcMain.handle('delete-template', (_e, name) => {
    try {
        const p = path.join(TEMPLATES_DIR, name + '.json');
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('export-template', async (_e, { name, data }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出模板',
        defaultPath: (name || 'template') + '.json',
        filters: [{ name: 'JSON 模板', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('import-template', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '导入模板',
        filters: [{ name: 'JSON 模板', extensions: ['json'] }],
        properties: ['openFile']
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    try {
        const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
        return { ok: true, name: path.basename(filePaths[0], '.json'), data };
    } catch (e) { return { ok: false, error: '模板格式错误：' + e.message }; }
});

ipcMain.handle('open-image', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择照片',
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
        properties: ['openFile']
    });
    if (canceled || filePaths.length === 0) return null;
    const fp = filePaths[0];
    return { name: path.basename(fp), path: fp, data: fs.readFileSync(fp).toString('base64') };
});

ipcMain.handle('save-image-base64', async (_e, { data, filename }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出图片',
        defaultPath: filename,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }, { name: 'JPEG 图片', extensions: ['jpg'] }]
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    return true;
});

ipcMain.handle('save-images-batch', async (_e, files) => {
    // files: [{ data, filename }]
    let dir = null;
    try {
        const res = await dialog.showOpenDialog({
            title: '选择导出目录',
            properties: ['openDirectory', 'createDirectory']
        });
        if (res.canceled || !res.filePaths.length) return { canceled: true };
        dir = res.filePaths[0];
    } catch (e) { return { canceled: true, error: String(e) }; }
    let ok = 0, fail = 0;
    try {
        for (const f of files) {
            if (!f || !f.data) { fail++; continue; }
            try {
                fs.writeFileSync(path.join(dir, f.filename), Buffer.from(f.data, 'base64'));
                ok++;
            } catch (e) { fail++; }
        }
    } catch (e) { return { ok, fail, error: String(e) }; }
    return { ok, fail, dir };
});

    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
}