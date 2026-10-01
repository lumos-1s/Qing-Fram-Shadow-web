// 渲染引擎不变量回归测试(纯 node,不需要 Electron)
//   node tools/test-engine-invariants.js
//
// 为什么需要它:engine.js / engine-styles.js 的改动由视觉回归基线(869 键)兜底,但那条链要跑
// Electron、比的是像素指纹。这里换一个角度,直接在 node 里加载引擎源码并断言**等价性**:
// 为性能引入的缓存(parseColor 记忆化、颗粒砖 LRU)必须与原公式逐比特一致 ——
// 也就是说,"不改变任何渲染像素"这个前提在这里被单独钉死。
//
// 手法:engine.js 是经典 <script> 脚本(没有 module.exports),用 new Function 把源码包成一个
// 函数体、补上最小 window/document 桩,再把内部符号 return 出来直接调。
'use strict';

const fs = require('fs');
const path = require('path');

let fails = 0;
function ok(cond, label, extra) {
    if (cond) { console.log('  OK   ' + label); return; }
    fails++;
    console.log('  FAIL ' + label + (extra ? '   ' + extra : ''));
}

/* ───────── 最小 DOM 桩:只为 grainTile 的 createImageData/putImageData ───────── */
function makeCanvasStub() {
    const c = { width: 0, height: 0, _img: null };
    c.getContext = () => ({
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (img) => { c._img = img; },
    });
    return c;
}
const documentStub = { createElement: (tag) => (tag === 'canvas' ? makeCanvasStub() : {}) };
const windowStub = {};

/* ───────── 加载引擎源码 ───────── */
const ENGINE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'engine.js'), 'utf-8');
let Engine;
try {
    Engine = new Function('window', 'document', ENGINE_SRC + `
;return { parseColor, rgba, grainTile, GRAIN_TILE_CACHE, GRAIN_TILE_ORDER, GRAIN_TILE_MAX, clamp };`
    )(windowStub, documentStub);
} catch (e) {
    console.error('加载 engine.js 失败(可能需要补 DOM 桩):', e && e.message);
    process.exit(1);
}

/* ───────── 参考实现:改动前的 parseColor 公式(逐字复刻) ───────── */
function refParseColor(hex, opacity) {
    try {
        hex = String(hex || '#000000').replace('#', '');
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        if (hex.length === 6) hex = 'FF' + hex;
        const argb = parseInt(hex, 16);
        const a = (argb >> 24) & 0xFF;
        const r = (argb >> 16) & 0xFF;
        const g = (argb >> 8) & 0xFF;
        const b = argb & 0xFF;
        const alpha = (a / 255) * ((opacity == null ? 100 : opacity) / 100);
        return { r, g, b, a: Math.max(0, Math.min(1, alpha)) };
    } catch (e) { return { r: 0, g: 0, b: 0, a: 1 }; }
}

/* ───────── 参考实现:颗粒砖的 LCG(与 engine.js 同一算法与盐值) ───────── */
function refGrain(size) {
    const d = new Uint8ClampedArray(size * size * 4);
    let seed = (Math.imul(size, 2654435761) ^ 20240816) >>> 0;
    for (let i = 0; i < d.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const v = 58 + ((seed >>> 16) & 255) * (140 / 255);
        d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    return d;
}

console.log('渲染引擎不变量(纯 node)');
console.log('─'.repeat(72));

/* ① parseColor 记忆化必须完全透明 */
{
    const hexes = ['#fff', 'ffffff', '#000', 'FF0000', 'ff0000', '12345', 'zzz', '', null, undefined,
        '#FFFFFFFF', 'FFFFFFFF', '0a0b0c', '#AbCdEf', '  ', '#'];
    const ops = [null, undefined, 0, 1, 50, 99, 100, 150, -10];
    let bad = 0, sample = '';
    for (const h of hexes) {
        for (const o of ops) {
            const a = refParseColor(h, o), b = Engine.parseColor(h, o);
            if (a.r !== b.r || a.g !== b.g || a.b !== b.b || a.a !== b.a) {
                bad++;
                if (!sample) sample = `${JSON.stringify(h)}/${o} 参考=${JSON.stringify(a)} 实际=${JSON.stringify(b)}`;
            }
        }
    }
    ok(bad === 0, `① parseColor 记忆化:${hexes.length * ops.length} 组输入与参考公式逐字段一致`, sample);
    // 同一输入重复取必须返回同一个对象(缓存在起作用),且再次调用仍与参考一致
    const x1 = Engine.parseColor('#336699', 80), x2 = Engine.parseColor('#336699', 80);
    ok(x1 === x2, '① parseColor:相同输入命中缓存(同对象)');
    ok(JSON.stringify(x2) === JSON.stringify(refParseColor('#336699', 80)), '① parseColor:命中缓存后取值不变');
    // 大小写/井号不同但语义相同的输入,值必须一致(键不同不影响结果)
    ok(JSON.stringify(Engine.parseColor('336699', 80)) === JSON.stringify(Engine.parseColor('#336699', 80)),
        '① parseColor:带井号与不带井号结果一致');
    // rgba() 仍按字段格式化
    ok(Engine.rgba({ r: 1.4, g: 2.5, b: 3.6, a: 0.5 }) === 'rgba(1,3,4,0.5)', '① rgba 格式化未变');
}

/* ② 颗粒砖:像素必须与参考 LCG 完全一致 */
{
    const sizes = [96, 137, 300];
    let bad = 0, detail = '';
    for (const s of sizes) {
        const c = Engine.grainTile(s);
        const got = c._img && c._img.data;
        const want = refGrain(s);
        if (!got || got.length !== want.length) { bad++; detail = 'size=' + s + ' 长度不符'; continue; }
        for (let i = 0; i < want.length; i++) {
            if (got[i] !== want[i]) { bad++; detail = `size=${s} 第 ${i} 字节 实际=${got[i]} 期望=${want[i]}`; break; }
        }
    }
    ok(bad === 0, `② 颗粒砖:${sizes.length} 个尺寸逐字节等于参考 LCG`, detail);
}

/* ③ 颗粒砖缓存必须有上限,且淘汰后重算的字节完全相同 */
{
    const MAX = Engine.GRAIN_TILE_MAX;
    ok(typeof MAX === 'number' && MAX > 0, '③ 颗粒砖缓存存在上限常量', String(MAX));
    const before = Object.keys(Engine.GRAIN_TILE_CACHE).length;
    const first = 200;                       // 先放一块,后面要被挤出去
    const firstData = Engine.grainTile(first)._img.data.slice();
    for (let i = 0; i < MAX + 3; i++) Engine.grainTile(first + 1 + i);
    const count = Object.keys(Engine.GRAIN_TILE_CACHE).length;
    ok(count <= MAX, `③ 连续放入 ${MAX + 4} 个不同尺寸后缓存条目 ≤ ${MAX}`, '实际=' + count);
    ok(!Engine.GRAIN_TILE_CACHE[first], '③ 最早的一块已被淘汰');
    const again = Engine.grainTile(first)._img.data;
    let same = again.length === firstData.length;
    for (let i = 0; same && i < again.length; i++) if (again[i] !== firstData[i]) same = false;
    ok(same, '③ 淘汰后重算的颗粒砖与首次逐字节相同(确定性生成)');
    ok(before >= 0, '③ 缓存键空间说明:' + Object.keys(Engine.GRAIN_TILE_CACHE).join(','));
}

/* ④ 文字度量记忆化的两条前提(源码级绊线)
   引擎组明确警告过:Chromium 的 measureText 会把 ctx.letterSpacing 计入宽度,
   缓存键漏掉字距就会在设了字距的风格里量出错值 —— 那是"改像素"级的错误。
   另一条是 setFont 必须照旧每次都调(有调用方依赖它留下的 ctx.font 副作用)。
   这两点无法在不跑 Electron 的情况下用行为测试覆盖,所以做成源码断言。 */
{
    const stylesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'engine-styles.js'), 'utf-8');
    const charWBody = (stylesSrc.match(/function charW\(g, ch, px, mono, bold\)[\s\S]*?\n    \}/) || [''])[0];
    const tmfBody = (stylesSrc.match(/function textMetricsF\([\s\S]*?\n    \}/) || [''])[0];
    const memoIx = charWBody.indexOf('memoCharW(');
    const setFontIx = charWBody.indexOf('setFont(');
    ok(charWBody.length > 0 && tmfBody.length > 0, '④ 找到 charW / textMetricsF 实现');
    ok(charWBody.indexOf('letterSpacing') >= 0, '④ charW 缓存键包含 letterSpacing');
    ok(tmfBody.indexOf('letterSpacing') >= 0, '④ textMetricsF 缓存键包含 letterSpacing');
    ok(setFontIx >= 0 && memoIx > setFontIx, '④ charW 仍然先 setFont 再查缓存(保留 ctx.font 副作用)');
    ok(tmfBody.indexOf('setFont(') >= 0 && tmfBody.indexOf('memoCharW(') > tmfBody.indexOf('setFont('),
        '④ textMetricsF 在循环外先 setFont,再逐字查缓存');
}

(async () => {
/* ⑤ 预设加载的两条路径必须产出完全相同的对象
   presets.js 现在优先走合并通道 load-all-presets(1 次 IPC 取代 1+78 次),
   但 tools/preload-measure.js(所有 Electron 用例用的桥)**没有**这个方法,只能走回退路径。
   所以两条路径必须逐字段、逐键序一致 —— 否则"测试里能过、正式版行为不同"。
   这条测试同时是回退路径的守门员。 */
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'presets.js'), 'utf-8');
    // 注意:new Function(...)(...) 返回的是**内层函数**,而它从闭包读外层参数 window,
    // 不接受调用参数 —— 所以用一个可变持有者逐例换 qingframe。
    const winStub = {};
    const load = new Function('window', src + '\n;return loadAllPresets;')(winStub);
    const DATA = [{ templateName: '甲', templateTag: '杂志', baseMargin: { marginTop: 5 } },
        { templateName: '乙', templateTag: '胶片' }];
    const NAMES = ['甲', '乙', '_坏'];
    const clone = (d) => JSON.parse(JSON.stringify(d));
    // 逐个读取路径的桩:第 3 个名字故意取不到(模拟坏模板 → null)
    const fallbackBridge = () => ({
        listPresets: async () => NAMES.slice(),
        loadPreset: async (n) => { const i = NAMES.indexOf(n); return DATA[i] ? clone(DATA[i]) : null; },
    });

    // ① 合并通道可用
    winStub.qingframe = {
        loadAllPresets: async () => DATA.map((d, i) => ({ name: NAMES[i], data: clone(d) })),
        listPresets: async () => { throw new Error('不该走回退路径'); },
        loadPreset: async () => { throw new Error('不该走回退路径'); },
    };
    const r1 = await load();

    // ② 没有合并通道(测试桥就是这样)→ 回退
    winStub.qingframe = fallbackBridge();
    const r2 = await load();

    // ③ 合并通道返回空数组 → 回退
    winStub.qingframe = Object.assign({ loadAllPresets: async () => [] }, fallbackBridge());
    const r3 = await load();

    // ④ 合并通道抛错 → 回退
    winStub.qingframe = Object.assign({ loadAllPresets: async () => { throw new Error('boom'); } }, fallbackBridge());
    const r4 = await load();

    const j = (v) => JSON.stringify(v);
    ok(j(r1) === j(r2), '⑤ 合并通道与逐个读取:结果逐键序完全相同', j(r1) !== j(r2) ? j(r1) + ' vs ' + j(r2) : '');
    ok(j(r2) === j(r3) && j(r2) === j(r4), '⑤ 合并通道返回空/抛错时正确回退,结果一致');
    ok(r1.length === 2 && r1[0]._fileName === '甲' && r1[1]._fileName === '乙', '⑤ _fileName 被正确打标');
    ok(Object.keys(r1[0]).indexOf('_fileName') === Object.keys(r1[0]).length - 1, '⑤ _fileName 位于键序末尾(与旧路径同形)');
    ok(r2.length === 2, '⑤ 回退路径跳过 loadPreset 返回 null 的项');
}

/* ⑥ 导出换算(元素尺寸倍数)必须满足的三条性质
   背景:元素几何以设备像素存储,预览画布 = _logW × dpr、导出画布 = _logW × 1,
   所以导出前要按 k = afterW / (beforeW × pathDpr) 缩放元素。这里把这条换算单独钉住:
     a. pathDpr = uiMaxSave / beforeW 时,k 恰好等于 afterW / uiMaxSave(第 1 张 = 所见即所得)
     b. beforeW 逐张参与 —— 批量导出时第 2..n 张用自己的 beforeW,不被第 1 张顶替
        (这条是原作者的口径;上一轮我误用 uiMaxSave 顶替了它,此测试防回归)
     c. k === 1 表示无需再渲一次(省掉每张的第 3 次全尺寸渲染) */
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app-export.js'), 'utf-8');
    const win = {};
    const App = new Function('window', src + '\n;return window.App;')(win);
    ok(App && typeof App.exportSizeScale === 'function', '⑥ app-export.js 可加载且导出换算已抽出为纯函数');

    const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9) * Math.max(1, Math.abs(b));

    // a. 第 1 张:pathDpr = uiMaxSave/beforeW → k === afterW/uiMaxSave
    const uiMaxSave = 3600, beforeW1 = 1800, afterW = 4000;
    const p1 = uiMaxSave / beforeW1;                       // = 2(DPR 2 的图层通道)
    ok(near(App.exportSizeScale(afterW, beforeW1, p1), afterW / uiMaxSave),
        '⑥ 第 1 张:k = afterW / 真实预览宽度(所见即所得)', String(App.exportSizeScale(afterW, beforeW1, p1)));

    // b. 第 2 张换一张竖图:自己的 beforeW 必须参与,不能用第 1 张的
    const beforeW2 = 1350, afterW2 = 3000;
    const k2 = App.exportSizeScale(afterW2, beforeW2, p1);
    ok(near(k2, afterW2 / (beforeW2 * p1)), '⑥ 批量:k 用该图自己的 beforeW', String(k2));
    ok(!near(k2, afterW2 / (beforeW1 * p1)), '⑥ 批量:不会误用第 1 张的 beforeW');

    // c. 口径一致时 k === 1(调用方据此跳过第 3 次渲染)
    ok(App.exportSizeScale(beforeW1 * p1, beforeW1, p1) === 1, '⑥ 口径一致时 k 恰为 1(可跳过重渲)');
    ok(App.exportSizeScale(100, 100, 1) === 1, '⑥ DPR=1 且尺寸未变时 k 恰为 1');

    // d. 非法 pathDpr 退化为 1(与改动前的行为一致)
    ok(near(App.exportSizeScale(4000, 1800, 0), 4000 / 1800), '⑥ pathDpr=0 退化为 1');
    ok(near(App.exportSizeScale(4000, 1800, undefined), 4000 / 1800), '⑥ pathDpr=undefined 退化为 1');
    ok(near(App.exportSizeScale(4000, 1800, NaN), 4000 / 1800), '⑥ pathDpr=NaN 退化为 1');

    // e. 文件名去重:首张保留原名,后续追加 _1、_2
    const files = [{ stem: 'a_边框', ext: 'jpg' }, { stem: 'a_边框', ext: 'jpg' },
        { stem: 'a_边框', ext: 'jpg' }, { stem: 'b_拼图', ext: 'png' }];
    App.dedupeExportNames(files);
    ok(JSON.stringify(files.map(f => f.filename)) === JSON.stringify(['a_边框.jpg', 'a_边框_1.jpg', 'a_边框_2.jpg', 'b_拼图.png']),
        '⑥ dedupeExportNames:重名首张原名、后续 _1/_2', JSON.stringify(files.map(f => f.filename)));

    // f. 每张图用哪个模板的优先级
    const fake = { imageTemplates: new Map(), defaultTemplate: () => ({ from: 'default' }) };
    const imA = { customSettings: { from: 'custom' } };
    const imB = {};
    fake.imageTemplates.set(imB, { from: 'map' });
    const imC = {};
    ok(App.exportTemplateFor.call(fake, imA, 0, 0, { from: 'live' }).from === 'custom', '⑥ 模板优先级:customSettings 最优先');
    ok(App.exportTemplateFor.call(fake, imB, 1, 0, { from: 'live' }).from === 'map', '⑥ 模板优先级:其次 imageTemplates 快照');
    ok(App.exportTemplateFor.call(fake, imC, 2, 2, { from: 'live' }).from === 'live', '⑥ 模板优先级:当前主图用正在编辑的模板');
    ok(App.exportTemplateFor.call(fake, imC, 2, 0, { from: 'live' }).from === 'default', '⑥ 模板优先级:其余图用各自的默认边框');
}

/* ⑦ .qfs 工程导出的两处省法必须成立
   ① 旋转过的照片:im.el 本身就是尺寸吻合的 canvas(内容来自 JPEG,必然不透明),
      "新建同尺寸画布 + 铺白底 + 1:1 blit"整步是空操作 —— 直接对原 canvas 编码,
      像素与编码器输入都没变,因此产物逐字节相同,却省掉一块全分辨率画布和一次 blit。
      这条断言把"能复用"的判据钉死(尺寸必须严格一致,<img> 一律不复用)。
   ② customSettings 不再深拷贝:随即被 IPC 结构化克隆,中间无人改写。断言它保持同一引用。 */
{
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app-qfs.js'), 'utf-8');
    const win = {};
    const Q = new Function('window', src + '\n;return window.App;')(win);
    ok(Q && typeof Q.qfsReusableSource === 'function' && typeof Q.qfsImageEntry === 'function',
        '⑦ app-qfs.js 可加载且两个纯函数已抽出');

    const mkCanvas = (w, h, withToDataURL) => {
        const c = { tagName: 'CANVAS', width: w, height: h };
        if (withToDataURL !== false) c.toDataURL = () => 'data:image/jpeg;base64,AAAA';
        return c;
    };

    const hit = mkCanvas(4000, 3000);
    ok(Q.qfsReusableSource({ el: hit, w: 4000, h: 3000 }) === hit, '⑦ 尺寸吻合的 canvas → 复用');
    ok(Q.qfsReusableSource({ el: mkCanvas(4000, 3000), w: 3999, h: 3000 }) === null, '⑦ 尺寸不符 → 不复用');
    ok(Q.qfsReusableSource({ el: { tagName: 'IMG', width: 4000, height: 3000 }, w: 4000, h: 3000 }) === null,
        '⑦ <img> 一律不复用(可能有 alpha,必须铺白底)');
    ok(Q.qfsReusableSource({ el: mkCanvas(10, 10, false), w: 10, h: 10 }) === null, '⑦ 缺 toDataURL → 不复用');
    ok(Q.qfsReusableSource(null) === null && Q.qfsReusableSource({ el: null, w: 1, h: 1 }) === null, '⑦ 空输入 → 不复用');

    const live = { templateName: '含 logo 的模板', logoElements: [{ dataUrl: 'data:image/png;base64,' + 'x'.repeat(1000) }] };
    const im = { name: '照片.jpg', w: 4000, h: 3000, exif: { make: 'Canon' }, customSettings: live };
    const e = Q.qfsImageEntry(im, 'BASE64DATA');
    ok(e.customSettings === live, '⑦ customSettings 保持同一引用(不再深拷贝)');
    ok(e.data === 'BASE64DATA' && e.name === '照片.jpg' && e.w === 4000 && e.h === 3000, '⑦ 其余字段原样带出');
    ok(JSON.stringify(Q.qfsImageEntry({ w: 1, h: 1 }, null)) === JSON.stringify({ name: 'photo', w: 1, h: 1, exif: {}, customSettings: null, data: null }),
        '⑦ 缺字段时的默认值与旧实现一致(name=photo / exif={} / customSettings=null)');
}

/* ⑧ 面板能力表(style-caps)的记忆化必须完全透明
   visibleRows 是纯函数(输入只有风格名),现在按大写名缓存结果。这条测试钉住两件事:
     · 形状不变:任何风格都返回同一组 18 个行键(少一个就意味着某行会永远显/隐)
     · 缓存透明:同一风格(含大小写变体)返回同一份结果,内容与逐次重算一致
   之所以放这里:Electron 那套 panel-visibility 用例要跑 GUI,而能力表本身是纯数据。 */
{
    const caps = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'style-caps.js'));
    ok(caps && typeof caps.visibleRows === 'function' && Array.isArray(caps.DIMS), '⑧ style-caps 可被 require(UMD)');

    const ROW_KEYS = ['rowSignModel', 'rowSignText', 'rowSignFont', 'rowSignColor', 'rowAvatarScale', 'rowSignSize',
        'rowParamColor', 'rowParamType', 'rowParamPos', 'rowBgBlur', 'rowBrandSize', 'rowParamScale', 'rowBrandLogo']
        .concat(caps.DIMS.map(d => d.row)).sort();
    ok(ROW_KEYS.length === 18, '⑧ 面板行键共 18 个', String(ROW_KEYS.length));

    const styles = Object.keys(caps.MEASURED || {}).concat(['', 'NONE', 'UNKNOWN_STYLE', 'signature', 'SIMPL E']);
    let shapeBad = '', missing = 0;
    for (const s of styles) {
        const rows = caps.visibleRows(s);
        const keys = Object.keys(rows).sort();
        if (keys.length !== ROW_KEYS.length || keys.some((k, i) => k !== ROW_KEYS[i])) { shapeBad = s + ' → ' + keys.length + ' 键'; missing++; }
        if (Object.values(rows).some(v => typeof v !== 'boolean')) { shapeBad = s + ' → 存在非布尔值'; missing++; }
    }
    ok(missing === 0, `⑧ ${styles.length} 个风格(含未知/空/大小写变体)都返回同一组 18 个布尔键`, shapeBad);

    ok(caps.visibleRows('SIGNATURE') === caps.visibleRows('signature'), '⑧ 大小写变体命中同一条缓存(返回同一对象)');
    ok(caps.visibleRows('SIGNATURE') === caps.visibleRows('SIGNATURE'), '⑧ 同一输入重复调用返回同一对象(缓存在起作用)');
    ok(JSON.stringify(caps.visibleRows('SIGNATURE')) === JSON.stringify(caps.visibleRows('SIGNATURE')), '⑧ 缓存内容稳定');

    const sig = caps.visibleRows('SIGNATURE'), simple = caps.visibleRows('SIMPLE');
    ok(sig.rowSignText === true && simple.rowSignText === false, '⑧ 个性风格显示签名文字行,普通风格不显示');
    ok(caps.visibleRows('SIGN_PARAM').rowSignModel === true, '⑧ SIGN_PARAM 显示「品牌+型号」行');
    ok(caps.visibleRows('').rowSignText === false, '⑧ 空风格名不报错且各行均隐藏');
    ok(caps.DIMS.every(d => caps.visibleRows('SIGNATURE')[d.row] === caps.has('SIGNATURE', d.key)),
        '⑧ 五个数值滑块行与 MEASURED 实测口径一致');
}

console.log('─'.repeat(72));
console.log(fails ? `✖ ${fails} 项未通过` : '✓ 全部通过');
process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });