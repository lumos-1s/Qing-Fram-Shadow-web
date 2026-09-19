const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { createStateStore } = require('./state');

// 渲染进程通过 qflocal:// 协议在磁盘上直接读取照片(不经过 base64 过 IPC,节省内存)
protocol.registerSchemesAsPrivileged([
    { scheme: 'qflocal', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// 主进程侧 EXIF 解析(渲染进程 exif.js 以 CommonJS 导出)
const exifUtil = require(path.join(__dirname, '..', 'renderer', 'js', 'exif.js'));
async function readExif(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return {};
        const buf = await fs.promises.readFile(filePath);
        if (!buf || !buf.length) return {};
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const raw = exifUtil.parseExif(ab);
        return exifUtil.exifSummary(raw) || {};
    } catch (e) { return {}; }
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    const PRESETS_DIR = path.join(__dirname, '..', '..', 'shared', 'presets');
    const LOGOS_DIR = path.join(__dirname, '..', '..', 'shared', 'brandlogos');
    const TEXTURES_DIR = path.join(__dirname, '..', '..', 'shared', 'textures');
    const TEMPLATES_DIR = path.join(app.getPath('userData'), 'templates');
    const { loadState, saveState, validDir, freeFilePath } = createStateStore(path.join(app.getPath('userData'), 'state.json'));

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
    protocol.handle('qflocal', (request) => {
        try {
            const u = new URL(request.url);
            const filePath = u.searchParams.get('p');
            if (!filePath || !fs.existsSync(filePath)) return new Response('Not Found', { status: 404 });
            return net.fetch(pathToFileURL(filePath).href);
        } catch (e) {
            return new Response('Not Found', { status: 404 });
        }
    });
    createWindow();

    // ── 自动更新：仅打包后(app.isPackaged)生效，开发模式跳过；任何异常都不阻塞启动 ──
    if (app.isPackaged) {
        try {
            const { autoUpdater } = require('electron-updater');
            autoUpdater.autoDownload = true;
            autoUpdater.checkForUpdatesAndNotify().catch(err => {
                console.warn('[updater] 检查更新失败:', err && err.message);
            });
        } catch (e) {
            console.warn('[updater] 初始化失败:', e && e.message);
        }
    }

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
    const st = loadState();
    const baseName = (name || 'template') + '.json';
    const def = validDir(st.lastExportDir) ? path.join(st.lastExportDir, baseName) : baseName;
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出模板',
        defaultPath: def,
        filters: [{ name: 'JSON 模板', extensions: ['json'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        saveState({ lastExportDir: path.dirname(filePath) });
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('import-template', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '导入模板',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [{ name: 'JSON 模板', extensions: ['json'] }],
        properties: ['openFile']
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    try {
        const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
        saveState({ lastOpenDir: path.dirname(filePaths[0]) });
        return { ok: true, name: path.basename(filePaths[0], '.json'), data };
    } catch (e) { return { ok: false, error: '模板格式错误：' + e.message }; }
});

// ── .qfs 工程文件:自包含单文件(模板 + 源照片 + 每图模板,照片以 base64 内嵌) ──
ipcMain.handle('export-qfs', async (_e, data) => {
    const st = loadState();
    const baseName = (data && data.name ? String(data.name) : '未命名工程') + '.qfs';
    const def = validDir(st.lastExportDir) ? path.join(st.lastExportDir, baseName) : baseName;
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出工程 (.qfs)',
        defaultPath: def,
        filters: [
            { name: '清框影工程 (*.qfs)', extensions: ['qfs'] },
            { name: 'JSON', extensions: ['json'] }
        ]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        saveState({ lastExportDir: path.dirname(filePath) });
        return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
});

ipcMain.handle('open-qfs', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '打开工程 (.qfs)',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [
            { name: '清框影工程 (*.qfs)', extensions: ['qfs'] },
            { name: 'JSON', extensions: ['json'] }
        ],
        properties: ['openFile']
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    try {
        const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
        saveState({ lastOpenDir: path.dirname(filePaths[0]) });
        return { ok: true, name: path.basename(filePaths[0], path.extname(filePaths[0])), data };
    } catch (e) { return { ok: false, error: '工程文件格式错误：' + e.message }; }
});

ipcMain.handle('get-user', () => {
    const st = loadState();
    return st.user || null;
});

ipcMain.handle('save-user', (_e, user) => {
    saveState({ user });
    return { ok: true };
});

ipcMain.handle('logout-user', () => {
    saveState({ user: null });
    return { ok: true };
});

ipcMain.handle('open-image', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择照片',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
        properties: ['openFile']
    });
    if (canceled || filePaths.length === 0) return null;
    saveState({ lastOpenDir: path.dirname(filePaths[0]) });
    const fp = filePaths[0];
    return { name: path.basename(fp), path: fp, size: fs.statSync(fp).size, exif: await readExif(fp) };
});

ipcMain.handle('open-images', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择照片（可多选，第一张会成为当前主图）',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
        properties: ['openFile', 'multiSelections']
    });
    if (canceled || !filePaths.length) return null;
    saveState({ lastOpenDir: path.dirname(filePaths[0]) });
    const items = [];
    for (const fp of filePaths) items.push({ name: path.basename(fp), path: fp, size: fs.statSync(fp).size, exif: await readExif(fp) });
    return items;
});

ipcMain.handle('read-exif', (_e, filePath) => readExif(String(filePath || '')));

// 贴纸 / 自定义图标:体积小且须内嵌进模板(导出/导入不丢),仍走 base64 dataUrl
ipcMain.handle('open-sticker-image', async () => {
    const st = loadState();
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择贴纸 / 图标图片',
        defaultPath: validDir(st.lastOpenDir) ? st.lastOpenDir : undefined,
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
        properties: ['openFile']
    });
    if (canceled || filePaths.length === 0) return null;
    saveState({ lastOpenDir: path.dirname(filePaths[0]) });
    const fp = filePaths[0];
    return { name: path.basename(fp), data: fs.readFileSync(fp).toString('base64') };
});

ipcMain.handle('save-image-base64', async (_e, { data, filename }) => {
    const st = loadState();
    const dir = validDir(st.lastExportDir) ? st.lastExportDir : null;
    // 目标目录已有同名文件时自动加号,再次导出数字继续递增
    const def = dir ? freeFilePath(dir, filename) : filename;
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出图片',
        defaultPath: def,
        filters: [
            { name: 'PNG 图片', extensions: ['png'] },
            { name: 'JPEG 图片', extensions: ['jpg'] },
            { name: 'WebP 图片', extensions: ['webp'] }
        ]
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    saveState({ lastExportDir: path.dirname(filePath) });
    return true;
});

ipcMain.handle('save-images-batch', async (_e, files) => {
    // files: [{ data, filename }]
    let dir = null;
    const st = loadState();
    try {
        const res = await dialog.showOpenDialog({
            title: '选择导出目录',
            defaultPath: validDir(st.lastExportDir) ? st.lastExportDir : undefined,
            properties: ['openDirectory', 'createDirectory']
        });
        if (res.canceled || !res.filePaths.length) return { canceled: true };
        dir = res.filePaths[0];
    } catch (e) { return { canceled: true, error: String(e) }; }
    saveState({ lastExportDir: dir });
    let ok = 0, fail = 0;
    const written = new Set();
    try {
        for (const f of files) {
            if (!f || !f.data) { fail++; continue; }
            try {
                // 目录里已有同名文件(含本次已写入)时自动加号
                const dest = freeFilePath(dir, f.filename, written);
                fs.writeFileSync(dest, Buffer.from(f.data, 'base64'));
                written.add(path.basename(dest));
                ok++;
            } catch (e) { fail++; }
        }
    } catch (e) { return { ok, fail, error: String(e) }; }
    return { ok, fail, dir };
});

// 先选好保存位置再导出:多文件选目录,单文件选文件(带默认文件名)
ipcMain.handle('pick-export-location', async (_e, { count, hintName }) => {
    const st = loadState();
    const dir0 = validDir(st.lastExportDir) ? st.lastExportDir : undefined;
    if (count > 1) {
        const res = await dialog.showOpenDialog({
            title: '选择导出目录',
            defaultPath: dir0,
            properties: ['openDirectory', 'createDirectory']
        });
        if (res.canceled || !res.filePaths.length) return { canceled: true };
        const dir = res.filePaths[0];
        saveState({ lastExportDir: dir });
        return { mode: 'dir', dir };
    }
    const def = dir0 ? freeFilePath(dir0, hintName || 'photo.jpg') : (hintName || 'photo.jpg');
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出图片',
        defaultPath: def,
        filters: [
            { name: 'PNG 图片', extensions: ['png'] },
            { name: 'JPEG 图片', extensions: ['jpg'] },
            { name: 'WebP 图片', extensions: ['webp'] }
        ]
    });
    if (canceled || !filePath) return { canceled: true };
    saveState({ lastExportDir: path.dirname(filePath) });
    return { mode: 'file', filePath };
});

// 把已渲染好的导出数据写入选好的位置
ipcMain.handle('write-export-files', async (_e, { location, files }) => {
    if (!location || !files || !files.length) return { ok: 0, fail: files ? files.length : 0 };
    if (location.mode === 'file') {
        try {
            fs.writeFileSync(location.filePath, Buffer.from(files[0].data, 'base64'));
            return { ok: 1, fail: 0 };
        } catch (e) {
            return { ok: 0, fail: 1, error: String(e) };
        }
    }
    let ok = 0, fail = 0;
    const written = new Set();
    try {
        for (const f of files) {
            if (!f || !f.data) { fail++; continue; }
            try {
                const dest = freeFilePath(location.dir, f.filename, written);
                fs.writeFileSync(dest, Buffer.from(f.data, 'base64'));
                written.add(path.basename(dest));
                ok++;
            } catch (e) { fail++; }
        }
    } catch (e) { return { ok, fail, error: String(e) }; }
    return { ok, fail };
});

    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
}