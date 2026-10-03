// 内置自定义图标库的持久化(独立于 electron,便于单元测试)
//
// 为什么不能就地改 shared/custom-icons.json ——
//   1. 打包后 <__dirname>/../../shared 在 app.asar 里,**只读**,writeFileSync 必抛。
//      原来的 delete/rename 就是这么写的:发行版里删除/重命名静默失败(渲染层只 console.warn),
//      图标看着没了,重启复活 —— 正是 d3e64e6 想修的问题。
//   2. 开发时它会写工作区,把 41.8 MB 的库文件搞成脏文件。
//
// 所以:shared/custom-icons.json 降级为**只读种子**,真正的可写副本放在 userData。
// 首次访问时按字节复制一次种子(41.8 MB 的 copyFileSync 是纯 I/O,不解析,很快),
// 之后所有读写都走 userData。这样"已删除的条目"不会因为改成新方案而集体复活,
// 也顺带把仓库摘干净了。
//
// 缓存:这个文件 41.8 MB,原来每次 list/delete/rename 都同步 readFileSync + JSON.parse,
// 主进程会卡住数秒(切图标池时肉眼可见)。种子不可变,解析结果缓存一次,
// 只有本进程自己写盘后才失效 —— 单进程拥有者,不需要文件监听。
const fs = require('fs');
const path = require('path');

function createCustomIconStore(storeFile, seedFile) {
    let cache = null;      // null = 尚未载入
    let loadError = null;  // 「读不到」与「本来就是空库」必须能区分,见下方 remove/rename

    // true = 库文件可用;false = 压根没有库(无种子、副本也不存在)
    function ensureStore() {
        try {
            if (fs.existsSync(storeFile)) return true;
        } catch (e) { loadError = 'existsSync 失败:' + e.message; return false; }
        if (!seedFile) return false;
        try {
            if (!fs.existsSync(seedFile)) return false;
        } catch (e) { loadError = 'existsSync 失败:' + e.message; return false; }
        try {
            fs.mkdirSync(path.dirname(storeFile), { recursive: true });
            fs.copyFileSync(seedFile, storeFile);
            return true;
        } catch (e) {
            // 典型触发:userData 不可写、或目标路径被占成普通文件。
            // 这里若吞掉,remove 会拿着空数组算出 removed:0 并回 ok:true —— 又一次静默失败。
            loadError = '复制种子到 userData 失败:' + e.message;
            return false;
        }
    }

    function load() {
        if (cache) return cache;
        loadError = null;
        if (ensureStore()) {
            try {
                const raw = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
                cache = Array.isArray(raw) ? raw : [];
            } catch (e) { loadError = '读取图标库失败:' + e.message; cache = []; }
        } else {
            cache = [];
        }
        return cache;
    }

    function persist(arr) {
        fs.mkdirSync(path.dirname(storeFile), { recursive: true });
        fs.writeFileSync(storeFile, JSON.stringify(arr, null, 2), 'utf-8');
        cache = arr;
    }

    // 读写前先确认库真的拿到了。读不到却回 { ok:true, removed:0 } 等于骗调用方:
    // 「本来就没有这一项」和「我根本没读到你删的是哪一项」对用户是两回事。
    function guard() { load(); return loadError ? { ok: false, error: loadError } : null; }

    return {
        // 读失败返回空库而不是抛:图标池空着不该让整个启动失败(旧实现同语义)
        list() { return load(); },

        remove(dataUrl) {
            try {
                const bad = guard();
                if (bad) return bad;
                const arr = load();
                const next = arr.filter(c => c.dataUrl !== dataUrl);
                const removed = arr.length - next.length;
                if (removed) persist(next);
                return { ok: true, removed };
            } catch (e) { return { ok: false, error: e.message }; }
        },

        rename(dataUrl, name) {
            try {
                const bad = guard();
                if (bad) return bad;
                const arr = load();
                let changed = 0;
                arr.forEach(c => { if (c.dataUrl === dataUrl) { c.name = name; changed++; } });
                if (changed) persist(arr);
                return { ok: true, changed };
            } catch (e) { return { ok: false, error: e.message }; }
        }
    };
}

module.exports = { createCustomIconStore };