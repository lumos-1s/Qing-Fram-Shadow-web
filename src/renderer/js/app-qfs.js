// .qfs 模块:自包含工程文件(单文件 JSON:bundle 模板 + 源照片 base64 + 每图模板)
window.App = Object.assign(window.App || {}, {
    // 把照片对象渲染进离屏画布,取 base64(仅导出时调用,限定内存开销)
    imageToQfsBase64(im, mime, quality) {
        const c = document.createElement('canvas');
        c.width = im.w; c.height = im.h;
        const cx = c.getContext('2d');
        if (mime === 'image/jpeg') {
            cx.fillStyle = '#ffffff';
            cx.fillRect(0, 0, c.width, c.height);
        }
        cx.drawImage(im.el, 0, 0);
        return c.toDataURL(mime, quality).split(',')[1];
    },

    // 导出当前会话为 .qfs 工程(含所有照片 + 每图模板);无照片时退回纯模板 JSON
    async exportQFS() {
        if (!this.images || !this.images.length) { this.setStatus('请先导入照片再导出工程'); return; }
        this.syncModelFromUI();
        const name = (this.$('tfTemplateName') && this.$('tfTemplateName').value.trim()) || '未命名工程';
        const images = [];
        for (const im of this.images) {
            let data = null;
            try { data = this.imageToQfsBase64(im, 'image/jpeg', 0.92); } catch (e) { data = null; }
            images.push({
                name: im.name || 'photo',
                w: im.w, h: im.h,
                exif: im.exif || {},
                customSettings: im.customSettings ? JSON.parse(JSON.stringify(im.customSettings)) : null,
                data
            });
        }
        const bundle = {
            v: 2,
            kind: 'qfs',
            app: 'qingframe-web',
            name,
            createdAt: new Date().toISOString(),
            session: { currentIdx: this.currentIdx },
            template: this.cloneTemplate(),
            images
        };
        this.setStatus('正在写入 .qfs 工程文件…');
        const r = await window.qingframe.exportQfs(bundle);
        this.setStatus(r.ok ? `工程已导出为「${name}.qfs」` : (r.canceled ? '已取消导出' : '导出失败：' + (r.error || '')));
    },

    // 导入 .qfs 工程(自包含)或旧版裸模板 JSON(自动识别)
    async importQFS() {
        const r = await window.qingframe.openQfs();
        if (!r.ok) { this.setStatus(r.canceled ? '已取消' : '导入失败：' + (r.error || '')); return; }
        const data = r.data;
        if (!data || typeof data !== 'object') { this.setStatus('导入失败：文件内容无法识别'); return; }
        if (Array.isArray(data.images) && data.images.length) {
            await this.restoreQfsProject(data, r.name);
        } else {
            // 兼容旧版 .json 裸模板
            this.onSettingCommit();
            this.template = JSON.parse(JSON.stringify(data));
            this.normalizeTemplate();
            this.saveCurrentTemplate();
            this.refreshUI();
            this.scheduleRender(true);
            this.setStatus(`已导入模板「${r.name}」`);
        }
        this.refreshTemplates();
    },

    // 用 .qfs 内容重建会话(替换当前工作区)
    async restoreQfsProject(bundle, name) {
        const ims = [];
        const metas = bundle.images || [];
        for (const m of metas) {
            if (!m.data) continue;
            const img = new Image();
            const src = String(m.data).indexOf('data:') === 0 ? m.data : 'data:image/jpeg;base64,' + m.data;
            await new Promise(res => { img.onload = res; img.onerror = res; img.src = src; });
            if (!img.naturalWidth) continue;
            const exif = m.exif || {};
            const oriented = await this.applyOrientation(img, exif.orientation);
            const useEl = oriented ? oriented.el : img;
            const im = {
                el: useEl,
                name: m.name || 'photo',
                w: oriented ? oriented.w : img.naturalWidth,
                h: oriented ? oriented.h : img.naturalHeight,
                exif,
                customSettings: m.customSettings ? JSON.parse(JSON.stringify(m.customSettings)) : null
            };
            if (im.customSettings) this.imageTemplates.set(im, JSON.parse(JSON.stringify(im.customSettings)));
            this.queueThumb(im);
            ims.push(im);
        }
        if (!ims.length) { this.setStatus('导入失败：工程里没有可恢复的照片'); return; }
        this.onSettingCommit();
        this.images = ims;
        this.selectedIdx = [];
        this.batchSel = [];
        const ci = Math.min(Math.max(0, (bundle.session && bundle.session.currentIdx) || 0), ims.length - 1);
        this.currentIdx = ci;
        this.image = ims[ci];
        this.template = this.image && this.image.customSettings
            ? JSON.parse(JSON.stringify(this.image.customSettings))
            : (bundle.template ? JSON.parse(JSON.stringify(bundle.template)) : this.defaultTemplate());
        this.normalizeTemplate();
        this.invalidateStyleCaches();
        this.buildThumbnails();
        this.afterImageSelect();
        this.refreshUI();
        this.scheduleRender(true);
        this.saveDraftNow();
        this.setStatus(`已打开工程「${name}」（${ims.length} 张照片）`);
    }
});