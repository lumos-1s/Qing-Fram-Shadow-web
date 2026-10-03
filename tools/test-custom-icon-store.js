// 自定义图标库持久化回归测试(纯 node,不需要 Electron)
//   node tools/test-custom-icon-store.js
//
// 覆盖 src/main/custom-icons.js。它替掉的那段逻辑有个在开发期完全看不见的 bug:
// 旧实现就地改 <appRoot>/shared/custom-icons.json —— 打包后该路径在 app.asar 里**只读**,
// writeFileSync 必抛,删除/重命名静默失败(渲染层只 console.warn),图标看着消失、重启复活。
// 修法是「种子只读 + userData 可写副本」,这里把该保证的性质全部钉住,尤其是:
//   · 种子文件必须逐字节不变(证明写操作没碰它)
//   · 删掉/改名必须跨进程存活(模拟重启)
//   · 目标不可写时必须返回 { ok:false } 而不是抛异常/假装成功
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCustomIconStore } = require(path.join(__dirname, '..', 'src', 'main', 'custom-icons.js'));

let fails = 0;
function ok(cond, label, extra) {
    if (cond) { console.log('  OK   ' + label); return; }
    fails++;
    console.log('  FAIL ' + label + (extra ? '   ' + extra : ''));
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qfs-icons-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {} });

function mkCase(name, arr) {
    const dir = path.join(ROOT, name);
    fs.mkdirSync(dir, { recursive: true });
    const seed = path.join(dir, 'custom-icons.json');
    fs.writeFileSync(seed, JSON.stringify(arr, null, 2), 'utf-8');
    return { dir, seed, store: path.join(dir, 'userData', 'custom-icons.json') };
}

const ICONS = [
    { name: '甲', dataUrl: 'data:image/png;base64,AAAA', custom: true },
    { name: '乙', dataUrl: 'data:image/png;base64,BBBB', custom: true },
    { name: '丙', dataUrl: 'data:image/png;base64,CCCC', custom: true }
];

console.log('自定义图标库 · 只读种子 + userData 可写副本');
console.log('─'.repeat(72));

/* ─────────── 1. 种子按字节复制,种子本身不被写 ─────────── */
{
    const c = mkCase('seed-copy', ICONS);
    const seedBefore = fs.readFileSync(c.seed);
    const store = createCustomIconStore(c.store, c.seed);
    const list = store.list();

    ok(list.length === 3, '首次 list 从种子载入 3 个图标', 'got ' + list.length);
    ok(fs.existsSync(c.store), '首次 list 在 userData 生成可写副本');
    ok(fs.readFileSync(c.seed).equals(seedBefore), '种子文件逐字节未变');
    ok(fs.existsSync(c.seed), '种子文件未被搬走');
}

/* ─────────── 2. 删除跨进程存活(模拟重启) ─────────── */
{
    const c = mkCase('delete', ICONS);
    const seedBefore = fs.readFileSync(c.seed);
    const s1 = createCustomIconStore(c.store, c.seed);
    const r = s1.remove(ICONS[0].dataUrl);
    ok(r.ok === true && r.removed === 1, 'remove 返回 { ok:true, removed:1 }', JSON.stringify(r));
    ok(s1.list().length === 2, 'remove 后本进程内立即生效');
    ok(fs.readFileSync(c.seed).equals(seedBefore), 'remove 没有改种子');

    // 新实例 = 重启:必须还是 2 个,且不含甲
    const s2 = createCustomIconStore(c.store, c.seed);
    const after = s2.list();
    ok(after.length === 2, '重启后仍是 2 个(写盘生效)', 'got ' + after.length);
    ok(!after.some(x => x.dataUrl === ICONS[0].dataUrl), '重启后不含已删的甲');
    ok(fs.readFileSync(c.seed).equals(seedBefore), '重启读取全程种子未被改');

    const r2 = s2.remove(ICONS[0].dataUrl);
    ok(r2.ok === true && r2.removed === 0, '重复删除同一项返回 removed:0(不重复写盘)');
}

/* ─────────── 3. 重命名跨进程存活 ─────────── */
{
    const c = mkCase('rename', ICONS);
    createCustomIconStore(c.store, c.seed).list();
    const s1 = createCustomIconStore(c.store, c.seed);
    const r = s1.rename(ICONS[1].dataUrl, '乙新名');
    ok(r.ok === true && r.changed === 1, 'rename 返回 { ok:true, changed:1 }', JSON.stringify(r));

    const s2 = createCustomIconStore(c.store, c.seed);
    const after = s2.list();
    const renamed = after.find(x => x.dataUrl === ICONS[1].dataUrl);
    ok(after.length === 3, '重命名不改变条目数');
    ok(renamed && renamed.name === '乙新名', '重启后新名字仍在', renamed ? renamed.name : '(丢失)');

    const r2 = s2.rename('data:image/png;base64,NOPE', 'x');
    ok(r2.ok === true && r2.changed === 0, '重命名不存在的条目返回 changed:0');
}

/* ─────────── 4. 副本一旦存在,种子后续变化不再影响(已删条目不会复活) ─────────── */
{
    const c = mkCase('seed-later', ICONS);
    createCustomIconStore(c.store, c.seed).remove(ICONS[0].dataUrl);
    // 模拟"换了新种子"(例如作者更新了初始库)
    fs.writeFileSync(c.seed, JSON.stringify(ICONS.concat([{ name: '丁', dataUrl: 'data:image/png;base64,DDDD', custom: true }]), null, 2));
    const s2 = createCustomIconStore(c.store, c.seed);
    const after = s2.list();
    ok(after.length === 2, '种子后来新增条目不会灌进已有副本(否则删除语义会被悄悄改掉)', 'got ' + after.length);
    ok(!after.some(x => x.dataUrl === ICONS[0].dataUrl), '已删的甲没有复活');
}

/* ─────────── 5. 缺失 / 损坏 / 空库都不抛 ─────────── */
{
    const c = mkCase('no-seed', ICONS);
    const store = createCustomIconStore(c.store, null);
    ok(store.list().length === 0, '无种子无副本 → 空库');
    const r = store.remove('x');
    ok(r.ok === true && r.removed === 0, '空库 remove 返回 ok(不是异常)');

    const c2 = mkCase('no-seed-file', []);
    const s2 = createCustomIconStore(c2.store, path.join(c2.dir, '不存在.json'));
    ok(s2.list().length === 0, '种子路径不存在 → 空库');
}
{
    const c = mkCase('corrupt', ICONS);
    fs.mkdirSync(path.dirname(c.store), { recursive: true });
    fs.writeFileSync(c.store, '{ 这不是 json', 'utf-8');
    const store = createCustomIconStore(c.store, c.seed);
    ok(store.list().length === 0, '副本损坏 → 空库而不是抛异常');
    // 关键:list 给出空库会让人以为是"库本来空的";此时 delete/rename 必须承认自己读失败,
    // 否则会拿着空数组算出 removed:0 并回 ok:true —— 正是本次要根除的静默失败。
    const r = store.remove(ICONS[0].dataUrl);
    ok(r && r.ok === false, '副本损坏 → remove 返回 ok:false(而不是 removed:0 的假成功)', JSON.stringify(r));
}

/* ─────────── 6. 目标不可写(asar 只读的等价场景)必须显式失败 ─────────── */
{
    const c = mkCase('readonly', ICONS);
    // 把 userData 目录的位置占成一个普通文件,让 mkdirSync/copyFileSync 必然失败
    fs.mkdirSync(c.dir, { recursive: true });
    fs.writeFileSync(path.join(c.dir, 'userData'), 'x', 'utf-8');
    const store = createCustomIconStore(c.store, c.seed);
    const r = store.remove(ICONS[0].dataUrl);
    ok(r && r.ok === false && typeof r.error === 'string' && r.error.length > 0,
        '目标不可写时 remove 返回 { ok:false, error } —— 不假装成功(这正是旧 bug 的静默面)',
        JSON.stringify(r));
    const r2 = store.rename(ICONS[0].dataUrl, 'n');
    ok(r2 && r2.ok === false, '目标不可写时 rename 同样返回 ok:false', JSON.stringify(r2));
    ok(store.list().length === 0, '目标不可写时 list 仍返回空库(不抛,启动不崩)');
}

/* ─────────── 7. 缓存一致性:写盘后同进程 list 必须是新值 ─────────── */
{
    const c = mkCase('cache', ICONS);
    const store = createCustomIconStore(c.store, c.seed);
    ok(store.list().length === 3, '缓存:首次 list 命中种子');
    store.remove(ICONS[2].dataUrl);
    ok(store.list().length === 2, '缓存:remove 后同进程 list 立刻反映新值(无陈旧读)');
    ok(store.rename(ICONS[1].dataUrl, 'Z').ok === true, '缓存:remove 之后 rename 仍成功');
    ok(store.list().find(x => x.dataUrl === ICONS[1].dataUrl).name === 'Z', '缓存:rename 后同进程 list 反映新名');
}

console.log('─'.repeat(72));
if (fails) { console.log(`✗ ${fails} 项不通过`); process.exit(1); }
console.log('✓ 全部通过');