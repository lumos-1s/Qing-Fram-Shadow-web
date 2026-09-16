// 导出模块：图片导出 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    /* ── 导出 ── */
    async exportImage() {
        if (!this.image) { this.setStatus('请先导入照片'); return; }
        const EXPORT_MAX = 8192;
        const fmt = this.dom.selFormat.value;
        const mime = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
        const ext = fmt === 'jpeg' ? 'jpg' : 'png';
        const targets = this.selectedIdx.length > 1 ? this.selectedIdx : [this.currentIdx];
        const originalIdx = this.currentIdx;
        const baseTemplate = this.template;
        const prevMax = this.displayMax;
        const files = [];
        const scaleElPix = (tpl, k) => {
            if (k === 1) return false;
            let any = false;
            (tpl.logoElements || []).forEach(el => {
                if (typeof el.x === 'number') {
                    el.x *= k; el.y *= k; if (el.size) el.size *= k;
                    if (el.offsetX) el.offsetX *= k;
                    if (el.offsetY) el.offsetY *= k;
                    any = true;
                }
            });
            (tpl.decorConfig && tpl.decorConfig.stickers || []).forEach(s => {
                s.x = (s.x || 0) * k; s.y = (s.y || 0) * k; s.scale = (s.scale || 1) * k;
                any = true;
            });
            (tpl.decorConfig && tpl.decorConfig.textLines || []).forEach(l => {
                if (l.align === 'free') { l.x = (l.x || 0) * k; l.y = (l.y || 0) * k; l.fontSize = (l.fontSize || 18) * k; any = true; }
            });
            return any;
        };
        try {
            for (let n = 0; n < targets.length; n++) {
                const idx = targets[n];
                const im = this.images[idx];
                if (!im) continue;
                this.image = im;
                this.invalidateStyleCaches();
                this.currentIdx = idx;
                this.template = im.customSettings || baseTemplate;
                this.normalizeTemplate();
                const puzzle = !!(this.template && this.template.puzzle && this.template.puzzle.enabled);
                // 先按 UI 默认尺寸渲染一次,取得元素坐标的"基准画布宽度"
                const uiMaxSave = this.displayMax;
                this.displayMax = undefined;
                await new Promise(res => requestAnimationFrame(() => {
                    if (puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false, true);
                    else window.__render(this, false);
                    res();
                }));
                const beforeW = Math.max(1, this.dom.canvas.width || 1);
                this.displayMax = EXPORT_MAX;
                await new Promise(res => requestAnimationFrame(() => {
                    if (puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false, true);
                    else window.__render(this, false);
                    res();
                }));
                const afterW = Math.max(1, this.dom.canvas.width || 1);
                const k = afterW / beforeW;
                // 元素坐标为基准画布像素:导出画布变大时等比放大,避免缩到角落
                if (!puzzle && k !== 1 && scaleElPix(this.template, k)) {
                    await new Promise(res => requestAnimationFrame(() => {
                        window.__render(this, false);
                        res();
                    }));
                    scaleElPix(this.template, 1 / k);
                }
                this.displayMax = uiMaxSave;
                let src = this.dom.canvas;
                if (fmt === 'jpeg') {
                    const bg = document.createElement('canvas');
                    bg.width = src.width; bg.height = src.height;
                    const bgx = bg.getContext('2d');
                    bgx.fillStyle = '#ffffff';
                    bgx.fillRect(0, 0, bg.width, bg.height);
                    bgx.drawImage(src, 0, 0);
                    src = bg;
                }
                const dataUrl = src.toDataURL(mime, fmt === 'jpeg' ? 0.92 : 1);
                const base64 = dataUrl.split(',')[1];
                const baseName = (im.name || 'photo').replace(/\.[^.]+$/, '');
                files.push({ data: base64, stem: `${baseName}${puzzle ? '_拼图' : '_边框'}`, ext });
                const bar = document.getElementById('progressBar');
                if (bar) bar.style.width = Math.round(((n + 1) / targets.length) * 100) + '%';
            }
        } finally {
            this.currentIdx = originalIdx;
            this.image = this.images[this.currentIdx];
            this.invalidateStyleCaches();
            this.template = (this.image && this.image.customSettings) || baseTemplate;
            if (prevMax === undefined) delete this.displayMax;
            else this.displayMax = prevMax;
        }

        if (this.image) this.scheduleRender(true);

        this.dedupeExportNames(files);

        let result;
        if (files.length > 1 && window.qingframe.saveImagesBatch) {
            result = await window.qingframe.saveImagesBatch(files);
            if (result && result.canceled) { this.setStatus('已取消导出'); this.resetProgress(); return; }
        } else if (files.length === 1) {
            result = await window.qingframe.saveImage(files[0].data, files[0].filename) ? { ok: 1 } : { ok: 0 };
        } else {
            result = { ok: 0, fail: files.length };
        }
        const r = result || {};
        this.setStatus(`导出完成：成功 ${r.ok || 0}${r.fail ? `，失败 ${r.fail}` : ''}`);
        this.resetProgress();
        this.updateStatusBar();
    },

    // 导出文件名:按图片原有名称命名;同一名称重复时,首张保留原名,后续追加 _1、_2…
    dedupeExportNames(files) {
        const counts = new Map();
        for (const f of files) counts.set(f.stem, (counts.get(f.stem) || 0) + 1);
        const emitted = new Map();
        files.forEach(f => {
            const total = counts.get(f.stem);
            const idx = emitted.get(f.stem) || 0;
            emitted.set(f.stem, idx + 1);
            f.filename = (total === 1 || idx === 0) ? `${f.stem}.${f.ext}` : `${f.stem}_${idx}.${f.ext}`;
        });
        return files;
    },

    resetProgress() {
        const bar = document.getElementById('progressBar');
        if (bar) setTimeout(() => bar.style.width = '0', 800);
    }
});
