// 参数字号标签回归:锁定「档位值 → 标签文本」的映射。
// 用法:
//   node tools/test-param-font-label.js     # 断言全部通过则退出码 0
//
// 为什么需要它:字号档位会按照片宽度缩放(autoExifSize = 档位 × clamp(iw/1200, 0.5, 8)),
// 同一档位在 1200px 与 4000px 宽的照片上能差 3 倍以上。这带来一个必须钉死的语义:
// 标签只报「档位」,不报像素,且**与照片宽度无关**。
//
// 历史 bug:标签曾经报折算后的真实像素(4000px 照片上档位 100 显示 333px)。数字会
// 随所选照片跳变,用户拖到 100 却在不同照片上看到 100/213/333,观感就是"字号不跟随"。
// 781 个视觉用例只覆盖画布像素、碰不到这层 UI 文本,所以这类问题只能靠专门的测试拦。
//
// 这层测试的价值不在"数字对不对",而在**照片宽度不变性**:同一档位换任何图宽,标签必须
// 逐字相同。曾经把 px 折算进来的改法就是在这里被挡住的。
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'src', 'renderer', 'index.html');

// 退出码收尾。Electron 主进程**完全忽略 process.exitCode** —— 实测:app.quit() 之后设 42
// 得到 0;连 app.quit() 都不调、只 win.destroy() 也得到 0。只有 app.exit(code) 能带出非 0。
// 必须在所有 console 输出之后再调用(app.exit 是立即终止;实测 200 行输出不会丢)。
function finish(code) { app.exit(code || 0); }

const NOTE_MANUAL = '按图宽自适应';

// 覆盖到极端图宽:clamp(iw/1200, 0.5, 8) 的两端都要踩到,确保任何缩放系数都影响不到标签
const WIDTHS = [400, 1200, 4000, 9600];
// 手动档位:0 是自适应(见下),其余覆盖默认值、常用值与滑块上限
const MANUAL = [1, 33, 100, 160];

const CHECK = `
(async () => {
  const App = window.App;
  await App.loadPresets();
  const val = document.getElementById('lblParamFontSize');
  const note = document.getElementById('lblParamFontNote');
  if (!val) throw new Error('找不到 lblParamFontSize');
  if (!note) throw new Error('找不到 lblParamFontNote');
  const out = [];
  for (const pf of ${JSON.stringify([0].concat(MANUAL))}) {
    for (const w of ${JSON.stringify(WIDTHS)}) {
      App.image = { w: w, h: Math.round(w * 0.75) };
      App.template = { paramFontSize: pf };
      App.updateParamFontLabel();
      out.push({ pf: pf, w: w, val: val.textContent, note: note.textContent });
    }
  }
  return out;
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { backgroundThrottling: false, sandbox: false } });
  await win.loadFile(PAGE);
  await new Promise(r => setTimeout(r, 1200));
  const got = await win.webContents.executeJavaScript(CHECK);
  app.quit();

  const fails = [];
  const byPf = {};
  for (const r of got) (byPf[r.pf] = byPf[r.pf] || []).push(r);

  for (const pf of Object.keys(byPf).map(Number).sort((a, b) => a - b)) {
    const rows = byPf[pf];
    const first = rows[0];
    // 1) 与照片宽度无关:同一档位下所有图宽的标签必须逐字相同
    for (const r of rows) {
      if (r.val !== first.val) fails.push(`档位 ${pf} 在图宽 ${r.w} 下标签变成 "${r.val}"(期望恒为 "${first.val}")`);
      if (r.note !== first.note) fails.push(`档位 ${pf} 在图宽 ${r.w} 下说明变成 "${r.note}"(期望恒为 "${first.note}")`);
    }
    // 2) 不得出现 px —— 档位不是像素,报 px 就是那个会跳的假数字
    if (/px/i.test(first.val)) fails.push(`档位 ${pf} 标签含 "px": "${first.val}"`);
    // 3) 具体取值
    if (pf === 0) {
      if (first.val !== '自适应') fails.push(`自适应模式标签应为 "自适应",实为 "${first.val}"`);
      if (first.note !== '') fails.push(`自适应模式不应有说明小字,实为 "${first.note}"`);
    } else {
      if (first.val !== String(pf)) fails.push(`档位 ${pf} 标签应为 "${pf}",实为 "${first.val}"`);
      if (first.note !== NOTE_MANUAL) fails.push(`档位 ${pf} 说明小字应为 "${NOTE_MANUAL}",实为 "${first.note}"`);
    }
  }

  console.log('== 参数字号标签回归 ==');
  for (const pf of Object.keys(byPf).map(Number).sort((a, b) => a - b)) {
    const r = byPf[pf][0];
    const tag = pf === 0 ? '自适应' : '手动';
    console.log(`  ${String(pf).padStart(3)} 档位  [${tag}]  标签="${r.val}"  说明="${r.note}"  (${WIDTHS.length} 种图宽下逐字相同)`);
  }
  console.log('─'.repeat(64));
  if (fails.length) {
    console.log(`✖ ${fails.length} 项不符:`);
    for (const f of fails) console.log('  ' + f);
    finish(1);
    return;
  }
  console.log(`✓ 全部通过(${Object.keys(byPf).length} 个档位 × ${WIDTHS.length} 种图宽)`);
  finish(0);
}).catch(e => { console.error(e); finish(1); });
