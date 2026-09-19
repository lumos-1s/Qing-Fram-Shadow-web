// 导出模块：图片导出 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    /* ── 导出:先选保存位置,再渲染导出画面,最后写盘 ── */
    async exportImage() {
        if (!this.image) { this.setStatus('请先导入照片'); return; }
        const fmt = this.dom.selFormat.value;
        const mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[fmt] || 'image/jpeg';
        const lossy = fmt === 'jpeg' || fmt === 'webp';
        const ext = fmt === 'jpeg' ? 'jpg' : fmt;
        const quality = lossy ? Math.min(1, Math.max(0.6, (parseInt(this.dom.slExportQuality.value, 10) || 92) / 100)) : 1;
        const sizeOpt = parseInt(this.dom.selExportSize.value, 10) || 0;
        const needsBg = fmt === 'jpeg';
        const targets = this.selectedIdx.length > 1 ? this.selectedIdx : [this.currentIdx];
        const jobs = [];
        targets.forEach(idx => {
            const im = this.images[idx];
            if (!im) return;
            const tpl = im.customSettings || this.imageTemplates.get(im) ||
                (this.currentIdx === idx ? this.template : this.defaultTemplate());
            const puzzle = !!(tpl && tpl.puzzle && tpl.puzzle.enabled);
            jobs.push({ im, puzzle });
        });
        if (!jobs.length) { this.setStatus('请先导入照片'); return; }

        // ① 先在画布外准备好文件名(不触发任何渲染),单文件时作为默认名
        const files = jobs.map(j => {
            const baseName = (j.im.name || 'photo').replace(/\.[^.]+$/, '');
            return { data: null, stem: `${baseName}${j.puzzle ? '_拼图' : '_边框'}`, ext };
        });
        this.dedupeExportNames(files);

        // ② 先弹出保存位置:多文件选目录,单文件选文件
        let loc;
        try {
            loc = await window.qingframe.pickExportLocation({ count: jobs.length, hintName: files[0].filename });
        } catch (e) { loc = null; }
        if (!loc || loc.canceled) { this.setStatus('已取消导出'); return; }

        // ③ 再逐张渲染导出画面(展示画布同步变大),期间无渲染的确认框
        const originalIdx = this.currentIdx;
        const baseTemplate = this.template;
        const prevMax = this.displayMax;
        const uiMaxSave = this.dom.canvas.width;
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
            for (let n = 0; n < jobs.length; n++) {
                const { im, puzzle } = jobs[n];
                this.image = im;
                this.invalidateStyleCaches();
                this.currentIdx = this.images.indexOf(im);
                // 每张图用各自预设:已自定义/记忆过的用其自身;当前主图用正在编辑的模板;其余未设置的用各自默认边框(不跟随第一张)
                this.template = im.customSettings || this.imageTemplates.get(im) ||
                    (this.images.indexOf(im) === originalIdx ? baseTemplate : this.defaultTemplate());
                this.normalizeTemplate();
                // 先按 UI 默认尺寸渲染一次,取得元素坐标的"基准画布宽度"
                this.displayMax = undefined;
                await new Promise(res => requestAnimationFrame(() => {
                    if (puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false, true);
                    else window.__render(this, false);
                    res();
                }));
                const beforeW = Math.max(1, this.dom.canvas.width || 1);
                this.displayMax = sizeOpt > 0 ? sizeOpt : Math.max(1, im.w || 1, im.h || 1);
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
                if (needsBg) {
                    const bg = document.createElement('canvas');
                    bg.width = src.width; bg.height = src.height;
                    const bgx = bg.getContext('2d');
                    bgx.fillStyle = '#ffffff';
                    bgx.fillRect(0, 0, bg.width, bg.height);
                    bgx.drawImage(src, 0, 0);
                    src = bg;
                }
                files[n].data = src.toDataURL(mime, quality).split(',')[1];
                const bar = document.getElementById('progressBar');
                if (bar) bar.style.width = Math.round(((n + 1) / jobs.length) * 100) + '%';
            }
            // ④ 渲染完毕,直接写入已选定的目录/文件
            const r = await window.qingframe.writeExportFiles({ location: loc, files }) || {};
            const m = `导出完成：成功 ${r.ok || 0}${r.fail ? `，失败 ${r.fail}` : ''}`;
            this.setStatus(m);
        } finally {
            this.currentIdx = originalIdx;
            this.image = this.images[this.currentIdx];
            this.invalidateStyleCaches();
            this.template = (this.image && this.image.customSettings) || baseTemplate;
            if (prevMax === undefined) delete this.displayMax;
            else this.displayMax = prevMax;
        }

        if (this.image) this.scheduleRender(true);
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
