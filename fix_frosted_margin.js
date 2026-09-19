const fs = require('fs');
let eng = fs.readFileSync('src/renderer/js/engine-styles.js', 'utf8').replace(/\r\n/g, '\n');

// 印象毛玻璃:左侧文字区宽度跟随全局边距缩放
eng = eng.replace(
    `        const leftW = Math.max(180, Math.round(iw * 0.35));`,
    `        const gm = S.globalMargin || 1;
        const leftW = Math.max(180, Math.round(iw * 0.35 * gm));`
);
fs.writeFileSync('src/renderer/js/engine-styles.js', eng, 'utf8');
console.log('ok');
