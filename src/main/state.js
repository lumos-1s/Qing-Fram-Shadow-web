// 主进程持久状态与文件命名工具(独立于 electron,便于单元测试)
const fs = require('fs');
const path = require('path');

function createStateStore(stateFile) {
    function loadState() {
        try {
            if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf-8')) || {};
        } catch (e) { /* 忽略损坏的配置 */ }
        return {};
    }
    function saveState(patch) {
        try {
            const s = loadState();
            Object.assign(s, patch);
            fs.writeFileSync(stateFile, JSON.stringify(s), 'utf-8');
        } catch (e) { /* 忽略写入失败 */ }
    }
    function validDir(p) { return typeof p === 'string' && p && fs.existsSync(p); }
    // 目标目录已有同名文件时,在名称后追加 _1、_2… 取第一个可用名(第二次导出数字自动加一)
    function freeFilePath(dir, filename, used) {
        const ext = path.extname(filename);
        const stem = filename.slice(0, filename.length - ext.length);
        const taken = (p) => {
            if (used && used.has(path.basename(p))) return true;
            try { return fs.existsSync(p); } catch (e) { return true; }
        };
        let i = 0, cand = path.join(dir, filename);
        while (taken(cand)) {
            i++;
            cand = path.join(dir, `${stem}_${i}${ext}`);
        }
        return cand;
    }
    return { loadState, saveState, validDir, freeFilePath };
}

module.exports = { createStateStore };