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
    // 目录内容只读一次:原实现对每个候选名都调一次 fs.existsSync,批量导出时每张都要往返磁盘若干次。
    // 目录读不到时退回逐个 existsSync(保持"读不到就当已占用"的原语义)。
    // 注意:Windows/macOS 的文件系统大小写不敏感,而 existsSync 也按平台语义工作,
    // 所以集合比对必须用全小写键 —— 否则「Photo.JPG 已存在、要写 photo.jpg」会被判为不冲突而覆盖掉旧文件。
    function freeFilePath(dir, filename, used) {
        const ext = path.extname(filename);
        const stem = filename.slice(0, filename.length - ext.length);
        let listing = null;
        try { listing = new Set(fs.readdirSync(dir).map(n => n.toLowerCase())); } catch (e) { listing = null; }
        const taken = (p) => {
            const base = path.basename(p);
            if (used && used.has(base)) return true;
            if (listing) return listing.has(base.toLowerCase());
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