const fs = require('fs');
let eng = fs.readFileSync('src/renderer/js/engine-styles.js', 'utf8').replace(/\r\n/g, '\n');
// styleAvatarMemo bottomH 0.16 -> 0.13
eng = eng.replace(
    `        const bottomH = Math.round(iw * 0.16);
        const w = iw + pad * 2, h = ih + pad + bottomH;
        g.fillStyle = '#f5f0eb';`,
    `        const bottomH = Math.round(iw * 0.13);
        const w = iw + pad * 2, h = ih + pad + bottomH;
        g.fillStyle = '#f5f0eb';`
);
// styleSignature bottomH 0.12 -> 0.10
eng = eng.replace(
    `            case 'SIGNATURE': {
                const p = Math.max(30, Math.round(iw * 0.04));
                const bh = Math.round(iw * 0.12);
                return { w: iw + p * 2, h: ih + p + bh };
            }`,
    `            case 'SIGNATURE': {
                const p = Math.max(30, Math.round(iw * 0.04));
                const bh = Math.round(iw * 0.10);
                return { w: iw + p * 2, h: ih + p + bh };
            }`
);
// styleDims AVATAR_MEMO
eng = eng.replace(
    `            case 'AVATAR_MEMO': {
                const p = Math.max(30, Math.round(iw * 0.05));
                const bh = Math.round(iw * 0.14);
                return { w: iw + p * 2, h: ih + p * 2 + bh };
            }`,
    `            case 'AVATAR_MEMO': {
                const p = Math.max(30, Math.round(iw * 0.05));
                const bh = Math.round(iw * 0.11);
                return { w: iw + p * 2, h: ih + p * 2 + bh };
            }`
);
fs.writeFileSync('src/renderer/js/engine-styles.js', eng, 'utf8');
console.log('ok');
