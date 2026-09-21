// 打包产物校验:确认发行版里没有第三方品牌 Logo
// 用法: node tools/verify-dist.js        (npm run verify:dist)
// 退出码: 0 = 干净, 1 = 发现泄漏, 2 = 无法判定(没有可检查的产物)
//
// 为什么需要这个:build.files 里的 `!shared/brandlogos/**` 是唯一的真相源,但它只影响
// 「下次打包」。一旦有人改了 files 配置、或用了旧配置打出来的产物,Logo 就会静默进包。
// 每次发布前跑一次本脚本,把「靠记得」变成「靠检查」。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const LEAK_MARKER = 'brandlogos';
// 应当出现在发行版里的关键内容(缺了说明打包配置把正常文件也排除了)
const EXPECTED = [
    { label: '主进程入口', match: /src[\\/]main[\\/]index\.js$/ },
    { label: '渲染引擎', match: /src[\\/]renderer[\\/]js[\\/]engine\.js$/ },
    { label: '预设目录', match: /shared[\\/]presets$/ },
];

function findAsar(dir, out = [], depth = 0) {
    if (depth > 4) return out;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) findAsar(full, out, depth + 1);
        else if (e.name === 'app.asar') out.push(full);
    }
    return out;
}

function listAsar(asarPath) {
    const asar = require('@electron/asar');
    const fn = asar.listPackage || asar.list;
    if (typeof fn !== 'function') throw new Error('@electron/asar 没有 listPackage/list 方法');
    return fn(asarPath);
}

console.log('清框影 · 打包产物校验');
console.log('─'.repeat(56));

if (!fs.existsSync(DIST)) {
    console.log('× dist/ 不存在 —— 还没有打包过,无法校验。');
    console.log('  先执行: npm run dist');
    process.exit(2);
}

const asars = findAsar(DIST);

// 产物新鲜度:app.asar 若比「源码/配置」还旧,说明它是上一次构建留下的,不能代表当前配置。
// 不做这一步的话,重新打包失败时会拿旧 asar 校验并误报通过。
const SOURCE_ROOTS = ['src', 'shared', 'package.json'];
// 只把「代码与配置」算作源码时间:排除 shared/brandlogos(那 106 个素材的 mtime 会把
// 「最新源码时间」拉到未来,导致刚打好的包被误判过期),也排除 dist 之类的产物。
const SOURCE_EXT = new Set(['.js', '.html', '.css', '.json', '.svg']);
const SOURCE_SKIP = /[\\/]brandlogos[\\/]/;
let newestSource = 0;
function scanNewest(p) {
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
        if (SOURCE_SKIP.test(p + path.sep)) return;
        for (const e of fs.readdirSync(p)) scanNewest(path.join(p, e));
    } else if (SOURCE_EXT.has(path.extname(p).toLowerCase()) && !SOURCE_SKIP.test(p)) {
        if (st.mtimeMs > newestSource) newestSource = st.mtimeMs;
    }
}
SOURCE_ROOTS.forEach(r => scanNewest(path.join(ROOT, r)));

if (!asars.length) {
    console.log('× 在 dist/ 下找不到 app.asar,无法校验。');
    console.log('  dist/ 里现有: ' + (fs.readdirSync(DIST).join(', ') || '(空)'));
    console.log('  安装包(nsis/portable)内部无法直接读取,请先产出未压缩目录:');
    console.log('    node node_modules/electron-builder/out/cli/cli.js --win --dir');
    process.exit(2);
}

let leaked = 0;
let checked = 0;
let missingExpected = 0;
let stale = 0;

for (const asarPath of asars) {
    const rel = path.relative(ROOT, asarPath);
    let files;
    try {
        files = listAsar(asarPath);
    } catch (e) {
        console.log(`\n? ${rel} 读取失败: ${e.message}`);
        continue;
    }
    checked++;

    const asarMtime = fs.statSync(asarPath).mtimeMs;
    const isStale = asarMtime < newestSource;
    if (isStale) stale++;
    const ageMark = isStale
        ? `   ← 已过期(早于源码改动 ${Math.round((newestSource - asarMtime) / 60000)} 分钟)`
        : '   ✓';

    const logos = files.filter(f => f.includes(LEAK_MARKER) && !f.endsWith('brandlogos'));
    const logoDirs = files.filter(f => f.endsWith('brandlogos') || f.endsWith('brandlogos\\') || f.endsWith('brandlogos/'));
    const presets = files.filter(f => /shared[\\/]presets[\\/].+\.json$/.test(f));
    const textures = files.filter(f => /shared[\\/]textures[\\/].+\.(png|jpg|jpeg)$/i.test(f));

    console.log(`\n▶ ${rel}`);
    console.log(`  生成时间            : ${new Date(asarMtime).toLocaleString()}${ageMark}`);
    console.log(`  条目总数            : ${files.length}`);
    console.log(`  品牌 Logo 文件      : ${logos.length}${logos.length ? '   ← 泄漏!' : '   ✓'}`);
    console.log(`  brandlogos 目录条目 : ${logoDirs.length}${logoDirs.length ? '   ← 泄漏!' : '   ✓'}`);
    console.log(`  shared/presets 预设 : ${presets.length}${presets.length === 70 ? '   ✓' : '   ← 数量异常(应为 70)'}`);
    console.log(`  shared/textures 纹理: ${textures.length}${textures.length === 10 ? '   ✓' : '   ← 数量异常(应为 10)'}`);

    if (logos.length) {
        console.log('  泄漏样例:');
        logos.slice(0, 5).forEach(f => console.log(`    ${f}`));
    }
    if (presets.length !== 70 || textures.length !== 10) missingExpected++;

    for (const exp of EXPECTED) {
        if (!files.some(f => exp.match.test(f))) {
            console.log(`  ! 缺少${exp.label}`);
            missingExpected++;
        }
    }

    leaked += logos.length + logoDirs.length;
}

// 安装包(体积/时间仅作提示,内部无法直接读取)
const installers = fs.readdirSync(DIST).filter(f => /\.(exe|dmg|AppImage|zip)$/i.test(f));
if (installers.length) {
    console.log(`\n· dist/ 下的安装包(内部无法直接读取,仅提示):`);
    installers.forEach(f => {
        const st = fs.statSync(path.join(DIST, f));
        console.log(`    ${f}  ${(st.size / 1024 / 1024).toFixed(1)} MB  ${st.mtime.toLocaleString()}`);
    });
    console.log('    若这些包打在排除规则生效之前,它们仍含 Logo —— 需重新打包后覆盖。');
}

console.log('\n' + '─'.repeat(56));
const problems = [];
if (leaked) {
    problems.push(`发现 ${leaked} 处品牌 Logo 泄漏`);
}
if (!checked) {
    problems.push('没有任何 app.asar 被成功读取');
}
if (stale) {
    problems.push(`${stale} 个 app.asar 早于源码改动(产物过期,不能代表当前配置)`);
}
if (missingExpected) {
    problems.push(`${missingExpected} 项内容缺失或数量异常`);
}

if (problems.length) {
    console.log('✖ 校验未通过:');
    problems.forEach(p => console.log(`  - ${p}`));
    if (leaked) {
        console.log('  → 检查 package.json 的 build.files 是否仍含 "!shared/brandlogos/**"。');
    }
    if (stale && !leaked) {
        console.log('  → 删除 dist/ 后重新打包,否则校验的是旧产物。');
    }
    process.exit(leaked || !checked ? 1 : 2);
}
console.log(`✓ 通过:检查了 ${checked} 个 app.asar,产物新鲜、无品牌 Logo,预设与纹理齐全。`);
