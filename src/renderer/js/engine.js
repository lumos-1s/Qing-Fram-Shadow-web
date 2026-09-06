// 清框??Canvas 2D 渲染引擎 —????JavaFX BorderEngine 逐行移植
// 严格对齐原版:computeCanvasSize(含侧投影阴影预留空间)、图??阴影/辉光/渐变/纹理/描边)??// 照片投影(四面均匀/悬浮双层/默认小阴??、白色齿孔、全局光影(暗角/漏光)??// 装饰(四角括号/EXIF 底条)、卡片样??renderCardStyle 独立管线)??
// ── 工具 ──
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// parseColor：hex + opacity(0-100) ??{r,g,b,a}，与原版 parseColor 一??空透明度按 100 处理)
function parseColor(hex, opacity) {
    try {
        hex = String(hex || '#000000').replace('#', '');
        if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        if (hex.length === 6) hex = 'FF' + hex;
        const argb = parseInt(hex, 16);
        const a = (argb >> 24) & 0xFF;
        const r = (argb >> 16) & 0xFF;
        const g = (argb >> 8) & 0xFF;
        const b = argb & 0xFF;
        const alpha = (a / 255) * ((opacity == null ? 100 : opacity) / 100);
        return { r, g, b, a: clamp(alpha, 0, 1) };
    } catch (e) {
        return { r: 0, g: 0, b: 0, a: 1 };
    }
}
function rgba(c) { return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${c.a})`; }

// baseMargin 总边??对应原版 getTotalLeft/Right/Top/Bottom)
function totals(m) {
    return { left: m.marginLeft || 0, right: m.marginRight || 0, top: m.marginTop || 0, bottom: m.marginBottom || 0 };
}

// 侧投影模式的阴影预留空间:容纳环境阴影层的模糊半径 + 最大偏移量(原版 getShadowSpace)
function getShadowSpace(template) {
    if (!template) return 0;
    for (const layer of (template.layerList || [])) {
        const sg = layer.shadowGlowConfig;
        if (sg && sg.sideShadow === 1) {
            const radius = Math.max(4, (sg.shadowBlur || 0) * 1.5);
            const off = Math.max(0, Math.max(sg.shadowOffsetX || 0, sg.shadowOffsetY || 0)) * 2.4;
            return Math.max(24, radius * 2 + off);
        }
    }
    return 0;
}

function parseRatio(ratio) {
    try {
        const parts = String(ratio).split(':');
        return [parseFloat(parts[0]), parseFloat(parts[1])];
    } catch (e) { return null; }
}

// 计算渲染画布尺寸(含画布比例调??+ 侧投影预留空??，与原版 computeCanvasSize 一??
function computeCanvasSize(imgW, imgH, template) {
    const margin = template.baseMargin || {};
    const t = totals(margin);
    let canvasW = imgW + t.left + t.right;
    let canvasH = imgH + t.top + t.bottom;
    const shadowSpace = getShadowSpace(template);
    if (shadowSpace > 0) { canvasW += shadowSpace * 2; canvasH += shadowSpace * 2; }
    const ratio = template.canvasRatio;
    if (ratio && ratio !== 'original') {
        const wh = parseRatio(ratio);
        if (wh) {
            // 只扩大、不裁剪:向目标比??补齐"，照片保持完??
        const targetRatio = wh[0] / wh[1];
            const currentRatio = canvasW / canvasH;
            if (currentRatio > targetRatio) canvasH = canvasW / targetRatio;
            else canvasW = canvasH * targetRatio;
        }
    }
    return [canvasW, canvasH];
}

// ── 渲染主入??对应原版 renderToCanvas 的三路分??──
function renderToCanvas(app, compare) {
    const { image, template } = app;
    const img = image.el;
    const cw0 = img.naturalWidth, ch0 = img.naturalHeight;

    // 对比原图:只画照片本身,无边??
    if (compare) {
        const canvas = app.dom.canvas;
        canvas.width = cw0; canvas.height = ch0;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, cw0, ch0);
        ctx.drawImage(img, 0, 0, cw0, ch0);
        app.applyZoomStyle();
        return;
    }

    // 1) photoFrameStyle 相框样式(BorderProcessor 移植,engine-styles.js)
    const pfStyle = template.photoFrameStyle;
    if (pfStyle && pfStyle !== 'NONE') {
        if (window.EngineStyles && window.EngineStyles.renderPhotoFrame) {
            window.EngineStyles.renderPhotoFrame(app);
        } else {
            renderPlaceholder(app, '#ffffff');
        }
        return;
    }

    // 2) 卡片样式(bgBlurEnable==1 ??renderCardStyle 独立管线)
    const margin = template.baseMargin || {};
    if ((margin.bgBlurEnable || 0) === 1) { renderCardStyle(app); return; }

    // 3) 默认:模板图层样式
    renderTemplateStyle(app);
}

function setupCanvas(app, canvasW, canvasH) {
    const canvas = app.dom.canvas;
    const displayMax = (typeof app.displayMax === 'number' && app.displayMax > 0) ? app.displayMax : 1800;
    const scale = Math.min(1, displayMax / Math.max(canvasW, canvasH));
    canvas.width = Math.max(1, Math.round(canvasW * scale));
    canvas.height = Math.max(1, Math.round(canvasH * scale));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(scale, scale);
    return ctx;
}

// ── 模板图层样式(对应原版 renderToCanvas 非卡片体)──
function renderTemplateStyle(app) {
    const { image, template } = app;
    const img = image.el;
    const margin = template.baseMargin || {};
    const t = totals(margin);
    const cs = computeCanvasSize(img.naturalWidth, img.naturalHeight, template);
    const canvasW = cs[0], canvasH = cs[1];
    const ctx = setupCanvas(app, canvasW, canvasH);

    // 白底
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // 图层(倒序:最底层先画)
    const layers = template.layerList || [];
    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (layer.visible === false) continue;
        drawLayerShadowGlow(ctx, layer, canvasW, canvasH, margin);
        drawSingleLayer(ctx, layer, canvasW, canvasH, margin);
    }

    // 照片
    drawOriginImage(ctx, img, margin, canvasW, canvasH, template);

    // 形状遮罩:仅胶片齿??白色;原版无锯齿撕裂、无暗色圆点)
    applyShapeMask(ctx, template.filmTearConfig, canvasW, canvasH, margin);

    // 全局光影
    applyGlobalLight(ctx, template.lightEffect, canvasW, canvasH);

    ctx.restore();

    // 元素叠层(基准画布像素坐标):文字/贴纸/四角括号/EXIF 底条 + Logo
    const cw = app.dom.canvas.width, ch = app.dom.canvas.height;
    drawDecoration(ctx, template.decorConfig || {}, cw, ch, image);
    drawDraftText(ctx, template, cw, ch);
    drawLogoElements(ctx, template.logoElements || [], cw, ch);

    app.applyZoomStyle();
}

// 图层圆角:cornerConfig 供边框(图层/描边)独立于照片圆角自由调整
function layerCornerRadii(layer, w, h) {
    const lcc = (layer && layer.cornerConfig) || {};
    const maxR = Math.min(w, h) / 2;
    const all = clamp(lcc.cornerRadiusAll || 0, 0, maxR);
    const one = (v) => (v || 0) > 0 ? Math.min(v, maxR) : all;
    return { tl: one(lcc.cornerRadiusTL), tr: one(lcc.cornerRadiusTR), bl: one(lcc.cornerRadiusBL), br: one(lcc.cornerRadiusBR) };
}

// 以圆角路径(如果有)裁剪后填充矩形;无圆角时与 fillRect 完全一致
function fillLayerRect(ctx, x, y, w, h, corners) {
    const r = corners && (corners.tl || corners.tr || corners.bl || corners.br);
    if (r) {
        ctx.save();
        buildRoundedPath(ctx, x, y, w, h, corners.tl, corners.tr, corners.bl, corners.br);
        ctx.clip();
        ctx.fillRect(x, y, w, h);
        ctx.restore();
    } else {
        ctx.fillRect(x, y, w, h);
    }
}

function drawSingleLayer(ctx, layer, cw, ch, margin) {
    const bx = (margin.marginLeft || 0) + (layer.marginLeft || 0);
    const by = (margin.marginTop || 0) + (layer.marginTop || 0);
    const bw = cw - (margin.marginLeft || 0) - (margin.marginRight || 0) - (layer.marginLeft || 0) - (layer.marginRight || 0);
    const bh = ch - (margin.marginTop || 0) - (margin.marginBottom || 0) - (layer.marginTop || 0) - (layer.marginBottom || 0);
    if (bw <= 0 || bh <= 0) return;

    const corners = layerCornerRadii(layer, bw, bh);
    const fill = layer.fillConfig || {};
    applyFill(ctx, fill, bx, by, bw, bh);
    fillLayerRect(ctx, bx, by, bw, bh, corners);
    ctx.globalCompositeOperation = 'source-over';

    const stroke = layer.strokeConfig || {};
    if ((stroke.strokeWidth || 0) > 0) {
        applyStroke(ctx, stroke, bx, by, bw, bh, corners);
    }
}

function drawLayerShadowGlow(ctx, layer, cw, ch, margin) {
    const sg = layer.shadowGlowConfig || {};
    if (sg.shadowEnable !== 1 && sg.glowEnable !== 1) return;

    const lx = (margin.marginLeft || 0) + (layer.marginLeft || 0);
    const ly = (margin.marginTop || 0) + (layer.marginTop || 0);
    const lw = cw - (margin.marginLeft || 0) - (margin.marginRight || 0) - (layer.marginLeft || 0) - (layer.marginRight || 0);
    const lh = ch - (margin.marginTop || 0) - (margin.marginBottom || 0) - (layer.marginTop || 0) - (layer.marginBottom || 0);

    const corners = layerCornerRadii(layer, lw, lh);

    // 阴影
    if (sg.shadowEnable === 1) {
        ctx.save();
        ctx.shadowColor = rgba(parseColor(sg.shadowColorHex, sg.shadowOpacity));
        ctx.shadowBlur = sg.shadowBlur || 0;
        ctx.shadowOffsetX = sg.shadowOffsetX || 0;
        ctx.shadowOffsetY = sg.shadowOffsetY || 0;
        // Canvas ??spread,用略大的填充近似(与原版注释一??
        applyFill(ctx, layer.fillConfig || {}, lx, ly, lw, lh);
        fillLayerRect(ctx, lx, ly, lw, lh, corners);
        ctx.restore();
    }

    // 辉光:以辉光色本身为填充源
    if (sg.glowEnable === 1) {
        const glowColor = parseColor(sg.glowColorHex, sg.glowOpacity);
        ctx.save();
        ctx.shadowColor = rgba(glowColor);
        ctx.shadowBlur = sg.glowBlur || 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = rgba(glowColor);
        fillLayerRect(ctx, lx, ly, lw, lh, corners);
        ctx.restore();
    }
}

function applyFill(ctx, fill, x, y, w, h) {
    const type = fill.fillType || 'solid';
    if (type === 'gradient') { applyGradient(ctx, fill, x, y, w, h); return; }
    if (type === 'transparent') { ctx.fillStyle = 'rgba(0,0,0,0)'; return; }
    if (type === 'texture' && fill.textureSrc) { fillTexture(ctx, fill, x, y, w, h); return; }
    ctx.fillStyle = rgba(parseColor(fill.fillHex, fill.fillOpacity));
}

function applyGradient(ctx, fill, x, y, w, h) {
    const stops = (fill.gradientStops || []).map(s => ({
        pos: s.position || 0,
        c: parseColor(s.color, fill.gradientOpacity),
    }));
    if (!stops.length) { ctx.fillStyle = '#ffffff'; return; }
    const angle = (fill.gradientAngle || 0) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const cx = x + w / 2, cy = y + h / 2;
    const dx = Math.abs(w * cos / 2) + Math.abs(h * sin / 2);
    const dy = Math.abs(w * sin / 2) + Math.abs(h * cos / 2);
    let grad;
    if (fill.gradientType === 'radial') {
        grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(dx, dy));
    } else {
        const x0 = cx - dx, y0 = cy - dy, x1 = cx + dx, y1 = cy + dy;
        grad = ctx.createLinearGradient(x0, y0, x1, y1);
    }
    for (const s of stops) grad.addColorStop(clamp(s.pos, 0, 1), rgba(s.c));
    ctx.fillStyle = grad;
}

const TEXTURE_CACHE = {};
function getTexture(name) {
    if (!name) return null;
    if (TEXTURE_CACHE[name] && TEXTURE_CACHE[name].complete && TEXTURE_CACHE[name].naturalWidth > 0) return TEXTURE_CACHE[name];
    if (TEXTURE_CACHE[name]) return null;
    

const app = (typeof window !== 'undefined' && window.App) ? window.App : null;
    const t = app && app.textures ? app.textures.find(x => x.name === name) : null;
    if (!t) return null;
    const im = new Image();
    im.onload = () => { if (window.App) window.App.requestRender(); };
    im.src = t.dataUrl;
    TEXTURE_CACHE[name] = im;
    return null;
}

// 元素位图:纹理名或 dataUrl 均可(贴纸 dataUrl / Logo 图标 / 内置纹理走同一缓存)
function getElementBitmap(src) {
    if (!src) return null;
    if (TEXTURE_CACHE[src] && TEXTURE_CACHE[src].complete && TEXTURE_CACHE[src].naturalWidth > 0) return TEXTURE_CACHE[src];
    if (TEXTURE_CACHE[src]) return null; // 加载??    
const app = (typeof window !== 'undefined' && window.App) ? window.App : null;
    let url = src;
    const tex = app && app.textures ? app.textures.find(x => x.name === src) : null;
    if (tex && tex.dataUrl) url = tex.dataUrl;
    const im = new Image();
    im.onload = () => { if (app) app.requestRender(); };
    im.onerror = () => { TEXTURE_CACHE[src] = null; };
    im.src = url;
    TEXTURE_CACHE[src] = im;
    return null;
}
function mapBlend(blend) {
    if (blend === 'multiply') return 'multiply';
    if (blend === 'screen') return 'screen';
    if (blend === 'overlay') return 'overlay';
    return null;
}
function fillTexture(ctx, fill, x, y, w, h) {
    const name = fill.textureSrc;
    const tex = TEXTURE_CACHE[name];
    if (!tex || !tex.complete || !tex.naturalWidth) {
        getTexture(name);
        ctx.fillStyle = rgba(parseColor(fill.fillHex, fill.fillOpacity));
        return;
    }
    try {
        const scale = fill.textureScale || 1;
        // 与原??ImagePattern 一??锚点 (x+offsetX, y+offsetY),纹素尺寸 texW*scale
        const pat = ctx.createPattern(tex, 'repeat');
        if (!pat) { ctx.fillStyle = rgba(parseColor(fill.fillHex, fill.fillOpacity)); return; }
        pat.setTransform(new DOMMatrix().translate(x + (fill.textureOffsetX || 0), y + (fill.textureOffsetY || 0)).scale(scale));
        const blend = mapBlend(fill.textureBlend);
        ctx.save();
        ctx.globalAlpha = clamp((fill.textureOpacity == null ? 100 : fill.textureOpacity) / 100, 0, 1);
        if (blend) ctx.globalCompositeOperation = blend;
        ctx.fillStyle = pat;
        ctx.fillRect(x, y, w, h);
        ctx.restore();
    } catch (e) {
        ctx.fillStyle = rgba(parseColor(fill.fillHex, fill.fillOpacity));
    }
}

function applyStroke(ctx, stroke, x, y, w, h, corners) {
    const sw = stroke.strokeWidth || 0;
    const pos = stroke.strokePos || 'inside';
    const inset = pos === 'inside' ? 0 : pos === 'center' ? sw / 2 : sw;
    ctx.strokeStyle = rgba(parseColor(stroke.strokeColorHex, stroke.strokeOpacity));
    ctx.lineWidth = sw;
    if (stroke.strokeDashArray && stroke.strokeDashArray.length) {
        ctx.setLineDash(stroke.strokeDashArray);
        ctx.lineDashOffset = stroke.strokeDashOffset || 0;
    }
    const r = corners && (corners.tl || corners.tr || corners.bl || corners.br);
    if (r) {
        const d = 2 * inset;
        buildRoundedPath(ctx, x + inset, y + inset, w - d, h - d,
            Math.max(0, corners.tl - inset), Math.max(0, corners.tr - inset),
            Math.max(0, corners.bl - inset), Math.max(0, corners.br - inset));
        ctx.stroke();
    } else {
        ctx.strokeRect(x + inset, y + inset, w - 2 * inset, h - 2 * inset);
    }
    ctx.setLineDash([]);
}

// 构建圆角矩形路径(与原??buildRoundedPath 一??
function buildRoundedPath(ctx, x, y, w, h, tl, tr, bl, br) {
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx.lineTo(x, y + tl);
    ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
}

// 照片绘制(投影 + 圆角裁剪),与原??drawOriginImage 一??
function drawOriginImage(ctx, img, margin, cw, ch, template) {
    const iw = img.naturalWidth * (margin.imgScale || 1);
    const ih = img.naturalHeight * (margin.imgScale || 1);
    const usableW = cw - (margin.marginLeft || 0) - (margin.marginRight || 0);
    const usableH = ch - (margin.marginTop || 0) - (margin.marginBottom || 0);
    const ox = (margin.marginLeft || 0) + (usableW - iw) / 2 + (margin.imgOffsetX || 0);
    const oy = (margin.marginTop || 0) + (usableH - ih) / 2 + (margin.imgOffsetY || 0);
    const corner = template.cornerConfig || {};
    const rTL = corner.cornerRadiusTL || 0, rTR = corner.cornerRadiusTR || 0;
    const rBL = corner.cornerRadiusBL || 0, rBR = corner.cornerRadiusBR || 0;
    const hasCorner = rTL > 0 || rTR > 0 || rBL > 0 || rBR > 0;

    // 照片后的投影:优先使用图层中启用的阴影参数
    let photoShadow = null;
    for (const layer of (template.layerList || [])) {
        const sg = layer.shadowGlowConfig;
        if (sg && sg.shadowEnable === 1) { photoShadow = sg; break; }
    }

    if (photoShadow) {
        if (photoShadow.sideShadow !== 1) {
            // 四边均匀投影:投影从照片四周均匀扩散(偏移恒为 0)
            ctx.save();
            ctx.shadowColor = rgba(parseColor(photoShadow.shadowColorHex, photoShadow.shadowOpacity));
            ctx.shadowBlur = photoShadow.shadowBlur || 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            if (hasCorner) {
                buildRoundedPath(ctx, ox, oy, iw, ih, rTL, rTR, rBL, rBR);
                ctx.clip();
            }
            ctx.drawImage(img, ox, oy, iw, ih);
            ctx.restore();
        } else {
            // 立体悬浮卡片(浮影白框):白色衬边 + 环境阴影(????大模?? + 接触阴影(????小模?? + 卡片本体
            const matL = margin.marginLeft, matT = margin.marginTop;
            const matR = margin.marginRight, matB = margin.marginBottom;
            const cx = ox - matL, cy = oy - matT;
            const cw2 = iw + matL + matR, ch2 = ih + matT + matB;
            const sc = parseColor(photoShadow.shadowColorHex, photoShadow.shadowOpacity);
            const blur = Math.max(4, photoShadow.shadowBlur || 0);
            const offX = photoShadow.shadowOffsetX || 0, offY = photoShadow.shadowOffsetY || 0;

            // 环境阴影:大模糊、浅色、偏移更??            
            ctx.save();
            ctx.shadowColor = `rgba(${Math.round(sc.r)},${Math.round(sc.g)},${Math.round(sc.b)},${sc.a * 0.6})`;
            ctx.shadowBlur = blur * 1.5;
            ctx.shadowOffsetX = offX * 2.4;
            ctx.shadowOffsetY = offY * 2.4;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(cx, cy, cw2, ch2);
            ctx.restore();

            // 接触阴影:小模糊、深色、紧贴卡??            
            ctx.save();
            ctx.shadowColor = rgba(sc);
            ctx.shadowBlur = blur * 0.5;
            ctx.shadowOffsetX = offX * 0.5;
            ctx.shadowOffsetY = offY * 0.5;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(cx, cy, cw2, ch2);
            ctx.restore();

            // 卡片本体(白色衬边)
            ctx.save();
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(cx, cy, cw2, ch2);
            ctx.restore();
        }
    } else {
        // 默认小阴??        
            ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        if (hasCorner) {
            buildRoundedPath(ctx, ox + 5, oy + 5, iw, ih, rTL, rTR, rBL, rBR);
            ctx.fill();
        } else {
            ctx.fillRect(ox + 5, oy + 5, iw, ih);
        }
        ctx.restore();
    }

    // 照片本体
    if (hasCorner) {
        ctx.save();
        buildRoundedPath(ctx, ox, oy, iw, ih, rTL, rTR, rBL, rBR);
        ctx.clip();
        ctx.drawImage(img, ox, oy, iw, ih);
        ctx.restore();
    } else {
        ctx.drawImage(img, ox, oy, iw, ih);
    }
}

// 形状遮罩:仅胶片齿??原版 applyShapeMask)
function applyShapeMask(ctx, filmTearConfig, cw, ch, margin) {
    if (filmTearConfig && filmTearConfig.filmPerforationEnable === 1) {
        drawFilmPerforations(ctx, filmTearConfig, cw, ch, margin);
    }
}

// 白色齿孔(原版 drawFilmPerforations:hstrip 上下两条轨道,否则左右竖列)
// 锚定到照片区(??baseMargin 内侧):web 预设把胶片条作为照片区图??页边留白属页面背??
// margin ??0 时与原版画布原点一致??
function drawFilmPerforations(ctx, config, cw, ch, margin) {
    const size = config.filmPerforationSize || 0;
    const spacing = config.filmPerforationSpacing || 0;
    const isRound = config.filmPerforationType === 'round';
    const horizontal = config.filmPerforationType === 'hstrip';
    // 步长守卫:size/spacing ??0 或负数时保证循环推进
    const stepX = Math.max(1, size + spacing);
    const stepY = Math.max(1, size + spacing);
    const m = 15;
    const ax = (margin && margin.marginLeft) || 0;
    const ay = (margin && margin.marginTop) || 0;
    const aw = cw - ax - ((margin && margin.marginRight) || 0);
    const ah = ch - ay - ((margin && margin.marginBottom) || 0);
    ctx.fillStyle = '#ffffff';
    if (horizontal) {
        const yTop = ay + m;
        const yBottom = ay + ah - m - size;
        let x = ax + m;
        while (x + size <= ax + aw - m) {
            ctx.fillRect(x, yTop, size, size);
            ctx.fillRect(x, yBottom, size, size);
            x += stepX;
        }
    } else {
        let y = ay + m;
        while (y + size <= ay + ah - m) {
            for (const xv of [ax + m, ax + aw - m - size]) {
                if (isRound) { ctx.beginPath(); ctx.arc(xv + size / 2, y + size / 2, size / 2, 0, Math.PI * 2); ctx.fill(); }
                else ctx.fillRect(xv, y, size, size);
            }
            y += stepY;
        }
    }
}

// 全局光影(原版 applyGlobalLight:暗角 MULTIPLY + 漏光 SCREEN;无胶片颗??
function applyGlobalLight(ctx, light, cw, ch) {
    if (!light) return;
    if (light.vignetteEnable === 1) {
        const s = light.vignetteStrength / 100;
        const r = Math.max(cw, ch) / 2;
        const grad = ctx.createRadialGradient(cw / 2, ch / 2, 0, cw / 2, ch / 2, r);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(Math.max(0, 1 - s), 'rgba(0,0,0,0)');
        grad.addColorStop(1, `rgba(0,0,0,${Math.min(1, s)})`);
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, cw, ch);
        ctx.restore();
    }
    if (light.lightLeakEnable === 1) {
        const op = light.lightLeakOpacity / 100;
        const type = light.lightLeakType || 'warm';
        let core, mid;
        if (type === 'cool') { core = [120, 200, 255]; mid = [70, 150, 255]; }
        else if (type === 'magenta') { core = [255, 140, 220]; mid = [220, 90, 255]; }
        else { core = [255, 190, 110]; mid = [255, 130, 60]; }
        const a = (light.lightLeakAngle || 0) * Math.PI / 180;
        const dx = Math.cos(a), dy = Math.sin(a);
        // 光源位于画布边缘外侧,光束与光晕从该方向射入画??
        const sx = cw / 2 + dx * cw * 0.58;
        const sy = ch / 2 + dy * ch * 0.58;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        // 1) 大范围柔光晕
        const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(cw, ch) * 0.85);
        halo.addColorStop(0, `rgba(${mid[0]},${mid[1]},${mid[2]},${clamp(op * 0.45, 0, 1)})`);
        halo.addColorStop(0.35, `rgba(${mid[0]},${mid[1]},${mid[2]},${clamp(op * 0.15, 0, 1)})`);
        halo.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = halo;
        ctx.fillRect(0, 0, cw, ch);
        // 2) 光束
        const bx = -dx, by = -dy;
        const beam = ctx.createLinearGradient(sx, sy, sx + bx * cw, sy + by * ch);
        beam.addColorStop(0, `rgba(${core[0]},${core[1]},${core[2]},${clamp(op * 0.9, 0, 1)})`);
        beam.addColorStop(0.3, `rgba(${core[0]},${core[1]},${core[2]},${clamp(op * 0.3, 0, 1)})`);
        beam.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = beam;
        ctx.fillRect(0, 0, cw, ch);
        ctx.restore();
    }
}

// EXIF 底条(原版 drawDecoration ??exifAutoText 逻辑)
function drawExifBar(ctx, decor, cw, ch) {
    if ((decor.exifAutoText || 0) !== 1) return;
    let exifLine = null;
    for (const l of (decor.textLines || [])) {
        if (l.text && (l.align === 'bottom' || l.align === 'exif')) { exifLine = l; break; }
    }
    if (!exifLine) return;
    const fs = autoExifTextSize(exifLine, cw);
    const pad = Math.max(6, fs * 0.25);
    const baseY = ch - fs - 10;
    const top = baseY - fs * 0.9 - pad;
    const bottom = Math.min(ch, baseY + fs * 0.25 + pad);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, top, cw, bottom - top);
}

// 文字字号:exif 自适行??2000px 基准缩放(0.5~2.5 ??,其余保持原??原版 autoExifTextSize)
function autoExifTextSize(textLine, canvasW) {
    let fs = Math.max(1, textLine.fontSize || 1);
    if (textLine.align === 'exif' && !textLine.autoSize) {
        const k = clamp(canvasW / 2000, 0.5, 2.5);
        fs = Math.max(4, fs * k);
    }
    return fs;
}

// 四角括号装饰(原版 drawCornerDecor:line/round/double)
function drawCornerDecor(ctx, type, s, cw, ch) {
    if (!s || s <= 0) return;
    const isRound = type === 'round';
    const isDouble = type === 'double';
    ctx.strokeStyle = 'rgb(128,128,128)';
    ctx.lineWidth = 2;
    const corners = [[s, s], [cw - s, s], [s, ch - s], [cw - s, ch - s]];
    for (const c of corners) {
        const x = c[0], y = c[1];
        const dx = x < cw / 2 ? 1 : -1;
        const dy = y < ch / 2 ? 1 : -1;
        if (isRound) {
            const r = Math.max(4, s * 0.6);
            ctx.beginPath();
            ctx.moveTo(x + dx * s, y);
            ctx.arcTo(x, y, x, y + dy * s, r);
            ctx.stroke();
        } else if (isDouble) {
            const in_ = Math.max(4, s * 0.25);
            const len = Math.max(6, s - in_ * 2);
            ctx.beginPath();
            ctx.moveTo(x, y); ctx.lineTo(x + dx * s, y);
            ctx.moveTo(x, y); ctx.lineTo(x, y + dy * s);
            const xi = x + dx * in_, yi = y + dy * in_;
            ctx.moveTo(xi, yi); ctx.lineTo(xi + dx * len, yi);
            ctx.moveTo(xi, yi); ctx.lineTo(xi, yi + dy * len);
            ctx.stroke();
        } else {
            ctx.beginPath();
            ctx.moveTo(x, y); ctx.lineTo(x + dx * s, y);
            ctx.moveTo(x, y); ctx.lineTo(x, y + dy * s);
            ctx.stroke();
        }
    }
}

// 文字行锚??原版 textLineAnchor)
function textLineAnchor(textLine, cw, ch, card, cardY, cardH) {
    const fs = autoExifTextSize(textLine, cw);
    const align = textLine.align || 'bottom';
    if (align === 'free') return [textLine.x || 0, textLine.y || 0];
    const tx = textLine.x > 0 ? textLine.x : cw / 2;
    let ty;
    if (align === 'bottom' || align === 'exif') {
        ty = card ? cardY + cardH + Math.max(8, ch * 0.008) : ch - fs - 10;
    } else if (align === 'top') {
        ty = card ? fs + Math.max(6, ch * 0.004) : fs + 10;
    } else {
        ty = textLine.y > 0 ? textLine.y
            : (card ? cardY + cardH + Math.max(8, ch * 0.008) : ch - fs - 10);
    }
    return [tx, ty];
}

// 文字行绘??原版 drawTextLine)
function drawTextLine(ctx, line, cw, ch, card, cardY, cardH) {
    ctx.save();
    const fs = autoExifTextSize(line, cw);
    ctx.font = `${line.fontWeight || 400} ${fs}px "${line.fontFamily || 'Microsoft YaHei'}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = rgba(parseColor(line.colorHex, line.opacity));
    const anchor = textLineAnchor(line, cw, ch, card || false, cardY || 0, cardH || 0);
    const rot = line.rotation || 0;
    if (rot !== 0) {
        ctx.translate(anchor[0], anchor[1]);
        ctx.rotate(rot * Math.PI / 180);
        ctx.fillText(line.text, 0, 0);
    } else {
        ctx.fillText(line.text, anchor[0], anchor[1]);
    }
    ctx.restore();
}

// 实时草稿文字(align:'live',??UI 预览??不写??textLines)
function drawDraftText(ctx, template, cw, ch) {
    const d = template && template._draftText;
    if (d && d.text) drawTextLine(ctx, d, cw, ch, false, 0, 0);
}

// 依据 decor.showExif 构建 EXIF 水印文字??web 特??保留)
function buildExifLines(template, image) {
    const d = template.decor || {};
    if (d.showExif !== 'yes') return [];
    const e = (image && image.exif) || {};
    const parts = [
        e.make && e.model ? `${e.make} ${e.model}` : (e.make || e.model),
        e.shutter, e.aperture, e.iso, e.focal
    ].filter(Boolean);
    if (!parts.length) return [];
    return [{
        text: parts.join(' · '),
        x: 0, y: 0,
        fontSize: (d.exifSize || 14),
        colorHex: (d.exifColor || '#FFFFFF').replace('#', ''),
        opacity: 80,
        align: 'bottom',
        fontFamily: 'Microsoft YaHei',
        fontWeight: 400,
    }];
}

// 装饰总入??原版 drawDecoration:文字/贴纸/四角括号/EXIF 底条)
function drawDecoration(ctx, decor, cw, ch, image) {
    if (!decor) return;

    // 文字??    
for (const textLine of (decor.textLines || [])) {
        if (!textLine.text) continue;
        drawTextLine(ctx, textLine, cw, ch, false, 0, 0);
    }
    // web ??EXIF 水印??
    const exifLines = buildExifLines({ decor }, image);
    for (const line of exifLines) drawTextLine(ctx, line, cw, ch, false, 0, 0);
    // 贴纸
    for (const sticker of (decor.stickers || [])) {
        if (!sticker.src) continue;
        const tex = getElementBitmap(sticker.src);
        if (!tex || !tex.complete || !tex.naturalWidth) continue;
        const sw = tex.naturalWidth * (sticker.scale || 1);
        const sh = tex.naturalHeight * (sticker.scale || 1);
        ctx.save();
        ctx.translate(sticker.x || 0, sticker.y || 0);
        if (sticker.rotation) ctx.rotate(sticker.rotation * Math.PI / 180);
        ctx.globalAlpha = clamp((sticker.opacity == null ? 100 : sticker.opacity) / 100, 0, 1);
        ctx.drawImage(tex, -sw / 2, -sh / 2, sw, sh);
        ctx.restore();
    }
    // 四角括号
    if ((decor.cornerDecorEnable || 0) === 1) {
        drawCornerDecor(ctx, decor.cornerDecorType || 'line', decor.cornerDecorSize || 30, cw, ch);
    }
    // EXIF 底条
    drawExifBar(ctx, decor, cw, ch);
}

// ── 卡片样式(原版 renderCardStyle:独立管线,不画图层)──
function renderCardStyle(app) {
    const { image, template } = app;
    const img = image.el;
    const margin = template.baseMargin || {};
    const originW = img.naturalWidth, originH = img.naturalHeight;
    let canvasW = originW + (margin.marginLeft || 0) + (margin.marginRight || 0);
    let canvasH = originH + (margin.marginTop || 0) + (margin.marginBottom || 0);

    const ratio = template.canvasRatio;
    if (ratio && ratio !== 'original') {
        const wh = parseRatio(ratio);
        if (wh) {
            const targetRatio = wh[0] / wh[1];
            const currentRatio = canvasW / canvasH;
            if (currentRatio > targetRatio) canvasH = canvasW / targetRatio;
            else canvasW = canvasH * targetRatio;
        }
    }

    const ctx = setupCanvas(app, canvasW, canvasH);

    // 1. 模糊背景(cover 铺满)
    drawBlurredBackground(ctx, img, canvasW, canvasH, margin);
    const whiteOv = margin.bgBlurWhiteOverlay || 0;
    if (whiteOv > 0) {
        const ovA = whiteOv === 1 ? 0.15 : clamp(whiteOv / 100, 0, 1);
        ctx.fillStyle = `rgba(255,255,255,${ovA})`;
        ctx.fillRect(0, 0, canvasW, canvasH);
    }

    // 2. 径向暗角(原版固定 0.25)
    const cx = canvasW / 2, cy = canvasH / 2;
    const radius = Math.sqrt(cx * cx + cy * cy);
    const vig = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    vig.addColorStop(0, 'rgba(255,255,255,0.0)');
    vig.addColorStop(0.5, 'rgba(0,0,0,0.0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, canvasW, canvasH);

    // 3. 内容??
    const cardX = margin.marginLeft || 0;
    const cardY = margin.marginTop || 0;
    const cardW0 = canvasW - (margin.marginLeft || 0) - (margin.marginRight || 0);
    let cardH = canvasH - (margin.marginTop || 0) - (margin.marginBottom || 0);
    const textAreaH = Math.max(20, canvasH * 0.011);
    cardH -= textAreaH;

    // 4. 圆角照片 + 柔和阴影
    const corner = template.cornerConfig || {};
    const cr = clamp(corner.cornerRadiusAll || 0, 0, cardW0 / 2);
    const prTL = (corner.cornerRadiusTL || 0) > 0 ? Math.min(corner.cornerRadiusTL, cardW0 / 2) : cr;
    const prTR = (corner.cornerRadiusTR || 0) > 0 ? Math.min(corner.cornerRadiusTR, cardW0 / 2) : cr;
    const prBL = (corner.cornerRadiusBL || 0) > 0 ? Math.min(corner.cornerRadiusBL, cardH / 2) : cr;
    const prBR = (corner.cornerRadiusBR || 0) > 0 ? Math.min(corner.cornerRadiusBR, cardH / 2) : cr;

    const imgScale = Math.min(cardW0 / originW, cardH / originH);
    const drawW = originW * imgScale;
    const drawH = originH * imgScale;
    const drawX = cardX + (cardW0 - drawW) / 2;
    const drawY = cardY + (cardH - drawH) / 2;

    // 阴影参数:优先图层启用的阴??否则默认柔和阴影
    let cardShadow = null;
    for (const layer of (template.layerList || [])) {
        const sg = layer.shadowGlowConfig;
        if (sg && sg.shadowEnable === 1) { cardShadow = sg; break; }
    }
    let blur, offX, offY, sc;
    if (cardShadow) {
        blur = cardShadow.shadowBlur || 0;
        offX = cardShadow.shadowOffsetX || 0;
        offY = cardShadow.shadowOffsetY || 0;
        sc = parseColor(cardShadow.shadowColorHex, cardShadow.shadowOpacity);
    } else {
        blur = Math.max(8, canvasW * 0.006);
        offX = 0;
        offY = Math.max(2, canvasH * 0.002);
        sc = { r: 0, g: 0, b: 0, a: 0.30 };
    }

    // Step 1: 圆角路径填充 + DropShadow 柔和投影
    ctx.save();
    ctx.shadowColor = rgba(sc);
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = offX;
    ctx.shadowOffsetY = offY;
    ctx.fillStyle = '#ffffff';
    buildRoundedPath(ctx, drawX, drawY, drawW, drawH, prTL, prTR, prBL, prBR);
    ctx.fill();
    ctx.restore();

    // Step 2: 清晰照片(圆角裁剪)
    ctx.save();
    buildRoundedPath(ctx, drawX, drawY, drawW, drawH, prTL, prTR, prBL, prBR);
    ctx.clip();
    ctx.drawImage(img, drawX, drawY, drawW, drawH);
    ctx.restore();

    // 8. 全局光影
    applyGlobalLight(ctx, template.lightEffect, canvasW, canvasH);

    ctx.restore();

    // 元素叠层(基准画布像素坐标)
    const cw = app.dom.canvas.width, ch = app.dom.canvas.height;
    drawDecoration(ctx, template.decorConfig || {}, cw, ch, image);
    drawDraftText(ctx, template, cw, ch);
    drawLogoElements(ctx, template.logoElements || [], cw, ch);

    app.applyZoomStyle();
}

// 模糊背景:用户背景图优??否则照片本身模糊 cover 铺满(原版 drawBlurredBackground)
// 绘制区四周外??3 倍模糊半??避免模糊核采样到图像边缘造成角部半透明
function drawBlurredBackground(ctx, img, cw, ch, margin) {
    const imgW = img.naturalWidth, imgH = img.naturalHeight;
    const blurRadius = Math.max(1, margin.bgBlurRadius || 0);
    const pad = Math.ceil(blurRadius * 3);
    const scale = Math.max((cw + pad * 2) / imgW, (ch + pad * 2) / imgH);
    const sx = ((cw + pad * 2) - imgW * scale) / 2 - pad;
    const sy = ((ch + pad * 2) - imgH * scale) / 2 - pad;
    ctx.save();
    ctx.filter = `blur(${blurRadius}px)`;
    ctx.drawImage(img, sx, sy, imgW * scale, imgH * scale);
    ctx.restore();
}

// Logo 元素绘制(透明 PNG 叠在最上层;坐标为基准画布像??拖拽/命中检测一??
function drawLogoElements(ctx, elements, cw, ch) {
    if (!elements || !elements.length) return;
    const sorted = elements.slice().sort((a, b) => (a.z || 0) - (b.z || 0));
    for (const el of sorted) {
        if (!el || !el.dataUrl) continue;
        const img = getElementBitmap(el.dataUrl);
        if (!img || !img.complete || !img.naturalWidth) continue;
        const size = Math.max(2, el.size || 60);
        let cx, cy;
        if (typeof el.x === 'number' && typeof el.y === 'number') {
            cx = el.x; cy = el.y;
        } else {
            // 传统锚点对齐(相对画布)
            const hAlign = el.x || 'right', vAlign = el.y || 'bottom';
            const ox = el.offsetX || 20, oy = el.offsetY || 20;
            cx = hAlign === 'left' ? ox + size / 2 : hAlign === 'center' ? cw / 2 : cw - ox - size / 2;
            cy = vAlign === 'top' ? oy + size / 2 : vAlign === 'center' ? ch / 2 : ch - oy - size / 2;
        }
        ctx.save();
        ctx.globalAlpha = clamp((el.opacity == null ? 100 : el.opacity) / 100, 0, 1);
        ctx.translate(cx, cy);
        if (el.rotation) ctx.rotate(el.rotation * Math.PI / 180);
        ctx.drawImage(img, -size / 2, -size / 2, size, size);
        ctx.restore();
    }
}

// 用户叠层元素:自由文字 + 贴纸 + Logo(用于相框风格??避免与样式内绘制重复)
function drawUserElements(ctx, template, cw, ch) {
    if (!template) return;
    const decor = template.decorConfig || {};
    for (const textLine of (decor.textLines || [])) {
        if (textLine.text && textLine.align === 'free') drawTextLine(ctx, textLine, cw, ch, false, 0, 0);
    }
    for (const sticker of (decor.stickers || [])) {
        if (!sticker.src) continue;
        const tex = getElementBitmap(sticker.src);
        if (!tex || !tex.complete || !tex.naturalWidth) continue;
        const sw = tex.naturalWidth * (sticker.scale || 1);
        const sh = tex.naturalHeight * (sticker.scale || 1);
        ctx.save();
        ctx.translate(sticker.x || 0, sticker.y || 0);
        if (sticker.rotation) ctx.rotate(sticker.rotation * Math.PI / 180);
        ctx.globalAlpha = clamp((sticker.opacity == null ? 100 : sticker.opacity) / 100, 0, 1);
        ctx.drawImage(tex, -sw / 2, -sh / 2, sw, sh);
        ctx.restore();
    }
    drawDraftText(ctx, template, cw, ch);
    drawLogoElements(ctx, template.logoElements || [], cw, ch);
}

function renderPlaceholder(app) {
    const canvas = app.dom.canvas;
    canvas.width = 400; canvas.height = 300;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = '#cccccc';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('该预设样式(MVP 尚未支持)', 200, 150);
    app.applyZoomStyle();
}

// ── 拼图渲染(拼图页签,独立管线;长边 4000 导出??app.displayMax)──
function puzzleSlotCountOf(layout) {
    const n = { single: 1, as2: 2, h2: 2, v2: 2, h3: 3, v3: 3, as4: 4, grid4: 4, h4: 4, v4: 4, grid6: 6, grid9: 9 };
    return n[layout] || 1;
}

function puzzleLayoutSize(layout, S, gap) {
    switch (layout) {
        case 'h2': return [2 * S + gap, S];
        case 'v2': return [S, 2 * S + gap];
        case 'as2': return [Math.round(S * 1.5) + gap, S];
        case 'h3': return [3 * S + 2 * gap, S];
        case 'v3': return [S, 3 * S + 2 * gap];
        case 'grid4': return [2 * S + gap, 2 * S + gap];
        case 'as4': return [Math.round(S * 1.6) + gap, S];
        case 'h4': return [4 * S + 3 * gap, S];
        case 'v4': return [S, 4 * S + 3 * gap];
        case 'grid6': return [3 * S + 2 * gap, 2 * S + gap];
        case 'grid9': return [3 * S + 2 * gap, 3 * S + 2 * gap];
        default: return [S, S];
    }
}

function puzzleRects(layout, W, H, g) {
    const g2 = g / 2, rows = (hx) => { const a = []; for (let i = 0; i < hx; i++) a.push(i); return a; };
    switch (layout) {
        case 'h2': return [[0, 0, (W - g) / 2, H], [(W - g) / 2 + g, 0, (W - g) / 2, H]];
        case 'v2': return [[0, 0, W, (H - g) / 2], [0, (H - g) / 2 + g, W, (H - g) / 2]];
        case 'as2': {
            const w1 = Math.round(W * 2 / 3 - g2), w2 = W - w1 - g;
            return [[0, 0, w1, H], [w1 + g, 0, w2, H]];
        }
        case 'h3': {
            const cw = (W - 2 * g) / 3; const a = [];
            for (const i of rows(3)) a.push([i * (cw + g), 0, cw, H]);
            return a;
        }
        case 'v3': {
            const chh = (H - 2 * g) / 3; const a = [];
            for (const i of rows(3)) a.push([0, i * (chh + g), W, chh]);
            return a;
        }
        case 'grid4': {
            const cw = (W - g) / 2, chh = (H - g) / 2; const a = [];
            for (const rr of rows(2)) for (const c of rows(2)) a.push([c * (cw + g), rr * (chh + g), cw, chh]);
            return a;
        }
        case 'as4': {
            const w1 = Math.round(W * 3 / 5 - g2), w2 = W - w1 - g, chh = (H - 2 * g) / 3;
            const a = [[0, 0, w1, H]];
            for (const i of rows(3)) a.push([w1 + g, i * (chh + g), w2, chh]);
            return a;
        }
        case 'h4': {
            const cw = (W - 3 * g) / 4; const a = [];
            for (const i of rows(4)) a.push([i * (cw + g), 0, cw, H]);
            return a;
        }
        case 'v4': {
            const chh = (H - 3 * g) / 4; const a = [];
            for (const i of rows(4)) a.push([0, i * (chh + g), W, chh]);
            return a;
        }
        case 'grid6': {
            const cw = (W - 2 * g) / 3, chh = (H - g) / 2; const a = [];
            for (const rr of rows(2)) for (const c of rows(3)) a.push([c * (cw + g), rr * (chh + g), cw, chh]);
            return a;
        }
        case 'grid9': {
            const cw = (W - 2 * g) / 3, chh = (H - 2 * g) / 3; const a = [];
            for (const rr of rows(3)) for (const c of rows(3)) a.push([c * (cw + g), rr * (chh + g), cw, chh]);
            return a;
        }
        default: return [[0, 0, W, H]];
    }
}

// 槽内图片适配:cover/contain + 槽位缩放/偏移
function puzzleFit(r, iw, ih, mode, zoomPct, offX, offY) {
    const z = (zoomPct == null ? 100 : zoomPct) / 100;
    const s = mode === 'contain' ? Math.min(r.w / iw, r.h / ih) : Math.max(r.w / iw, r.h / ih);
    const dw = iw * s * z, dh = ih * s * z;
    const dx = r.x + (r.w - dw) / 2 + (offX || 0) / 100 * (r.w - dw);
    const dy = r.y + (r.h - dh) / 2 + (offY || 0) / 100 * (r.h - dh);
    return { dx, dy, dw, dh };
}

// 槽位下方电影字幕??
function drawPuzzleCaption(ctx, cap, r) {
    if (!cap || (!cap.line1 && !cap.line2)) return;
    const size1 = Math.max(6, cap.size1 || 28), size2 = Math.max(6, cap.size2 || 20);
    const c = parseColor(cap.color || 'ffffff', 100);
    const lead1 = Math.round(size1 * 1.15);
    const spacing = ((cap.spacing == null ? 60 : cap.spacing) / 100) * size1;
    const barH = lead1 + Math.max(size1, size2) * 0.35 + spacing + size2;
    const barY = Math.max(r.y, r.y + r.h - barH);
    if (cap.bgBar === 1) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(r.x, barY, r.w, Math.min(barH, r.h));
    }
    ctx.fillStyle = rgba(c);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if (cap.line1) {
        ctx.font = `${size1}px "${cap.font1 || 'Microsoft YaHei'}"`;
        ctx.fillText(cap.line1, r.x + r.w / 2, barY + lead1);
    }
    if (cap.line2) {
        ctx.font = `${size2}px "${cap.font2 || 'Microsoft YaHei'}"`;
        ctx.fillText(cap.line2, r.x + r.w / 2, Math.min(r.y + r.h - 4, barY + lead1 + spacing + size2));
    }
}

function renderPuzzle(app, compare) {
    const pk = (app.template && app.template.puzzle) || {};
    const layout = pk.layout || 'single';
    const n = puzzleSlotCountOf(layout);
    const srcs = (app.images && app.images.length) ? app.images : (app.image ? [app.image] : []);
    const used = srcs.slice(0, n);
    const gap = Math.max(0, Math.round(((pk.gap == null ? 6 : pk.gap) / 100) * 1000));
    const S = 1000;
    let W = 1000, H = 1000;
    const sz = puzzleLayoutSize(layout, S, gap);
    W = sz[0]; H = sz[1];
    if (pk.canvasRatio && pk.canvasRatio !== 'auto') {
        const wh = parseRatio(pk.canvasRatio);
        if (wh) {
            const R = wh[0] / wh[1];
            if (W / H !== R) H = Math.max(20, Math.round(W / R));
        }
    }
    const ctx = setupCanvas(app, W, H);

    // 背景:0 白色 / 1 模糊照片??
    if (pk.bgMode === 1 && used[0]) {
        drawBlurredBackground(ctx, used[0].el, W, H, { bgBlurRadius: 24 });
    } else {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
    }

    // 分隔??边框??
    const border = parseColor(pk.borderColor || 'ffffff', 100);
    const b = Math.max(1, Math.round(W * 0.0015));
    const rects = puzzleRects(layout, W, H, gap);
    ctx.fillStyle = rgba(border);
    for (const r of rects) ctx.fillRect(Math.round(r[0] - b), Math.round(r[1] - b), Math.round(r[2] + b * 2), Math.round(r[3] + b * 2));

    rects.forEach((r, i) => {
        const im = used[i];
        const rx = r[0], ry = r[1], rw = r[2], rh = r[3];
        if (!im || !im.el) {
            ctx.fillStyle = 'rgba(224,224,224,1)';
            ctx.fillRect(rx, ry, rw, rh);
            return;
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(rx, ry, rw, rh);
        ctx.clip();
        const fit = puzzleFit({ x: rx, y: ry, w: rw, h: rh }, im.el.naturalWidth, im.el.naturalHeight, pk.slotFill || 'cover', pk.zoom != null ? pk.zoom : 100, pk.offsetX || 0, pk.offsetY || 0);
        ctx.drawImage(im.el, fit.dx, fit.dy, fit.dw, fit.dh);
        ctx.restore();
        const cap = pk.captions && pk.captions[i];
        if (cap && (cap.line1 || cap.line2)) drawPuzzleCaption(ctx, cap, { x: rx, y: ry, w: rw, h: rh });
    });

    ctx.restore();
    app.applyZoomStyle();
}

window.__renderPuzzle = renderPuzzle;
window.__render = renderToCanvas;
