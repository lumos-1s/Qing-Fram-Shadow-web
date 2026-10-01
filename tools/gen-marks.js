// 生成 shared/marks/ 下的内置标记(SVG)。
//   node tools/gen-marks.js           写入文件
//   node tools/gen-marks.js --check   只校验磁盘上的文件是否与本文件一致(过期则退出码 1)
//
// 为什么要生成器而不是手写 16 个 SVG:与 tools/gen-style-caps.js 同一个理由 ——
// 「素材」也应该是可复现、可审查、可批量改的。改配色/改线宽/加一个标记,改这里再重新生成。
//
// 为什么是"原创标记"而不是品牌 Logo:发行版不随包分发任何第三方品牌的图形素材
// (商标与著作权原因,详见 THIRD_PARTY_ASSETS 说明)。这里全部是项目自绘的几何/排版图形,
// 著作权归项目所有,可以随 MIT 一起分发。
//
// 为什么每个标记两套(White/Black):池子里的图标没有"改色"控件,而水印要落在
// 深浅不一的照片上 —— 单色标记总有一种背景会看不见。沿用 shared/brandlogos 已有的
// `_White` / `_Black` 后缀约定,用户在池子里一眼能分。
'use strict';

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'shared', 'marks');
const SIZE = 256;

const r2 = (n) => Math.round(n * 100) / 100;
const polar = (cx, cy, r, deg) => {
    const a = (deg - 90) * Math.PI / 180;
    return [r2(cx + r * Math.cos(a)), r2(cy + r * Math.sin(a))];
};
// 正多边形顶点
const polygon = (cx, cy, r, n, rot = 0) => {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(polar(cx, cy, r, rot + i * 360 / n));
    return pts.map(p => p.join(',')).join(' ');
};

/* ── 标记定义:C 是当前变体的颜色 ── */
const MARKS = {
    // 器材署名:最常用的一枚 —— 描边徽章 + SHOT ON
    'shot-on': (C) => `
        <rect x="14" y="88" width="228" height="80" rx="14" stroke="${C}" stroke-width="10"/>
        <text x="128" y="142" text-anchor="middle" font-family="Arial,Helvetica,sans-serif"
              font-size="36" font-weight="700" letter-spacing="3" fill="${C}">SHOT ON</text>`,

    // 线条相机:机身 + 镜头 + 取景器凸起
    'camera-line': (C) => `
        <rect x="26" y="76" width="204" height="116" rx="18" stroke="${C}" stroke-width="10"/>
        <circle cx="128" cy="134" r="38" stroke="${C}" stroke-width="10"/>
        <circle cx="128" cy="134" r="15" fill="${C}"/>
        <rect x="94" y="58" width="56" height="20" rx="7" fill="${C}"/>`,

    // 光圈:外圈 + 六边形叶片 + 六条径向线
    'aperture': (C) => {
        const hex = polygon(128, 128, 62, 6, 0);
        let spokes = '';
        for (let i = 0; i < 6; i++) {
            const [x1, y1] = polar(128, 128, 62, i * 60);
            const [x2, y2] = polar(128, 128, 104, i * 60);
            spokes += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C}" stroke-width="9"/>`;
        }
        return `
        <circle cx="128" cy="128" r="104" stroke="${C}" stroke-width="10"/>
        <polygon points="${hex}" stroke="${C}" stroke-width="9" fill="none"/>${spokes}`;
    },

    // 胶片条:上下齿孔 + 两条片基边线
    'film-strip': (C) => {
        let holes = '';
        for (let x = 18; x <= 218; x += 34) {
            holes += `<rect x="${x}" y="62" width="20" height="18" rx="4" fill="${C}"/>`;
            holes += `<rect x="${x}" y="176" width="20" height="18" rx="4" fill="${C}"/>`;
        }
        return `
        <line x1="12" y1="92" x2="244" y2="92" stroke="${C}" stroke-width="9"/>
        <line x1="12" y1="164" x2="244" y2="164" stroke="${C}" stroke-width="9"/>${holes}`;
    },

    // 编号章:NO. 0001
    'no-stamp': (C) => `
        <rect x="22" y="90" width="212" height="76" rx="8" stroke="${C}" stroke-width="10"/>
        <text x="128" y="141" text-anchor="middle" font-family="Arial,Helvetica,sans-serif"
              font-size="34" font-weight="700" letter-spacing="2" fill="${C}">NO. 0001</text>`,

    // 日期框:点阵虚线框 + 三段分隔(日期值由文字功能填,这里只给容器)
    'date-frame': (C) => `
        <rect x="16" y="100" width="224" height="56" rx="10" stroke="${C}" stroke-width="8"
              stroke-dasharray="10 8"/>
        <line x1="90" y1="108" x2="90" y2="148" stroke="${C}" stroke-width="6" stroke-dasharray="8 7"/>
        <line x1="166" y1="108" x2="166" y2="148" stroke="${C}" stroke-width="6" stroke-dasharray="8 7"/>`,

    // 四角括号:呼应引擎里的 cornerDecor
    'corner-brackets': (C) => {
        const d = (sx, sy, dx, dy) => `<path d="M${sx} ${sy + 56 * dy} V${sy} H${sx + 56 * dx}" stroke="${C}" stroke-width="12" fill="none"/>`;
        return `\n        ${d(34, 34, 1, 1)}${d(222, 34, -1, 1)}${d(34, 222, 1, -1)}${d(222, 222, -1, -1)}`;
    },

    // 星芒:12 道放射 + 中心点
    'starburst': (C) => {
        let rays = '';
        for (let i = 0; i < 12; i++) {
            const inner = i % 3 === 0 ? 26 : 44;      // 三长一短,更像星芒
            const [x1, y1] = polar(128, 128, inner, i * 30);
            const [x2, y2] = polar(128, 128, 108, i * 30);
            rays += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${C}" stroke-width="10" stroke-linecap="round"/>`;
        }
        return `${rays}\n        <circle cx="128" cy="128" r="16" fill="${C}"/>`;
    }
};

const VARIANTS = [['White', '#ffffff'], ['Black', '#000000']];

function render(name, color) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" fill="none">${MARKS[name](color)}
</svg>
`;
}

function build() {
    const files = {};
    for (const name of Object.keys(MARKS)) {
        for (const [suffix, color] of VARIANTS) {
            files[`${name}_${suffix}.svg`] = render(name, color);
        }
    }
    return files;
}

const files = build();
const names = Object.keys(files);
const isCheck = process.argv.includes('--check');

if (isCheck) {
    const stale = [], missing = [];
    for (const n of names) {
        const p = path.join(OUT_DIR, n);
        if (!fs.existsSync(p)) { missing.push(n); continue; }
        if (fs.readFileSync(p, 'utf-8') !== files[n]) stale.push(n);
    }
    const extra = fs.existsSync(OUT_DIR)
        ? fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.svg') && !names.includes(f))
        : [];
    if (missing.length || stale.length || extra.length) {
        console.error('✖ shared/marks 与生成器不一致(跑 npm run gen:marks 重新生成)');
        if (missing.length) console.error('  缺失: ' + missing.join(', '));
        if (stale.length) console.error('  内容过期: ' + stale.join(', '));
        if (extra.length) console.error('  多出(生成器里没有): ' + extra.join(', '));
        process.exit(1);
    }
    console.log(`✓ 内置标记与生成器一致(${names.length} 个文件 / ${Object.keys(MARKS).length} 种造型)`);
} else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(OUT_DIR, n), files[n], 'utf-8');
    console.log(`已写入 ${names.length} 个文件 → ${path.relative(path.join(__dirname, '..'), OUT_DIR)}`);
    console.log('  造型: ' + Object.keys(MARKS).join(', '));
    console.log('  变体: ' + VARIANTS.map(v => v[0]).join(' / '));
}
