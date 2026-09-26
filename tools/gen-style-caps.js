// 能力表生成器:从视觉回归基线**实测**得出「哪个风格吃哪个参数」,写回 src/renderer/js/style-caps.js。
// 用法:
//   node tools/gen-style-caps.js            # 写回 style-caps.js 的生成区
//   node tools/gen-style-caps.js --check    # 只校验:与实测不符则退出码 1(不写文件)
//   node tools/gen-style-caps.js --report   # 打印能力矩阵 + 覆盖率汇总
//
// 为什么实测而不手维护:能力表本身就是"防它腐烂"的东西,手写的表会以同样的速度烂掉。
// 判据很硬 —— 某风格在该参数两个极值下渲染指纹与基准一致,就说明引擎里没人读它,
// 面板却把滑块露出来给人拖,这就是"某预设不响应滑块"的全部真相。
// 判据完全交给 CI:改了引擎却没重新生成表 → --check 失败。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(ROOT, 'tests', 'visual', 'baseline.json');
const CAPS_PATH = path.join(ROOT, 'src', 'renderer', 'js', 'style-caps.js');
const BEGIN = '    // ── 生成区 BEGIN (tools/gen-style-caps.js)── 请勿手改,改动会在下次生成时被覆盖 ──\n    const MEASURED = ';
const END = ';\n    // ── 生成区 END ──';

const capsApi = require(CAPS_PATH);
const DIMS = capsApi.DIMS;

// 判定"这个风格到底吃不吃这个参数"的依据。
//
// 不要用全图平均差当判据:指纹是 32×32 分块平均,一张 928×1028 的画布上,一行 22px 的
// 参数文字放大到 107px 后虽���只改动 51 个格子(单格最大差 15.7),除以 928 格后均值只剩
// 0.37 —— 真实存在的响应会被大画布稀释到看不见。早期版本用"均值 > 0.5"因此误判了
// PARAM_BOTTOM_LEFT / PARAM_TOP_LEFT / STAMP_POSTAGE 等 9 个 pf 和 3 个 bi 风格。
//
// 改为看**局部**证据:单格最大差 + 变化格数。实测两者之间有干净的空隙:
//   - 真正生效的项:变化格数 >= 4,单格最大差 >= 6
//   - 真正无效的项:变化格数恒为 0,单格最大差 <= 1.33
// 残留的 <=1.33 全部是 1/3、2/3、1、4/3 个灰阶,即 RGB 三通道平均后的浮点舍入残差
// (指纹本身是分块平均),不是渲染差异。门槛取 max>=2 && cells>=2 落在 1.33 与 4 之间,
// 两侧各有 2 倍以上余量,不依赖噪声底假设。
const CELL_MIN_DIFF = 2;   // 单格最大差达到这个灰阶才算真的动了
const CELL_MIN_COUNT = 2;  // 至少这么多格变了,滤掉单点抖动

// 返回 { sizeChanged, max, cells };sizeChanged 表示画布尺寸随参数变了,必然是生效的
function fpStats(a, b) {
    if (!a || !b || a.CW !== b.CW || a.CH !== b.CH) return { sizeChanged: true, max: Infinity, cells: Infinity };
    const n = Math.min(a.data.length, b.data.length);
    let max = 0, cells = 0;
    for (let i = 0; i < n; i += 3) {
        const d = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
        if (d > max) max = d;
        if (d >= CELL_MIN_DIFF) cells++;
    }
    return { sizeChanged: false, max, cells };
}

// 一个探测极值是否证明参数生效
function probeHit(s) {
    if (s.sizeChanged) return true;
    return s.max >= CELL_MIN_DIFF && s.cells >= CELL_MIN_COUNT;
}

// 旧的"全图均值"判据,保留给 --report 对照排错用
function fpDiffMean(a, b) {
    if (!a || !b || a.CW !== b.CW || a.CH !== b.CH) return Infinity;
    const n = Math.min(a.data.length, b.data.length);
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.abs(a.data[i] - b.data[i]);
    return s / n;
}

if (!fs.existsSync(BASELINE)) {
    console.error(`视觉基线不存在:${BASELINE}\n先跑 npm run test:visual -- --update`);
    process.exit(1);
}
const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const styles = Object.keys(baseline).filter(k => k.endsWith('__base')).map(k => k.slice(0, -'__base'.length)).sort();
if (!styles.length) {
    console.error('基线里一个 __base 用例都没有,基线已损坏');
    process.exit(1);
}

// ── 实测 ──
const measured = {};     // style -> { dim: bool }
let missing = 0;
for (const s of styles) {
    measured[s] = {};
    const base = baseline[s + '__base'];
    for (const d of DIMS) {
        let hit = false;
        for (const v of d.probe) {
            const key = capsApi.dimCaseId(s, d.key, v);
            const c = baseline[key];
            if (!c) { missing++; continue; }
            if (probeHit(fpStats(base.fp, c.fp))) hit = true;
        }
        measured[s][d.key] = hit;
    }
}

// ── 序列化成生成区的 JS 字面量 ──
function renderBlock() {
    const lines = [];
    for (const s of styles) {
        const bits = DIMS.filter(d => measured[s][d.key]).map(d => d.key);
        lines.push(`        ${s}: { ${bits.map(b => b + ': true').join(', ')} },`);
    }
    return '{\n' + lines.join('\n') + '\n    }';
}

function replaceBlock(text) {
    const i = text.indexOf(BEGIN);
    const j = text.indexOf(END);
    if (i < 0 || j < 0 || j < i) throw new Error('style-caps.js 里找不到生成区标记');
    return text.slice(0, i) + BEGIN + renderBlock() + text.slice(j);
}

const argv = process.argv.slice(2);

if (argv.includes('--report')) {
    const w = Math.max(...styles.map(s => s.length));
    console.log('参数生效矩阵(实测:该维度两个极值下指纹是否变化)');
    console.log('─'.repeat(w + 4 + DIMS.length * 5));
    console.log('风格'.padEnd(w) + DIMS.map(d => d.key.padEnd(5)).join(''));
    for (const s of styles) {
        console.log(s.padEnd(w) + DIMS.map(d => (measured[s][d.key] ? '  ✓  ' : '  ·  ')).join(''));
    }
    console.log('─'.repeat(w + 4 + DIMS.length * 5));
    for (const d of DIMS) {
        const n = styles.filter(s => measured[s][d.key]).length;
        const pct = Math.round(n / styles.length * 100);
        console.log(`  ${d.key.padEnd(4)} ${String(n).padStart(2)}/${styles.length} (${pct}%)  ${d.label}  →  ${d.field}`);
        const dead = styles.filter(s => !measured[s][d.key]);
        if (dead.length) console.log(`       不生效:${dead.length} 个`);
    }
    if (missing) console.log(`\n  ⚠ 基线缺 ${missing} 个探测用例(指纹缺失按不生效计,建议 npm run test:visual -- --update)`);

    // 对照通道:如果改用"全图平均差 > 0.5"会漏判成什么样。保留下来是为了让这个坑
    // 可以当场复核,而不是只靠注释里的一句话。
    const probes = (s, d) => d.probe.map(v => {
        const c = baseline[capsApi.dimCaseId(s, d.key, v)];
        if (!c) return null;
        const st = fpStats(baseline[s + '__base'].fp, c.fp);
        return { v, st, mean: fpDiffMean(baseline[s + '__base'].fp, c.fp) };
    }).filter(Boolean);

    const meanSays = (list) => list.some(p => p.st.sizeChanged || p.mean > 0.5);
    const disagree = [];
    for (const s of styles) {
        for (const d of DIMS) {
            if (!measured[s][d.key]) continue;          // 本工具判生效
            if (meanSays(probes(s, d))) continue;         // 旧判据也同意,无需报
            disagree.push({ s, d, list: probes(s, d) });
        }
    }
    if (disagree.length) {
        console.log(`\n  ⚠ 全图平均差判据会漏判 ${disagree.length} 项 —— 下列参数真实生效,但平均差 < 0.5:`);
        for (const g of disagree) {
            const ev = g.list.map(p => p.st.sizeChanged
                ? `${g.d.key}=${p.v} 尺寸变化`
                : `${g.d.key}=${p.v} 均值${p.mean.toFixed(2)}/单格${p.st.max.toFixed(0)}/${p.st.cells}格`).join('   ');
            console.log(`      ${g.d.key.padEnd(4)} ${g.s.padEnd(w)}  ${ev}`);
        }
    }
    process.exit(0);
}

const cur = fs.readFileSync(CAPS_PATH, 'utf8');
const next = replaceBlock(cur);

if (argv.includes('--check')) {
    if (cur === next) {
        console.log(`✓ 能力表与实测一致(${styles.length} 风格 × ${DIMS.length} 维度)`);
        process.exit(0);
    }
    console.error('✖ 能力表已过期:引擎行为与 src/renderer/js/style-caps.js 里的生成区不符。');
    console.error('  跑 `npm run gen:caps` 重新生成。');
    process.exit(1);
}

fs.writeFileSync(CAPS_PATH, next, 'utf8');
const on = styles.map(s => DIMS.filter(d => measured[s][d.key]).length).reduce((a, b) => a + b, 0);
console.log(`[caps:update] 已写入 ${styles.length} 风格 / ${on} 项能力(共 ${styles.length * DIMS.length} 格)`);
for (const d of DIMS) {
    const n = styles.filter(s => measured[s][d.key]).length;
    console.log(`  ${d.key.padEnd(4)} ${String(n).padStart(2)}/${styles.length}  ${d.label}`);
}
