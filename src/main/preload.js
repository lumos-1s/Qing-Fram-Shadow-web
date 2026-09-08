const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qingframe', {
    openImage: () => ipcRenderer.invoke('open-image'),
    openImages: () => ipcRenderer.invoke('open-images'),
    listPresets: () => ipcRenderer.invoke('list-presets'),
    loadPreset: (name) => ipcRenderer.invoke('load-preset', name),
    saveImage: (data, filename) => ipcRenderer.invoke('save-image-base64', { data, filename }),
    saveImagesBatch: (files) => ipcRenderer.invoke('save-images-batch', files),
    listLogos: () => ipcRenderer.invoke('list-logos'),
    listTextures: () => ipcRenderer.invoke('list-textures'),
    saveTemplate: (name, data) => ipcRenderer.invoke('save-template', { name, data }),
    listTemplates: () => ipcRenderer.invoke('list-templates'),
    loadTemplate: (name) => ipcRenderer.invoke('load-template', name),
    deleteTemplate: (name) => ipcRenderer.invoke('delete-template', name),
    exportTemplate: (name, data) => ipcRenderer.invoke('export-template', { name, data }),
    importTemplate: () => ipcRenderer.invoke('import-template')
});