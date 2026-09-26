// 风格能力表 —— 「面板控件 ↔ 引擎风格」绑定关系的唯一事实来源。
//
// 背景:这层绑定原先散在多处、互相抄写、各写各的:
//   - app.js 的 updatePersonalVisibility():一串 if/else + 内联 .includes([...]) 白名单
//   - tools/visual-regression.js:BRAND_STYLES 又抄了一份同样的名单
// 结果就是「某预设不响应滑块」:滑块在面板上对所有风格可见,引擎里却只有少数风格真的读它。
//   圆角 9/63 · 整体留白 3/63 · 图片缩放 9/63 · 背景模糊 6/63 · 参数字号 更少
//
// 本表把绑定拆成两半:
//
//   MEASURED —— 五个「数值滑块」维度,由 tools/gen-style-caps.js 从视觉回归基线**实测**生成:
//               某风格在极值下渲染指纹不变,就说明它压根不读这个参数。判断不依赖人脑,所以不会腐烂。
//   DECLARED —— 无法用像素差判定的语义能力(勾选项、分组),手写在此。
//
// 消费方:app.js(面板显隐)、tools/visual-regression.js(测试矩阵)、tools/gen-style-caps.js。
//
// 改完引擎后若某风格开始/不再响应某参数 → 跑 `npm run gen:caps` 重新生成。
// `npm run check:caps` 只校验不写文件,过期则退出码 1(CI 用)。
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.StyleCaps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────────────
    // 维度定义(手写)。同时被面板显隐、视觉回归矩阵、能力表生成器共用 —— 不要在别处再抄一份。
    //   probe: 实测用的两个极值,范围对齐 index.html 里对应 input 的 min/max
    //   row  : 该滑块所在 .param-row 的 id(有些行原先没有 id,已补)
    // ────────────────────────────────────────────────────────────────────────
    const DIMS = [
        { key: 'pf', label: '参数字号', row: 'rowParamFontSize', slider: 'slParamFontSize', field: 'paramFontSize', probe: [16, 160] },
        { key: 'cr', label: '图片圆角', row: 'rowCornerRadius', slider: 'slCornerRadius', field: 'cornerConfig.cornerRadiusAll', probe: [0, 200] },
        { key: 'gm', label: '统一边距', row: 'rowGlobalMargin', slider: 'slGlobalMargin', field: 'baseMargin.globalMargin', probe: [0.4, 2.0] },
        { key: 'isc', label: '图片缩放', row: 'rowImgScale', slider: 'slImgScale', field: 'baseMargin.imgScale', probe: [0.6, 1.4] },
        { key: 'bi', label: '背景模糊程度', row: 'rowBgBlurInt', slider: 'slBgBlurInt', field: 'blurIntensity', probe: [10, 100] }
    ];

    // 用例 id 里的数值写法(0.4 → "04")。视觉回归基线的 key 依赖它,改了就等于作废整个基线。
    function caseSuffix(v) { return String(v).replace('.', ''); }
    function dimCaseId(style, dimKey, v) { return style + '__' + dimKey + caseSuffix(v); }

    // ────────────────────────────────────────────────────────────────────────
    // 风格分组(手写,从 app.js updatePersonalVisibility 原样搬过来,语义不变)
    // ────────────────────────────────────────────────────────────────────────
    const PERSONAL_STYLES = ['SIGNATURE', 'SIGN_PARAM', 'AVATAR_MEMO', 'AV_OVERLAY', 'AV_OVERLAY_TR', 'AV_OVERLAY_BR', 'AV_OVERLAY_BC', 'AV_OVERLAY_BC2'];
    const OVERLAY_STYLES = ['OVERLAY_PARAM_LEFT', 'OVERLAY_PARAM_RIGHT', 'OVERLAY_PARAM_BOTTOM'];
    const BLUR_STYLES = ['BLUR_CLASSIC', 'BLUR_DATE'];
    const IMPRESSION_STYLES = ['IMP_FROSTED', 'OVERLAY_PARAM_LEFT', 'OVERLAY_PARAM_RIGHT', 'OVERLAY_PARAM_BOTTOM', 'CARD_LOGO_PARAM'];
    const WM_PARAM_STYLES = ['FUJI_WM', 'FUJI_WM_BRAND'];
    const WM_BRAND_STYLES = ['FUJI_WM_BRAND', 'DARK_BRAND_ONLY'];
    const BOTTOM_BAR_STYLES = ['SIGNATURE', 'SIGN_PARAM', 'AVATAR_MEMO'];
    const BRAND_LOGO_STYLES = [
        'WM_CLASSIC', 'WM_BRAND_LOGO', 'IMP_FROSTED', 'IMP_CLASSIC',
        'OVERLAY_PARAM_LEFT', 'OVERLAY_PARAM_RIGHT', 'OVERLAY_PARAM_BOTTOM',
        'CARD_LEICA', 'CARD_LOGO_PARAM', 'CARD_PURE_LOGO', 'CARD_SIMPLE', 'CARD_IMMERSION',
        'FUJI_WM_BRAND', 'DARK_BRAND_ONLY', 'OVERLAY_LOGO_BOTTOM',
        'SIGN_PARAM', 'SIGN_BLUR', 'BLUR_CLASSIC', 'BLUR_DATE',
        'FUJI_WHITE', 'COLOR_CLASSIC', 'ART_CARD'
    ];

    // 非风格引擎路径(路线2 卡片 bgBlurEnable / 路线3 图层模板)的能力。
    // 这两条路径不吃 MEASURED —— engine.js 的卡片/图层分支直接读 baseMargin.imgScale 与
    // cornerConfig(见 engine.js 卡片分支与图层分支),applyGlobalMargin 也照常作用于四边 margin。
    // 故一律保持「可见」,与接入能力表之前的行为完全一致;不参与收紧。
    const PATH_FALLBACK = { pf: true, cr: true, gm: true, isc: true, bi: false };

    // ── 生成区 BEGIN (tools/gen-style-caps.js)── 请勿手改,改动会在下次生成时被覆盖 ──
    const MEASURED = {
        ALBUM_CORNER: {  },
        ART_CARD: { pf: true },
        AVATAR_MEMO: {  },
        AV_BLUR: { bi: true },
        AV_OVERLAY: {  },
        AV_OVERLAY_BC: {  },
        AV_OVERLAY_BC2: {  },
        AV_OVERLAY_BR: {  },
        AV_OVERLAY_TR: {  },
        BLUR_CLASSIC: { pf: true, cr: true, isc: true, bi: true },
        BLUR_DATE: { pf: true, cr: true, isc: true, bi: true },
        CARD_3D: {  },
        CARD_IMMERSION: { pf: true },
        CARD_LEICA: { pf: true },
        CARD_LOGO_PARAM: { pf: true },
        CARD_PURE_LOGO: { pf: true },
        CARD_SIMPLE: { pf: true },
        COLOR_CLASSIC: { pf: true },
        COLOR_REFINED: { pf: true },
        COMIC_PANEL: {  },
        CYBER_GLITCH: { pf: true, cr: true, gm: true, isc: true, bi: true },
        DARK_BRAND_ONLY: { pf: true, cr: true, isc: true },
        DOUBLE_LINE: {  },
        DROP_SHADOW: {  },
        FILM_STRIP: {  },
        FOLD_CORNER: {  },
        FUJI_WHITE: { pf: true },
        FUJI_WM: { pf: true, cr: true, isc: true },
        FUJI_WM_BRAND: { pf: true, cr: true, isc: true },
        GRADIENT: {  },
        IMP_CLASSIC: { pf: true },
        IMP_FROSTED: { pf: true, gm: true },
        MOVIE_TICKET: {  },
        NEWSPAPER: {  },
        OVERLAY_LOGO_BOTTOM: { pf: true },
        OVERLAY_PARAM_BOTTOM: { pf: true, cr: true, gm: true, isc: true },
        OVERLAY_PARAM_LEFT: { pf: true, cr: true, isc: true },
        OVERLAY_PARAM_RIGHT: { pf: true, cr: true, isc: true },
        PARAM_BOTTOM_LEFT: { pf: true },
        PARAM_BOTTOM_SINGLE: { pf: true },
        PARAM_TOP_LEFT: { pf: true },
        PINBOARD_TAPE: {  },
        POLAROID: { pf: true },
        POLAROID_HAND: {  },
        ROUNDED: {  },
        SIGNATURE: {  },
        SIGN_BLUR: { pf: true, bi: true },
        SIGN_PARAM: { pf: true },
        SIG_BLUR: { bi: true },
        SIMPLE: {  },
        SIMPLE_FILM: { pf: true },
        STAMP_POSTAGE: { pf: true },
        TEARED_PAPER: {  },
        TORN_JOURNAL: {  },
        VHS_TAPE: {  },
        VINTAGE: {  },
        WATERCOLOR_BLEED: {  },
        WHITE_PLAIN: {  },
        WM_AI: { pf: true },
        WM_BRAND_LOGO: { pf: true },
        WM_CLASSIC: { pf: true },
        WM_SINGLE: { pf: true },
        XIAOMI_IMP: { pf: true },
    };
    // ── 生成区 END ──

    // 某风格是否具备某能力。未知风格(非 draw 映射表内,即卡片/图层路径)回落到 PATH_FALLBACK。
    function has(style, dimKey) {
        const m = MEASURED[style];
        if (m) return !!m[dimKey];
        return !!PATH_FALLBACK[dimKey];
    }

    function caps(style) {
        const out = {};
        for (const d of DIMS) out[d.key] = has(style, d.key);
        return out;
    }

    // ────────────────────────────────────────────────────────────────────────
    // 面板行显隐:app.js updatePersonalVisibility 的唯一实现。
    // 返回 { rowId: 是否可见 };app.js 只负责把结果写进 el.style.display。
    //
    // 与旧 if/else 梯子逐行核对过等价性(旧代码里"CARD_3D 先隐藏、后被覆盖"的那几处在
    // 覆盖后落到同一个值,故折叠无差异)。差异只有一处,且是有意的:pf / bi / cr / gm / isc
    // 这五行改由 MEASURED 实测决定,见 tools/test-panel-visibility.js 的收紧登记。
    // ────────────────────────────────────────────────────────────────────────
    function visibleRows(style) {
        const s = String(style || '').toUpperCase();
        const isPersonal = PERSONAL_STYLES.indexOf(s) >= 0;
        const isOverlay = OVERLAY_STYLES.indexOf(s) >= 0;
        const isBlur = BLUR_STYLES.indexOf(s) >= 0;
        const isLogoParam = s === 'CARD_LOGO_PARAM';
        const isBottomBar = BOTTOM_BAR_STYLES.indexOf(s) >= 0;

        // 签名/头像核心组:旧代码里 CARD_3D 先随组显示、再被单独隐藏,净效果等于不显示
        const sigCore = isPersonal;
        const v = {};
        v.rowSignModel = s === 'SIGN_PARAM';
        v.rowSignText = sigCore;
        v.rowSignFont = sigCore;
        v.rowSignColor = sigCore;
        v.rowAvatarScale = sigCore;
        v.rowSignSize = sigCore;
        v.rowParamColor = sigCore;
        v.rowParamType = isBottomBar;
        v.rowParamPos = isBottomBar;
        v.rowBgBlur = isPersonal || isOverlay || isLogoParam;
        v.rowBrandSize = IMPRESSION_STYLES.indexOf(s) >= 0 || WM_BRAND_STYLES.indexOf(s) >= 0;
        v.rowParamScale = IMPRESSION_STYLES.indexOf(s) >= 0 || isBlur || WM_PARAM_STYLES.indexOf(s) >= 0;
        v.rowBrandLogo = BRAND_LOGO_STYLES.indexOf(s) >= 0;
        // 五个数值滑块:实测决定。旧实现里 CARD_3D 无条件盖掉的几行,在实测口径下
        // 已被上面各自的判定吸收,故这里不需要额外的 is3d 分支。
        for (const d of DIMS) v[d.row] = has(s, d.key);
        return v;
    }

    return { DIMS, MEASURED, PATH_FALLBACK, PERSONAL_STYLES, OVERLAY_STYLES, BLUR_STYLES, BRAND_LOGO_STYLES, caseSuffix, dimCaseId, has, caps, visibleRows };
});
