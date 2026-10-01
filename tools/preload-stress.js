// 压测专用 preload:桥接应用 IPC + 注入照片
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qingframe', {
    openImage: () => ipcRenderer.invoke('open-image'),
    openImages: () => ipcRenderer.invoke('open-images'),
    listPresets: () => ipcRenderer.invoke('list-presets'),
    loadPreset: (name) => ipcRenderer.invoke('load-preset', name),
    saveImage: (data, filename) => ipcRenderer.invoke('save-image-base64', { data, filename }),
    saveImagesBatch: (files) => ipcRenderer.invoke('save-images-batch', files),
    pickExportLocation: (payload) => ipcRenderer.invoke('pick-export-location', payload),
    writeExportFiles: (payload) => ipcRenderer.invoke('write-export-files', payload),
    listLogos: () => ipcRenderer.invoke('list-logos'),
    listTextures: () => ipcRenderer.invoke('list-textures'),
    saveTemplate: (name, data) => ipcRenderer.invoke('save-template', { name, data }),
    listTemplates: () => ipcRenderer.invoke('list-templates'),
    loadTemplate: (name) => ipcRenderer.invoke('load-template', name),
    deleteTemplate: (name) => ipcRenderer.invoke('delete-template', name),
    renameTemplate: (oldName, newName) => ipcRenderer.invoke('rename-template', { oldName, newName }),
    exportTemplate: (name, data) => ipcRenderer.invoke('export-template', { name, data }),
    importTemplate: () => ipcRenderer.invoke('import-template'),
    exportQfs: (data) => ipcRenderer.invoke('export-qfs', data),
    openQfs: () => ipcRenderer.invoke('open-qfs'),
    getUser: () => ipcRenderer.invoke('get-user'),
    saveUser: (user) => ipcRenderer.invoke('save-user', user),
    logoutUser: () => ipcRenderer.invoke('logout-user'),
    getPrefs: () => ipcRenderer.invoke('get-prefs'),
    savePrefs: (prefs) => ipcRenderer.invoke('save-prefs', prefs),
    readExif: (filePath) => ipcRenderer.invoke('read-exif', filePath),
    openStickerImage: () => ipcRenderer.invoke('open-sticker-image')
});

contextBridge.exposeInMainWorld('__stress', {
    list: () => ipcRenderer.invoke('stress:list'),
    loadPhoto: (name) => ipcRenderer.invoke('stress:load-photo', name)
    // 注意:这里**不要**提供 setAbort()。contextBridge 暴露的函数,函数体在 preload 的隔离世界执行,
    // 在里面写 window.__stressAbort 只会写到隔离世界,主世界的 RUNNER 读不到 —— 熔断会静默失效。
    // 需要置位时由主进程用 webContents.executeJavaScript() 在主世界求值(见 stress.js 的采样器)。
});