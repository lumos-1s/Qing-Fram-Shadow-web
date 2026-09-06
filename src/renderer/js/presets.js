// 通过 IPC(主进程 fs)加载预设 JSON
async function loadAllPresets() {
    const names = await window.qingframe.listPresets();
    const out = [];
    for (const name of names) {
        const data = await window.qingframe.loadPreset(name);
        if (data) {
            data._fileName = name;
            out.push(data);
        }
    }
    return out;
}

window.__loadAllPresets = loadAllPresets;
