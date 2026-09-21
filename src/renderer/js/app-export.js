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
            const tpl = this.exportTemplateFor(im, idx, this.currentIdx, this.template);
            const puzzle = !!(tpl && tpl.puzzle && tpl.puzzle.enabled);
            // blank:未设过边框(默认空模板),多图导出时会被静默当成“原图直出”,与预览预期不符
            jobs.push({ im, puzzle, blank: !this.hasBorderSettings(tpl), useBase: false });
        });
        if (!jobs.length) { this.setStatus('请先导入照片'); return; }

        // 空模板陷阱:当前正编辑的边框有意义,而其它照片还没有边框 → 给一次选择:沿用当前设计 / 按原图直出
        let useBaseCount = 0;
        const blanks = jobs.filter(j => j.blank);
        if (jobs.length > 1 && blanks.length && this.hasBorderSettings(this.template)) {
            const names = blanks.slice(0, 3).map(j => (j.im.name || '照片').replace(/\.[^.]+$/, '')).join('、');
            const more = blanks.length > 3 ? `…等 ${blanks.length} 张` : `共 ${blanks.length} 张`;
            const ok = window.confirm(`${names}${more}还没有设置边框,默认会按原图导出。\n\n是否改为沿用当前边框设计导出这些照片?`);
            if (ok) blanks.forEach(j => { j.blank = false; j.useBase = true; useBaseCount++; });
        }

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
                // 只缩放「尺寸」。位置不再按 k 放大:
                //  - rel 元素的位置是相对比例(rx/ry),与画布大小无关,放大比例会把它推出画布;
                //  - 锚点元素兼容旧模板的 offsetX/offsetY,按 k 放大以保持视觉边距。
                if (el.size) el.size *= k;
                if (typeof el.x !== 'number' && (el.offsetX || el.offsetY)) {
                    if (el.offsetX) el.offsetX *= k;
                    if (el.offsetY) el.offsetY *= k;
                }
                any = true;
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
        const btnCancel = document.getElementById('btnExportCancel');
        try {
            // 导出按逻辑像素渲染(不乘 devicePixelRatio),保证导出分辨率与该选项/“原图尺寸”一致
            this.uiDprOverride = 1;
            this._exportAbort = false;
            if (btnCancel) btnCancel.style.display = '';
            this.setStatus(`正在导出 ${jobs.length} 张…`);
            let okCount = 0, failCount = 0, aborted = false;
            for (let n = 0; n < jobs.length; n++) {
                if (this._exportAbort) { aborted = true; break; }
                const { im, puzzle } = jobs[n];
                this.image = im;
                this.invalidateStyleCaches();
                this.currentIdx = this.images.indexOf(im);
                // 每张图用各自预设:已自定义/记忆过的用其自身;当前主图用正在编辑的模板;其余未设置的用各自默认边框(不跟随第一张)
                const srcTpl = jobs[n].useBase ? baseTemplate : this.exportTemplateFor(im, this.images.indexOf(im), originalIdx, baseTemplate);
                // 导出专用深拷贝:后续 scaleElPix 的缩放不会污染正在编辑的活模板与已存的 customSettings 快照
                this.template = JSON.parse(JSON.stringify(srcTpl));
                this.normalizeTemplate();
                // 先按 UI 默认尺寸渲染一次,取得元素坐标的"基准画布宽度"
                this.displayMax = undefined;
                delete this.exportScale;
                try {
                    await new Promise(res => requestAnimationFrame(() => {
                        if (puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false, true);
                        else window.__render(this, false);
                        res();
                    }));
                    const beforeW = Math.max(1, this.dom.canvas.width || 1);
                    const targetPx = sizeOpt > 0 ? sizeOpt : Math.max(1, im.w || 1, im.h || 1);
                    this.displayMax = targetPx;
                    // 选了大尺寸选项时交出目标长边,由引擎上采样到该值(小图也能导出到所选尺寸)
                    if (sizeOpt > 0) this.exportScale = sizeOpt;
                    await new Promise(res => requestAnimationFrame(() => {
                        if (puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false, true);
                        else window.__render(this, false);
                        res();
                    }));
                    const afterW = Math.max(1, this.dom.canvas.width || 1);
                    const k = afterW / beforeW;
                    // 元素坐标为基准画布像素:导出画布变大时等比放大,避免缩到角落
                    // (this.template 是导出专用拷贝,副本随本循环丢弃,无需再按 1/k 还原)
                    if (!puzzle && k !== 1 && scaleElPix(this.template, k)) {
                        await new Promise(res => requestAnimationFrame(() => {
                            window.__render(this, false);
                            res();
                        }));
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
                } catch (e) {
                    files[n].data = null;
                }
                // 目录模式多张时逐张写盘并及时释放内存,避免全部 base64 同时驻留
                if (files[n].data && loc.mode === 'dir' && jobs.length > 1) {
                    const wr = await window.qingframe.writeExportFiles({ location: loc, files: [files[n]] }) || {};
                    if (wr.ok) okCount++; else failCount++;
                    files[n].data = null;
                } else if (!files[n].data) {
                    failCount++;
                }
                this.showExportProgress(n, jobs.length, im.name);
            }
            // 剩余文件(单文件模式 / 目录模式仅一张)统一写出;已取消导出则丢弃未写盘的结果
            const pending = files.filter(f => !!f.data);
            if (pending.length && !aborted) {
                const r = await window.qingframe.writeExportFiles({ location: loc, files: pending }) || {};
                okCount += r.ok || 0; failCount += r.fail || 0;
            }
            const m = aborted
                ? `已取消导出：完成 ${okCount}${failCount ? `，失败 ${failCount}` : ''}`
                : `导出完成：成功 ${okCount}${failCount ? `，失败 ${failCount}` : ''}${useBaseCount ? `（${useBaseCount} 张沿用当前设计）` : ''}`;
            this.setStatus(m);
        } finally {
            if (btnCancel) btnCancel.style.display = 'none';
            delete this.uiDprOverride;
            delete this.exportScale;
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

    // 每张照片导出用哪个模板:已自定义/记忆过的用其自身;否则当前主图(ownerIdx,导出开始时的图)用 liveTemplate,其余用默认空模板
    exportTemplateFor(im, idx, ownerIdx, liveTemplate) {
        return im.customSettings || this.imageTemplates.get(im) ||
            (idx === ownerIdx ? liveTemplate : this.defaultTemplate());
    },

    // 导出进度:进度条 + 底部“第 n / N 张”标签
    showExportProgress(n, total, name) {
        const bar = document.getElementById('progressBar');
        if (bar) bar.style.width = Math.round(((n + 1) / total) * 100) + '%';
        const label = document.getElementById('exportProgressText');
        if (label) { label.style.display = ''; label.textContent = `导出中 ${n + 1}/${total} · ${String(name || '').replace(/\.[^.]+$/, '')}`; }
    },

    resetProgress() {
        const bar = document.getElementById('progressBar');
        if (bar) setTimeout(() => bar.style.width = '0', 800);
        const btnCancel = document.getElementById('btnExportCancel');
        if (btnCancel) btnCancel.style.display = 'none';
        const label = document.getElementById('exportProgressText');
        if (label) label.style.display = 'none';
        delete this._exportAbort;
    }
});
