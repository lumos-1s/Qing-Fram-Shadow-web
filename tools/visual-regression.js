// 视觉回归测试:渲染所有风格 × 关键参数组合,与基线(颜色指纹+布局指标)比对。
// 用法:
//   node tools/visual-regression.js            # 比对并退出码 0/1
//   node tools/visual-regression.js --update   # 重建基线(tests/visual/baseline.json)
//   node tools/visual-regression.js --presets  # 预设冒烟:70 预设走 __render 真实渲染路径 ---- 并入 run
//   node tools/visual-regression.js --dev      # 开发模式:渲染到 tests/visual/out/ 不比对
// 设计:
//   - 复用 design/regress.html(轻量,只加载 engine.js+engine-styles.js,无整套 app)
//   - 指纹:画布 32 格分块平均 RGB —— 抓布局/颜色错位
//   - 指标:品牌左缘/参数框左缘/红色 logo 框 —— 抓左留白类像素锚点回归
//   - CYBER_GLITCH 有 Math.random:页面内已注入确定性 PRNG,可复现
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'design', 'regress.html');
const BASELINE = path.join(ROOT, 'tests', 'visual', 'baseline.json');
const OUT_DIR = path.join(ROOT, 'tests', 'visual', 'out');
const PRESETS_DIR = path.join(ROOT, 'shared', 'presets');

// 比对容差
const FP_TOL = 2.0;        // 指纹平均通道差(0-255)
const POS_TOL = 2;         // 指标 px 容差
const WARN_TOL = 3;        // 预设冒烟:量有偏差但很小

// ── 测试矩阵 ──
// 全量 63 风格(engine-styles.js draw 映射),bl=1(文字+logo) pf=33 bs=1 基准
const STYLE_NAMES = [
  'SIMPLE', 'WHITE_PLAIN', 'ROUNDED', 'FILM_STRIP', 'POLAROID', 'DOUBLE_LINE', 'VINTAGE',
  'GRADIENT', 'DROP_SHADOW', 'BLUR_CLASSIC', 'BLUR_DATE',
  'WM_CLASSIC', 'WM_SINGLE', 'WM_BRAND_LOGO', 'WM_AI', 'IMP_FROSTED', 'IMP_CLASSIC', 'XIAOMI_IMP',
  'CARD_LEICA', 'CARD_LOGO_PARAM', 'CARD_PURE_LOGO', 'CARD_SIMPLE', 'CARD_IMMERSION',
  'OVERLAY_PARAM_LEFT', 'OVERLAY_PARAM_RIGHT', 'OVERLAY_PARAM_BOTTOM',
  'FUJI_WM', 'FUJI_WM_BRAND', 'DARK_BRAND_ONLY', 'OVERLAY_LOGO_BOTTOM',
  'COLOR_CLASSIC', 'COLOR_REFINED', 'ART_CARD', 'FUJI_WHITE',
  'SIMPLE_FILM', 'PARAM_TOP_LEFT', 'PARAM_BOTTOM_LEFT', 'PARAM_BOTTOM_SINGLE',
  'STAMP_POSTAGE', 'TEARED_PAPER', 'FOLD_CORNER', 'PINBOARD_TAPE', 'VHS_TAPE', 'ALBUM_CORNER',
  'MOVIE_TICKET', 'WATERCOLOR_BLEED', 'CYBER_GLITCH', 'POLAROID_HAND', 'TORN_JOURNAL',
  'CARD_3D', 'COMIC_PANEL', 'NEWSPAPER', 'SIGNATURE', 'SIGN_PARAM', 'AVATAR_MEMO',
  'SIGN_BLUR', 'SIG_BLUR', 'AV_BLUR', 'AV_OVERLAY', 'AV_OVERLAY_TR', 'AV_OVERLAY_BR',
  'AV_OVERLAY_BC', 'AV_OVERLAY_BC2'
];

// 品牌 logo 会出现的风格:跑 brandLogo × brandSize 组合
const BRAND_STYLES = [
  'WM_CLASSIC', 'WM_BRAND_LOGO', 'IMP_FROSTED', 'IMP_CLASSIC',
  'OVERLAY_PARAM_LEFT', 'OVERLAY_PARAM_RIGHT', 'OVERLAY_PARAM_BOTTOM',
  'CARD_LEICA', 'CARD_LOGO_PARAM', 'CARD_PURE_LOGO', 'CARD_SIMPLE', 'CARD_IMMERSION',
  'FUJI_WM_BRAND', 'DARK_BRAND_ONLY', 'OVERLAY_LOGO_BOTTOM',
  'SIGN_PARAM', 'SIGN_BLUR', 'BLUR_CLASSIC', 'BLUR_DATE',
  'FUJI_WHITE', 'COLOR_CLASSIC', 'ART_CARD'
];

// 参数放大会显著影响布局的风格:跑 paramFontSize 极值
const PARAM_STYLES = [
  'IMP_FROSTED', 'OVERLAY_PARAM_LEFT', 'OVERLAY_PARAM_RIGHT', 'OVERLAY_PARAM_BOTTOM',
  'CARD_LOGO_PARAM', 'CARD_LEICA', 'WM_CLASSIC', 'WM_SINGLE', 'WM_BRAND_LOGO', 'WM_AI',
  'BLUR_CLASSIC', 'BLUR_DATE', 'SIGN_PARAM', 'SIGN_BLUR', 'FUJI_WM_BRAND', 'AV_BLUR',
  'CARD_IMMERSION'
];

function buildCases() {
  const cases = [];
  for (const st of STYLE_NAMES) {
    cases.push({ id: st + '__base', st, bl: 1, pf: 33, bs: 1 });
  }
  for (const st of BRAND_STYLES) {
    const combos = [
      ['__bl0', 0, 1], ['__bl2', 2, 1], ['__bl1bs3', 1, 3], ['__bl2bs3', 2, 3]
    ];
    for (const [tag, bl, bs] of combos) {
      cases.push({ id: st + tag, st, bl, pf: 33, bs });
    }
  }
  for (const st of PARAM_STYLES) {
    for (const pf of [16, 160]) {
      cases.push({ id: st + '__pf' + pf, st, bl: 1, pf, bs: 1 });
    }
  }
  return cases;
}

function presetCases() {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  const files = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')).sort();
  const cases = [];
  for (const f of files) {
    const name = f.replace(/\.json$/, '');
    let t = null;
    try { t = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf-8')); } catch (e) { continue; }
    cases.push({ id: 'preset_' + name, st: String(t.photoFrameStyle || 'LEGACY').toUpperCase(), bl: 0, pf: 33, bs: 1, extra: t, noStyle: !t.photoFrameStyle });
  }
  return cases;
}

// 工具:加载现有基线
function loadBaseline() {
  try { return JSON.parse(fs.readFileSync(BASELINE, 'utf-8')); } catch (e) { return {}; }
}

function saveBaseline(map) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(map, null, 1), 'utf-8');
}

// 平均通道差
function fpDiff(a, b) {
  if (!a || !b) return Infinity;
  if (a.CW !== b.CW || a.CH !== b.CH) return Infinity;
  const n = Math.min(a.data.length, b.data.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a.data[i] - b.data[i]);
  return sum / n;
}

// 布局指标比对:返回最大偏差像素
function metricDiff(a, b) {
  let max = 0;
  for (const k of ['ml', 'boxLeftDark', 'brandLeftDark']) {
    const va = a && a[k], vb = b && b[k];
    if (va == null || vb == null) continue;
    if (va === -1 || vb === -1) continue;
    max = Math.max(max, Math.abs(va - vb));
  }
  if (a && b && a.logoRedBox && b.logoRedBox) {
    for (const k of ['x0', 'y0', 'w', 'h']) {
      max = Math.max(max, Math.abs(a.logoRedBox[k] - b.logoRedBox[k]));
    }
    for (const k of ['x1', 'y1']) {
      max = Math.max(max, Math.abs(a.logoRedBox[k] - b.logoRedBox[k]));
    }
  }
  return max;
}

// ── 渲染批次:一次 executeJavaScript 传全部用例 ──
async function renderBatch(win, cases, chunk = 180) {
  const results = [];
  for (let i = 0; i < cases.length; i += chunk) {
    const slice = cases.slice(i, i + chunk);
    const r = await win.webContents.executeJavaScript(`window.__QR.run(${JSON.stringify(slice)})`);
    results.push(...r);
  }
  return results;
}

function main() {
  const argv = process.argv.slice(2);
  const isUpdate = argv.includes('--update');
  const isPresets = argv.includes('--presets');
  const isDev = argv.includes('--dev');
  const mode = isUpdate ? 'update' : isPresets ? 'presets' : isDev ? 'dev' : 'compare';

  const runCases = isPresets ? presetCases() : (isDev ? buildCases().slice(0, 8) : buildCases());
  const baseline = isUpdate ? {} : loadBaseline();

  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      width: 1000, height: 800, show: false,
      webPreferences: { backgroundThrottling: false, sandbox: false }
    });
    await win.loadFile(PAGE);
    await new Promise(r => setTimeout(r, 200));
    const results = await renderBatch(win, runCases);
    app.quit();

    if (isDev) {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      for (const r of results) {
        fs.writeFileSync(path.join(OUT_DIR, r.id + '.json'), JSON.stringify({ st: r.st, W: r.W, H: r.H, error: r.error, m: r.m }, null, 1), 'utf-8');
      }
      const ok = results.filter(r => !r.error);
      const bad = results.filter(r => r.error);
      console.log(`[visual:dev] ${ok.length}/${results.length} rendered OK`);
      if (bad.length) {
        console.log('--- render errors ---');
        for (const r of bad) console.log('  ' + r.id + ': ' + r.error.slice(0, 120));
      }
      process.exit(bad.length ? 1 : 0);
      return;
    }

    if (isPresets) {
      let ok = 0, fail = 0;
      const byPath = {};
      console.log('== 预设冒烟(走 __render 真实渲染路径)==');
      for (const r of results) {
        byPath[r.path] = (byPath[r.path] || 0) + 1;
        if (r.error) {
          fail++; console.log('  FAIL ' + r.id + ' [' + r.path + ']: ' + r.error.slice(0, 120));
        } else if (r.m && r.m.W > 0 && r.m.H > 0) {
          ok++;
        } else { fail++; console.log('  FAIL ' + r.id + ' [' + r.path + ']: 渲染尺寸异常 (' + (r.W || 0) + 'x' + (r.H || 0) + ')'); }
      }
      console.log('  路径分布: ' + Object.keys(byPath).map(k => k + ':' + byPath[k]).join('  '));
      console.log(`  通过 ${ok} / 失败 ${fail}`);
      process.exit(fail ? 1 : 0);
      return;
    }

    // update / compare
    const updated = {};
    let diffList = [];
    let renderErrors = 0;

    for (const r of results) {
      if (r.error) { renderErrors++; continue; }
      const mine = { fp: r.fp, m: r.m, W: r.W, H: r.H };
      updated[r.id] = mine;
      const ref = baseline[r.id];
      if (isUpdate) continue;
      if (!ref) continue; // 新增用例,update 时自动收录
      let over = false, why = '';
      if (ref.W !== r.W || ref.H !== r.H) { over = true; why = `尺寸 ${ref.W}x${ref.H} -> ${r.W}x${r.H}`; }
      const fd = fpDiff(ref.fp, r.fp);
      if (fd > FP_TOL) { over = true; if (!why) why = `指纹差 ${fd.toFixed(1)}`; else why += `, 指纹差 ${fd.toFixed(1)}`; }
      const md = metricDiff(ref.m, r.m);
      if (md > POS_TOL) { over = true; if (!why) why = `指标差 ${md}px`; else why += `, 指标差 ${md}px`; }
      if (over) diffList.push({ id: r.id, why });
    }

    if (isUpdate) {
      saveBaseline(updated);
      console.log(`[visual:update] 基线已重建:${Object.keys(updated).length} 用例 (renderErrors=${renderErrors})`);
      process.exit(renderErrors ? 1 : 0);
      return;
    }

    const total = Object.keys(updated).length;
    const matched = total - diffList.length;
    console.log(`== 视觉回归 (${mode}) ==`);
    console.log(`  渲染 ${runCases.length} 用例 / 无错 ${total} / 渲染失败 ${renderErrors}`);
    console.log(`  与基线比对:一致 ${matched} / 差异 ${diffList.length}`);
    if (diffList.length) {
      console.log('--- 差异明细 ---');
      for (const d of diffList) console.log('  ' + d.id + ': ' + d.why);
    }
    const stale = Object.keys(baseline).filter(k => !updated[k]);
    if (stale.length) {
      console.log(`  (基线含 ${stale.length} 个已不存在的用例,可用 --update 清理)`);
    }
    process.exit(renderErrors || diffList.length ? 1 : 0);
  });
}

main();