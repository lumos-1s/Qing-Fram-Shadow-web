// 相框样式引擎(原版 BorderProcessor.java 移植,阶段一)
// 严格对齐原版:BorderProcessor.apply() 的 size 折算(size*2 → min边/1000 缩放)、cornerRadius 后处理
// (ROUNDED 用四角、其余统一圆角且 BLUR_CLASSIC/BLUR_DATE 不裁角)、try/catch 失败回退原图、
// addGradient 用 extractDominantColors(直方图 16bin + 平均亮度 35~225 + bin 距离≥30)。
// 阶段一 = 无相机/无 Logo 美术依赖的纯几何风格;文本类/Logo 类风格后续分批,未实现时渲染中性底+风格名。

(function () {
    'use strict';

    const DISPLAY_MAX = 1800;
    const NOW = new Date();

    function pad0(n) { return n < 10 ? '0' + n : '' + n; }
    function dateYMD() { return NOW.getFullYear() + '.' + pad0(NOW.getMonth() + 1) + '.' + pad0(NOW.getDate()); }

    // ── 工具 ──
    function newCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = Number.isFinite(w) ? Math.max(1, Math.round(w)) : 1;
        c.height = Number.isFinite(h) ? Math.max(1, Math.round(h)) : 1;
        return c;
    }

    // 原版 apply(): scaled = max(5, size*2.0); ref=min(w,h); scaled = max(5, scaled*ref/1000)
    function scaledSize(img, size) {
        let scaled = Math.max(5, Math.floor(size * 2.0));
        const ref = Math.min(img.naturalWidth, img.naturalHeight);
        scaled = Math.max(5, Math.floor(scaled * ref / 1000.0));
        return scaled;
    }

    function color(hex, a) {
        try {
            hex = String(hex || '#000000').replace('#', '');
            if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
            const n = parseInt(hex, 16);
            return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
        } catch (e) { return { r: 0, g: 0, b: 0, a }; }
    }
    function rgbaC(c) { return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + (c.a == null ? 1 : c.a) + ')'; }
    function rgbJ(r, g, b) { return 'rgb(' + r + ',' + g + ',' + b + ')'; }

    // 文本度量(近似 Java FontMetrics:ascent≈0.78em,descent≈0.22em)
    function measureText(ctx, text, px, mono) {
        ctx.save();
ctx.font = px + 'px ' + (mono ? 'monospace' : 'sans-serif');
        const w = ctx.measureText(text).width;
        ctx.restore();
        return { w, ascent: Math.round(px * 0.78), descent: Math.round(px * 0.22), height: Math.round(px) };
    }
    function drawText(ctx, text, x, y, px, fill, mono, bold) {
        ctx.save();
        if (bold) ctx.font = 'bold ' + px + 'px ' + (mono ? 'monospace' : 'sans-serif');
        else ctx.font = px + 'px ' + (mono ? 'monospace' : 'sans-serif');
        ctx.fillStyle = fill;
        ctx.fillText(text, x, y);
        ctx.restore();
    }

    // ── 图像主色(原版 extractDominantColors,16bin)──
    function smallImage(img, maxEdge) {
        const iw = Math.max(1, img.naturalWidth || 1);
        const ih = Math.max(1, img.naturalHeight || 1);
        const sw = Math.min(maxEdge, iw);
        const sh = Math.max(1, Math.round(sw * ih / iw));
        const c = newCanvas(sw, sh);
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.drawImage(img, 0, 0, sw, sh);
        return { c, g, sw, sh };
    }
    function extractDominant(img) {
        const key = imgKey(img) + ':dom';
        if (_domCache[key]) return _domCache[key];
        const { g, sw, sh } = smallImageCached(img, 64);
        const { data } = g.getImageData(0, 0, sw, sh);
        const bins = 16;
        const hist = {};
        for (let i = 0; i < sw * sh; i++) {
            const r = data[i * 4], gv = data[i * 4 + 1], b = data[i * 4 + 2];
            const ri = Math.floor(r * bins / 256);
            const gi = Math.floor(gv * bins / 256);
            const bi = Math.floor(b * bins / 256);
            const key = ri + ',' + gi + ',' + bi;
            hist[key] = (hist[key] || 0) + 1;
        }
        const list = [];
        for (const k in hist) {
            const p = k.split(',').map(Number);
            const avg = (p[0] * 256 / bins + p[1] * 256 / bins + p[2] * 256 / bins) / 3;
            if (avg < 35 || avg > 225) continue;
            list.push({ ri: p[0], gi: p[1], bi: p[2], count: hist[k] });
        }
        list.sort((a, b) => b.count - a.count);
        const toColor = b => ({ r: Math.min(255, b.ri * 256 / bins + 8), g: Math.min(255, b.gi * 256 / bins + 8), b: Math.min(255, b.bi * 256 / bins + 8) });
        if (!list.length) { const fb = [{ r: 100, g: 180, b: 255 }, { r: 255, g: 180, b: 100 }]; _domCache[key] = fb; return fb; }
        const f = list[0];
        let s = null;
        for (let i = 1; i < list.length; i++) {
            const d = Math.sqrt(Math.pow(list[i].ri - f.ri, 2) + Math.pow(list[i].gi - f.gi, 2) + Math.pow(list[i].bi - f.bi, 2));
            if (d >= 30) { s = list[i]; break; }
        }
        if (!s) s = f;
        const res = [toColor(f), toColor(s)];
        _domCache[key] = res;
        return res;
    }

    // ── 模糊(原版 fastBlur:降采样 → 高斯核卷积 → 双线性放大)──
    // 与 Java fastBlur 同算法:ks 高斯核(sigma=ks/4)、EDGE_NO_OP、二值线性插值放大。
    function fastBlurCanvas(src, radius) {
        const radiusN = Math.max(1, radius);
        const w = src.width, h = src.height;
        const scale = Math.max(1, Math.floor(radiusN / 6));
        const sw = Math.max(1, Math.floor(w / scale)), sh = Math.max(1, Math.floor(h / scale));
        if (sw === w && sh === h) { return src; }
        const small = newCanvas(sw, sh);
        const sg = small.getContext('2d');
        sg.imageSmoothingEnabled = true;
        sg.drawImage(src, 0, 0, sw, sh);
        let kSize = Math.max(3, Math.floor(radiusN / scale));
        if (kSize % 2 === 0) kSize++;
        const blurred = gaussianFilter(small, kSize);
        const out = newCanvas(w, h);
        const og = out.getContext('2d');
        og.imageSmoothingEnabled = true;
        og.drawImage(blurred, 0, 0, w, h);
        return out;
    }
    // Java fastBlur 的高斯核卷积(EDGE_NO_OP):sigma=ks/4,kernel 归一化
    // 优化:二维核(k×k)拆成可分离两遍(横 k + 竖 k),1D 核按 ks 缓存,结果与二维版一致
    const _gaussKernel = {};
    function gauss1DKernel(ks) {
        let k = _gaussKernel[ks];
        if (k) return k;
        const hl = Math.floor(ks / 2);
        const sigma = ks / 4;
        const raw = [];
        let sum = 0;
        for (let i = 0; i < ks; i++) {
            const v = Math.exp(-(Math.pow(i - hl, 2)) / (2 * sigma * sigma));
            raw.push(v); sum += v;
        }
        const kk = new Float64Array(ks);
        for (let i = 0; i < ks; i++) kk[i] = raw[i] / sum;
        k = { kk, hl };
        _gaussKernel[ks] = k;
        return k;
    }
    function gaussianFilter(srcCanvas, ks) {
        const iw = srcCanvas.width, ih = srcCanvas.height;
        const ctx = srcCanvas.getContext('2d');
        const src = ctx.getImageData(0, 0, iw, ih);
        const d = src.data;
        const { kk, hl } = gauss1DKernel(ks);
        // 横过一遍:左右边缘列保持原值(EDGE_NO_OP)
        const tmp = new Uint8ClampedArray(d.length);
        for (let y = 0; y < ih; y++) {
            const yb = y * iw;
            for (let x = 0; x < iw; x++) {
                const oi = (yb + x) * 4;
                if (x < hl || x >= iw - hl) {
                    tmp[oi] = d[oi]; tmp[oi + 1] = d[oi + 1]; tmp[oi + 2] = d[oi + 2]; tmp[oi + 3] = d[oi + 3];
                    continue;
                }
                let r = 0, g = 0, b = 0, a = 0;
                for (let kx = 0; kx < ks; kx++) {
                    const si = (yb + x - hl + kx) * 4;
                    const kv = kk[kx];
                    // Java 的 alpha 分量也参与卷积;RGB 按预乘权重叠加
                    a += d[si + 3] * kv;
                    r += d[si] * kv; g += d[si + 1] * kv; b += d[si + 2] * kv;
                }
                tmp[oi] = r; tmp[oi + 1] = g; tmp[oi + 2] = b; tmp[oi + 3] = a;
            }
        }
        // 竖过一遍:上下边缘行/左右边缘列均保持原值 → 边界环与二维版一致
        const out = new Uint8ClampedArray(d.length);
        for (let y = 0; y < ih; y++) {
            const yb = y * iw;
            for (let x = 0; x < iw; x++) {
                const oi = (yb + x) * 4;
                if (y < hl || y >= ih - hl || x < hl || x >= iw - hl) {
                    out[oi] = d[oi]; out[oi + 1] = d[oi + 1]; out[oi + 2] = d[oi + 2]; out[oi + 3] = d[oi + 3];
                    continue;
                }
                let r = 0, g = 0, b = 0, a = 0;
                for (let ky = 0; ky < ks; ky++) {
                    const si = ((y - hl + ky) * iw + x) * 4;
                    const kv = kk[ky];
                    a += tmp[si + 3] * kv;
                    r += tmp[si] * kv; g += tmp[si + 1] * kv; b += tmp[si + 2] * kv;
                }
                out[oi] = r; out[oi + 1] = g; out[oi + 2] = b; out[oi + 3] = a;
            }
        }
        src.data.set(out);
        ctx.putImageData(src, 0, 0);
        return srcCanvas;
    }

    // ── 渲染缓存(对齐 Java ConvolveOp/取色缓存):照片不变时模糊底与取色结果不重算 ──
    const _blurCache = [];
    const BLUR_CACHE_MAX = 2;
    const _smallCache = {};
    const _edgeCache = {};
    const _bottomCache = {};
    const _domCache = {};
    const _multiCache = {};
    const imgKey = img => (img && img.src ? img.src : '') + '@' + img.naturalWidth + 'x' + img.naturalHeight;
    function getBlurBacking(key) {
        for (let i = 0; i < _blurCache.length; i++) {
            if (_blurCache[i].key === key) { _blurCache[i].last = Date.now(); return _blurCache[i].canvas; }
        }
        return null;
    }
    function putBlurBacking(key, canvas) {
        _blurCache.push({ key, canvas, last: Date.now() });
        if (_blurCache.length > BLUR_CACHE_MAX) {
            _blurCache.sort((a, b) => a.last - b.last);
            _blurCache.shift();
        }
    }
    function smallImageCached(img, maxEdge) {
        const key = imgKey(img) + ':' + maxEdge;
        let e = _smallCache[key];
        if (!e) { e = smallImage(img, maxEdge); _smallCache[key] = e; }
        return e;
    }
    function clearStyleCaches() {
        _blurCache.length = 0;
        for (const k in _smallCache) delete _smallCache[k];
        for (const k in _edgeCache) delete _edgeCache[k];
        for (const k in _bottomCache) delete _bottomCache[k];
        for (const k in _domCache) delete _domCache[k];
        for (const k in _multiCache) delete _multiCache[k];
        for (const k in _gaussKernel) delete _gaussKernel[k];
    }

    // ── 圆角后处理(原版 applyCornerRadius 单个/四角)──
    function roundRectPath(g, x, y, w, h, r) {
        x = x || 0; y = y || 0;
        g.beginPath();
        if (g.roundRect) { g.roundRect(x, y, w, h, r, r); return; }
        g.moveTo(x + r, y); g.lineTo(x + w - r, y);
        g.arcTo(x + w, y, x + w, y + r, r); g.lineTo(x + w, y + h - r);
        g.arcTo(x + w, y + h, x + w - r, y + h, r); g.lineTo(x + r, y + h);
        g.arcTo(x, y + h, x, y + h - r, r); g.lineTo(x, y + r);
        g.arcTo(x, y, x + r, y, r); g.closePath();
    }
    function cornerClip(src, tl, tr, bl, br) {
        const w = src.width, h = src.height;
        const out = newCanvas(w, h);
        const g = out.getContext('2d');
        const p = new Path2D();
        p.moveTo(tl, 0);
        p.lineTo(w - tr, 0);
        if (tr > 0) p.quadraticCurveTo(w, 0, w, tr); else p.lineTo(w, 0);
        p.lineTo(w, h - br);
        if (br > 0) p.quadraticCurveTo(w, h, w - br, h); else p.lineTo(w, h);
        p.lineTo(bl, h);
        if (bl > 0) p.quadraticCurveTo(0, h, 0, h - bl); else p.lineTo(0, h);
        p.lineTo(0, tl);
        if (tl > 0) p.quadraticCurveTo(0, 0, tl, 0); else p.lineTo(0, 0);
        p.closePath();
        g.clip(p);
        g.drawImage(src, 0, 0);
        return out;
    }
    function singleCornerClip(src, radius) {
        const w = src.width, h = src.height;
        const r = Math.min(radius, Math.floor(Math.min(w, h) / 2));
        if (r <= 0) return src;
        const out = newCanvas(w, h);
        const g = out.getContext('2d');
        roundRectPath(g, 0, 0, w, h, r);
        g.clip();
        g.drawImage(src, 0, 0);
        return out;
    }

    // ── 阶段一核心风格(纯几何/颜色,无相机无 Logo)──
    function styleSimple(img, size, g, iw, ih) {
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, iw + size * 2, ih + size * 2);
        g.drawImage(img, size, size);
    }
    function styleWhitePlain(img, size, g, iw, ih) {
        g.fillStyle = '#cccccc';
        g.fillRect(0, 0, iw + size * 2, ih + size * 2);
        g.drawImage(img, size, size);
        g.strokeStyle = '#dddddd';
        g.lineWidth = 1;
        g.strokeRect(size - 1, size - 1, iw + 2, ih + 2);
    }
    function styleRounded(img, size, g, iw, ih) {
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, iw + size * 2, ih + size * 2);
        g.drawImage(img, size, size);
    }
    function styleFilmStrip(img, size, g, iw, ih) {
        const railH = Math.max(20, size), sprocket = Math.max(6, Math.floor(railH / 4)), gap = sprocket * 2;
        const w = iw + size * 2, h = ih + railH * 2;
        g.fillStyle = '#000000';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#ffffff';
        for (let x = size + Math.floor(gap / 2); x < w - size; x += sprocket + gap) {
            g.fillRect(x, Math.floor(railH / 2 - sprocket / 2), sprocket, sprocket);
            g.fillRect(x, Math.floor(h - railH / 2 - sprocket / 2), sprocket, sprocket);
        }
        g.drawImage(img, size, railH);
    }
    function stylePolaroid(img, size, g, iw, ih, S) {
        const fs = Math.max(10, Math.round(autoExifSize(S.paramFs, iw)));
        const bottom = Math.max(size * 3, Math.round(fs * 2.6));
        const w = iw + size * 2, h = ih + size + bottom;
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
        const date = dateYMD();
        const m = measureText(g, date, fs, true);
        const tx = Math.floor((w - m.w) / 2);
        const ty = ih + size + Math.floor((bottom - m.height) / 2) + m.ascent;
        drawText(g, date, tx, ty, fs, 'rgb(160,160,160)', true);
    }
    function styleDoubleLine(img, size, g, iw, ih) {
        const outer = size, gap = Math.max(4, Math.floor(size / 3)), inner = size - gap;
        const w = iw + outer * 2, h = ih + outer * 2;
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, outer, outer);
        g.strokeStyle = rgbJ(60, 60, 60);
        g.lineWidth = Math.max(1, Math.floor(gap / 2));
        const l = outer - inner;
        g.strokeRect(l, l, w - l * 2 - 1, h - l * 2 - 1);
        g.strokeStyle = rgbJ(40, 40, 40);
        g.lineWidth = Math.max(2, Math.floor(outer / 5));
        g.strokeRect(Math.floor(gap / 2), Math.floor(gap / 2), w - gap - 1, h - gap - 1);
    }
    function styleVintage(img, size, g, iw, ih) {
        const w = iw + size * 2, h = ih + size * 2;
        g.fillStyle = rgbJ(210, 190, 165);
        g.fillRect(0, 0, w, h);
        g.strokeStyle = rgbJ(160, 140, 115);
        g.lineWidth = Math.max(2, Math.floor(size / 8));
        g.strokeRect(size - 2, size - 2, iw + 3, ih + 3);
        g.drawImage(img, size, size);
    }
    function styleGradient(img, size, g, iw, ih) {
        const w = iw + size * 2, h = ih + size * 2;
        const cols = extractDominant(img);
        const grad = g.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, rgbaC(cols[0]));
        grad.addColorStop(1, rgbaC(cols[1]));
        g.fillStyle = grad;
        g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
    }
    function fillRoundRectCtx(g, x, y, w, h, r) {
        g.beginPath();
        if (g.roundRect) { g.roundRect(x, y, w, h, r, r); g.fill(); return; }
        g.moveTo(x + r, y);
        g.lineTo(x + w - r, y);
        g.arcTo(x + w, y, x + w, y + r, r);
        g.lineTo(x + w, y + h - r);
        g.arcTo(x + w, y + h, x + w - r, y + h, r);
        g.lineTo(x + r, y + h);
        g.arcTo(x, y + h, x, y + h - r, r);
        g.lineTo(x, y + r);
        g.arcTo(x, y, x + r, y, r);
        g.closePath();
        g.fill();
    }
    function styleDropShadow(img, size, g, iw, ih) {
        const offset = Math.max(8, Math.floor(size / 2)), softness = Math.max(8, Math.floor(size / 2)), margin = size;
        const w = iw + margin * 2 + offset, h = ih + margin * 2 + offset;
        const shadow = newCanvas(w, h);
        const sg = shadow.getContext('2d');
        sg.fillStyle = '#000000';
        const arc = Math.max(5, Math.floor(size / 4));
        fillRoundRectCtx(sg, margin + offset, margin + offset, iw, ih, arc);
        const blurred = fastBlurCanvas(shadow, softness);
        g.drawImage(blurred, 0, 0);
        g.drawImage(img, margin, margin);
    }

    // ── 自研特色风格:仿古邮票 / 撕纸边 / 折角相纸 / 胶带挂片 ──
    // 确定性噪声:同照片同风格下渲染结果稳定(基于照片尺寸+盐的 Java LCG)
    function styleNoise(iw, ih, salt) { return javaRandom(iw * 7919 + ih * 104729 + salt); }

    function stampMatte(size) {
        const m = Math.max(72, Math.floor(size * 2.6));
        const padX = Math.max(44, Math.round(m * 0.55));
        const padY = Math.max(78, Math.round(m * 0.98));
        const d = Math.max(10, Math.round(m / 5));
        return { m, padX, padY, d };
    }
    // 邮票齿孔:沿四周外缘打半圆孔(destination-out,露出透明底)
    function stampPerforate(g, w, h, d) {
        const r = d / 2, pitch = Math.max(Math.ceil(d * 1.6), d + 2);
        g.save();
        g.globalCompositeOperation = 'destination-out';
        for (let x = r; x < w; x += pitch) {
            g.beginPath(); g.arc(x, 0, r, 0, 6.2832); g.fill();
            g.beginPath(); g.arc(x, h, r, 0, 6.2832); g.fill();
        }
        for (let y = r; y < h; y += pitch) {
            g.beginPath(); g.arc(0, y, r, 0, 6.2832); g.fill();
            g.beginPath(); g.arc(w, y, r, 0, 6.2832); g.fill();
        }
        g.restore();
    }
    function styleStampPostage(img, size, g, iw, ih, S) {
        const { padX, padY, d } = stampMatte(size);
        const w = iw + padX * 2, h = ih + padY * 2;
        g.fillStyle = '#f6f3ea';
        g.fillRect(0, 0, w, h);
        stampPerforate(g, w, h, d);
        g.drawImage(img, padX, padY, iw, ih);
        g.strokeStyle = 'rgba(120,110,88,0.5)';
        g.lineWidth = 1;
        g.strokeRect(padX - 0.5, padY - 0.5, iw + 1, ih + 1);
        const ink = 'rgba(66,58,120,0.62)';
        const fs = Math.max(11, Math.min(Math.round(autoExifSize(S.paramFs, iw)), Math.floor(padY / 3)));
        const fy = Math.floor(fs * 0.36);
        drawTrackedTextL(g, '中国邮政', w / 2, Math.floor(padY / 2) + fy, fs, ink, true, 0.55, null);
        const val = '¥ 0.80';
        drawTrackedTextL(g, val, w / 2, h - Math.floor(padY / 2) + fy, fs, ink, true, 0.55, null);
        // 邮戳(右上,盖在照片上)
        const rnd = styleNoise(iw, ih, 9301);
        const pr0 = Math.max(16, Math.floor(Math.min(iw, ih) * 0.16));
        g.save();
        g.translate(padX + Math.floor(iw * 0.76), padY + Math.floor(ih * 0.30));
        g.rotate(-0.14);
        g.strokeStyle = 'rgba(46,40,108,0.4)';
        g.lineWidth = 1.5;
        g.beginPath(); g.arc(0, 0, pr0, 0, 6.2832); g.stroke();
        g.beginPath(); g.arc(0, 0, pr0 * 0.55, 0, 6.2832); g.stroke();
        g.lineWidth = 1.1;
        for (let k = 0; k < 2; k++) {
            const yy = (k - 0.5) * pr0 * 0.68;
            g.beginPath();
            for (let x = -pr0; x <= pr0; x += pr0 / 8) g.lineTo(x, yy + (rnd(3) - 1) * 3);
            g.stroke();
        }
        g.restore();
    }

    // 撕纸边:照片轻微倾斜 + 白纸毛边镂空(角度/毛边均由尺寸+盐确定,稳定可复现)
    function tornPaperParams(iw, ih, size) {
        const rnd = styleNoise(iw, ih, 113);
        const deg = (rnd(500) - 250) / 250 * 2.4;
        const a = deg * 0.01745329252;
        const s = Math.sin(a), c = Math.cos(a);
        const bw = Math.ceil(iw * c + ih * Math.abs(s));
        const bh = Math.ceil(iw * Math.abs(s) + ih * c);
        const pad = Math.max(40, Math.floor(size * 1.4));
        return { a, bw, bh, pad, rnd };
    }
    function tornHolePath(rnd, iw, ih, amp) {
        const n = Math.max(3, Math.floor(Math.max(iw, ih) / 16));
        const p = new Path2D();
        const pts = [];
        const j = (v) => v + (rnd(3) - 1) * amp;
        const px0 = -iw / 2, py0 = -ih / 2;
        for (let i = 0; i <= n; i++) pts.push([j(px0 + iw * i / n), py0 + (rnd(3) - 1) * amp]);
        for (let i = 1; i <= n; i++) pts.push([iw / 2 + (rnd(3) - 1) * amp, j(py0 + ih * i / n)]);
        for (let i = 1; i <= n; i++) pts.push([j(iw / 2 - iw * i / n), ih / 2 + (rnd(3) - 1) * amp]);
        for (let i = 1; i <= n; i++) pts.push([-iw / 2 + (rnd(3) - 1) * amp, j(ih / 2 - ih * i / n)]);
        p.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
        p.closePath();
        return p;
    }
    function styleTornPaper(img, size, g, iw, ih) {
        const { a, bw, bh, pad, rnd } = tornPaperParams(iw, ih, size);
        const w = bw + pad * 2, h = bh + pad * 2;
        const cx = w / 2, cy = h / 2;
        const paper = '#fbfaf4';
        g.fillStyle = paper;
        g.fillRect(0, 0, w, h);
        g.save();
        g.translate(cx, cy);
        g.rotate(a);
        g.drawImage(img, -iw / 2, -ih / 2);
        g.restore();
        // 白纸覆盖(留毛边孔):先画纸,再按抖动照片轮廓挖空,边缘描淡影
        const ov = newCanvas(w, h);
        const og = ov.getContext('2d');
        og.fillStyle = paper;
        og.fillRect(0, 0, w, h);
        const amp = Math.max(3, Math.floor(Math.min(iw, ih) * 0.014));
        const hole = tornHolePath(rnd, iw, ih, amp);
        og.save();
        og.translate(cx, cy);
        og.rotate(a);
        og.globalCompositeOperation = 'destination-out';
        og.fillStyle = '#000';
        og.fill(hole);
        og.globalCompositeOperation = 'source-over';
        og.strokeStyle = 'rgba(0,0,0,0.07)';
        og.lineWidth = 2;
        og.stroke(hole);
        og.restore();
        g.drawImage(ov, 0, 0);
    }

    // 折角相纸:白卡纸四边留白,右上角撕折(缺角 + 翻起的纸角落在照片上)
    function styleFoldCorner(img, size, g, iw, ih) {
        const w = iw + size * 2, h = ih + size * 2;
        const px = size, py = size;
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, px, py);
        const fl = Math.max(36, Math.floor(Math.min(iw, ih) * 0.10));
        const P0 = [px + iw, py], P1 = [px + iw - fl, py], P2 = [px + iw, py + fl], R = [px + iw - fl, py + fl];
        // 先镂空被折掉的照片角(露出底色)
        g.save();
        g.globalCompositeOperation = 'destination-out';
        g.beginPath();
        g.moveTo(P0[0], P0[1]); g.lineTo(P1[0], P1[1]); g.lineTo(P2[0], P2[1]); g.closePath();
        g.fill();
        g.restore();
        // 折痕投影
        g.strokeStyle = 'rgba(0,0,0,0.12)';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(P1[0] + 1, P1[1] + 2); g.lineTo(P2[0] + 2, P2[1] - 1);
        g.stroke();
        // 翻起的纸角(纸背高光渐变面)
        const lg = g.createLinearGradient(P2[0], P2[1], P1[0], P1[1]);
        lg.addColorStop(0, 'rgb(245,242,233)');
        lg.addColorStop(1, 'rgb(226,222,210)');
        g.fillStyle = lg;
        g.beginPath();
        g.moveTo(P1[0], P1[1]); g.lineTo(R[0], R[1]); g.lineTo(P2[0], P2[1]); g.closePath();
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.16)';
        g.lineWidth = 1;
        g.stroke();
    }

    // 胶带挂片:牛皮纸底 + 和纸胶带(半透明)压住照片
    function drawTape(g, x, y, len, th, ang, color) {
        g.save();
        g.translate(x, y);
        g.rotate(ang);
        g.fillStyle = color;
        fillRoundRectCtx(g, -len / 2, -th / 2, len, th, th / 2);
        g.strokeStyle = 'rgba(255,255,255,0.5)';
        g.lineWidth = 1;
        const rr = th * 0.7;
        g.beginPath(); g.moveTo(-len / 2 + rr, -th / 2 + 1); g.quadraticCurveTo(-len / 2 + rr, 0, -len / 2 + rr, th / 2 - 1); g.stroke();
        g.beginPath(); g.moveTo(len / 2 - rr, -th / 2 + 1); g.quadraticCurveTo(len / 2 - rr, 0, len / 2 - rr, th / 2 - 1); g.stroke();
        g.restore();
    }
    function stylePinboardTape(img, size, g, iw, ih) {
        const w = iw + size * 2, h = ih + size * 2;
        g.fillStyle = '#f5f2ea';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
        const th = Math.max(14, Math.floor(size * 0.5));
        const len = Math.max(90, Math.floor(iw * 0.3));
        drawTape(g, size + Math.floor(len * 0.35), size - Math.floor(th * 0.3), len, th, -0.16, 'rgba(222,208,156,0.62)');
        drawTape(g, w - size - Math.floor(len * 0.35), size - Math.floor(th * 0.3), len, th, 0.16, 'rgba(156,178,208,0.55)');
        drawTape(g, w / 2, h - size + Math.floor(th * 0.3), Math.floor(len * 0.7), th, 0.04, 'rgba(190,168,190,0.5)');
    }
    // ── 四格创新边框:VHS录像带 / 老相册角贴 / 撕边电影票 / 水彩晕染 ──
    function styleVhsTape(img, size, g, iw, ih) {
        const sidePad = Math.max(8, Math.floor(size / 4));
        const barH = Math.max(28, Math.floor(size * 0.75));
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
    }
    function styleAlbumCorner(img, size, g, iw, ih) {
        const pad = Math.max(40, Math.floor(size * 1.2));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#3d3a35';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        const cs = Math.max(28, Math.floor(Math.min(iw, ih) * 0.07));
        const paper = '#d9c39a';
        const corners = [[pad, pad, 1, 1], [pad + iw, pad, -1, 1], [pad, pad + ih, 1, -1], [pad + iw, pad + ih, -1, -1]];
        for (const [cx, cy, sx, sy] of corners) {
            g.fillStyle = 'rgba(0,0,0,0.18)';
            g.beginPath();
            g.moveTo(cx + 2, cy + 2); g.lineTo(cx + sx * cs + 2, cy + 2); g.lineTo(cx + 2, cy + sy * cs + 2);
            g.closePath(); g.fill();
            g.fillStyle = paper;
            g.beginPath();
            g.moveTo(cx, cy); g.lineTo(cx + sx * cs, cy); g.lineTo(cx, cy + sy * cs);
            g.closePath(); g.fill();
            g.strokeStyle = 'rgba(90,70,40,0.35)'; g.lineWidth = 1; g.stroke();
        }
    }
    function styleMovieTicket(img, size, g, iw, ih) {
        const topBot = Math.max(30, Math.floor(size * 0.8));
        const sidePad = Math.max(20, Math.floor(size * 0.6));
        const stubW = Math.max(100, Math.floor(iw * 0.18));
        const w = iw + sidePad * 2 + stubW, h = ih + topBot * 2;
        g.fillStyle = '#f5f0e6';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, sidePad, topBot);
        const sx = sidePad + iw;
        const r = Math.max(6, Math.floor(size * 0.22));
        const pitch = Math.max(r * 2.2, r * 2 + 2);
        g.save();
        g.globalCompositeOperation = 'destination-out';
        for (let y = topBot + r; y < topBot + ih; y += pitch) { g.beginPath(); g.arc(sx, y, r, 0, 6.2832); g.fill(); }
        g.restore();
        const cx = sx + r + Math.floor((stubW - r) / 2);
        const fs = Math.max(11, Math.floor(size * 0.32));
        g.save();
        g.translate(cx, topBot + Math.floor(ih / 2));
        g.rotate(-Math.PI / 2);
        drawTextL(g, 'ADMIT ONE', -Math.floor(ih * 0.18), Math.floor(fs * 0.35), '#999', fs, false, true, 0);
        g.restore();
        drawTextL(g, 'ROW 12', sx + r + 10, topBot + Math.floor(ih * 0.30), '#555', fs, true, false, 0);
        drawTextL(g, 'SEAT 08', sx + r + 10, topBot + Math.floor(ih * 0.45), '#555', fs, true, false, 0);
        drawTextL(g, 'SCREEN 7', sx + r + 10, topBot + Math.floor(ih * 0.60), '#555', fs, true, false, 0);
    }
    function styleWatercolorBleed(img, size, g, iw, ih) {
        const bleed = Math.max(70, Math.floor(size * 1.8));
        const w = iw + bleed * 2, h = ih + bleed * 2;
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        const palettes = [
            ['rgba(70,130,200,0.70)', 'rgba(150,120,200,0.60)', 'rgba(200,130,160,0.60)'],
            ['rgba(90,170,130,0.70)', 'rgba(225,185,110,0.60)', 'rgba(175,155,200,0.60)'],
            ['rgba(210,135,120,0.70)', 'rgba(145,180,220,0.60)', 'rgba(175,205,155,0.60)']
        ];
        const rnd = styleNoise(iw, ih, 777);
        const pal = palettes[rnd(palettes.length)];
        const px0 = bleed, py0 = bleed;
        for (let i = 0; i < 20; i++) {
            const edge = rnd(4);
            let px, py;
            if (edge === 0) { px = px0 + rnd(iw); py = py0 - Math.floor(bleed * 0.05) + rnd(Math.floor(bleed * 0.5)); }
            else if (edge === 1) { px = px0 + rnd(iw); py = py0 + ih - Math.floor(bleed * 0.05) + rnd(Math.floor(bleed * 0.5)); }
            else if (edge === 2) { px = px0 - Math.floor(bleed * 0.05) + rnd(Math.floor(bleed * 0.5)); py = py0 + rnd(ih); }
            else { px = px0 + iw - Math.floor(bleed * 0.05) + rnd(Math.floor(bleed * 0.5)); py = py0 + rnd(ih); }
            const pr = Math.max(40, Math.floor(bleed * (0.8 + rnd(100) / 100)));
            const col = pal[rnd(pal.length)];
            const grad = g.createRadialGradient(px, py, 0, px, py, pr);
            grad.addColorStop(0, col); grad.addColorStop(0.7, col.replace(/0.45|0.55/, '0.15')); grad.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = grad;
            g.beginPath(); g.arc(px, py, pr, 0, 6.2832); g.fill();
        }
        g.drawImage(img, px0, py0);
    }


    // ── 阶段二基设:风格序号 / Java Random(原件 cameraFor 的 seed RNG)──
    const ORD = { NONE:0,SIMPLE:1,POLAROID:2,FILM_STRIP:3,ROUNDED:4,DOUBLE_LINE:5,VINTAGE:6,GRADIENT:7,DROP_SHADOW:8,
        BLUR_CLASSIC:9,BLUR_DATE:10,WM_CLASSIC:11,WM_SINGLE:12,WM_BRAND_LOGO:13,WM_AI:14,IMP_FROSTED:15,IMP_CLASSIC:16,FUJI_WM:48,FUJI_WM_BRAND:49,DARK_BRAND_ONLY:50,
        XIAOMI_IMP:17,CARD_LEICA:18,CARD_LOGO_PARAM:19,CARD_PURE_LOGO:20,CARD_SIMPLE:21,CARD_IMMERSION:22,
        OVERLAY_PARAM_LEFT:23,OVERLAY_PARAM_RIGHT:24,OVERLAY_PARAM_BOTTOM:25,OVERLAY_LOGO_BOTTOM:26,
        COLOR_CLASSIC:27,COLOR_REFINED:28,ART_CARD:29,WHITE_PLAIN:30,FUJI_WHITE:31,
        PARAM_TOP_LEFT:32,PARAM_BOTTOM_LEFT:33,PARAM_BOTTOM_SINGLE:34,SIMPLE_FILM:35,
        STAMP_POSTAGE:36,TEARED_PAPER:37,FOLD_CORNER:38,PINBOARD_TAPE:39, VHS_TAPE:40,ALBUM_CORNER:41,MOVIE_TICKET:42,WATERCOLOR_BLEED:43,CYBER_GLITCH:51,POLAROID_HAND:52,TORN_JOURNAL:53,CARD_3D:54,COMIC_PANEL:55,NEWSPAPER:56,SIGNATURE:57,SIGN_PARAM:58,AVATAR_MEMO:59,
SIGN_BLUR:60,
SIG_BLUR:61,
AV_BLUR:62,
AV_OVERLAY:63,
AV_OVERLAY_TR:64,
AV_OVERLAY_BR:65,
AV_OVERLAY_BC:66,
AV_OVERLAY_BC2:67 };
    const MASK48 = 0xffffffffffffn, MULT = 0x5deece66dn, INC = 0xbn;
    function javaRandom(seed64) {
        let s = (BigInt(seed64) ^ MULT) & MASK48;
        const next = bits => { s = (s * MULT + INC) & MASK48; return Number(s >> BigInt(48 - bits)); };
        return function nextInt(bound) {
            if (bound <= 0) return 0;
            if ((bound & -bound) === bound) return (bound * next(31)) >> 31;
            let bits, val;
            do { bits = next(31); val = bits % bound; } while (bits - val + (bound - 1) < 0);
            return val;
        };
    }

    // 网络 EXIF(± 字段)映射为相机规格;无数据走 Java 同 seed 随机
    function camHasData(exif) { return !!(exif && (exif.make || exif.model || exif.focal || exif.aperture || exif.iso || exif.shutter)); }
    // 品牌名规范化:把EXIF里的make字段映射成简洁品牌名
    function normalizeBrand(make, model) {
        const s = (make + ' ' + model).toLowerCase();
        if (!make && !model) return '';
        const map = [
            [/sony|sony corporation|sony corp/i, 'SONY'],
            [/canon|canon inc.|canon inc/i, 'Canon'],
            [/nikon|nikon corporation|nikon corp/i, 'Nikon'],
            [/fujifilm|fuji photo|fujinon|fuji/i, 'FUJIFILM'],
            [/leica|leica camera|leica geosystems/i, 'Leica'],
            [/panasonic|lumix|panasonic corp/i, 'Panasonic'],
            [/olympus|olympus imaging|om system|om digital/i, 'OM System'],
            [/pentax|ricoh|ricoh imaging|asahi pentax/i, 'PENTAX'],
            [/hasselblad/i, 'HASSELBLAD'],
            [/phase one|phaseone/i, 'Phase One'],
            [/samsung|samsung techwin/i, 'SAMSUNG'],
            [/xiaomi|xiaomi inc|redmi/i, 'Xiaomi'],
            [/huawei|huawei device/i, 'HUAWEI'],
            [/apple|iphone|apple inc./i, 'Apple'],
            [/google|pixel/i, 'Google'],
            [/oneplus|one+/i, 'OnePlus'],
            [/oppo|bbk electronic/i, 'OPPO'],
            [/vivo|vivoelectronics/i, 'vivo'],
            [/dji|shenzhen dj/i, 'DJI'],
            [/gopro/i, 'GoPro'],
            [/zeiss|carl zeiss/i, 'ZEISS'],
            [/contax|kyocera/i, 'CONTAX'],
            [/konica|minolta|konica minolta/i, 'KONICA MINOLTA'],
            [/mamiya/i, 'Mamiya'],
            [/sinar/i, 'Sinar'],
            [/alpa/i, 'ALPA'],
            [/fujifilm|gfx/i, 'FUJIFILM'],
        ];
        for (const [re, name] of map) {
            if (re.test(s)) return name;
        }
        // 没匹配到就原样返回make的前20字符
        return (make || '').trim().substring(0, 20);
    }

    function cameraFor(styleName, iw, ih, exif) {
        const noBrandModel = (styleName === 'SIMPLE_FILM' || styleName === 'PARAM_BOTTOM_SINGLE');
        if (camHasData(exif)) {
            const focal = exif.focal || '50mm', aper = exif.aperture || 'f/2.8';
            const iso = exif.iso || 'ISO 400', shut = exif.shutter || '1/125';
            if (noBrandModel) return { brand: '', model: '', focal, aperture: aper, iso: '', shutter: '' };
            let b = normalizeBrand(exif.make, exif.model);
            let m = (exif.model || '').trim();
            // model里去掉品牌名重复部分
            if (m && b && m.toLowerCase().includes(b.toLowerCase())) {
                m = m.replace(new RegExp(b, 'gi'), '').trim();
            }
            if (!b && !m) b = 'CAMERA';
            return { brand: b, model: m, focal, aperture: aper, iso, shutter: shut };
        }
        const rnd = javaRandom(iw * 313 + ih * 997 + ORD[styleName]);
        const focals = ['24mm','28mm','35mm','50mm','85mm','135mm','200mm'];
        const apert = ['f/1.4','f/2.0','f/2.8','f/4.0','f/5.6','f/8.0','f/11'];
        const isos = ['ISO 100','ISO 200','ISO 400','ISO 800','ISO 1600','ISO 3200'];
        const shutters = ['1/60','1/125','1/250','1/500','1/1000','1/2000','1/4000'];
        const f = () => focals[rnd(focals.length)], a = () => apert[rnd(apert.length)],
            i = () => isos[rnd(isos.length)], s = () => shutters[rnd(shutters.length)];
        if (noBrandModel) return { brand: '', model: '', focal: f(), aperture: a(), iso: '', shutter: '' };
        let b, m;
        if (['CARD_LEICA','CARD_LOGO_PARAM','CARD_IMMERSION','OVERLAY_LOGO_BOTTOM'].includes(styleName)) { b='LEICA'; m='M10-P'; }
        else if (['FUJI_WHITE','OVERLAY_PARAM_BOTTOM'].includes(styleName)) { b='FUJIFILM'; m='X-T5'; }
        else if (['XIAOMI_IMP','IMP_FROSTED','IMP_CLASSIC'].includes(styleName)) { b='XIAOMI'; m='14 Ultra'; }
        else if (['ART_CARD','COLOR_CLASSIC','COLOR_REFINED'].includes(styleName)) { b='GFX'; m='100S'; }
        else if (['WM_CLASSIC','WM_SINGLE','WM_BRAND_LOGO','WM_AI','BLUR_CLASSIC','BLUR_DATE','OVERLAY_PARAM_LEFT'].includes(styleName)) { b='SONY'; m='A7 IV'; }
        else if (styleName === 'CARD_PURE_LOGO') { b='LEICA'; m='Q3'; }
        else if (['CARD_SIMPLE','PARAM_TOP_LEFT','PARAM_BOTTOM_LEFT','OVERLAY_PARAM_RIGHT'].includes(styleName)) { b='CANON'; m='EOS R5'; }
        else return { brand: '', model: '', focal: '', aperture: '', iso: '', shutter: '' };
        return { brand: b, model: m, focal: f(), aperture: a(), iso: i(), shutter: s() };
    }
    function exifLine(cam) { return cam.focal + '  ' + cam.aperture + '  ' + cam.iso + '  ' + cam.shutter; }
    function buildParamString(cam, paramType) {
        const ap = cam.aperture.replace('f/', 'F');
        const ss = cam.shutter.endsWith('s') ? cam.shutter : cam.shutter + 's';
        if (paramType === 1) return cam.focal + '  ' + ap;
        if (paramType === 2) return dateYMD();
        return cam.focal + '  ' + ap + '  ' + ss + '  ' + cam.iso;
    }
    function positionOf(p) { return (p === '居左' || p === 'LEFT') ? 'LEFT' : (p === '居右' || p === 'RIGHT') ? 'RIGHT' : (p === '分列' || p === 'SPLIT') ? 'SPLIT' : 'CENTER'; }

    // ── 文本:字距(track)/度量/绘制 ──
    function setFont(g, px, mono, bold, family) {
        g.font = (bold ? 'bold ' : '') + px + 'px ' + (mono ? 'monospace' : (family || 'sans-serif'));
    }
    function charW(g, ch, px, mono, bold) {
        if (mono) return Math.round(px * 0.60);
        setFont(g, px, mono, bold);
        return g.measureText(ch).width;
    }
    function textMetrics(g, text, px, mono, bold, track) {
        const ascent = Math.round(px * 0.78), descent = Math.round(px * 0.22);
        let w = 0;
        for (let i = 0; i < text.length; i++) w += charW(g, text[i], px, mono, bold);
        w += (track || 0) * Math.max(0, text.length - 1);
        return { w, ascent, descent, height: ascent + descent, maxDescent: descent };
    }
    function drawTextL(g, text, x, y, fill, px, mono, bold, track) {
        if (!text) return;
        if (!track) { setFont(g, px, mono, bold); g.fillStyle = fill; g.fillText(text, x, y); return; }
        setFont(g, px, mono, bold);
        g.fillStyle = fill;
        let cx = x;
        for (let i = 0; i < text.length; i++) {
            g.fillText(text[i], cx, y);
            cx += charW(g, text[i], px, mono, bold) + track;
        }
    }
    function drawShadowTextL(g, text, x, y, px, fill, mono, bold, track) {
        const off = Math.max(1, Math.round(px / 24));
        drawTextL(g, text, x + off, y + off, 'rgba(0,0,0,0.59)', px, mono, bold, track);
        drawTextL(g, text, x, y, fill, px, mono, bold, track);
    }
    function fitFont(g, text, mono, bold, startFs, maxWidth, track) {
        let fs = Math.max(9, startFs);
        while (fs > 9) { if (textMetrics(g, text, fs, mono, bold, track).w <= maxWidth) break; fs--; }
        return fs;
    }
    function roundedPhoto(img, arc) {
        const c = newCanvas(img.naturalWidth, img.naturalHeight);
        const g = c.getContext('2d');
        roundRectPath(g, 0, 0, c.width, c.height, Math.max(1, arc));
        g.clip();
        g.drawImage(img, 0, 0);
        return c;
    }
    function drawCardSoftShadow(g, w, h, px, py, pw, ph, arc) {
        const blur = Math.max(6, Math.min(24, Math.floor(pw / 60)));
        const sh = newCanvas(w, h);
        const sg = sh.getContext('2d');
        sg.fillStyle = 'rgba(0,0,0,0.275)';
        fillRoundRectCtx(sg, px + Math.floor(blur / 3), py + Math.max(4, Math.floor(blur / 2)), pw, ph, Math.max(1, arc));
        g.drawImage(fastBlurCanvas(sh, blur), 0, 0);
    }
    const trim = s => String(s == null ? '' : s).trim().toUpperCase();

    // ── ColorSampler(原版 sampleEdgeColor / sampleBottomDarkColor)──
    function sampleEdgeColor(img) {
        const key = imgKey(img) + ':edge';
        if (_edgeCache[key]) return _edgeCache[key];
        const w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.max(1, Math.floor(Math.max(w, h) / 64));
        const sw = Math.floor(w / scale), sh = Math.floor(h / scale);
        const small = newCanvas(sw, sh);
        const sg = small.getContext('2d');
        sg.imageSmoothingEnabled = true; sg.drawImage(img, 0, 0, sw, sh);
        const { data } = sg.getImageData(0, 0, sw, sh);
        const stripW = Math.max(1, Math.floor(sw / 10)), stripH = Math.max(1, Math.floor(sh / 10));
        let r = 0, g = 0, b = 0, n = 0;
        const acc = i => { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; };
        for (let x = 0; x < sw; x++) for (let y = 0; y < stripH; y++) acc((y * sw + x) * 4);
        for (let x = 0; x < sw; x++) for (let y = sh - stripH; y < sh; y++) acc((y * sw + x) * 4);
        for (let y = stripH; y < sh - stripH; y++) {
            for (let x = 0; x < stripW; x++) acc((y * sw + x) * 4);
            for (let x = sw - stripW; x < sw; x++) acc((y * sw + x) * 4);
        }
        if (!n) { const fb2 = { r: 100, g: 120, b: 140 }; _edgeCache[key] = fb2; return fb2; }
        const res = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
        _edgeCache[key] = res;
        return res;
    }
    function sampleBottomDarkColor(img) {
        const key = imgKey(img) + ':bottom';
        if (_bottomCache[key]) return _bottomCache[key];
        const w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.max(1, Math.floor(Math.max(w, h) / 64));
        const sw = Math.floor(w / scale), sh = Math.floor(h / scale);
        const small = newCanvas(sw, sh);
        const sg = small.getContext('2d');
        sg.imageSmoothingEnabled = true; sg.drawImage(img, 0, 0, sw, sh);
        const { data } = sg.getImageData(0, 0, sw, sh);
        const stripH = Math.max(1, Math.floor(sh / 5));
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = sh - stripH; y < sh; y++) {
            for (let x = 0; x < sw; x++) {
                const i = (y * sw + x) * 4;
                const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
                if (lum < 128) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
            }
        }
        if (!n) { const fb3 = { r: 25, g: 25, b: 30 }; _bottomCache[key] = fb3; return fb3; }
        const res = { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
        _bottomCache[key] = res;
        return res;
    }

    // ── 模糊底/主照片/底部遮罩(原版 createBlurBacking/drawBlurBackground/drawMainPhoto/drawBottomMaskAndText)──
    const scaledPx = x => Math.round(x);
    function autoExifSize(paramFs, lastW) {
        if (!lastW) return paramFs;
        const k = Math.max(0.5, Math.min(8, lastW / 1200.0));
        return Math.max(2, Math.min(800, Math.round(paramFs * k)));
    }
    function scaledBlurRadius(blurIntensity) { return Math.max(6, Math.round((50 + blurIntensity / 2.0) * 1.0)); }
    // 模糊留白带:上/左/右/下的解析度统一,由"模糊半径"兜底,边框粗细不超过图片短边的 7%,避免大边框预设把照片框出大片空白
    function blurBand(size, iw, ih, intensity) {
        const blurRadius = scaledBlurRadius(intensity);
        const rim = Math.min(Math.max(scaledPx(50), Math.floor(size / 2)), Math.round(Math.min(iw, ih) * 0.07));
        return Math.max(blurRadius, rim);
    }
    // 参数文字字号:由照片宽度驱动(跟随 paramFs 滑块),不受模糊带高度压缩,保证清晰可读
    function blurExifSz(iw, ih, paramFs) {
        return Math.max(28, Math.min(Math.round(autoExifSize(paramFs, iw) * 1.5), Math.round(Math.min(iw, ih) * 0.09)));
    }
    // 底部参数带:至少能放下 型号行+参数行,其余三边仍用紧凑的模糊带
    function blurBottom(size, iw, ih, S) {
        const side = blurBand(size, iw, ih, S.blurIntensity);
        const exifSz = blurExifSz(iw, ih, S.paramFs);
        const blockH = (S.paramType === 0 ? (exifSz + scaledPx(4)) + scaledPx(6) + exifSz : exifSz);
        return Math.max(side, Math.round(blockH + scaledPx(24)));
    }
    function createBlurBacking(img, marginLr, marginTop, marginBottom, blurIntensity) {
        const key = imgKey(img) + ':' + marginLr + ':' + marginTop + ':' + marginBottom + ':' + blurIntensity;
        const hit = getBlurBacking(key);
        if (hit) return hit;
        const bw = img.naturalWidth + marginLr * 2, bh = img.naturalHeight + marginTop + marginBottom;
        const temp = newCanvas(bw, bh);
        const tg = temp.getContext('2d');
        tg.imageSmoothingEnabled = true;
        const sc = 1.2 + blurIntensity * 0.003;
        const sw = Math.round(img.naturalWidth * sc), sh = Math.round(img.naturalHeight * sc);
        tg.drawImage(img, Math.floor((bw - sw) / 2), Math.floor((bh - sh) / 2), sw, sh);
        const out = fastBlurCanvas(temp, scaledBlurRadius(blurIntensity));
        putBlurBacking(key, out);
        return out;
    }
    function drawBlurBackground(g, backing, img, cx, cy, blurMargin, blurIntensity) {
        g.drawImage(backing, 0, 0);
        const edge = sampleEdgeColor(img);
        const imgCX = cx + img.naturalWidth / 2, imgCY = cy + img.naturalHeight / 2;
        const innerR = Math.min(img.naturalWidth, img.naturalHeight) / 2;
        const outerR = innerR + blurMargin;
        const d0 = Math.min(1, innerR / outerR);
        const rad = g.createRadialGradient(imgCX, imgCY, 0, imgCX, imgCY, outerR);
        rad.addColorStop(0, 'rgba(0,0,0,0)');
        rad.addColorStop(d0, 'rgba(0,0,0,0)');
        rad.addColorStop(1, 'rgba(' + edge.r + ',' + edge.g + ',' + edge.b + ',0.71)');
        g.fillStyle = rad;
        g.fillRect(0, 0, backing.width, backing.height);
    }
    function drawMainPhoto(g, img, cx, cy, arc, scale, offX, offY) {
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const sc = scale || 1;
        const dw = iw * sc, dh = ih * sc;
        const dx = cx + (iw - dw) / 2 + (offX || 0);
        const dy = cy + (ih - dh) / 2 + (offY || 0);
        const radius = Math.max(1, arc * sc);
        // 悬浮阴影:大小与糊度跟随照片尺寸及图片缩放同步放大(图片越大/越放大,影子越宽越柔和)
        // 透明度刻意压低,避免在模糊底上形成"黑圈/黑框"轮廓
        const shBlur = Math.max(4, Math.round(Math.min(iw, ih) * 0.03 * sc));
        const shOff = Math.max(3, Math.round(shBlur * 0.8));
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.5)';
        g.shadowBlur = shBlur * 1.5;
        g.shadowOffsetY = shOff * 1.5;
        g.fillStyle = '#ffffff';
        roundRectPath(g, dx, dy, dw, dh, radius);
        g.fill();
        g.shadowBlur = 0;
        g.shadowOffsetY = 0;
        roundRectPath(g, dx, dy, dw, dh, radius);
        g.clip();
        g.drawImage(img, dx, dy, dw, dh);
        for (const [wd, al] of [[Math.max(1, scaledPx(2)), 28], [Math.max(1, scaledPx(5)), 16], [Math.max(1, scaledPx(8)), 8]]) {
            g.strokeStyle = 'rgba(120,120,120,' + (al / 255).toFixed(3) + ')';
            g.lineWidth = wd;
            g.beginPath();
            if (g.roundRect) { g.roundRect(dx + wd / 2, dy + wd / 2, Math.max(0, dw - wd), Math.max(0, dh - wd), Math.max(1, arc * sc - wd / 2), Math.max(1, arc * sc - wd / 2)); }
            else { g.rect(dx + wd / 2, dy + wd / 2, Math.max(0, dw - wd), Math.max(0, dh - wd)); }
            g.stroke();
        }
        g.restore();
    }
    // 参数/主角 居中与左右(WatermarkRender.Position)
    function alignTextX(w, textW, pos, padX) {
        if (pos === 'LEFT' || pos === 'SPLIT') return padX;
        if (pos === 'RIGHT') return w - textW - padX;
        return (w - textW) / 2;
    }

    // ── WatermarkRender.drawParamMask(原版,含底部遮罩输入 = 整图)──
    function drawParamMask(g, canvasEl, cw, ch, cam, position, paramFs) {
        const lines = [cam.brand, cam.model, cam.focal, cam.aperture, cam.iso, cam.shutter].filter(v => v && String(v).trim() !== '');
        if (!lines.length) return;
        if (position === 'SPLIT') {
            const mid = Math.floor(lines.length / 2);
            drawSingleMask(g, canvasEl, cw, ch, lines.slice(0, mid), 'LEFT', paramFs);
            drawSingleMask(g, canvasEl, cw, ch, lines.slice(mid), 'RIGHT', paramFs);
            return;
        }
        drawSingleMask(g, canvasEl, cw, ch, lines, position, paramFs);
    }
    function drawSingleMask(g, canvasEl, cw, ch, lines, pos, paramFs) {
        const fs = Math.max(11, autoExifSize(paramFs, cw));
        const fm = textMetrics(g, lines[0], fs, true, false, 0);
        let maxW = 0;
        for (const l of lines) maxW = Math.max(maxW, textMetrics(g, l, fs, true, false, 0).w);
        const lineH = fm.height;
        const maskW = maxW + 24, maskH = lines.length * lineH + (lines.length - 1) * 16 + 16;
        let x = (pos === 'RIGHT') ? cw - maskW - 12 : 12;
        let y = Math.floor((ch - maskH) / 2);
        let mx = Math.max(0, x), my = Math.max(0, y);
        let mw = Math.min(cw - mx, maskW), mh = Math.min(ch - my, maskH);
        if (mw <= 0 || mh <= 0) return;
        const sx = Math.min(mx, cw - 1), sy = Math.min(my, ch - 1);
        const sw = Math.min(mw, cw - sx), sh = Math.min(mh, ch - sy);
        if (sw <= 0 || sh <= 0) return;
        const sub = newCanvas(sw, sh);
        const sg = sub.getContext('2d');
        sg.drawImage(canvasEl, sx, sy, sw, sh, 0, 0, sw, sh);
        g.drawImage(fastBlurCanvas(sub, Math.max(8, Math.floor(fs / 2))), mx, my, mw, mh);
        g.fillStyle = 'rgba(0,0,0,0.22)';
        fillRoundRectCtx(g, mx, my, mw, mh, 12);
        g.save();
        roundRectPath(g, mx, my, mw, mh, 12);
        g.clip();
        g.fillStyle = '#ffffff';
        let textY = my + 8 + fm.ascent;
        for (let li = 0; li < lines.length; li++) {
            const l = lines[li];
            if (li === 0) {
                // 品牌名用Georgia衬线字体
                g.font = 'bold ' + fs + "px Georgia, 'Times New Roman', serif";
                g.letterSpacing = Math.round(fs * 0.15);
            } else {
                g.font = 'bold ' + fs + 'px sans-serif';
                g.letterSpacing = 0;
            }
            g.fillText(l, mx + 12, textY);
            textY += lineH + 16;
        }
        g.letterSpacing = 0;
        g.restore();
    }

    // ── 卡片柔影辅助:applyCardShadow / applyBlurOuterShadow(shadowSize>0 时生效,默认 0 跳过)──
    function applyCardShadow(g, x, y, w, h, arc, S) {
        const sSize = S.shadowSize || 0;
        if (sSize <= 0) return;
        const depth = Math.max(1, Math.floor((S.shadowDepth || 30) * sSize / 100));
        const offset = Math.max(1, Math.floor(sSize / 4));
        const alpha = Math.max(10, Math.min(180, S.shadowAlpha != null ? S.shadowAlpha : 80));
        for (let i = 0; i < 3; i++) {
            const layerOff = offset + Math.floor(i * offset / 2);
            const layerSize = sSize - Math.floor(i * sSize / 6);
            const layerAlpha = alpha - i * 30;
            if (layerAlpha < 5) break;
            g.fillStyle = 'rgba(0,0,0,' + (layerAlpha / 255).toFixed(3) + ')';
            fillRoundRectCtx(g, x + layerOff, y + layerOff, w, h, Math.max(1, arc - i * 2));
        }
        g.fillStyle = 'rgba(0,0,0,' + (Math.min(60, Math.floor(alpha / 2)) / 255).toFixed(3) + ')';
        fillRoundRectCtx(g, x + Math.max(1, Math.floor(depth / 2)), y + depth, w, h, Math.max(1, arc));
    }
    function applyBlurOuterShadow(g, x, y, w, h, arc, S) {
        const sSize = S.shadowSize || 0;
        if (sSize <= 0) return;
        const depth = Math.max(1, Math.floor((S.shadowDepth || 30) * sSize / 100));
        const alpha = Math.max(10, Math.min(180, S.shadowAlpha != null ? S.shadowAlpha : 80));
        for (let i = 0; i < 3; i++) {
            const ext = sSize - Math.floor(i * sSize / 6);
            const layerAlpha = alpha - i * 30;
            if (layerAlpha < 5) break;
            g.fillStyle = 'rgba(0,0,0,' + (layerAlpha / 255).toFixed(3) + ')';
            fillRoundRectCtx(g, x - ext, y - ext, w + 2 * ext, h + 2 * ext, Math.max(1, arc - i * 2));
        }
        g.fillStyle = 'rgba(0,0,0,' + (Math.min(60, Math.floor(alpha / 2)) / 255).toFixed(3) + ')';
        fillRoundRectCtx(g, x - 2, y + depth, w + 4, h, Math.max(1, arc));
    }

    // ── 阶段二:文本类风格(原版 addXxx 逐行移植)──
    const cx2 = (w, tw) => (w - tw) / 2;
    function styleBlurClassic(img, size, g, iw, ih, S) {
        const side = blurBand(size, iw, ih, S.blurIntensity);
        const bottom = blurBottom(size, iw, ih, S);
        styleBlurCommon(img, size, g, iw, ih, S, side, bottom, false);
    }
    function styleBlurDate(img, size, g, iw, ih, S) {
        const side = blurBand(size, iw, ih, S.blurIntensity);
        const bottom = blurBottom(size, iw, ih, S);
        styleBlurCommon(img, size, g, iw, ih, S, side, bottom, true);
    }
    function styleBlurCommon(img, size, g, iw, ih, S, blurMargin, blurBottom, dateLayout) {
        const backing = createBlurBacking(img, blurMargin, blurMargin, blurBottom, S.blurIntensity);
        const cx = blurMargin, cy = blurMargin, cw = backing.width, ch = backing.height;
        drawBlurBackground(g, backing, img, cx, cy, blurMargin);
        const photoCr = Math.min(S.cornerAll, Math.min(iw, ih) / 2);
        drawMainPhoto(g, img, cx, cy, photoCr, S.imgScale, S.imgOffsetX, S.imgOffsetY);

        if (!S.useExif) return;
        const topY = cy + ih;
        const maskH = ch - topY;
        const centerY = topY + Math.floor(maskH / 2);
        const showModel = S.paramType === 0;
        // 原版:字号由照片宽度驱动(blurExifSz),底部参数带高度为其留出空间,两行完整露出且清晰
        const exifSz = blurExifSz(iw, ih, S.paramFs);
        const modelSz = exifSz + scaledPx(4);
        const paramSz = exifSz;

        const bc = sampleBottomDarkColor(img);
        const grad = g.createLinearGradient(0, topY, 0, ch);
        grad.addColorStop(0, 'rgba(' + bc.r + ',' + bc.g + ',' + bc.b + ',0)');
        grad.addColorStop(1, 'rgba(' + bc.r + ',' + bc.g + ',' + bc.b + ',' + (200 / 255).toFixed(3) + ')');
        g.fillStyle = grad;
        g.fillRect(0, topY, cw, maskH);

        const pos = S.position;
        const padX = Math.max(scaledPx(20), scaledPx(10) + exifSz);
        const modelTrack = Math.max(1, Math.round(modelSz * 0.08));
        const paramTrack = Math.max(1, Math.round(paramSz * 0.10));
        const model = S.cam.brand + ' ' + S.cam.model;
        const text = dateLayout ? dateYMD() : buildParamString(S.cam, S.paramType);
        if (showModel) {
            const gap = Math.min(scaledPx(6), Math.max(0, maskH - modelSz - paramSz));
            const blockH = modelSz + gap + paramSz;
            const modelY = Math.max(topY + modelSz, centerY - Math.floor(blockH / 2) + modelSz);
            const paramsY = modelY + paramSz + gap;
            const mw = textMetrics(g, model, modelSz, false, true, modelTrack);
            let mX;
            if (pos === 'LEFT' || pos === 'SPLIT') mX = padX;
            else if (pos === 'RIGHT') mX = cw - mw.w - padX;
            else mX = cx2(cw, mw.w);
            drawTextL(g, model, mX, modelY, 'rgba(255,255,255,0.922)', modelSz, false, true, modelTrack);
            const pw = textMetrics(g, text, paramSz, true, false, paramTrack);
            let pX;
            if (pos === 'RIGHT' || pos === 'SPLIT') pX = cw - pw.w - padX;
            else if (pos === 'LEFT') pX = padX;
            else pX = cx2(cw, pw.w);
            drawTextL(g, text, pX, paramsY, 'rgba(220,220,220,0.824)', paramSz, true, false, paramTrack);
        } else {
            const paramsY = centerY + Math.floor(paramSz / 2);
            const pw = textMetrics(g, text, paramSz, true, false, paramTrack);
            let pX;
            if (pos === 'LEFT' || pos === 'SPLIT') pX = padX;
            else if (pos === 'RIGHT') pX = cw - pw.w - padX;
            else pX = cx2(cw, pw.w);
            drawTextL(g, text, pX, paramsY, 'rgba(220,220,220,0.824)', paramSz, true, false, paramTrack);
        }
    }
    function styleWmClassic(img, size, g, iw, ih, S) {
        const barH = Math.max(50, size), pad = size, w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        const barY = ih + pad;
        const fs = Math.max(11, Math.floor(size / 3));
        g.fillStyle = 'rgb(30,30,30)'; g.fillRect(pad, barY, iw, barH);
        drawLogo(g, trim(S.cam.brand), pad + 10, barY + Math.floor(barH / 2) + Math.floor(fs / 3), fs);
        const line2 = S.cam.model + '  |  ' + S.cam.focal + '  ' + S.cam.aperture;
        drawTextL(g, line2, pad + 10 + fs * 4, barY + Math.floor(barH / 2) + Math.floor(fs / 3), 'rgb(180,180,180)', autoExifSize(S.paramFs, iw), true, false, 0);
    }
    function styleWmSingle(img, size, g, iw, ih, S) {
        const barH = Math.max(32, size), pad = Math.max(8, Math.floor(size / 2));
        const w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        const barY = ih + pad;
        const fs = Math.max(10, Math.floor(size / 3));
        const line = S.cam.focal + '  ' + S.cam.aperture + '  ' + S.cam.iso + '  ' + S.cam.shutter;
        const f = autoExifSize(S.paramFs, iw);
        const fm = textMetrics(g, line, f, true, false, 0);
        drawTextL(g, line, cx2(w, fm.w), barY + Math.floor(barH / 2) + Math.floor(fm.ascent / 2), 'rgb(60,60,60)', f, true, false, 0);
    }
    const AI_FAMILIES = ['"Microsoft YaHei","sans-serif"', '"KaiTi","楷体","serif"', '"SimSun","宋体","serif"', 'monospace'];
    function textMetricsF(g, text, px, mono, bold, track, family) {
        const ascent = Math.round(px * 0.78), descent = Math.round(px * 0.22);
        setFont(g, px, mono, bold, family);
        let w = 0;
        for (const ch of text) w += g.measureText(ch).width;
        w += (track || 0) * Math.max(0, text.length - 1);
        return { w, ascent, descent, height: ascent + descent, maxDescent: descent };
    }
    function fitFontFs(g, text, fs, maxWidth, family, mono) {
        while (fs > 9) { if (textMetricsF(g, text, fs, mono, true, 0, family).w <= maxWidth) break; fs--; }
        return fs;
    }
    function styleWmAi(img, size, g, iw, ih, S) {
        const cam = S.cam, cap = S.aiCaption;
        const twoLine = cap && S.aiCapLayout !== 1;
        let barH = Math.max(twoLine ? 64 : 44, Math.floor(size * (twoLine ? 3 : 2) / 2));
        barH += Math.floor(barH * Math.max(0, S.aiCapSizePct - 100) / 250);
        const pad = Math.max(8, Math.floor(size / 2));
        const w = iw + pad * 2, h = ih + pad + barH;
        let capCol, paramCol;
        if (S.aiCapTheme === 1) {
            g.fillStyle = 'rgb(20,20,22)'; g.fillRect(0, 0, w, h);
            capCol = 'rgb(245,243,238)'; paramCol = 'rgb(160,160,165)';
        } else if (S.aiCapTheme === 2) {
            const main = sampleEdgeColor(img);
            g.fillStyle = 'rgb(' + main.r + ',' + main.g + ',' + main.b + ')'; g.fillRect(0, 0, w, h);
            const light = (main.r * 299 + main.g * 587 + main.b * 114) / 1000 <= 150;
            capCol = light ? 'rgb(245,243,238)' : 'rgb(35,35,35)';
            paramCol = light ? 'rgb(195,195,200)' : 'rgb(110,110,110)';
        } else {
            g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
            capCol = 'rgb(35,35,35)'; paramCol = 'rgb(150,150,150)';
        }
        g.drawImage(img, pad, pad);
        const barY = ih + pad;
        const params = cam.focal + '  ' + cam.aperture + '  ' + cam.iso + '  ' + cam.shutter;
        if (!cap) {
            const f = autoExifSize(S.paramFs, iw);
            const fm = textMetrics(g, params, f, true, false, 0);
            drawTextL(g, params, cx2(w, fm.w), barY + Math.floor(barH / 2) + Math.floor(fm.ascent / 2), 'rgb(60,60,60)', f, true, false, 0);
            return;
        }
        const family = AI_FAMILIES[S.aiCapFontIdx];
        const mono = S.aiCapFontIdx === 3;
        let fs = Math.max(10, Math.floor(Math.max(12, Math.floor(size / 3)) * S.aiCapSizePct / 100));
        fs = fitFontFs(g, cap, fs, iw - 20, family, mono);
        const cfm = textMetricsF(g, cap, fs, mono, true, 0, family);
        const drawCap = (t, x, y) => { setFont(g, fs, mono, true, family); g.fillStyle = capCol; g.fillText(t, x, y); };
        const centered = S.aiCapLayout !== 0;
        if (!twoLine) {
            const x = centered ? cx2(w, cfm.w) : pad + 10;
            drawCap(cap, x, barY + Math.floor(barH / 2) + Math.floor(cfm.ascent / 2) - 2);
        } else {
            const capX = centered ? cx2(w, cfm.w) : pad + 10;
            drawCap(cap, capX, barY + Math.floor(barH / 4) + Math.floor(cfm.ascent / 2) - 2);
            const f2 = autoExifSize(S.paramFs, iw);
            const line2 = cam.model ? params + '   |   ' + cam.model : params;
            const pfm = textMetrics(g, line2, f2, true, false, 0);
            const pX = centered ? cx2(w, pfm.w) : pad + 10;
            drawTextL(g, line2, pX, barY + Math.floor(barH * 3 / 4) + Math.floor(pfm.ascent / 2) - 1, paramCol, f2, true, false, 0);
        }
    }
    function styleWmBrandLogo(img, size, g, iw, ih, S) {
        const barH = Math.max(56, Math.floor(size * 3 / 2)), pad = size;
        const w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = 'rgb(20,20,20)'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        if (S.useExif) {
            const barY = ih + pad, textCenterY = barY + Math.floor(barH / 2);
            const logoFs = Math.max(14, autoExifSize(S.paramFs, iw) + 4);
            drawLogo(g, trim(S.cam.brand), pad + 16, textCenterY + Math.floor(logoFs / 3), logoFs);
            const ps = buildParamString(S.cam, S.paramType);
            if (ps) {
                const f = autoExifSize(S.paramFs, iw);
                const fmm = textMetrics(g, ps, f, true, false, Math.max(1, Math.round(f * 0.08)));
                drawTextL(g, ps, w - pad - 16 - fmm.w, textCenterY + Math.floor(fmm.ascent / 2), 'rgb(200,200,200)', f, true, false, Math.max(1, Math.round(f * 0.08)));
            }
        }
    }
    function styleImpFrosted(img, size, g, iw, ih, S) {
        // 横版:左侧文字区,右侧照片
        const gm = S.globalMargin || 1;
        const leftW = Math.max(180, Math.round(iw * 0.35 * gm));
        const rightPad = Math.round(leftW / 2);
        const topBotPad = Math.max(50, Math.round(size * 1.2));
        const w = leftW + iw + rightPad;
        const h = ih + topBotPad * 2;
        // 1. 照片 cover 铺满做模糊底
        g.save();
        g.fillStyle = '#1a2a3a'; g.fillRect(0, 0, w, h);
        const scale = Math.max(w / iw, h / ih);
        const dw = iw * scale, dh = ih * scale;
        g.filter = 'blur(' + Math.max(18, Math.round(Math.min(w, h) / 20)) + 'px)';
        g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
        g.filter = 'none';
        g.restore();
        // 压暗
        g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(0, 0, w, h);
        // 2. 右侧照片(垂直居中,带圆角阴影)
        const px = leftW + 40 + (S.imgOffsetX || 0);
        const py = Math.round((h - ih) / 2) + (S.imgOffsetY || 0);
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.6)';
        g.shadowBlur = Math.max(24, Math.round(Math.min(iw, ih) * 0.07));
        g.shadowOffsetY = Math.max(10, Math.round(Math.min(iw, ih) * 0.03));
        g.fillStyle = '#ffffff';
        const r = Math.max(8, Math.round(Math.min(iw, ih) * 0.02));
        if (typeof g.roundRect === 'function') {
            g.beginPath(); g.roundRect(px, py, iw, ih, r); g.fill();
        } else {
            g.fillRect(px, py, iw, ih);
        }
        g.restore();
        g.save();
        if (typeof g.roundRect === 'function') {
            g.beginPath(); g.roundRect(px, py, iw, ih, r); g.clip();
        }
        g.drawImage(img, px, py);
        g.restore();
        // 3. 左侧品牌名
        const ml = Math.round(leftW * 0.25) + 40;
        const brand = (S.cam && S.cam.brand) ? S.cam.brand.toUpperCase() : 'SONY';
        // 默认自适应:按照片宽度比例算,用户调参数字号时按比例缩放
        const pfScale = (S.paramFs != null && S.paramFs > 0) ? S.paramFs / 33 : 1;
        const fBrand = Math.max(22, Math.round(leftW * 0.14 * pfScale));
        g.fillStyle = '#ffffff';
        g.font = 'bold ' + fBrand + "px Georgia, 'Times New Roman', serif";
        g.letterSpacing = Math.round(fBrand * 0.15);
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        g.fillText(brand, ml, Math.round(h * 0.28));
        // 4. 三行圆角方框参数
        if (true && S.useExif && S.cam) {
            const boxW = Math.round(leftW * 0.28 * pfScale);
            const boxH = Math.round(boxW * 0.55);
            const fBox = Math.max(11, Math.round(boxH * 0.45));
            const fVal = Math.max(13, Math.round(leftW * 0.08 * pfScale));
            const rows = [
                { label: 'F', val: String(S.cam.aperture || '6.3').replace(/^f\//i, '').replace(/^F\//i, '') },
                { label: 'ISO', val: String(S.cam.iso || '100').replace(/^iso/i, '') },
                { label: 'S', val: String(S.cam.shutter || '1/125').replace(/s$/i, '').replace(/^"/, '').replace(/"$/, '') }
            ];
            let ry = Math.round(h * 0.48);
            rows.forEach(row => {
                g.strokeStyle = '#ffffff';
                g.lineWidth = Math.max(1.5, Math.round(boxH * 0.08));
                g.beginPath();
                if (typeof g.roundRect === 'function') g.roundRect(ml, ry - boxH, boxW, boxH, Math.round(boxH * 0.2));
                else g.rect(ml, ry - boxH, boxW, boxH);
                g.stroke();
                g.fillStyle = '#ffffff';
                g.font = 'bold ' + fBox + 'px sans-serif';
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.fillText(row.label, ml + boxW / 2, ry - boxH / 2);
                g.font = 'bold ' + fVal + 'px sans-serif';
                g.textAlign = 'left';
                g.fillText(row.val, ml + boxW + Math.round(leftW * 0.05), ry - boxH / 2);
                ry += Math.round(boxH * 1.9);
            });
        }
    }
    function styleImpClassic(img, size, g, iw, ih, S) {
        const pad = Math.max(8, Math.floor(size / 2));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = 'rgb(40,40,45)'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        if (S.useExif) drawParamMask(g, g.canvas, w, h, S.cam, S.position, Math.max(11, S.paramFs));
    }
    function styleXiaomiImp(img, size, g, iw, ih, S) {
        const topPad = Math.max(20, Math.floor(size / 2));
        const barH = Math.max(50, size * 2);
        const sidePad = Math.max(6, Math.floor(size / 3));
        const w = iw + sidePad * 2, h = ih + topPad + barH;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, sidePad, topPad);
        const barY = ih + topPad;
        const f = autoExifSize(S.paramFs, iw);
        const fm = textMetrics(g, S.cam.focal, f, true, false, 0);
        g.fillStyle = 'rgb(240,240,240)';
        g.fillRect(sidePad, barY, iw, barH);
        const btns = [['焦距', S.cam.focal], ['光圈', S.cam.aperture], ['ISO', S.cam.iso], ['快门', S.cam.shutter]];
        const btnW = Math.floor(iw / btns.length), btnGap = 8;
        for (let i = 0; i < btns.length; i++) {
            const bx = sidePad + i * btnW + Math.floor(btnGap / 2);
            const by = barY + 6;
            const bw = btnW - btnGap, bh = barH - 12;
            g.fillStyle = 'rgb(220,220,220)';
            fillRoundRectCtx(g, bx, by, bw, bh, 8);
            const lw = textMetrics(g, btns[i][0], f, true, false, 0);
            const vw = textMetrics(g, btns[i][1], f, true, false, 0);
            drawTextL(g, btns[i][0], bx + Math.floor((bw - lw.w) / 2), by + fm.ascent + 4, 'rgb(120,120,120)', f, true, false, 0);
            drawTextL(g, btns[i][1], bx + Math.floor((bw - vw.w) / 2), by + bh - 8, 'rgb(30,30,30)', f, true, false, 0);
        }
    }
    function styleCardLeica(img, size, g, iw, ih, S) {
        const ref = Math.max(1, Math.min(iw, ih));
        const pad = Math.max(24, Math.floor(size * 3 / 4));
        const brand = trim(S.cam.brand);
        const dotGap = Math.max(8, Math.floor(size / 4));
        const w = iw + pad * 2;
        const bf = fitFont(g, brand, false, true, Math.max(14, autoExifSize(S.paramFs, iw)), iw, 0);
        const bm = textMetrics(g, brand, bf, false, true, 0);
        const dotD = Math.max(9, Math.floor(bf * 2 / 5));
        const pl = S.useExif ? exifLine(S.cam) : '';
        let pf = 0, pm = { w: 0, ascent: 0 };
        if (pl) {
            const reserved = pad * 2 + dotD + dotGap + bm.w + Math.floor(autoExifSize(S.paramFs, iw) * 0.5);
            pf = fitFont(g, pl, true, false, Math.max(12, Math.floor(autoExifSize(S.paramFs, iw) * 2 / 3)), Math.max(60, w - reserved), 0);
            pm = textMetrics(g, pl, pf, true, false, 0);
        }
        const maxFs = Math.max(bf, pf);
        const bandH = Math.max(52, Math.floor(maxFs * 5 / 2));
        const h = ih + pad + bandH;
        const g2 = g;
        g2.fillStyle = '#ffffff'; g2.fillRect(0, 0, w, h);
        g2.drawImage(img, pad, pad);
        const baseY = ih + pad + Math.floor((bandH + bm.ascent - bm.maxDescent) / 2);
        g2.fillStyle = 'rgb(226,6,18)';
        const capCenter = baseY - Math.floor(bf * 72 / 200);
        g2.beginPath();
        g2.arc(pad + dotD / 2, capCenter, dotD / 2, 0, Math.PI * 2);
        g2.fill();
        drawTextL(g2, brand, pad + dotD + dotGap, baseY, 'rgb(30,30,30)', bf, false, true, 0);
        if (pf && pl) drawTextL(g2, pl, w - pad - pm.w, baseY, 'rgb(120,120,120)', pf, true, false, 0);
    }
    function styleCardLogoParam(img, size, g, iw, ih, S) {
        const ref = Math.max(1, Math.min(iw, ih));
        const pad = Math.max(28, Math.floor(size * 3 / 5));
        const arc = Math.max(12, Math.floor(size / 4));
        const brand = trim(S.cam.brand), model = S.cam.model || '';
        const l1 = (brand + ' ' + model).trim() || 'CAMERA';
        const l2 = S.useExif ? exifLine(S.cam) : '';
        const innerW = Math.max(80, iw - Math.floor(pad * 2 / 3));
        const f1 = fitFont(g, l1, false, true, Math.max(14, autoExifSize(S.paramFs, iw)), innerW, 0);
        const m1 = textMetrics(g, l1, f1, false, true, 0);
        let f2 = null;
        let m2 = textMetrics(g, ' ', 10, true, false, 0);
        if (l2) {
            f2 = fitFont(g, l2, true, false, Math.max(12, Math.floor(autoExifSize(S.paramFs, iw) * 2 / 3)), innerW, 0);
            m2 = textMetrics(g, l2, f2, true, false, 0);
        }
        const gap = l2 ? Math.max(8, Math.floor(m1.height / 4)) : 0;
        const blockH = m1.height + (l2 ? gap + m2.height : 0);
        const bandH = Math.max(56, Math.floor(blockH + pad * 2 / 3));
        const w = iw + pad * 2, h = ih + pad + bandH;
        g.fillStyle = 'rgb(250,250,250)'; g.fillRect(0, 0, w, h);
        drawCardSoftShadow(g, w, h, pad, pad, iw, ih, arc);
        g.drawImage(roundedPhoto(img, arc), pad, pad);
        const bandTop = ih + pad;
        const y1 = bandTop + Math.floor((bandH - blockH) / 2) + m1.ascent;
        const l1m = textMetrics(g, l1, f1, false, true, 0);
        drawTextL(g, l1, cx2(w, l1m.w), y1, 'rgb(25,25,25)', f1, false, true, 0);
        if (l2 && f2) {
            setFont(g, f2, true, false);
            const l2w = g.measureText(l2).width;
            drawTextL(g, l2, cx2(w, l2w), y1 + gap + m2.height, 'rgb(130,130,130)', f2, true, false, 0);
        }
    }
    function styleCardPureLogo(img, size, g, iw, ih, S) {
        const pad = Math.max(32, size);
        const arc = Math.max(14, Math.floor(size / 3));
        const brand = trim(S.cam.brand) || 'PHOTO';
        const wf = fitFont(g, brand, false, true, Math.max(20, Math.min(96, Math.round(autoExifSize(S.paramFs, iw)))), Math.max(80, iw - pad), 0);
        const wm = textMetrics(g, brand, wf, false, true, Math.max(1, Math.round(wf * 0.45)));
        const extra = Math.max(wm.height * 3, size);
        const w = iw + pad * 2, h = ih + pad + extra;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        drawCardSoftShadow(g, w, h, pad, pad, iw, ih, arc);
        g.drawImage(roundedPhoto(img, arc), pad, pad);
        const baseY = ih + pad + Math.floor((extra - wm.height) / 2) + wm.ascent;
        drawTrackedTextL(g, brand, Math.floor(w / 2), baseY, wf, 'rgb(34,34,34)', 0.45, false);
    }
    function styleCardSimple(img, size, g, iw, ih, S) {
        const ref = Math.max(1, Math.min(iw, ih));
        const pad = Math.max(12, Math.floor(size / 2));
        const brand = trim(S.cam.brand);
        const line = S.useExif ? (brand + ' · ' + exifLine(S.cam)) : brand;
        const f = fitFont(g, line, true, false, Math.max(12, autoExifSize(S.paramFs, iw)), Math.max(60, iw - pad * 3), 0);
        const fm = textMetrics(g, line, f, true, false, 0);
        const capH = Math.floor(fm.height * 5 / 3) + Math.max(6, Math.floor(pad / 4));
        const w = iw + pad * 2, h = ih + pad + capH + Math.max(10, Math.floor(pad / 2));
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        g.strokeStyle = 'rgb(230,230,230)'; g.lineWidth = 1;
        g.strokeRect(pad - 1, pad - 1, iw + 1, ih + 1);
        drawTextL(g, line, cx2(w, fm.w), ih + pad + Math.floor((capH + fm.ascent - fm.maxDescent) / 2), 'rgb(150,150,150)', f, true, false, 0);
    }
    function styleCardImmersion(img, size, g, iw, ih, S) {
        const ref = Math.max(1, Math.min(iw, ih));
        const pad = Math.max(20, Math.floor(size * 2 / 5));
        const arc = Math.max(10, Math.floor(size / 4));
        const brand = trim(S.cam.brand);
        const line = S.useExif ? (brand + '   ' + exifLine(S.cam)) : brand;
        const f = fitFont(g, line, true, false, Math.max(12, autoExifSize(S.paramFs, iw)), Math.max(60, iw - pad), 0);
        const fm = textMetrics(g, line, f, true, false, 0);
        const bandH = fm.height * 2 + Math.max(10, Math.floor(pad / 2));
        const w = iw + pad * 2, h = ih + pad + bandH;
        g.fillStyle = 'rgb(17,17,17)'; g.fillRect(0, 0, w, h);
        g.drawImage(roundedPhoto(img, arc), pad, pad);
        drawTextL(g, line, cx2(w, fm.w), ih + pad + Math.floor((bandH + fm.ascent - fm.maxDescent) / 2), 'rgb(185,185,185)', f, true, false, 0);
    }
    function paintScrim(g, w, h, pos, band) {
        let grad;
        if (pos === 0) grad = g.createLinearGradient(0, 0, band, 0);
        else if (pos === 1) grad = g.createLinearGradient(w, 0, w - band, 0);
        else grad = g.createLinearGradient(0, h, 0, h - band);
        grad.addColorStop(0, 'rgba(0,0,0,0.431)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        if (pos === 0) g.fillRect(0, 0, band, h);
        else if (pos === 1) g.fillRect(w - band, 0, band, h);
        else g.fillRect(0, h - band, w, band);
    }
    function styleOverlayParams(img, size, g, iw, ih, S, pos) {
        // LEFT(pos=0): 白底+照片在右+左侧品牌名和参数
        if (pos === 0) {
            const gm = S.globalMargin || 1;
            const pfScale = (S.paramFs != null && S.paramFs > 0) ? S.paramFs / 33 : 1;
            const leftW = Math.max(160, Math.round(iw * 0.35 * gm));
            const sidePad = Math.max(30, Math.round(size * 0.8 * gm));
            const w = leftW + iw + sidePad;
            const h = Math.round(ih * 1.08) + sidePad;
            g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
            const px = leftW + Math.round(sidePad * 0.3);
            const py = Math.round((h - ih) / 2);
            g.drawImage(img, px, py);
            const tx = Math.round(leftW * 0.2);
            const brand = (S.cam && S.cam.brand) ? S.cam.brand.toUpperCase() : 'SONY';
            const fBrand = Math.max(22, Math.round(leftW * 0.16 * pfScale));
            g.fillStyle = '#1a1a1a';
            g.font = 'bold ' + fBrand + "px Georgia, 'Times New Roman', serif";
            g.textAlign = 'left'; g.textBaseline = 'alphabetic';
            g.fillText(brand, tx, Math.round(h * 0.28));
            if (S.useExif && S.cam) {
                const boxW = Math.round(leftW * 0.3 * pfScale);
                const boxH = Math.round(boxW * 0.55);
                const fBox = Math.max(11, Math.round(boxH * 0.45));
                const fVal = Math.max(13, Math.round(leftW * 0.09 * pfScale));
                const rows = [
                    { label: 'F', val: String(S.cam.aperture || '6.3').replace(/^f\//i, '').replace(/^F\//i, '') },
                    { label: 'ISO', val: String(S.cam.iso || '100').replace(/^iso/i, '') },
                    { label: 'S', val: String(S.cam.shutter || '1/125').replace(/s$/i, '') }
                ];
                let ry = Math.round(h * 0.48);
                rows.forEach(row => {
                    g.strokeStyle = '#333333';
                    g.lineWidth = Math.max(1.5, Math.round(boxH * 0.08));
                    g.beginPath();
                    if (typeof g.roundRect === 'function') g.roundRect(tx, ry - boxH, boxW, boxH, Math.round(boxH * 0.2));
                    else g.rect(tx, ry - boxH, boxW, boxH);
                    g.stroke();
                    g.fillStyle = '#333333';
                    g.font = 'bold ' + fBox + 'px sans-serif';
                    g.textAlign = 'center'; g.textBaseline = 'middle';
                    g.fillText(row.label, tx + boxW / 2, ry - boxH / 2);
                    g.font = 'bold ' + fVal + 'px sans-serif';
                    g.textAlign = 'left';
                    g.fillText(row.val, tx + boxW + Math.round(leftW * 0.06), ry - boxH / 2);
                    ry += Math.round(boxH * 1.9);
                });
            }
            return;
        }
        // BOTTOM(pos=2): 白底+照片在上+底部品牌名和参数
        if (pos === 2) {
            const gm = S.globalMargin || 1;
            const pfScale = (S.paramFs != null && S.paramFs > 0) ? S.paramFs / 33 : 1;
            const bottomH = Math.max(120, Math.round(ih * 0.25 * gm));
            const sidePad = Math.max(30, Math.round(size * 0.8 * gm));
            const w = iw + sidePad * 2;
            const h = ih + bottomH + sidePad;
            g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
            const px = Math.round((w - iw) / 2);
            const py = Math.round(sidePad * 0.5);
            g.drawImage(img, px, py);
            const by = py + ih + Math.round(bottomH * 0.3);
            const brand = (S.cam && S.cam.brand) ? S.cam.brand.toUpperCase() : 'SONY';
            const fBrand = Math.max(18, Math.round(bottomH * 0.2 * pfScale));
            g.fillStyle = '#1a1a1a';
            g.font = 'bold ' + fBrand + "px Georgia, 'Times New Roman', serif";
            g.textAlign = 'center'; g.textBaseline = 'alphabetic';
            g.fillText(brand, w / 2, by);
            if (S.useExif && S.cam) {
                const boxW = Math.round(Math.max(280, Math.min(w * 0.35, 440)) * pfScale);
                const boxH = Math.round(boxW * 0.55);
                const fBox = Math.max(11, Math.round(boxH * 0.45));
                const fVal = Math.max(14, Math.round(boxH * 0.6));
                const rows = [
                    { label: 'F', val: String(S.cam.aperture || '6.3').replace(/^f\//i, '').replace(/^F\//i, '') },
                    { label: 'ISO', val: String(S.cam.iso || '100').replace(/^iso/i, '') },
                    { label: 'S', val: String(S.cam.shutter || '1/125').replace(/s$/i, '') }
                ];
                const valGap = Math.round(boxW * 0.3);
                const estValW = Math.round(boxW * 0.9);
                const itemW = boxW + valGap + estValW;
                const between = Math.round(itemW * 0.5);
                const totalW = rows.length * itemW + (rows.length - 1) * between;
                let bx = Math.round((w - totalW) / 2);
                const ry = by + Math.round(bottomH * 0.4);
                rows.forEach(row => {
                    g.strokeStyle = '#333333';
                    g.lineWidth = Math.max(1.5, Math.round(boxH * 0.08));
                    g.beginPath();
                    if (typeof g.roundRect === 'function') g.roundRect(bx, ry - boxH, boxW, boxH, Math.round(boxH * 0.2));
                    else g.rect(bx, ry - boxH, boxW, boxH);
                    g.stroke();
                    g.fillStyle = '#333333';
                    g.font = 'bold ' + fBox + 'px sans-serif';
                    g.textAlign = 'center'; g.textBaseline = 'middle';
                    g.fillText(row.label, bx + boxW / 2, ry - boxH / 2);
                    g.font = 'bold ' + fVal + 'px sans-serif';
                    g.textAlign = 'left';
                    g.fillText(row.val, bx + boxW + valGap, ry - boxH / 2);
                    bx += itemW + between;
                });
            }
            return;
        }
        // RIGHT(pos=1): 白底+照片在左+右侧品牌名和参数(印象右留白)
        if (pos === 1) {
            const gm = S.globalMargin || 1;
            const pfScale = (S.paramFs != null && S.paramFs > 0) ? S.paramFs / 33 : 1;
            const rightW = Math.max(160, Math.round(iw * 0.35 * gm));
            const sidePad = Math.max(30, Math.round(size * 0.8 * gm));
            const w = iw + rightW + sidePad;
            const h = Math.round(ih * 1.08) + sidePad;
            // 白底
            g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
            // 照片垂直居中在左侧
            const py = Math.round((h - ih) / 2);
            g.drawImage(img, sidePad, py);
            // 右侧文字
            const tx = sidePad + iw + Math.round(rightW * 0.15);
            const brand = (S.cam && S.cam.brand) ? S.cam.brand.toUpperCase() : 'SONY';
            const fBrand = Math.max(22, Math.round(rightW * 0.16 * pfScale));
            g.fillStyle = '#1a1a1a';
            g.font = 'bold ' + fBrand + "px Georgia, 'Times New Roman', serif";
            g.textAlign = 'left';
            g.textBaseline = 'alphabetic';
            g.fillText(brand, tx, Math.round(h * 0.28));
            // 三行圆角方框参数
            if (S.useExif && S.cam) {
                const boxW = Math.round(rightW * 0.3 * pfScale);
                const boxH = Math.round(boxW * 0.55);
                const fBox = Math.max(11, Math.round(boxH * 0.45));
                const fVal = Math.max(13, Math.round(rightW * 0.09 * pfScale));
                const rows = [
                    { label: 'F', val: String(S.cam.aperture || '6.3').replace(/^f\//i, '').replace(/^F\//i, '') },
                    { label: 'ISO', val: String(S.cam.iso || '100').replace(/^iso/i, '') },
                    { label: 'S', val: String(S.cam.shutter || '1/125').replace(/s$/i, '') }
                ];
                let ry = Math.round(h * 0.48);
                rows.forEach(row => {
                    g.strokeStyle = '#333333';
                    g.lineWidth = Math.max(1.5, Math.round(boxH * 0.08));
                    g.beginPath();
                    if (typeof g.roundRect === 'function') g.roundRect(tx, ry - boxH, boxW, boxH, Math.round(boxH * 0.2));
                    else g.rect(tx, ry - boxH, boxW, boxH);
                    g.stroke();
                    g.fillStyle = '#333333';
                    g.font = 'bold ' + fBox + 'px sans-serif';
                    g.textAlign = 'center';
                    g.textBaseline = 'middle';
                    g.fillText(row.label, tx + boxW / 2, ry - boxH / 2);
                    g.font = 'bold ' + fVal + 'px sans-serif';
                    g.textAlign = 'left';
                    g.fillText(row.val, tx + boxW + Math.round(rightW * 0.06), ry - boxH / 2);
                    ry += Math.round(boxH * 1.9);
                });
            }
            return;
        }
        // LEFT/BOTTOM 分支保持原样
        const ref = Math.max(1, Math.min(iw, ih));
        const inset = Math.max(12, Math.floor(size / 2));
        const brand = trim(S.cam.brand), model = S.cam.model || '';
        const vertical = pos !== 2;
        let line = vertical ? (brand + ' ' + model).trim() : ((brand + ' ' + model).trim() + '   ' + exifLine(S.cam)).trim();
        if (!line) line = 'PHOTO';
        const along = vertical ? ih : iw;
        const f = fitFont(g, line, true, false, Math.max(12, Math.min(autoExifSize(S.paramFs, iw), Math.floor(along / 10))), Math.max(60, along - inset * 2), 0);
        const fm = textMetrics(g, line, f, true, false, 0);
        g.drawImage(img, 0, 0);
        paintScrim(g, iw, ih, pos, fm.height * 2 + inset);
        const textC = 'rgba(255,255,255,0.922)';
        if (vertical) {
            const ax = pos === 0 ? inset + fm.ascent : iw - inset - fm.ascent;
            const ay = pos === 0 ? ih - inset : inset;
            g.save();
            g.translate(ax, ay);
            g.rotate(pos === 0 ? -Math.PI / 2 : Math.PI / 2);
            drawShadowTextL(g, line, 0, 0, f, textC, true, false, 0);
            g.restore();
        } else {
            drawShadowTextL(g, line, cx2(iw, fm.w), ih - inset - fm.maxDescent, f, textC, true, false, 0);
        }
    }
    function styleOverlayLogo(img, size, g, iw, ih, S) {
        const inset = Math.max(14, Math.floor(size * 2 / 5));
        let brand = trim(S.cam.brand);
        if (!brand) brand = 'PHOTO';
        let fs = Math.max(16, Math.min(96, Math.round(autoExifSize(S.paramFs, iw))));
        let track = 1, tw = 0;
        for (; fs > 10; fs--) {
            track = Math.max(1, Math.round(fs * 0.45));
            tw = textMetrics(g, brand, fs, false, true, track).w;
            if (tw <= iw - inset * 2) break;
        }
        track = Math.max(1, Math.round(fs * 0.45));
        const wm = textMetrics(g, brand, fs, false, true, track);
        tw = wm.w;
        g.drawImage(img, 0, 0);
        paintScrim(g, iw, ih, 2, wm.height * 3 + inset);
        const baseY = ih - inset - wm.maxDescent;
        const x = cx2(iw, tw);
        const toff = Math.max(1, Math.floor(fs / 24));
        setFont(g, fs, false, true);
        g.fillStyle = 'rgba(0,0,0,0.588)';
        let sx = x;
        for (let i = 0; i < brand.length; i++) {
            g.fillText(brand[i], sx + toff, baseY + toff);
            sx += charW(g, brand[i], fs, false, true) + track;
        }
        g.fillStyle = 'rgba(255,255,255,0.941)';
        sx = x;
        for (let i = 0; i < brand.length; i++) {
            g.fillText(brand[i], sx, baseY);
            sx += charW(g, brand[i], fs, false, true) + track;
        }
    }
    function extractMultipleDominant(img, n) {
        const key = imgKey(img) + ':multi:' + n;
        if (_multiCache[key]) return _multiCache[key].slice();
        const iw = Math.max(1, img.naturalWidth || 1), ih = Math.max(1, img.naturalHeight || 1);
        const sw = Math.min(48, iw);
        const sh = Math.max(1, Math.floor(sw * ih / iw));
        // smallImageCached 已按最小边 48 绘制缩略图,直接取数据,不必重复 drawImage
        const sg = smallImageCached(img, 48).g;
        const { data } = sg.getImageData(0, 0, sw, sh);
        const bins = 12;
        const map = {};
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
            const i = (y * sw + x) * 4;
            const ri = Math.floor(data[i] * bins / 256), gi = Math.floor(data[i + 1] * bins / 256), bi = Math.floor(data[i + 2] * bins / 256);
            const key = ri + ',' + gi + ',' + bi;
            map[key] = (map[key] || 0) + 1;
        }
        const keys = Object.keys(map).sort((a, k) => map[k] - map[a]);
        const rnd = javaRandom(42);
        const out = [];
        for (let i = 0; i < n; i++) {
            if (i < keys.length) {
                const p = keys[i].split(',').map(Number);
                out.push('rgb(' + Math.min(255, Math.floor(p[0] * 256 / bins + 8)) + ',' + Math.min(255, Math.floor(p[1] * 256 / bins + 8)) + ',' + Math.min(255, Math.floor(p[2] * 256 / bins + 8)) + ')');
            } else {
                out.push('rgb(' + (50 + rnd(180)) + ',' + (50 + rnd(180)) + ',' + (50 + rnd(180)) + ')');
            }
        }
        _multiCache[key] = out.slice();
        return out;
    }
    const COLOR_SWATCHES = ['rgb(220,80,60)', 'rgb(60,140,200)', 'rgb(240,200,50)', 'rgb(80,180,100)', 'rgb(180,100,180)'];
    function styleColorClassic(img, size, g, iw, ih, S) {
        const fs = Math.max(10, Math.round(autoExifSize(S.paramFs, iw)));
        const barH = Math.max(40, size, Math.round(fs * 5 / 3)), pad = Math.max(8, Math.floor(size / 2));
        const w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        const barY = ih + pad;
        const cols = extractMultipleDominant(img, 5);
        const swatchH = barH, swW = Math.floor(w / cols.length);
        for (let i = 0; i < cols.length; i++) { g.fillStyle = cols[i]; g.fillRect(i * swW, barY, swW, swatchH); }
        const label = S.cam.brand + ' ' + S.cam.model;
        g.fillStyle = '#ffffff';
        g.font = 'bold ' + fs + 'px sans-serif';
        g.fillText(label, 12, barY + Math.floor(barH / 2) + Math.floor(fs / 3));
    }
    function styleColorRefined(img, size, g, iw, ih, S) {
        const barH = Math.max(50, Math.floor(size * 4 / 3)), pad = Math.max(8, Math.floor(size / 2));
        const w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = 'rgb(245,245,245)'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        const barY = ih + pad;
        const cols = extractMultipleDominant(img, 5);
        const swatchH = Math.floor(barH * 3 / 5), swW = Math.floor(w / cols.length);
        for (let i = 0; i < cols.length; i++) { g.fillStyle = cols[i]; g.fillRect(i * swW, barY, swW, swatchH); }
        const fs = Math.max(9, Math.floor(size / 4));
        const f = autoExifSize(S.paramFs, iw);
        const line = S.cam.focal + '  ' + S.cam.aperture + '  ' + S.cam.iso + '  ' + S.cam.shutter;
        const fm = textMetrics(g, line, f, true, false, 0);
        drawTextL(g, line, 12, barY + swatchH + Math.floor((barH - swatchH + fm.ascent) / 2), 'rgb(60,60,60)', f, true, false, 0);
    }
    function styleArtCard(img, size, g, iw, ih, S) {
        const fs = Math.max(11, Math.round(autoExifSize(S.paramFs, iw)));
        const barH = Math.max(36, size, Math.round(fs * 5 / 3)), pad = Math.max(8, Math.floor(size / 2));
        const w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        const barY = ih + pad;
        const swatchH = Math.floor(barH * 2 / 3), swW = Math.floor(w / COLOR_SWATCHES.length);
        for (let i = 0; i < COLOR_SWATCHES.length; i++) { g.fillStyle = COLOR_SWATCHES[i]; g.fillRect(i * swW, barY, swW, swatchH); }
        const model = 'GFX ' + S.cam.model;
        const mfw = textMetrics(g, model, fs, false, true, 0);
        drawTextL(g, model, w - pad - mfw.w, barY + swatchH + Math.floor((barH - swatchH + fs) / 2), 'rgb(60,60,60)', fs, false, true, 0);
    }
    function styleFujiWhite(img, size, g, iw, ih, S) {
        const pad = Math.max(12, Math.round(iw * 0.02));
        const fs = Math.max(11, Math.round(autoExifSize(S.paramFs, iw)));
        const f2 = Math.round(fs * 0.85);
        const lineGap = Math.round(fs * 0.6);
        // 两行总高度 + 上下留白
        const totalTextH = fs + lineGap + f2;
        const padBottom = Math.round(fs * 0.6);
        const barH = totalTextH + padBottom * 2;
        const w = iw + pad * 2, h = ih + pad + barH;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad);
        // 文字在barH内垂直居中
        const barY = ih + pad;
        const startY = barY + padBottom;
        const line1 = 'FUJIFILM ' + S.cam.model;
        const m1 = textMetrics(g, line1, fs, false, true, 0);
        drawTextL(g, line1, cx2(w, m1.w), startY + fs, 'rgb(40,40,40)', fs, false, true, 0);
        const line2 = S.cam.focal + '  ' + S.cam.aperture + '  ' + S.cam.iso + '  ' + S.cam.shutter;
        const m2 = textMetrics(g, line2, f2, true, false, 0);
        drawTextL(g, line2, cx2(w, m2.w), startY + fs + lineGap + f2, 'rgb(120,120,120)', f2, true, false, 0);
    }
    function styleSimpleFilm(img, size, g, iw, ih, S) {
        const w = iw + size * 2, h = ih + size * 2;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
        const f = autoExifSize(S.paramFs, iw);
        const info = S.cam.focal + '  ' + S.cam.aperture;
        const fm = textMetrics(g, info, f, true, false, 0);
        drawTextL(g, info, size + Math.floor((iw - fm.w) / 2), h - Math.floor(size / 2), 'rgb(140,140,140)', f, true, false, 0);
    }
    function styleParamTopLeft(img, size, g, iw, ih, S) {
        const w = iw + size * 2, h = ih + size * 2;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
        const fs = Math.max(9, Math.floor(size / 4));
        const f = autoExifSize(S.paramFs, iw);
        const line = S.cam.focal + '  ' + S.cam.aperture + '  ' + S.cam.iso + '  ' + S.cam.shutter;
        drawTextL(g, line, size + 8, size + fs + 4, 'rgb(100,100,100)', f, true, false, 0);
    }
    function styleParamBottomLeft(img, size, g, iw, ih, S) {
        const w = iw + size * 2, h = ih + size * 2;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
        const f = autoExifSize(S.paramFs, iw);
        const line = S.cam.brand + ' ' + S.cam.model + '  |  ' + S.cam.focal + '  ' + S.cam.aperture + '  ' + S.cam.iso + '  ' + S.cam.shutter;
        drawTextL(g, line, size + 8, h - size - 4, 'rgb(100,100,100)', f, true, false, 0);
    }
    function styleParamBottomSingle(img, size, g, iw, ih, S) {
        const w = iw + size * 2, h = ih + size * 2;
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, size, size);
        const f = autoExifSize(S.paramFs, iw);
        const info = S.cam.focal + '  ' + S.cam.aperture;
        const fm = textMetrics(g, info, f, true, false, 0);
        drawTextL(g, info, cx2(w, fm.w), h - Math.floor(size / 2), 'rgb(140,140,140)', f, true, false, 0);
    }
    function drawTrackedTextL(g, text, cx, baselineY, px, color, trackRatio, mono, forcedX) {
        const track = Math.max(1, Math.round(px * trackRatio));
        const fm = textMetrics(g, text, px, mono, true, track);
        const x0 = forcedX != null ? forcedX : cx - Math.floor(fm.w / 2);
        setFont(g, px, mono, true);
        g.fillStyle = color;
        let x = x0;
        for (let i = 0; i < text.length; i++) {
            g.fillText(text[i], x, baselineY);
            x += charW(g, text[i], px, mono, true) + track;
        }
    }

    // 未实现风格:中性底 + 风格名(占位)
    function stylePlaceholder(img, name, g, iw, ih) {
        g.fillStyle = '#f0f0f0';
        g.fillRect(0, 0, iw + 60, ih + 60);
        g.drawImage(img, 30, 30);
        g.strokeStyle = '#cccccc';
        g.lineWidth = 1;
        g.strokeRect(29.5, 29.5, iw + 1, ih + 1);
        drawText(g, name, 34, ih + 50, 16, '#999999', false, true);
    }

    // 阶段二渲染状态(模板参数 → 原版静态参数)
    function buildState(app, styleName, iw, ih, size) {
        const t = app.template;
        const cc = t.cornerConfig || {};
        const clampP = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v == null ? 0 : v)));
        // 合并 EXIF:面板手动(manualExif:brand/model/focal/aperture/iso/shutter)优先,缺失项用照片自动识别 exif
        const manual = (t.manualExif && typeof t.manualExif === 'object') ? t.manualExif : {};
        const auto = app.image.exif || {};
        const exif = {
            make: (manual.brand || '').trim() || auto.make || '',
            model: (manual.model || '').trim() || auto.model || '',
            focal: (manual.focal || '').trim() || auto.focal || '',
            aperture: (manual.aperture || '').trim() || auto.aperture || '',
            iso: (manual.iso || '').trim() || auto.iso || '',
            shutter: (manual.shutter || '').trim() || auto.shutter || '',
        };
        // 0(未指定) = 自适应:按照片短边/45,clamp 20~64(原版 autoParamFontSize 同规则)
        const rawPf = t.paramFontSize != null ? t.paramFontSize : 35;
        const autoPf = Math.max(20, Math.min(64, Math.round(Math.min(iw, ih) / 45)));
        return {
            size,
            exif,
            cam: cameraFor(styleName, iw, ih, exif),
            paramFs: rawPf > 0 ? clampP(rawPf, 2, 160) : autoPf,
            blurIntensity: clampP(t.blurIntensity != null ? t.blurIntensity : 50, 0, 100),
            paramType: clampP(t.paramType != null ? t.paramType : 0, 0, 2),
            position: positionOf(t.paramPosition),
            useExif: true,
            cornerAll: cc.cornerRadiusAll != null ? cc.cornerRadiusAll : 30,
            imgScale: (t.baseMargin && (t.baseMargin.imgScale || 1)) || 1,
            imgOffsetX: (t.baseMargin && t.baseMargin.imgOffsetX) || 0,
            imgOffsetY: (t.baseMargin && t.baseMargin.imgOffsetY) || 0,
            globalMargin: (t.baseMargin && t.baseMargin.globalMargin) || 1,
            shadowSize: clampP(t.shadowSize != null ? t.shadowSize : 0, 0, 80),
            shadowDepth: clampP(t.shadowDepth != null ? t.shadowDepth : 30, 0, 100),
            shadowAlpha: 80,
            aiCaption: String(t.aiCaption || '').trim(),
            aiCapLayout: clampP(t.aiCapLayout != null ? t.aiCapLayout : 0, 0, 2),
            aiCapFontIdx: clampP(t.aiCapFontIdx != null ? t.aiCapFontIdx : 0, 0, 3),
            aiCapSizePct: clampP(t.aiCapSizePct != null ? t.aiCapSizePct : 100, 50, 200),
            aiCapTheme: clampP(t.aiCapTheme != null ? t.aiCapTheme : 0, 0, 2),
            userSignature: String(t.userSignature || '').trim(),
            signFont: String(t.signFont || 'cursive'),
            signColor: String(t.signColor || '#555'),
            avatarScale: Number(t.avatarScale || 0.85),
            signSize: Number(t.signSize || 1),
            signBgBlur: Number(t.signBgBlur || 0),
            paramColor: String(t.paramColor || 'auto'),
            avatarOffX: Number(t.avatarOffX || 0),
            avatarOffY: Number(t.avatarOffY || 0),
            avatarSelected: !!t.avatarSelected,
            logoSize: clampP(t.logoSize != null ? t.logoSize : 14, 0, 200),
        };
    }

    // ── 品牌 Logo(LogoResource.java 移植)──
    // 与 Java 严格同算法:width() 返回 fs*系数,logoSz 须代入同一公式比对。
    function logoWidth(brand, logoFs) {
        const b = String(brand || 'CAMERA').toUpperCase();
        const fs = logoFs;
        switch (b) {
            case 'LEICA': return fs * 5;
            case 'CANON': return fs * 4;
            case 'NIKON': return fs * 4;
            case 'FUJIFILM': return fs * 7;
            case 'SONY': return fs * 4;
            case 'HASSELBLAD': return fs * 8;
            case 'LUMIX': case 'PANASONIC': return fs * 5;
            case 'OLYMPUS': return fs * 6;
            case 'PENTAX': return fs * 5;
            case 'RICOH': return fs * 4;
            case 'ZEISS': return fs * 4;
            case 'DJI': return fs * 3;
            case 'APPLE': return fs * 4;
            case 'HONOR': return fs * 4;
            case 'HUAWEI': return fs * 5;
            case 'OPPO': return fs * 4;
            case 'SAMSUNG': return fs * 6;
            case 'VIVO': return fs * 4;
            case 'MI': case 'XIAOMI': return fs * 3;
            case 'CAMERA': return fs * 5;
            default: return fs * Math.min(String(brand || 'CAMERA').length, 8);
        }
    }
    function logoStrWidth(g, s, fs, bold) { return textMetrics(g, s, fs, false, bold, 0).w; }
    function logoFillRect(g, x, y, w, h) { g.fillRect(x, y, Math.max(0, w), Math.max(0, h)); }
    function logoRoundRect(g, x, y, w, h, r) {
        const rr = Math.max(1, r);
        g.beginPath();
        if (g.roundRect) { g.roundRect(x, y, w, h, rr, rr); g.fill(); return; }
        g.moveTo(x + rr, y);
        g.lineTo(x + w - rr, y);
        g.arcTo(x + w, y, x + w, y + rr, rr);
        g.lineTo(x + w, y + h - rr);
        g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
        g.lineTo(x + rr, y + h);
        g.arcTo(x, y + h, x, y + h - rr, r);
        g.lineTo(x, y + rr);
        g.arcTo(x, y, x + rr, y, r);
        g.closePath();
        g.fill();
    }
    // 品牌→唯一文本(用于 LogoResource 目前"文字近似"的绘制)
    function drawLogo(g, brand, x, y, logoFs) {
        const b = String(brand || 'CAMERA').toUpperCase();
        const fs = logoFs;
        // 统一用印象毛玻璃同款衬线字体:Georgia + 字间距
        g.font = 'bold ' + fs + "px Georgia, 'Times New Roman', serif";
        g.letterSpacing = Math.round(fs * 0.15);
        g.fillStyle = g.fillStyle; // 保留调用方设的颜色
        g.fillText(b, x, y);
        g.letterSpacing = 0;
        return textMetrics(g, b, fs, false, true, 0).w;
    }
    function _oldDrawLogo(g, brand, x, y, logoFs) {
        const b = String(brand || 'CAMERA').toUpperCase();
        const fs = logoFs;
        const txtL = (s, bold, subFs) => { const f = subFs || fs; setFont(g, f, false, bold); g.fillText(s, x, y); };
        const txtW = (s, bold) => textMetrics(g, s, logoFs, false, bold, 0).w;
        const total = logoWidth(brand, fs);
        if (b === 'LEICA') {
            const dotR = Math.round(fs / 3);
            g.fillStyle = 'rgb(200,30,30)';
            g.beginPath(); g.arc(x, y - dotR, dotR, 0, Math.PI * 2); g.fill();
            g.fillStyle = '#000';
            x += dotR * 3 + Math.round(fs / 3); txtL('LEICA', true);
            return total;
        } else if (b === 'CANON') {
            g.fillStyle = 'rgb(200,30,30)'; txtL('Canon', true); return total;
        } else if (b === 'NIKON') {
            const barW = fs * 4, barH = Math.round(fs * 0.7);
            g.fillStyle = 'rgb(255,200,0)'; logoRoundRect(g, x, y - barH, barW, barH, Math.round(fs / 5));
            g.fillStyle = '#000'; x += Math.round(fs / 3); y -= Math.round(fs / 8); txtL('NIKON', true); return total;
        } else if (b === 'FUJIFILM') {
            const w = fs * 7, h = Math.round(fs * 11 / 12);
            g.fillStyle = 'rgb(40,120,60)'; logoRoundRect(g, x, y - h + Math.round(fs / 4), w, h, Math.round(fs / 4));
            g.fillStyle = '#fff'; x += Math.round(fs / 3); y += Math.round(fs / 8); txtL('FUJIFILM', true); return total;
        } else if (b === 'SONY') { g.fillStyle = 'rgb(0,80,160)'; txtL('SONY', true); return total; }
        else if (b === 'HASSELBLAD') {
            g.fillStyle = '#000'; txtL('HASSELBLAD', true);
            g.fillStyle = 'rgb(180,0,0)'; logoFillRect(g, x + Math.round(fs / 2), y + Math.round(fs / 6), fs * 2, Math.round(fs / 10));
            return total;
        } else if (b === 'LUMIX' || b === 'PANASONIC') {
            g.fillStyle = '#000'; txtL('LUMIX', true);
            g.fillStyle = 'rgb(0,120,200)'; logoFillRect(g, x + txtW('LUMIX', true) + Math.round(fs / 4), y - Math.round(fs / 4), Math.round(fs * 3 / 4), Math.round(fs / 6));
            return total;
        } else if (b === 'OLYMPUS') { g.fillStyle = '#000'; txtL('OLYMPUS', true); return total; }
        else if (b === 'PENTAX') { g.fillStyle = 'rgb(0,60,120)'; txtL('PENTAX', true); return total; }
        else if (b === 'RICOH') { g.fillStyle = 'rgb(0,80,160)'; txtL('RICOH', true); return total; }
        else if (b === 'ZEISS') {
            g.fillStyle = 'rgb(0,60,180)'; txtL('ZEISS', true);
            g.strokeStyle = 'rgba(0,60,180,0.196)';
            g.lineWidth = Math.max(1, Math.round(fs / 8));
            g.beginPath(); g.ellipse(x - Math.round(fs / 4), y - Math.round(fs * 11 / 12), Math.round(fs * 11 / 20), Math.round(fs * 3 / 4), 0, 0, Math.PI * 2); g.stroke();
            return total;
        } else if (b === 'DJI') {
            g.fillStyle = '#000'; txtL('DJI', true);
            const dotR = Math.round(fs / 5);
            g.fillStyle = 'rgb(200,30,30)';
            g.beginPath(); g.arc(x + txtW('DJI', true) + Math.round(fs / 3), y - dotR, dotR, 0, Math.PI * 2); g.fill();
            return total;
        } else if (b === 'APPLE') { g.fillStyle = 'rgb(80,80,80)'; txtL('iPhone', false); return total; }
        else if (b === 'HONOR') { g.fillStyle = '#000'; txtL('HONOR', true); return total; }
        else if (b === 'HUAWEI') { g.fillStyle = 'rgb(200,30,30)'; txtL('HUAWEI', true); return total; }
        else if (b === 'OPPO') { g.fillStyle = 'rgb(80,80,80)'; txtL('OPPO', true); return total; }
        else if (b === 'SAMSUNG') { g.fillStyle = 'rgb(0,100,200)'; txtL('SAMSUNG', true); return total; }
        else if (b === 'VIVO') { g.fillStyle = 'rgb(0,80,200)'; txtL('vivo', true); return total; }
        else if (b === 'MI' || b === 'XIAOMI') { g.fillStyle = 'rgb(255,100,0)'; txtL('MI', true); return total; }
        else if (b === 'SIGMA') {
            g.fillStyle = 'rgb(190,30,45)';
            g.beginPath(); g.moveTo(x, y - Math.round(fs * 3 / 4)); g.lineTo(x + Math.round(fs / 2), y); g.lineTo(x, y + Math.round(fs * 3 / 4)); g.closePath(); g.fill();
            g.fillStyle = '#000'; x += Math.round(fs * 3 / 4); txtL('SIGMA', true); return total;
        } else if (b === 'TAMRON') {
            g.strokeStyle = 'rgb(0,90,170)';
            g.lineWidth = Math.max(1, Math.round(fs / 8));
            g.beginPath(); g.arc(x + Math.round(fs * 3 / 8), y, Math.round(fs * 3 / 8), 0, Math.PI * 2); g.stroke();
            g.fillStyle = '#000'; x += fs; txtL('TAMRON', true); return total;
        } else if (b === 'GOPRO') {
            g.fillStyle = '#000'; logoRoundRect(g, x, y - Math.round(fs * 3 / 4), fs * 3, Math.round(fs * 3 / 2), Math.round(fs / 4));
            g.fillStyle = '#fff'; x += Math.round(fs / 4); y += Math.round(fs / 8); txtL('GoPro', true, Math.round(fs * 3 / 4)); return total;
        } else if (b === 'INSTA360') {
            g.fillStyle = '#000'; txtL('INSTA360', true);
            g.fillStyle = 'rgb(220,30,40)';
            g.beginPath(); g.arc(x + txtW('INSTA360', true) + Math.round(fs / 3), y - Math.round(fs / 6), Math.round(fs / 6), 0, Math.PI * 2); g.fill();
            return total;
        } else if (b === 'RED') {
            g.fillStyle = 'rgb(200,20,25)'; logoFillRect(g, x, y - Math.round(fs * 3 / 4), fs * 2, Math.round(fs * 3 / 2));
            g.fillStyle = '#fff'; x += Math.round(fs / 4); y += Math.round(fs / 8); txtL('RED', true, Math.round(fs * 3 / 4)); return total;
        } else if (b === 'BLACKMAGIC') { g.fillStyle = 'rgb(10,10,10)'; txtL('Blackmagic', true); return total; }
        else if (b === 'KODAK') {
            g.fillStyle = 'rgb(240,200,0)'; logoFillRect(g, x, y - Math.round(fs * 3 / 4), fs * 3, Math.round(fs * 3 / 2));
            g.fillStyle = 'rgb(190,25,30)'; x += Math.round(fs / 4); y += Math.round(fs / 8); txtL('KODAK', true, Math.round(fs * 3 / 4)); return total;
        } else if (b === 'POLAROID') {
            const bw = fs * 3, h = Math.round(fs / 5), y0 = y - Math.round(fs * 3 / 4);
            const rainbow = ['rgb(230,60,50)', 'rgb(245,170,40)', 'rgb(240,220,60)', 'rgb(80,180,80)', 'rgb(70,150,220)', 'rgb(140,90,200)'];
            for (let i = 0; i < rainbow.length; i++) { g.fillStyle = rainbow[i]; logoFillRect(g, x + i * Math.floor(bw / rainbow.length), y0 + i * Math.floor(h / 2), Math.floor(bw / rainbow.length) + 1, h); }
            g.fillStyle = '#000'; x += Math.round(fs / 6); y += Math.round(fs / 6); txtL('Polaroid', true); return total;
        } else if (b === 'PHASE ONE' || b === 'PHASEONE') { g.fillStyle = '#000'; txtL('Phase One', true); return total; }
        else if (b === 'MAMIYA') { g.fillStyle = 'rgb(30,30,30)'; txtL('MAMIYA', true); return total; }
        else if (b === 'CASIO') { g.fillStyle = 'rgb(0,90,190)'; txtL('CASIO', true); return total; }
        else if (b === 'AGFA') { g.fillStyle = 'rgb(190,25,30)'; txtL('AGFA', true); return total; }
        else if (b === 'REDMI') { g.fillStyle = 'rgb(255,100,0)'; txtL('Redmi', true); return total; }
        else if (b === 'REALME') { g.fillStyle = 'rgb(240,190,30)'; txtL('realme', true); return total; }
        else if (b === 'ONEPLUS') {
            g.fillStyle = 'rgb(200,20,20)'; txtL('OnePlus', true);
            const tw = txtW('OnePlus', true);
            g.strokeStyle = '#000'; g.lineWidth = Math.max(1, Math.round(fs / 8));
            const x0 = x + tw + Math.round(fs / 3), xi = Math.round(fs);
            g.beginPath(); g.moveTo(x0, y - Math.round(fs / 3)); g.lineTo(x0 + xi, y + Math.round(fs / 3)); g.moveTo(x0, y + Math.round(fs / 3)); g.lineTo(x0 + xi, y - Math.round(fs / 3)); g.stroke();
            return total;
        } else if (b === 'IQOO') { g.fillStyle = 'rgb(0,100,220)'; txtL('iQOO', true); return total; }
        else if (b === 'GOOGLE') { g.fillStyle = 'rgb(60,90,200)'; txtL('Google', true); return total; }
        else if (b === 'NOTHING') { g.fillStyle = 'rgb(20,20,20)'; txtL('Nothing', false); return total; }
        else if (b === 'MOTOROLA') { g.fillStyle = 'rgb(25,25,25)'; txtL('MOTOROLA', true); return total; }
        else if (b === 'NOKIA') { g.fillStyle = 'rgb(0,90,200)'; txtL('NOKIA', true); return total; }
        else if (b === 'MEIZU') { g.fillStyle = 'rgb(0,90,200)'; txtL('MEIZU', true); return total; }
        else if (b === 'ZTE') { g.fillStyle = 'rgb(0,110,190)'; txtL('ZTE', true); return total; }
        else if (b === 'ASUS') { g.fillStyle = 'rgb(0,90,190)'; txtL('ASUS', true); return total; }
        else if (b === 'LG') { g.fillStyle = 'rgb(90,90,90)'; txtL('LG', true); return total; }
        else if (b === 'HTC') { g.fillStyle = 'rgb(0,140,90)'; txtL('HTC', true); return total; }
        else if (b === 'TECNO') { g.fillStyle = 'rgb(25,25,25)'; txtL('TECNO', true); return total; }
        else if (b === 'INFINIX') { g.fillStyle = 'rgb(0,150,170)'; txtL('Infinix', true); return total; }
        else if (b === 'LENOVO') { g.fillStyle = 'rgb(0,100,190)'; txtL('Lenovo', true); return total; }
        else if (b === 'ROLLEI') { g.fillStyle = 'rgb(180,25,30)'; txtL('ROLLEIFLEX', true); return total; }
        else if (b === 'CONTAX') {
            g.fillStyle = 'rgb(40,40,40)'; txtL('CONTAX', true);
            g.fillStyle = 'rgb(200,30,30)'; logoFillRect(g, x + txtW('CONTAX', true) + Math.round(fs / 4), y - Math.round(fs / 4), Math.round(fs * 3 / 4), Math.round(fs / 6));
            return total;
        } else if (b === 'VOIGTLANDER' || b === 'VOIGTLÄNDER') { g.fillStyle = 'rgb(30,30,30)'; txtL('Voigtländer', true); return total; }
        else if (b === 'HORSEMAN') { g.fillStyle = 'rgb(25,25,25)'; txtL('HORSEMAN', true); return total; }
        else if (b === 'LINHOF') { g.fillStyle = 'rgb(20,20,20)'; txtL('LINHOF', true); return total; }
        else if (b === 'TOYO') { g.fillStyle = 'rgb(0,90,170)'; txtL('TOYO', true); return total; }
        else if (b === 'SEAGULL') { g.fillStyle = 'rgb(200,25,30)'; txtL('SEAGULL', true); return total; }
        else if (b === 'LOMO') { g.fillStyle = 'rgb(0,90,200)'; txtL('LOMO', true); return total; }
        else if (b === 'ALPA') { g.fillStyle = 'rgb(25,25,25)'; txtL('ALPA', true); return total; }
        else if (b === 'NUBIA') { g.fillStyle = 'rgb(200,20,20)'; txtL('nubia', true); return total; }
        else if (b === 'REDMAGIC') { g.fillStyle = 'rgb(200,15,25)'; txtL('REDMAGIC', true); return total; }
        else if (b === 'BLACKSHARK') { g.fillStyle = 'rgb(25,25,25)'; txtL('BLACK SHARK', true); return total; }
        else if (b === 'ITEL') { g.fillStyle = 'rgb(0,100,200)'; txtL('itel', true); return total; }
        else if (b === 'DOOGEE') { g.fillStyle = 'rgb(0,120,210)'; txtL('DOOGEE', true); return total; }
        else if (b === 'ULEFONE') { g.fillStyle = 'rgb(0,110,190)'; txtL('Ulefone', true); return total; }
        else if (b === 'CAT') { g.fillStyle = 'rgb(245,170,0)'; txtL('CAT', true); return total; }
        else if (b === 'VERTU') { g.fillStyle = 'rgb(150,110,50)'; txtL('VERTU', true); return total; }
        else if (b === 'CAMERA') { g.fillStyle = 'rgb(120,120,120)'; txtL('CAMERA', true); return total; }
        else { g.fillStyle = 'rgb(80,80,80)'; txtL(String(brand || 'CAMERA').slice(0, 10), true); return total; }
    }

    // 成品尺寸(与原版几何一致)
    function styleDims(name, iw, ih, size, S) {
        const pad2 = v => Math.max(v, Math.floor(size / 2));
        switch (name) {
            case 'SIMPLE':
            case 'ROUNDED':
            case 'WHITE_PLAIN':
            case 'VINTAGE':
            case 'GRADIENT':
            case 'DOUBLE_LINE':
            case 'SIMPLE_FILM':
            case 'PARAM_TOP_LEFT':
            case 'PARAM_BOTTOM_LEFT':
            case 'PARAM_BOTTOM_SINGLE':
                return { w: iw + size * 2, h: ih + size * 2 };
            case 'FILM_STRIP': {
                const railH = Math.max(20, size);
                return { w: iw + size * 2, h: ih + railH * 2 };
            }
            case 'POLAROID': {
                const pfs = Math.max(10, Math.round(autoExifSize((S ? S.paramFs : 12), iw)));
                const pbottom = Math.max(size * 3, Math.round(pfs * 2.6));
                return { w: iw + size * 2, h: ih + size + pbottom };
            }
            case 'DROP_SHADOW': {
                const offset = Math.max(8, Math.floor(size / 2));
                return { w: iw + size * 2 + offset, h: ih + size * 2 + offset };
            }
            case 'BLUR_CLASSIC':
            case 'BLUR_DATE': {
                const side = blurBand(size, iw, ih, (S ? S.blurIntensity : 50));
                const bottom = S ? blurBottom(size, iw, ih, S) : side;
                return { w: iw + side * 2, h: ih + side + bottom };
            }
            case 'WM_CLASSIC': {
                const barH = Math.max(50, size);
                return { w: iw + size * 2, h: ih + size + barH };
            }
            case 'WM_SINGLE': {
                const barH = Math.max(32, size), pad = pad2(8);
                return { w: iw + pad * 2, h: ih + pad + barH };
            }
            case 'WM_BRAND_LOGO': {
                const barH = Math.max(56, Math.floor(size * 3 / 2));
                return { w: iw + size * 2, h: ih + size + barH };
            }
            case 'WM_AI': {
                const cap = S ? S.aiCaption : '';
                const twoLine = cap && (!S || S.aiCapLayout !== 1);
                let barH = Math.max(twoLine ? 64 : 44, Math.floor(size * (twoLine ? 3 : 2) / 2));
                const pct = S ? S.aiCapSizePct : 100;
                barH += Math.floor(barH * Math.max(0, pct - 100) / 250);
                const pad = pad2(8);
                return { w: iw + pad * 2, h: ih + pad + barH };
            }
            case 'IMP_FROSTED': {
                const lw = Math.max(180, Math.round(iw * 0.35));
                const rp = Math.round(lw / 2);
                const tbp = Math.max(50, Math.round(size * 1.2));
                return { w: lw + iw + rp, h: ih + tbp * 2 };
            }
            case 'FUJI_WM':
            case 'FUJI_WM_BRAND':
            case 'DARK_BRAND_ONLY': {
                const op = Math.max(15, Math.round(size * 0.5));
                return { w: iw + op * 2, h: ih + op * 2 };
            }
            case 'IMP_CLASSIC':
                return { w: iw + pad2(8) * 2, h: ih + pad2(8) * 2 };
            case 'XIAOMI_IMP': {
                const topPad = Math.max(20, Math.floor(size / 2));
                const barH = Math.max(50, size * 2);
                const sidePad = Math.max(6, Math.floor(size / 3));
                return { w: iw + sidePad * 2, h: ih + topPad + barH };
            }
            case 'CARD_LEICA': {
                const pad = Math.max(24, Math.floor(size * 3 / 4));
                const f1 = autoExifSize((S ? S.paramFs : 12), iw), f2 = Math.max(12, Math.floor(f1 * 2 / 3));
                const maxFs = Math.max(f1, f2);
                return { w: iw + pad * 2, h: ih + pad + Math.max(52, Math.floor(maxFs * 5 / 2)) };
            }
            case 'CARD_LOGO_PARAM': {
                const pad = Math.max(28, Math.floor(size * 3 / 5));
                const f1 = autoExifSize((S ? S.paramFs : 12), iw), f2 = Math.max(12, Math.floor(f1 * 2 / 3));
                const h1 = Math.round(f1), h2 = Math.round(f2);
                const gap = Math.max(8, Math.floor(h1 / 4));
                const bandH = Math.max(56, Math.floor((h1 + gap + h2) + pad * 2 / 3));
                return { w: iw + pad * 2, h: ih + pad + bandH };
            }
            case 'CARD_PURE_LOGO': {
                const pad = Math.max(32, size);
                const wf = Math.max(20, Math.min(96, Math.round(autoExifSize((S ? S.paramFs : 12), iw))));
                const extra = Math.max(Math.round(wf) * 3, size);
                return { w: iw + pad * 2, h: ih + pad + extra };
            }
            case 'CARD_SIMPLE': {
                const pad = Math.max(12, Math.floor(size / 2));
                const fmH = Math.round(autoExifSize((S ? S.paramFs : 12), iw));
                const capH = Math.floor(fmH * 5 / 3) + Math.max(6, Math.floor(pad / 4));
                return { w: iw + pad * 2, h: ih + pad + capH + Math.max(10, Math.floor(pad / 2)) };
            }
            case 'CARD_IMMERSION': {
                const pad = Math.max(20, Math.floor(size * 2 / 5));
                const fmH = Math.round(autoExifSize((S ? S.paramFs : 12), iw));
                const bandH = fmH * 2 + Math.max(10, Math.floor(pad / 2));
                return { w: iw + pad * 2, h: ih + pad + bandH };
            }
            case 'OVERLAY_PARAM_LEFT':
            case 'OVERLAY_PARAM_LEFT':
            case 'OVERLAY_PARAM_RIGHT': {
                const rw = Math.max(160, Math.round(iw * 0.35));
                const sp = Math.max(30, Math.round(size * 0.8));
                return { w: iw + rw + sp, h: Math.round(ih * 1.08) + sp };
            };
            case 'OVERLAY_PARAM_BOTTOM': {
                const bh = Math.max(120, Math.round(ih * 0.25));
                const sp = Math.max(30, Math.round(size * 0.8));
                return { w: Math.round(iw * 1.05) + sp * 2, h: ih + bh + sp };
            };
            case 'COLOR_CLASSIC': {
                const pfs = Math.max(10, Math.round(autoExifSize((S ? S.paramFs : 12), iw)));
                const barH = Math.max(40, size, Math.round(pfs * 5 / 3)), pad = pad2(8);
                return { w: iw + pad * 2, h: ih + pad + barH };
            }
            case 'COLOR_REFINED': {
                const barH = Math.max(50, Math.floor(size * 4 / 3)), pad = pad2(8);
                return { w: iw + pad * 2, h: ih + pad + barH };
            }
            case 'ART_CARD':
            case 'FUJI_WHITE': {
                const af = Math.max(11, Math.round(autoExifSize((S ? S.paramFs : 12), iw)));
                const af2 = Math.round(af * 0.85);
                const pad = Math.max(12, Math.round(iw * 0.02));
                const lineGap = Math.round(af * 0.6);
                const padBottom = Math.round(af * 0.6);
                const barH = af + lineGap + af2 + padBottom * 2;
                return { w: iw + pad * 2, h: ih + pad + barH };
            }
            case 'STAMP_POSTAGE': {
                const sd = stampMatte(size);
                return { w: iw + sd.padX * 2, h: ih + sd.padY * 2 };
            }
            case 'TEARED_PAPER': {
                const tp = tornPaperParams(iw, ih, size);
                return { w: tp.bw + tp.pad * 2, h: tp.bh + tp.pad * 2 };
            }
            case 'FOLD_CORNER':
            case 'PINBOARD_TAPE':
                return { w: iw + size * 2, h: ih + size * 2 };
            case 'VHS_TAPE': {
                const sidePad = Math.max(8, Math.floor(size / 4));
                const barH = Math.max(28, Math.floor(size * 0.75));
                return { w: iw + sidePad * 2, h: ih + barH * 2 };
            }
            case 'ALBUM_CORNER': {
                const pad = Math.max(40, Math.floor(size * 1.2));
                return { w: iw + pad * 2, h: ih + pad * 2 };
            }
            case 'MOVIE_TICKET': {
                const topBot = Math.max(30, Math.floor(size * 0.8));
                const sidePad = Math.max(20, Math.floor(size * 0.6));
                const stubW = Math.max(100, Math.floor(iw * 0.18));
                return { w: iw + sidePad * 2 + stubW, h: ih + topBot * 2 };
            }
            case 'WATERCOLOR_BLEED': {
                const bleed = Math.max(50, Math.floor(size * 1.5));
                return { w: iw + bleed * 2, h: ih + bleed * 2 };
            }
            case 'CYBER_GLITCH': {
                const p = Math.max(40, Math.round(iw * 0.04));
                return { w: iw + p * 2, h: ih + p * 2 };
            }
            case 'TORN_JOURNAL': {
                const p = Math.max(50, Math.round(iw * 0.06));
                return { w: iw + p * 2, h: ih + p * 2 };
            }
            case 'POLAROID_HAND': {
                const border = Math.max(30, Math.round(iw * 0.05));
                const bottomPad = Math.max(100, Math.round(iw * 0.15));
                return { w: iw + border * 2, h: ih + border + bottomPad };
            }
            case 'CARD_3D': {
                const padX = Math.round(iw * 0.18);
                const padTop = Math.round(iw * 0.1);
                const padBottom = Math.round(iw * 0.2);
                return { w: iw + padX * 2, h: ih + padTop + padBottom };
            }
            case 'COMIC_PANEL': {
                const gap = Math.round(iw * 0.015);
                return { w: iw + gap * 3, h: ih + gap * 3 + Math.round(iw * 0.08) };
            }
            case 'NEWSPAPER': {
                const pad = Math.max(40, Math.round(iw * 0.04));
                const headH = Math.round(iw * 0.12);
                return { w: iw + pad * 2, h: ih + pad * 2 + headH + 50 };
            }
            case 'SIGNATURE': {
                const p = Math.max(30, Math.round(iw * 0.04));
                const bh = Math.round(iw * 0.12);
                return { w: iw + p * 2, h: ih + p + bh };
            }
            case 'SIGN_PARAM': {
                const p = Math.max(30, Math.round(iw * 0.04));
                const bh = Math.round(iw * 0.14);
                return { w: iw + p * 2, h: ih + p + bh };
            }
            case 'AVATAR_MEMO': {
                const p = Math.max(30, Math.round(iw * 0.05));
                const bh = Math.round(iw * 0.14);
                return { w: iw + p * 2, h: ih + p * 2 + bh };
            }
            case 'SIGN_BLUR': {
                const p = Math.max(30, Math.round(iw * 0.04));
                const bh = Math.round(iw * 0.14);
                return { w: iw + p * 2, h: ih + p + bh };
            }
            case 'SIG_BLUR': {
                const p = Math.max(30, Math.round(iw * 0.04));
                const bh = Math.round(iw * 0.10);
                return { w: iw + p * 2, h: ih + p + bh };
            }
            case 'AV_BLUR': {
                const p = Math.max(30, Math.round(iw * 0.05));
                const bh = Math.round(iw * 0.11);
                return { w: iw + p * 2, h: ih + p * 2 + bh };
            }
            case 'AV_OVERLAY':
            case 'AV_OVERLAY_TR':
            case 'AV_OVERLAY_BR':
            case 'AV_OVERLAY_BC':
            case 'AV_OVERLAY_BC2': {
                const p = Math.max(20, Math.round(iw * 0.03));
                return { w: iw + p * 2, h: ih + p * 2 };
            }
            case 'OVERLAY_PARAM_LEFT':
            case 'OVERLAY_PARAM_RIGHT': {
                const gm = (S && S.globalMargin) || 1;
                const leftW = Math.max(160, Math.round(iw * 0.35 * gm));
                const sidePad = Math.max(30, Math.round(size * 0.8 * gm));
                return { w: leftW + iw + sidePad, h: Math.round(ih * 1.08) + sidePad };
            }
            case 'OVERLAY_PARAM_BOTTOM': {
                const gm = (S && S.globalMargin) || 1;
                const bottomH = Math.max(120, Math.round(ih * 0.25 * gm));
                const sidePad = Math.max(30, Math.round(size * 0.8 * gm));
                return { w: iw + sidePad * 2, h: ih + bottomH + sidePad };
            }
            case 'OVERLAY_LOGO_BOTTOM': {
                const p = Math.max(30, Math.round(iw * 0.05));
                const bh = Math.round(iw * 0.15);
                return { w: iw + p * 2, h: ih + p + bh };
            }
            default:
                return { w: iw + 60, h: ih + 60 };
        }
    }

    function renderPhotoFrame(app) {
        const t = app.template;
        const styleName = String(t.photoFrameStyle || 'NONE').toUpperCase();
        const img = app.image.el;
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const displayMax = app.displayMax || DISPLAY_MAX;
        const size = scaledSize(img, Math.max(5, t.photoFrameBorderSize || 5));
        const canvas = app.dom.canvas;

        if (styleName === 'NONE') {
            const scale = Math.min(1, displayMax / Math.max(iw, ih));
            canvas.width = Math.max(1, Math.round(iw * scale));
            canvas.height = Math.max(1, Math.round(ih * scale));
            canvas._logW = canvas.width;
            canvas._logH = canvas.height;
            const g = canvas.getContext('2d');
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, canvas.width, canvas.height);
            g.save();
            g.scale(scale, scale);
            g.drawImage(img, 0, 0);
            g.restore();
            drawUserElements(g, t, canvas.width, canvas.height);
            app.applyZoomStyle();
            return;
        }

    
    // 深色身份卡: 横版证件卡,小照片在左,右侧信息文字
    function styleIdCard(img, size, g, iw, ih, S) {
        // 横版卡片: 宽 > 高
        const photoW = Math.round(iw * 0.45);
        const photoH = Math.round(photoW * ih / iw);
        const cardH = Math.round(photoH * 1.25);
        const cardW = Math.round(photoW * 2.4);
        const pad = Math.round((cardW - photoW) * 0.15);
        // 深灰卡底
        g.fillStyle = '#2d2d32'; g.fillRect(0, 0, cardW, cardH);
        // 顶部银色条
        g.fillStyle = '#c0c0c8'; g.fillRect(0, 0, cardW, Math.round(cardH * 0.08));
        // 小照片在左
        const px = pad, py = Math.round(cardH * 0.18);
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.4)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
        g.fillStyle = '#fff'; g.fillRect(px, py, photoW, photoH);
        g.restore();
        g.drawImage(img, px, py, photoW, photoH);
        // 右侧文字
        const tx = px + photoW + Math.round(pad * 1.5);
        g.fillStyle = '#e0e0e0';
        g.font = 'bold ' + Math.round(cardH * 0.08) + 'px sans-serif';
        g.textAlign = 'left';
        g.fillText('PERSONAL ID', tx, Math.round(cardH * 0.25));
        g.font = Math.round(cardH * 0.055) + 'px sans-serif';
        g.fillStyle = '#aaa';
        g.fillText('Name: PHOTO', tx, Math.round(cardH * 0.4));
        g.fillText('Sex:  M    Ethnic:  Han', tx, Math.round(cardH * 0.52));
        g.fillText('No.  110101******0000', tx, Math.round(cardH * 0.64));
        // 条形码
        g.fillStyle = '#666';
        for (let i = 0; i < 25; i++) {
            const bw = (i * 7) % 3 === 0 ? 2 : 1;
            g.fillRect(tx + i * 5, Math.round(cardH * 0.78), bw, Math.round(cardH * 0.12));
        }
    }
    // 苹果圆角卡: 纯色渐变底+居中照片+极简
    function styleAppleCard(img, size, g, iw, ih, S) {
        const pad = Math.max(50, Math.round(size * 2));
        const w = iw + pad * 2, h = ih + pad * 2;
        // 渐变背景(灰蓝→灰紫)
        const grad = g.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#e8e8ec'); grad.addColorStop(1, '#d8d8e0');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
        // 中央大圆角照片
        const r = Math.round(Math.min(iw, ih) * 0.15);
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.25)'; g.shadowBlur = 40; g.shadowOffsetY = 15;
        g.fillStyle = '#fff';
        if (typeof g.roundRect === 'function') { g.beginPath(); g.roundRect(pad, pad, iw, ih, r); g.fill(); }
        else g.fillRect(pad, pad, iw, ih);
        g.restore();
        g.save();
        if (typeof g.roundRect === 'function') { g.beginPath(); g.roundRect(pad, pad, iw, ih, r); g.clip(); }
        g.drawImage(img, pad, pad);
        g.restore();
    }
    // 赛博霓虹: 黑底+青色网格线+扫描线
    function styleCyberNeon(img, size, g, iw, ih, S) {
        const pad = Math.max(40, Math.round(size * 1.5));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#050510'; g.fillRect(0, 0, w, h);
        // 青色网格线
        g.strokeStyle = 'rgba(0,255,255,0.15)'; g.lineWidth = 1;
        const grid = Math.round(w / 20);
        for (let x = 0; x < w; x += grid) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
        for (let y = 0; y < h; y += grid) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
        // 照片
        const r = Math.round(Math.min(iw, ih) * 0.02);
        g.save();
        g.shadowColor = '#00ffff'; g.shadowBlur = 25;
        g.fillStyle = '#000';
        if (typeof g.roundRect === 'function') { g.beginPath(); g.roundRect(pad, pad, iw, ih, r); g.fill(); }
        else g.fillRect(pad, pad, iw, ih);
        g.restore();
        g.save();
        if (typeof g.roundRect === 'function') { g.beginPath(); g.roundRect(pad, pad, iw, ih, r); g.clip(); }
        g.drawImage(img, pad, pad);
        g.restore();
        // 扫描线
        g.fillStyle = 'rgba(0,255,255,0.08)';
        for (let y = pad; y < pad + ih; y += 4) g.fillRect(pad, y, iw, 1);
        // 左上角标签
        g.fillStyle = '#00ffff'; g.font = 'bold ' + Math.round(w * 0.02) + 'px monospace';
        g.textAlign = 'left'; g.fillText('// CYBER_2077', pad, pad - 10);
    }
    // 霓虹辉光: 黑底+粉色灯管文字
    function styleNeonGlow(img, size, g, iw, ih, S) {
        const pad = Math.max(40, Math.round(size * 1.5));
        const w = iw + pad * 2, h = ih + pad * 2 + Math.round(ih * 0.15);
        g.fillStyle = '#0a0510'; g.fillRect(0, 0, w, h);
        // 照片
        const r = Math.round(Math.min(iw, ih) * 0.03);
        g.save();
        g.shadowColor = '#ff44aa'; g.shadowBlur = 30;
        g.strokeStyle = '#ff66bb'; g.lineWidth = 3;
        if (typeof g.roundRect === 'function') { g.beginPath(); g.roundRect(pad, pad, iw, ih, r); g.stroke(); }
        else g.strokeRect(pad, pad, iw, ih);
        g.restore();
        g.save();
        if (typeof g.roundRect === 'function') { g.beginPath(); g.roundRect(pad, pad, iw, ih, r); g.clip(); }
        g.drawImage(img, pad, pad);
        g.restore();
        // 底部霓虹文字
        const ty = pad + ih + Math.round((h - pad - ih) * 0.5);
        g.save();
        g.shadowColor = '#ff44aa'; g.shadowBlur = 20;
        g.fillStyle = '#ff88cc'; g.font = 'bold ' + Math.round(w * 0.05) + 'px cursive';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('✦ neon glow ✦', w / 2, ty);
        g.restore();
    }

    // 富士水印: 深色圆角卡片+照片cover+底部品牌名+参数
    function styleFujifilm(img, size, g, iw, ih, S, withBrand, showParams) { showParams = showParams !== false;
        const outerPad = Math.max(15, Math.round(size * 0.5));
        const w = iw + outerPad * 2;
        const h = ih + outerPad * 2;
        // 白外底
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        // 深色圆角卡片
        const cx = outerPad, cy = outerPad, cw = iw, ch = ih;
        const r = Math.round(Math.min(cw, ch) * 0.03);
        g.fillStyle = '#0d1b2a';
        if (typeof g.roundRect === 'function') { g.beginPath(); g.roundRect(cx, cy, cw, ch, r); g.fill(); }
        else g.fillRect(cx, cy, cw, ch);
        // 照片完整显示(支持缩放/偏移)
        const sc = S.imgScale || 1;
        const dw = iw * sc, dh = ih * sc;
        const dx = cx + (iw - dw) / 2 + (S.imgOffsetX || 0);
        const dy = cy + (ih - dh) / 2 + (S.imgOffsetY || 0);
        g.save();
        if (typeof g.roundRect === 'function') { g.beginPath(); g.roundRect(cx, cy, cw, ch, r); g.clip(); }
        g.drawImage(img, dx, dy, dw, dh);
        g.restore();
        // 文字大小(从面板参数)
        const fParam = Math.max(12, Math.round(S.paramFs || iw * 0.035));
        const fBrand = Math.max(16, Math.round(fParam * 1.3));
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic';
        const bottomPad = Math.max(20, Math.round(ih * 0.06));
        let ty = cy + ih - bottomPad;
        if (withBrand && S.cam) {
            g.font = 'bold ' + fBrand + 'px sans-serif';
            g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 6;
            g.fillStyle = '#ffffff';
            const brand = (S.cam.brand || 'FUJIFILM').toUpperCase();
            // 无参数时品牌直接画在底部
            g.fillText(brand, w / 2, showParams ? ty - fParam * 1.5 : ty);
            g.shadowBlur = 0;
        }
        if (showParams && S.useExif && S.cam) {
            const fLen = String(S.cam.focal || '450').replace(/mm$/i, '');
            const apt = String(S.cam.aperture || 'F6.3').replace(/^f\//i, 'F');
            const shut = String(S.cam.shutter || '1/125').replace(/s$/i, '');
            const iso = String(S.cam.iso || '100').replace(/^iso/i, '');
            const line = fLen + 'mm   ' + apt + '   ' + shut + 's   ISO' + iso;
            g.font = 'italic bold ' + fParam + 'px sans-serif';
            g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 6;
            g.fillStyle = '#ffffff';
            g.fillText(line, w / 2, ty);
            g.shadowBlur = 0;
        }
    }

    // ══ 赛博故障风 ══
    function styleCyberGlitch(img, size, g, iw, ih, S) {
        const pad = Math.max(40, Math.round(iw * 0.04));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#0a0a0f'; g.fillRect(0, 0, w, h);
        // RGB色偏(加强)
        g.save();
        g.drawImage(img, pad, pad);
        g.globalCompositeOperation = 'screen';
        g.globalAlpha = 0.7;
        g.fillStyle = 'rgba(255,0,64,0.6)';
        g.drawImage(img, pad - 6, pad);
        g.globalAlpha = 0.7;
        g.fillStyle = 'rgba(0,255,255,0.6)';
        g.drawImage(img, pad + 6, pad);
        g.restore();
        // 扫描线
        g.fillStyle = 'rgba(0,0,0,0.2)';
        for (let y = pad; y < pad + ih; y += 4) g.fillRect(pad, y, iw, 2);
        // 错位条(更明显)
        for (let i = 0; i < 12; i++) {
            const by = pad + Math.floor(Math.random() * ih);
            const bh = Math.floor(Math.random() * 15) + 3;
            const off = Math.floor(Math.random() * 40) - 20;
            g.drawImage(img, pad, by, iw, bh, pad + off, by, iw, bh);
        }
        // 噪点
        for (let i = 0; i < 400; i++) {
            g.fillStyle = 'rgba(255,255,255,' + (Math.random() * 0.4) + ')';
            g.fillRect(pad + Math.random() * iw, pad + Math.random() * ih, 2, 2);
        }
        // REC红点+时间码(大字)
        g.fillStyle = '#ff0040';
        g.beginPath(); g.arc(pad + 25, pad + 30, 10, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#00ff88';
        g.font = 'bold 20px monospace';
        g.textAlign = 'left';
        g.fillText('● REC  12:34:56', pad + 45, pad + 37);
    }

    // ══ 拍立得手写风 ══
    function stylePolaroidHand(img, size, g, iw, ih, S) {
        const border = Math.max(24, Math.round(iw * 0.06));
        const bottomPad = Math.max(60, Math.round(iw * 0.2));
        const w = iw + border * 2, h = ih + border + bottomPad;
        // 白色相纸
        g.fillStyle = '#fefefe'; g.fillRect(0, 0, w, h);
        // 照片
        g.drawImage(img, border, border, iw, ih);
        // 底部手写日期
        g.fillStyle = '#333';
        g.font = 'italic 18px "Comic Sans MS", cursive';
        g.textAlign = 'center';
        g.save();
        g.translate(w / 2, border + ih + 40);
        g.rotate(-0.03);
        g.fillText(new Date().toLocaleDateString('zh-CN'), 0, 0);
        g.restore();
        // 小爱心装饰
        g.fillStyle = '#ff6b9d';
        g.beginPath(); g.arc(w / 2 + 80, border + ih + 35, 4, 0, Math.PI * 2); g.fill();
    }

    // ══ 撕纸手账风 ══
    function styleTornJournal(img, size, g, iw, ih, S) {
        const pad = Math.max(30, Math.round(size * 0.8));
        const w = iw + pad * 2, h = ih + pad * 2;
        // 牛皮纸底
        g.fillStyle = '#e8dcc4'; g.fillRect(0, 0, w, h);
        // 纸纹
        g.fillStyle = 'rgba(139,119,89,0.1)';
        for (let i = 0; i < 100; i++) g.fillRect(Math.random() * w, Math.random() * h, 2, 1);
        // 撕边效果(不规则)
        const sx = pad, sy = pad, sw = iw, sh = ih;
        g.fillStyle = '#fff';
        g.beginPath();
        g.moveTo(sx, sy);
        for (let x = 0; x <= sw; x += 10) g.lineTo(sx + x, sy + (Math.random() - 0.5) * 8);
        for (let y = 0; y <= sh; y += 10) g.lineTo(sx + sw + (Math.random() - 0.5) * 8, sy + y);
        for (let x = sw; x >= 0; x -= 10) g.lineTo(sx + x, sy + sh + (Math.random() - 0.5) * 8);
        for (let y = sh; y >= 0; y -= 10) g.lineTo(sx + (Math.random() - 0.5) * 8, sy + y);
        g.closePath(); g.fill();
        g.save(); g.clip();
        g.drawImage(img, sx, sy, sw, sh);
        g.restore();
        // 胶带
        g.fillStyle = 'rgba(255,200,50,0.6)';
        g.fillRect(sx + sw / 2 - 30, sy - 8, 60, 16);
        g.fillRect(sx - 8, sy + sh / 2 - 8, 16, 60);
    }

    // ══ 3D卡片翻转 ══
    function styleCard3D(img, size, g, iw, ih, S) {
        const padX = Math.round(iw * 0.18);
        const padTop = Math.round(iw * 0.1);
        const padBottom = Math.round(iw * 0.2);
        const w = iw + padX * 2, h = ih + padTop + padBottom;
        const thickness = Math.round(iw * 0.02);
        // 深棕桌面渐变
        const grad = g.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#4a3728');
        grad.addColorStop(1, '#2a1d12');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
        // 卡片投影(最底层)
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.7)';
        g.shadowBlur = 40;
        g.shadowOffsetX = 12;
        g.shadowOffsetY = 18;
        g.fillStyle = '#888';
        g.fillRect(padX + thickness, padTop + thickness, iw, ih);
        g.restore();
        // 卡片厚度边(灰色层,右下露出)
        g.fillStyle = '#c8c8c8';
        g.fillRect(padX + thickness, padTop + thickness, iw, ih);
        g.fillStyle = '#b0b0b0';
        g.fillRect(padX + thickness, padTop + thickness, thickness, ih);
        g.fillRect(padX + thickness, padTop + thickness, iw, thickness);
        // 白色正面卡片(左上对齐)
        g.fillStyle = '#ffffff';
        g.fillRect(padX, padTop, iw, ih);
        // 照片贴在卡片上部
        g.drawImage(img, padX, padTop, iw, Math.round(ih * 0.85));
        // 底部手写
        g.fillStyle = '#aaa';
        g.font = Math.round(iw * 0.025) + 'px cursive';
        g.textAlign = 'center';
        g.fillText('✎ my memory', padX + iw / 2, padTop + Math.round(ih * 0.93));
    }

    // ══ 漫画分镜 ══
    function styleComicPanel(img, size, g, iw, ih, S) {
        const gap = 8;
        const cols = 2, rows = 2;
        const cw = Math.floor(iw / cols), ch = Math.floor(ih / rows);
        const w = iw + gap * (cols + 1), h = ih + gap * (rows + 1) + 60;
        // 黑底
        g.fillStyle = '#111'; g.fillRect(0, 0, w, h);
        // 切成4格
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const x = gap + c * (cw + gap), y = gap + r * (ch + gap);
                g.drawImage(img, c * cw, r * ch, cw, ch, x, y, cw, ch);
                g.strokeStyle = '#fff'; g.lineWidth = 3;
                g.strokeRect(x, y, cw, ch);
            }
        }
        // 气泡框
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(w - 80, h - 30, 22, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#000';
        g.font = 'bold 12px sans-serif';
        g.textAlign = 'center';
        g.fillText('!', w - 80, h - 26);
    }

    // ══ 复古报纸 ══
    function styleNewspaper(img, size, g, iw, ih, S) {
        const pad = Math.max(30, Math.round(size * 0.6));
        const w = iw + pad * 2, h = ih + pad * 2 + 100;
        // 报纸米黄底
        g.fillStyle = '#f0e9d6'; g.fillRect(0, 0, w, h);
        // 报头
        g.fillStyle = '#1a1a1a';
        g.font = 'bold 36px Georgia, serif';
        g.textAlign = 'center';
        g.fillText('THE DAILY PHOTO', w / 2, pad);
        g.font = '12px serif';
        g.fillText(new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' }), w / 2, pad + 20);
        // 分隔线
        g.fillRect(pad, pad + 30, w - pad * 2, 2);
        // 照片
        g.drawImage(img, pad, pad + 50, iw, ih);
        // 照片说明
        g.font = 'italic 14px serif';
        g.fillText('— A captured moment in time', w / 2, pad + 50 + ih + 25);
    }


    // ══ 签名纪念 ══
    function styleSignature(img, size, g, iw, ih, S) {
        const pad = Math.max(30, Math.round(iw * 0.04));
        const bottomH = Math.round(iw * 0.10);
        const w = iw + pad * 2, h = ih + pad + bottomH;
        if (S.signBgBlur) {
            g.save();
            g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, w, h);
            g.filter = 'blur(30px) brightness(0.6)';
            const bs = Math.max(w / iw, h / ih);
            g.drawImage(img, (w - iw * bs) / 2, (h - ih * bs) / 2, iw * bs, ih * bs);
            g.filter = 'none';
            g.restore();
        } else {
            g.fillStyle = '#faf8f5'; g.fillRect(0, 0, w, h);
        }
        g.save();
        if (S.signBgBlur) { g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8; }
        g.drawImage(img, pad, pad, iw, ih);
        g.restore();
        g.fillStyle = S.signBgBlur ? '#fff' : (S.signColor || '#555');
        g.font = 'italic ' + Math.round(iw * 0.05 * (S.signSize || 1)) + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive';
        g.textAlign = 'center';
        g.save();
        g.translate(w / 2, pad + ih + Math.round(bottomH * 0.6));
        g.rotate(-0.02);
        g.fillText(S.userSignature || '— my memory —', 0, 0);
        g.restore();
    }

    // ══ 签名+参数:底部左头像+签名,右品牌+参数 ══
    function styleSignParam(img, size, g, iw, ih, S) {
        const pad = Math.max(30, Math.round(iw * 0.04));
        const fs = Math.max(11, Math.round(autoExifSize(S.paramFs, iw)));
        const bottomH = Math.round(iw * 0.14);
        const w = iw + pad * 2, h = ih + pad + bottomH;
        if (S.signBgBlur) {
            g.save();
            g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, w, h);
            g.filter = 'blur(30px) brightness(0.6)';
            const bs = Math.max(w / iw, h / ih);
            g.drawImage(img, (w - iw * bs) / 2, (h - ih * bs) / 2, iw * bs, ih * bs);
            g.filter = 'none';
            g.restore();
        } else {
            g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        }
        g.save();
        if (S.signBgBlur) { g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8; }
        g.drawImage(img, pad, pad, iw, ih);
        g.restore();
        const barY = pad + ih;
        const midY = barY + bottomH / 2;

        // ══ 左侧:头像+签名 ══
        const avatarR = Math.round(bottomH * 0.3 * (S.avatarScale || 1));
        const ax = pad + avatarR + 6, ay = midY;
        const globalAv = window.__qfsAvatarImg;
        if (globalAv && globalAv.complete && globalAv.naturalWidth) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            if (S.avatarSelected) {
                g.shadowColor = '#10b981'; g.shadowBlur = 12;
                g.strokeStyle = '#10b981'; g.lineWidth = 3;
            } else {
                g.strokeStyle = '#eee'; g.lineWidth = 2;
            }
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
            g.shadowBlur = 0;
        }
        // 签名(头像右边)
        g.fillStyle = S.signColor || '#444';
        g.font = 'italic ' + Math.round(iw * 0.022 * (S.signSize || 1)) + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(S.userSignature || '— my memory —', ax + avatarR + 12, ay);
        g.textBaseline = 'alphabetic';

        // ══ 右侧:品牌+参数,以参数行居中 ══
        const rx = w - pad;
        // 先测参数行宽度
        const paramStr = (S.exif.focal||'') + '  ' + (S.exif.aperture||'') + '  ' + (S.exif.iso||'') + '  ' + (S.exif.shutter||'');
        g.font = fs + 'px sans-serif';
        const pw = g.measureText(paramStr).width;
        const cxRight = rx - pw / 2; // 参数行中心x
        // 品牌居中在参数行上方(印象毛玻璃同款衬线字体)
        const brandTxt = (S.exif.make || 'Camera').toUpperCase();
        const fBrand = Math.round(iw * 0.028);
        const pColor = S.paramColor === 'auto' ? (S.signBgBlur ? '#fff' : '#333') : S.paramColor;
        const pColorSoft = S.paramColor === 'auto' ? (S.signBgBlur ? 'rgba(255,255,255,0.7)' : '#999') : (S.paramColor === '#fff' ? 'rgba(255,255,255,0.7)' : '#999');
        g.fillStyle = pColor;
        g.font = 'bold ' + fBrand + "px Georgia, 'Times New Roman', serif";
        g.letterSpacing = Math.round(fBrand * 0.15);
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.fillText(brandTxt, cxRight, barY + Math.round(bottomH * 0.15));
        g.letterSpacing = 0;
        // 参数行
        g.fillStyle = pColorSoft;
        g.font = fs + 'px sans-serif';
        g.textBaseline = 'middle';
        g.fillText(paramStr, cxRight, barY + Math.round(bottomH * 0.65));
        g.textBaseline = 'alphabetic';
        g.textAlign = 'center';
    }

    // ══ 头像纪念 ══
    function styleAvatarMemo(img, size, g, iw, ih, S) {
        const pad = Math.max(30, Math.round(iw * 0.05));
        const bottomH = Math.round(iw * 0.16);
        const w = iw + pad * 2, h = ih + pad + bottomH;
        if (S.signBgBlur) {
            g.save();
            g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, w, h);
            g.filter = 'blur(30px) brightness(0.6)';
            const bs = Math.max(w / iw, h / ih);
            g.drawImage(img, (w - iw * bs) / 2, (h - ih * bs) / 2, iw * bs, ih * bs);
            g.filter = 'none';
            g.restore();
        } else {
            g.fillStyle = '#f5f0eb'; g.fillRect(0, 0, w, h);
        }
        g.save();
        if (S.signBgBlur) { g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8; }
        g.drawImage(img, pad, pad, iw, ih);
        g.restore();
        const barY = pad + ih;
        const avatarR = Math.round(bottomH * 0.32 * (S.avatarScale || 1));
        const offX = S.avatarOffX || 0, offY = S.avatarOffY || 0;
        const ax = pad + avatarR + 8 + offX, ay = barY + bottomH / 2 + offY;
        const globalAv = window.__qfsAvatarImg;
        if (globalAv && globalAv.complete && globalAv.naturalWidth) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
        }
        g.fillStyle = S.signColor || '#555';
        g.font = 'italic ' + Math.round(iw * 0.022 * (S.signSize || 1)) + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(S.userSignature || '— my memory —', ax + avatarR + 16, ay);
        g.textBaseline = 'alphabetic';
        g.textAlign = 'center';
        g.fillStyle = '#aaa';
        g.font = Math.round(iw * 0.018) + 'px sans-serif';
        g.textAlign = 'right';
        g.fillText(new Date().toLocaleDateString('zh-CN'), w - pad, barY + bottomH * 0.7);
        g.textAlign = 'center';
    }

    // ══ 签名+背景模糊:模糊照片铺满背景,清晰照片+底部条 ══
    function styleSignBlur(img, size, g, iw, ih, S) {
        const pad = Math.max(30, Math.round(iw * 0.04));
        const fs = Math.max(11, Math.round(autoExifSize(S.paramFs, iw)));
        const bottomH = Math.round(iw * 0.14);
        const w = iw + pad * 2, h = ih + pad + bottomH;
        // 模糊背景:把照片放大铺满画布
        g.save();
        g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, w, h);
        g.filter = 'blur(30px) brightness(0.6)';
        const bs = Math.max(w / iw, h / ih);
        g.drawImage(img, (w - iw * bs) / 2, (h - ih * bs) / 2, iw * bs, ih * bs);
        g.filter = 'none';
        g.restore();
        // 清晰照片居中
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8;
        g.drawImage(img, pad, pad, iw, ih);
        g.restore();
        const barY = pad + ih;
        const midY = barY + bottomH / 2;

        // 左侧头像+签名
        const avatarR = Math.round(bottomH * 0.3 * (S.avatarScale || 0.85));
        const ax = pad + avatarR + 6, ay = midY;
        const globalAv = window.__qfsAvatarImg;
        if (globalAv && globalAv.complete && globalAv.naturalWidth) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
        }
        g.fillStyle = '#fff';
        g.font = 'italic ' + Math.round(iw * 0.022 * (S.signSize || 1)) + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(S.userSignature || '— my memory —', ax + avatarR + 12, ay);
        g.textBaseline = 'alphabetic';

        // 右侧品牌+参数
        const rx = w - pad;
        const paramStr = (S.exif.focal||'') + '  ' + (S.exif.aperture||'') + '  ' + (S.exif.iso||'') + '  ' + (S.exif.shutter||'');
        g.font = fs + 'px sans-serif';
        const pw = g.measureText(paramStr).width;
        const cxRight = rx - pw / 2;
        const brandTxt2 = (S.exif.make || 'Camera').toUpperCase();
        const fBrand2 = Math.round(iw * 0.028);
        const pColor2 = S.paramColor === 'auto' ? (S.signBgBlur ? '#fff' : '#333') : S.paramColor;
        const pColorSoft2 = S.paramColor === 'auto' ? (S.signBgBlur ? 'rgba(255,255,255,0.7)' : '#999') : (S.paramColor === '#fff' ? 'rgba(255,255,255,0.7)' : '#999');
        g.fillStyle = pColor2;
        g.font = 'bold ' + fBrand2 + "px Georgia, 'Times New Roman', serif";
        g.letterSpacing = Math.round(fBrand2 * 0.15);
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.fillText(brandTxt2, cxRight, barY + Math.round(bottomH * 0.15));
        g.letterSpacing = 0;
        g.fillStyle = 'rgba(255,255,255,0.7)';
        g.font = fs + 'px sans-serif';
        g.textBaseline = 'middle';
        g.fillText(paramStr, cxRight, barY + Math.round(bottomH * 0.65));
        g.textBaseline = 'alphabetic';
        g.textAlign = 'center';
    }

    // ══ 签名·模糊:只签名居中,模糊背景 ══
    function styleSigBlur(img, size, g, iw, ih, S) {
        const pad = Math.max(30, Math.round(iw * 0.04));
        const bottomH = Math.round(iw * 0.10);
        const w = iw + pad * 2, h = ih + pad + bottomH;
        g.save();
        g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, w, h);
        g.filter = 'blur(30px) brightness(0.6)';
        const bs = Math.max(w / iw, h / ih);
        g.drawImage(img, (w - iw * bs) / 2, (h - ih * bs) / 2, iw * bs, ih * bs);
        g.filter = 'none';
        g.restore();
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8;
        g.drawImage(img, pad, pad, iw, ih);
        g.restore();
        const barY = pad + ih;
        g.fillStyle = '#fff';
        g.font = 'italic ' + Math.round(iw * 0.05 * (S.signSize || 1)) + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.save();
        g.translate(w / 2, barY + bottomH / 2);
        g.rotate(-0.015);
        g.fillText(S.userSignature || '— my memory —', 0, 0);
        g.restore();
        g.textBaseline = 'alphabetic';
    }

    // ══ 头像·模糊:头像+签名,模糊背景 ══
    function styleAvBlur(img, size, g, iw, ih, S) {
        const pad = Math.max(30, Math.round(iw * 0.05));
        const bottomH = Math.round(iw * 0.11);
        const w = iw + pad * 2, h = ih + pad * 2 + bottomH;
        g.save();
        g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, w, h);
        g.filter = 'blur(30px) brightness(0.6)';
        const bs = Math.max(w / iw, h / ih);
        g.drawImage(img, (w - iw * bs) / 2, (h - ih * bs) / 2, iw * bs, ih * bs);
        g.filter = 'none';
        g.restore();
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 20; g.shadowOffsetY = 8;
        g.drawImage(img, pad, pad, iw, ih);
        g.restore();
        const barY = pad + ih;
        const avatarR = Math.round(bottomH * 0.35 * (S.avatarScale || 0.85));
        const ax = pad + avatarR + 8, ay = barY + bottomH / 2;
        const globalAv = window.__qfsAvatarImg;
        if (globalAv && globalAv.complete && globalAv.naturalWidth) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
        }
        g.fillStyle = '#fff';
        g.font = 'italic ' + Math.round(iw * 0.022 * (S.signSize || 1)) + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.fillText(S.userSignature || '— my memory —', ax + avatarR + 16, ay);
        g.textBaseline = 'alphabetic';
        g.textAlign = 'right';
        g.fillStyle = 'rgba(255,255,255,0.6)';
        g.font = Math.round(iw * 0.018) + 'px sans-serif';
        g.fillText(new Date().toLocaleDateString('zh-CN'), w - pad, barY + bottomH * 0.7);
        g.textAlign = 'center';
    }

    // ══ 头像·叠加:头像+签名直接放在照片上 ══
    function styleAvOverlay(img, size, g, iw, ih, S) {
        const pad = Math.max(20, Math.round(iw * 0.03));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad, iw, ih);
        // 头像在左下角
        const avatarR = Math.round(Math.min(iw, ih) * 0.06 * (S.avatarScale || 0.85));
        const ax = pad + avatarR + Math.round(iw * 0.03);
        const ay = pad + ih - avatarR - Math.round(iw * 0.03);
        const globalAv = window.__qfsAvatarImg;
        if (globalAv && globalAv.complete && globalAv.naturalWidth) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
            g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
            g.stroke();
            g.shadowBlur = 0;
        }
        // 签名在头像右边(自动适配宽度)
        g.fillStyle = S.signColor || '#fff';
        let signFs = Math.round(iw * 0.022 * (S.signSize || 1));
        const signTxt = S.userSignature || '— my memory —';
        const maxSignW = pad + iw - (ax + avatarR + 12) - 10;
        g.font = 'italic ' + signFs + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive';
        let tw = g.measureText(signTxt).width;
        if (tw > maxSignW && maxSignW > 0) { signFs = Math.max(10, Math.round(signFs * maxSignW / tw)); g.font = 'italic ' + signFs + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive'; }
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 4;
        g.fillText(signTxt, ax + avatarR + 12, ay);
        g.shadowBlur = 0;
    }

    // ══ 头像·右上:头像在右上角,签名在下方 ══
    function styleAvOverlayTR(img, size, g, iw, ih, S) {
        const pad = Math.max(20, Math.round(iw * 0.03));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad, iw, ih);
        const avatarR = Math.round(Math.min(iw, ih) * 0.06 * (S.avatarScale || 0.85));
        const ax = pad + iw - avatarR - Math.round(iw * 0.03);
        const ay = pad + avatarR + Math.round(iw * 0.03);
        const globalAv = window.__qfsAvatarImg;
        if (globalAv && globalAv.complete && globalAv.naturalWidth) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
            g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 6; g.stroke(); g.shadowBlur = 0;
        }
        // 签名在头像下方居中(自动缩窄)
        g.fillStyle = S.signColor || '#fff';
        let signFs = Math.round(iw * 0.022 * (S.signSize || 1));
        const signTxt = S.userSignature || '— my memory —';
        const availL = ax - pad - 10, availR = (pad + iw) - ax - 10;
        const maxSignW = 2 * Math.max(20, Math.min(availL, availR));
        g.font = 'italic ' + signFs + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive';
        let tw = g.measureText(signTxt).width;
        if (tw > maxSignW) { signFs = Math.max(10, Math.round(signFs * maxSignW / tw)); g.font = 'italic ' + signFs + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive'; }
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 4;
        g.fillText(signTxt, ax, ay + avatarR + Math.round(iw * 0.015));
        g.shadowBlur = 0;
    }

    // ══ 头像·右下:头像在右下角,签名在左边 ══
    function styleAvOverlayBR(img, size, g, iw, ih, S) {
        const pad = Math.max(20, Math.round(iw * 0.03));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad, iw, ih);
        const avatarR = Math.round(Math.min(iw, ih) * 0.06 * (S.avatarScale || 0.85));
        const ax = pad + iw - avatarR - Math.round(iw * 0.03);
        const ay = pad + ih - avatarR - Math.round(iw * 0.03);
        const globalAv = window.__qfsAvatarImg;
        if (globalAv && globalAv.complete && globalAv.naturalWidth) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
            g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 6; g.stroke(); g.shadowBlur = 0;
        }
        // 签名在头像左边(自动缩窄)
        g.fillStyle = S.signColor || '#fff';
        let signFs = Math.round(iw * 0.022 * (S.signSize || 1));
        const signTxt = S.userSignature || '— my memory —';
        const maxSignW = ax - avatarR - 12 - pad - 10;
        g.font = 'italic ' + signFs + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive';
        let tw = g.measureText(signTxt).width;
        if (tw > maxSignW && maxSignW > 0) { signFs = Math.max(10, Math.round(signFs * maxSignW / tw)); g.font = 'italic ' + signFs + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive'; }
        g.textAlign = 'right';
        g.textBaseline = 'middle';
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 4;
        g.fillText(signTxt, ax - avatarR - 12, ay);
        g.shadowBlur = 0;
    }

    // ══ 头像·下中:头像底部居中,签名在下方 ══
    function styleAvOverlayBC(img, size, g, iw, ih, S) {
        const pad = Math.max(20, Math.round(iw * 0.03));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad, iw, ih);
        const avatarR = Math.round(Math.min(iw, ih) * 0.06 * (S.avatarScale || 0.85));
        const ax = pad + Math.round(iw / 2);
        const ay = pad + ih - avatarR - Math.round(iw * 0.04);
        const globalAv = window.__qfsAvatarImg;
        if (globalAv && globalAv.complete && globalAv.naturalWidth) {
            g.save();
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, ax - avatarR, ay - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(ax, ay, avatarR, 0, Math.PI * 2); g.stroke();
            g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 6; g.stroke(); g.shadowBlur = 0;
        }
        // 签名在头像下方居中(自动缩窄)
        g.fillStyle = S.signColor || '#fff';
        let signFs = Math.round(iw * 0.022 * (S.signSize || 1));
        const signTxt = S.userSignature || '— my memory —';
        const availL2 = ax - pad - 10, availR2 = (pad + iw) - ax - 10;
        const maxSignW2 = 2 * Math.max(20, Math.min(availL2, availR2));
        g.font = 'italic ' + signFs + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive';
        let tw2 = g.measureText(signTxt).width;
        if (tw2 > maxSignW2) { signFs = Math.max(10, Math.round(signFs * maxSignW2 / tw2)); g.font = 'italic ' + signFs + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive'; }
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 4;
        g.fillText(signTxt, ax, ay + avatarR + Math.round(iw * 0.012));
        g.shadowBlur = 0;
    }

    // ══ 头像·下排:头像左+签名右,同一排,整体底部居中 ══
    function styleAvOverlayBC2(img, size, g, iw, ih, S) {
        const pad = Math.max(20, Math.round(iw * 0.03));
        const w = iw + pad * 2, h = ih + pad * 2;
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.drawImage(img, pad, pad, iw, ih);
        const avatarR = Math.round(Math.min(iw, ih) * 0.05 * (S.avatarScale || 0.85));
        const globalAv = window.__qfsAvatarImg;
        // 先量签名宽度
        const signTxt = S.userSignature || '— my memory —';
        let signFs = Math.round(iw * 0.022 * (S.signSize || 1));
        g.font = 'italic ' + signFs + 'px "' + (S.signFont || 'Comic Sans MS') + '", cursive';
        let tw = g.measureText(signTxt).width;
        const gap = Math.round(iw * 0.015);
        const totalW = (globalAv ? avatarR * 2 : 0) + gap + tw;
        const startX = pad + Math.round((iw - totalW) / 2);
        const cy = pad + ih - avatarR - Math.round(iw * 0.04);
        // 头像
        let cx = startX;
        if (globalAv && globalAv.complete && globalAv.naturalWidth) {
            g.save();
            g.beginPath(); g.arc(cx + avatarR, cy, avatarR, 0, Math.PI * 2); g.clip();
            const s = Math.max(avatarR * 2 / globalAv.width, avatarR * 2 / globalAv.height);
            g.drawImage(globalAv, cx + avatarR - avatarR, cy - avatarR, globalAv.width * s, globalAv.height * s);
            g.restore();
            g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
            g.beginPath(); g.arc(cx + avatarR, cy, avatarR, 0, Math.PI * 2); g.stroke();
            g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 6; g.stroke(); g.shadowBlur = 0;
        }
        // 签名在头像右边
        g.fillStyle = S.signColor || '#fff';
        g.textAlign = 'left';
        g.textBaseline = 'middle';
        g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 4;
        g.fillText(signTxt, cx + avatarR * 2 + gap, cy);
        g.shadowBlur = 0;
    }

    const draw = {
            SIMPLE: styleSimple, WHITE_PLAIN: styleWhitePlain, ROUNDED: styleRounded,
            FILM_STRIP: styleFilmStrip, POLAROID: stylePolaroid,
            DOUBLE_LINE: styleDoubleLine, VINTAGE: styleVintage,
            GRADIENT: styleGradient, DROP_SHADOW: styleDropShadow,
            BLUR_CLASSIC: styleBlurClassic, BLUR_DATE: styleBlurDate,
            WM_CLASSIC: styleWmClassic, WM_SINGLE: styleWmSingle, WM_BRAND_LOGO: styleWmBrandLogo, WM_AI: styleWmAi,
            IMP_FROSTED: styleImpFrosted, IMP_CLASSIC: styleImpClassic, XIAOMI_IMP: styleXiaomiImp,
            CARD_LEICA: styleCardLeica, CARD_LOGO_PARAM: styleCardLogoParam, CARD_PURE_LOGO: styleCardPureLogo,
            CARD_SIMPLE: styleCardSimple, CARD_IMMERSION: styleCardImmersion,
            OVERLAY_PARAM_LEFT: (img, size, g, iw, ih, S2) => styleOverlayParams(img, size, g, iw, ih, S2, 0),
            OVERLAY_PARAM_RIGHT: (img, size, g, iw, ih, S2) => styleOverlayParams(img, size, g, iw, ih, S2, 1),
            OVERLAY_PARAM_BOTTOM: (img, size, g, iw, ih, S2) => styleOverlayParams(img, size, g, iw, ih, S2, 2),
        FUJI_WM: (img,size,g,iw,ih,S) => styleFujifilm(img,size,g,iw,ih,S,false),
        FUJI_WM_BRAND: (img,size,g,iw,ih,S) => styleFujifilm(img,size,g,iw,ih,S,true),
        DARK_BRAND_ONLY: (img,size,g,iw,ih,S) => styleFujifilm(img,size,g,iw,ih,S,true,false),
            OVERLAY_LOGO_BOTTOM: styleOverlayLogo,
            COLOR_CLASSIC: styleColorClassic, COLOR_REFINED: styleColorRefined, ART_CARD: styleArtCard,
            FUJI_WHITE: styleFujiWhite, SIMPLE_FILM: styleSimpleFilm,
            PARAM_TOP_LEFT: styleParamTopLeft, PARAM_BOTTOM_LEFT: styleParamBottomLeft, PARAM_BOTTOM_SINGLE: styleParamBottomSingle,
            STAMP_POSTAGE: styleStampPostage, TEARED_PAPER: styleTornPaper,
            FOLD_CORNER: styleFoldCorner, PINBOARD_TAPE: stylePinboardTape,
            VHS_TAPE: styleVhsTape, ALBUM_CORNER: styleAlbumCorner,
            MOVIE_TICKET: styleMovieTicket, WATERCOLOR_BLEED: styleWatercolorBleed,
            CYBER_GLITCH: styleCyberGlitch, POLAROID_HAND: stylePolaroidHand,
            TORN_JOURNAL: styleTornJournal, CARD_3D: styleCard3D,
            COMIC_PANEL: styleComicPanel, NEWSPAPER: styleNewspaper,
            SIGNATURE: styleSignature, SIGN_PARAM: styleSignParam,
            AVATAR_MEMO: styleAvatarMemo,
            SIGN_BLUR: styleSignBlur,
            SIG_BLUR: styleSigBlur,
            AV_BLUR: styleAvBlur,
            AV_OVERLAY: styleAvOverlay,
            AV_OVERLAY_TR: styleAvOverlayTR,
            AV_OVERLAY_BR: styleAvOverlayBR,
            AV_OVERLAY_BC: styleAvOverlayBC,
            AV_OVERLAY_BC2: styleAvOverlayBC2,
        }[styleName];
        const S = buildState(app, styleName, iw, ih, size);

        try {
            let out;
            if (!draw) {
                const dims = styleDims('_PH', iw, ih, size);
                out = newCanvas(dims.w, dims.h);
                const g = out.getContext('2d');
                stylePlaceholder(img, styleName, g, iw, ih);
            } else {
                const dims = styleDims(styleName, iw, ih, size, S);
                out = newCanvas(dims.w, dims.h);
                const g = out.getContext('2d');
                g.imageSmoothingEnabled = true;
                // 劫持drawImage:画原始照片时自动应用cornerConfig圆角
                const cc = t.cornerConfig || {};
                const photoTl = cc.cornerRadiusTL || 0, photoTr = cc.cornerRadiusTR || 0;
                const photoBl = cc.cornerRadiusBL || 0, photoBr = cc.cornerRadiusBR || 0;
                const photoRAll = cc.cornerRadiusAll || 0;
                const hasPhotoRound = photoRAll > 0 || photoTl > 0 || photoTr > 0 || photoBl > 0 || photoBr > 0;
                const origDrawImage = g.drawImage.bind(g);
                if (hasPhotoRound) {
                    g.drawImage = function(src, ...args) {
                        if (src === img) {
                            // 计算照片在画布上的位置和尺寸
                            let dx, dy, dw, dh;
                            if (args.length === 3) { dx = args[0]; dy = args[1]; dw = img.width; dh = img.height; }
                            else if (args.length === 5) { dx = args[0]; dy = args[1]; dw = args[2]; dh = args[3]; }
                            else if (args.length === 9) { dx = args[4]; dy = args[5]; dw = args[6]; dh = args[7]; }
                            else { origDrawImage(src, ...args); return; }
                            const r = photoRAll > 0 ? photoRAll : Math.min(photoTl, photoTr, photoBl, photoBr);
                            g.save();
                            if (r > 0 && g.roundRect) {
                                g.beginPath(); g.roundRect(dx, dy, dw, dh, r); g.clip();
                            }
                            origDrawImage(src, ...args);
                            g.restore();
                        } else {
                            origDrawImage(src, ...args);
                        }
                    };
                }
                draw(img, size, g, iw, ih, S);
                g.drawImage = origDrawImage;
                // 整体画布边框圆角
                const borderR = t.borderRadius || 0;
                if (borderR > 0) out = singleCornerClip(out, borderR);

                const decor = t.decorConfig || {};
                if ((decor.cornerDecorEnable || 0) === 1 && typeof window.drawCornerDecor === 'function') {
                    window.drawCornerDecor(out.getContext('2d'), decor.cornerDecorType || 'line', decor.cornerDecorSize || 30, out.width, out.height);
                }
            }

            const finalScale = Math.min(1, displayMax / Math.max(out.width, out.height));
            canvas.width = Math.max(1, Math.round(out.width * finalScale));
            canvas.height = Math.max(1, Math.round(out.height * finalScale));
            canvas._logW = canvas.width;
            canvas._logH = canvas.height;
            const g = canvas.getContext('2d');
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, canvas.width, canvas.height);
            g.save();
            g.imageSmoothingEnabled = true;
            g.scale(finalScale, finalScale);
            g.drawImage(out, 0, 0);
            g.restore();
            drawUserElements(g, t, canvas.width, canvas.height);
            app.applyZoomStyle();
        } catch (e) {
            // 与原版 apply 一致:出错回退为原图
            const scale = Math.min(1, displayMax / Math.max(iw, ih));
            canvas.width = Math.max(1, Math.round(iw * scale));
            canvas.height = Math.max(1, Math.round(ih * scale));
            canvas._logW = canvas.width;
            canvas._logH = canvas.height;
            const g = canvas.getContext('2d');
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, canvas.width, canvas.height);
            g.save();
            g.scale(scale, scale);
            g.drawImage(img, 0, 0);
            g.restore();
            app.applyZoomStyle();
        }
    }

    window.EngineStyles = { renderPhotoFrame, extractDominant, gaussianFilter, clearCaches: clearStyleCaches };
})();