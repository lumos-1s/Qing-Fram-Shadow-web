// 导出模块：图片导出 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    /* ── 导出:先选保存位置,再渲染导出画面,最后写盘 ── */
    async exportImage() {
        if (!this.image) { this.setStatus('请先导入照片'); return; }
        // 每次导出重新求通道比例(画布/显示尺寸可能在两次导出之间变过)
        delete this._exportPathDpr;
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
                // 让调度器里已排队的预览帧先跑完:导出期间 uiDprOverride=1,预览帧与导出帧
                // 渲染到同一块 canvas,谁后跑谁定稿。不等它就导出会拿到"预览还没让位"的中间态。
                await this.flushRender();
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
                    // 元素尺寸/锚点偏移的换算基准:试渲染宽度 × 本通道的 dpr 比例。
                    // 为什么必须补这个比例 —— 元素几何是以「设备像素」存的(engine.js drawLogoElements
                    // 在 ctx.restore() 之后按 canvas.width 口径绘制),而预览与导出的画布宽度差一个 dpr:
                    //   · 预览:engine setupCanvas 走 scale = uiScale * devicePixelRatio → canvas.width = _logW × dpr
                    //   · 导出:uiDprOverride=1 → canvas.width = _logW × 1
                    // 同一个 size 在两种画布上占图片的比例因此差 dpr 倍,不补就会让导出的 logo
                    // 正好大 dpr 倍(贴边的锚点 Logo 还会离边更远)。
                    // beforeW 是在导出通道里测的(dpr 恒 1),自己看不见这个差异,所以要单独求通道比例:
                    // 用第 1 张(用户正在看的那张)的真实画布宽度 uiMaxSave 与其试渲染宽度 beforeW 之比。
                    // 该比例同一会话内恒定(图层/卡片通道 = devicePixelRatio,相框通道 = 1),
                    // 之后每张沿用 —— 这样 beforeW 仍是**逐张**测的,保留了原作者"每张各自以默认预览
                    // 尺寸为基准"的口径(批量导出时各图长宽比不同,不能用第 1 张的宽度顶替)。
                    // DPR=1 或相框通道时 pathDpr = 1,行为与改动前完全一致。
                    if (!(this._exportPathDpr > 0)) {
                        this._exportPathDpr = (uiMaxSave > 0) ? (uiMaxSave / beforeW) : 1;
                    }
                    const k = this.exportSizeScale(afterW, beforeW, this._exportPathDpr);
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

    // 导出时元素尺寸/锚点偏移要乘的倍数。抽成纯函数便于单测(见 tools/test-engine-invariants.js ⑥):
    //   beforeW  = 该图在导出通道(uiDprOverride=1)下按默认显示尺寸试渲染的画布宽度
    //   pathDpr  = 预览画布宽度 / 同模板试渲染宽度 —— 同一会话内恒定的通道比例(图层/卡片 = dpr,相框 = 1)
    // 返回 1 表示"预览与导出口径一致,不必再渲一次"。
    exportSizeScale(afterW, beforeW, pathDpr) {
        const p = (typeof pathDpr === 'number' && pathDpr > 0) ? pathDpr : 1;
        return afterW / Math.max(1, beforeW * p);
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

    // 导出尺寸提示:所选档位超过相框能给出的最大尺寸时,提醒用户实际输出会小于所选值。
    //
    // 背景缺陷:engine-styles.js 的相框路径用 finalScale = Math.min(1, displayMax/长边) 封顶,
    // 根本不读 app.exportScale(而 NONE 路径读)。于是"选 4096/8192 + 用相框样式"拿不到所选尺寸 ——
    // 小图尤其明显(实测 1200px 照片选 4096 只出 1320px)。修它要动边框渲染主路径,
    // 而 AGENTS.md 规定「边框相关功能保持原样」,故不在渲染层动刀,改为把静默失望变成已知信息。
    //
    // 为什么只报"约 XXXX px"、不报精确值 —— 这里踩过一次坑,值得记下:
    // 我最初按 scaledSize 复刻了一份"照片长边 + 边框"当作上限,结果对 POLAROID_HAND 报错数。
    // 原因是 styleDims 里各样式取边框的方式根本不统一:多数样式用 scaledSize(...) 的返回值,
    // 但 POLAROID_HAND 这类是"比例驱动",直接写死 border = max(30, iw * 0.05),压根不读 photoFrameBorderSize。
    // 也就是说精确上限必须走 styleDims 那 63 个分支,而在 UI 层复刻一份必然随引擎演进而说错话 ——
    // 说错数字比不说更糟(用户会拿它当依据去定印刷尺寸)。
    //
    // 现在的做法:只陈述一定为真的事实,不猜具体数字。
    //   · 照片长边 L:相框的成品长边一定 ≥ L(加边框只会更大),所以能拿到 sizeOpt 当且仅当 sizeOpt ≥ L
    //   · 于是 sizeOpt > L ⟹ 一定拿不到 sizeOpt,这条推论与任何样式的边框算法无关,永不为错
    // 代价是对「刚好差一点够到」的档位会漏报(宁可漏报,不可报错)。
    updateExportSizeNote() {
        const note = this.dom.exportSizeNote;
        if (!note) return;
        const hide = () => {
            // 这是每次 input 都会走到的路径(经 onSettingChanged):已经是隐藏且无文字时别再写 DOM
            if (note.style.display === 'none' && !note.textContent) return;
            note.style.display = 'none';
            note.textContent = '';
        };
        const sizeOpt = parseInt(this.dom.selExportSize.value, 10) || 0;
        const tpl = this.template;
        // 原图直出(NONE)读 exportScale,行为与所选值一致,无需提示
        if (sizeOpt <= 0 || !tpl) return hide();
        if (String(tpl.photoFrameStyle || 'NONE').toUpperCase() === 'NONE') return hide();
        // 拼图走 app-puzzle.js 自己的导出通道(恒 4000px),与本表无关,别去打扰用户
        if (tpl.puzzle && tpl.puzzle.enabled) return hide();
        const el = this.image && this.image.el;
        if (!el) return hide();
        const photoLong = Math.max(el.naturalWidth || 0, el.naturalHeight || 0);
        // 照片长边都够不着所选档位 → 必然拿不到(sizeOpt > photoLong 是充分条件,与样式无关)
        if (sizeOpt <= photoLong) return hide();
        note.style.display = '';
        note.textContent = `相框按原始分辨率导出、不放大,实际长边不会达到 ${sizeOpt}px`;
        note.title = `所选 ${sizeOpt}px 大于照片原始长边 ${photoLong}px。相框成品长边只会在此基础上再加边框,` +
                     `因此无法上采样到 ${sizeOpt}px。照片足够大时该档位可正常输出。`;
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
