const fs = require('fs');
const path = 'src/renderer/js/engine-styles.js';
let src = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

// 1. 修 VHS:去掉 ▶ 乱码字符,右对齐文字
const oldVhs = `    function styleVhsTape(img, size, g, iw, ih) {
        const sidePad = Math.max(16, Math.floor(size / 2));
        const barH = Math.max(52, Math.floor(size * 2.2));
        const w = iw + sidePad * 2, h = ih + barH * 2;
        g.fillStyle = '#0a0a0a';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, sidePad, barH);
        const fs = Math.max(12, Math.floor(barH * 0.34));
        const cyTop = Math.floor(barH / 2), cyBot = barH + ih + Math.floor(barH / 2);
        const dotR = Math.max(5, Math.floor(fs * 0.36));
        g.fillStyle = '#e63229';
        g.beginPath(); g.arc(sidePad + dotR + 4, cyTop, dotR, 0, 6.2832); g.fill();
        drawTextL(g, 'SP 12:34:56', sidePad + dotR * 2 + 12, cyTop + Math.floor(fs * 0.36), '#7fffb0', fs, true, false, 0);
        drawTextL(g, 'PLAY \\u25B6', w - sidePad - 70, cyTop + Math.floor(fs * 0.36), '#cccccc', fs, true, false, 0);
        drawTextL(g, 'SP 0:00:00', sidePad + 4, cyBot + Math.floor(fs * 0.36), '#7fffb0', fs, true, false, 0);
        drawTextL(g, 'Hi-Fi STEREO', w - sidePad - 96, cyBot + Math.floor(fs * 0.36), '#888888', fs, true, false, 0);
    }`;

const newVhs = `    function styleVhsTape(img, size, g, iw, ih) {
        const sidePad = Math.max(16, Math.floor(size / 2));
        const barH = Math.max(56, Math.floor(size * 2.4));
        const w = iw + sidePad * 2, h = ih + barH * 2;
        g.fillStyle = '#0a0a0a';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, sidePad, barH);
        const fs = Math.max(12, Math.floor(barH * 0.32));
        const cyTop = Math.floor(barH / 2), cyBot = barH + ih + Math.floor(barH / 2);
        const baseYTop = cyTop + Math.floor(fs * 0.36);
        const baseYBot = cyBot + Math.floor(fs * 0.36);
        // REC 红点
        const dotR = Math.max(5, Math.floor(fs * 0.36));
        g.fillStyle = '#e63229';
        g.beginPath(); g.arc(sidePad + dotR + 6, cyTop, dotR, 0, 6.2832); g.fill();
        // 左上时间码
        drawTextL(g, 'SP 12:34:56', sidePad + dotR * 2 + 14, baseYTop, '#7fffb0', fs, true, false, 0);
        // 右上 PLAY(右对齐)
        const playTxt = 'PLAY';
        const playW = textMetrics(g, playTxt, fs, true, false, 0).w;
        drawTextL(g, playTxt, w - sidePad - playW, baseYTop, '#cccccc', fs, true, false, 0);
        // 左下时间码
        drawTextL(g, 'SP 0:00:00', sidePad + 6, baseYBot, '#7fffb0', fs, true, false, 0);
        // 右下 Hi-Fi(右对齐)
        const hifiTxt = 'Hi-Fi STEREO';
        const hifiW = textMetrics(g, hifiTxt, fs, true, false, 0).w;
        drawTextL(g, hifiTxt, w - sidePad - hifiW, baseYBot, '#888888', fs, true, false, 0);
    }`;

if (!src.includes(oldVhs)) { console.error('VHS ANCHOR NOT FOUND'); process.exit(1); }
src = src.replace(oldVhs, newVhs);

// 2. 修水彩:提高不透明度 + 增大半径 + 色块更靠外
const oldWc = `    function styleWatercolorBleed(img, size, g, iw, ih) {
        const bleed = Math.max(50, Math.floor(size * 1.5));
        const w = iw + bleed * 2, h = ih + bleed * 2;
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        const palettes = [
            ['rgba(110,165,215,0.32)', 'rgba(175,145,215,0.28)', 'rgba(215,155,175,0.28)'],
            ['rgba(130,195,155,0.32)', 'rgba(235,205,135,0.28)', 'rgba(195,175,215,0.28)'],
            ['rgba(225,160,145,0.32)', 'rgba(170,195,225,0.28)', 'rgba(195,215,175,0.28)']
        ];
        const rnd = styleNoise(iw, ih, 777);
        const pal = palettes[rnd(palettes.length)];
        const px0 = bleed, py0 = bleed;
        for (let i = 0; i < 16; i++) {
            const edge = rnd(4);
            let px, py;
            if (edge === 0) { px = px0 + rnd(iw); py = py0 - Math.floor(bleed * 0.3) + rnd(Math.floor(bleed * 0.9)); }
            else if (edge === 1) { px = px0 + rnd(iw); py = py0 + ih - Math.floor(bleed * 0.2) + rnd(Math.floor(bleed * 0.9)); }
            else if (edge === 2) { px = px0 - Math.floor(bleed * 0.3) + rnd(Math.floor(bleed * 0.9)); py = py0 + rnd(ih); }
            else { px = px0 + iw - Math.floor(bleed * 0.2) + rnd(Math.floor(bleed * 0.9)); py = py0 + rnd(ih); }
            const pr = Math.max(20, Math.floor(bleed * (0.45 + rnd(60) / 100)));
            const col = pal[rnd(pal.length)];
            const grad = g.createRadialGradient(px, py, 0, px, py, pr);
            grad.addColorStop(0, col); grad.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = grad;
            g.beginPath(); g.arc(px, py, pr, 0, 6.2832); g.fill();
        }
        g.drawImage(img, px0, py0);
    }`;

const newWc = `    function styleWatercolorBleed(img, size, g, iw, ih) {
        const bleed = Math.max(70, Math.floor(size * 1.8));
        const w = iw + bleed * 2, h = ih + bleed * 2;
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        const palettes = [
            ['rgba(90,150,210,0.55)', 'rgba(165,135,210,0.45)', 'rgba(210,145,170,0.45)'],
            ['rgba(110,185,145,0.55)', 'rgba(230,195,125,0.45)', 'rgba(185,165,210,0.45)'],
            ['rgba(220,150,135,0.55)', 'rgba(160,190,225,0.45)', 'rgba(185,210,165,0.45)']
        ];
        const rnd = styleNoise(iw, ih, 777);
        const pal = palettes[rnd(palettes.length)];
        const px0 = bleed, py0 = bleed;
        for (let i = 0; i < 20; i++) {
            const edge = rnd(4);
            let px, py;
            if (edge === 0) { px = px0 + rnd(iw); py = py0 - Math.floor(bleed * 0.1) + rnd(Math.floor(bleed * 0.7)); }
            else if (edge === 1) { px = px0 + rnd(iw); py = py0 + ih - Math.floor(bleed * 0.1) + rnd(Math.floor(bleed * 0.7)); }
            else if (edge === 2) { px = px0 - Math.floor(bleed * 0.1) + rnd(Math.floor(bleed * 0.7)); py = py0 + rnd(ih); }
            else { px = px0 + iw - Math.floor(bleed * 0.1) + rnd(Math.floor(bleed * 0.7)); py = py0 + rnd(ih); }
            const pr = Math.max(30, Math.floor(bleed * (0.6 + rnd(80) / 100)));
            const col = pal[rnd(pal.length)];
            const grad = g.createRadialGradient(px, py, 0, px, py, pr);
            grad.addColorStop(0, col); grad.addColorStop(0.7, col.replace(/0\.45|0\.55/, '0.15')); grad.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = grad;
            g.beginPath(); g.arc(px, py, pr, 0, 6.2832); g.fill();
        }
        g.drawImage(img, px0, py0);
    }`;

if (!src.includes(oldWc)) { console.error('WC ANCHOR NOT FOUND'); process.exit(1); }
src = src.replace(oldWc, newWc);

fs.writeFileSync(path, src, 'utf8');
console.log('OK: VHS + Watercolor fixed');
