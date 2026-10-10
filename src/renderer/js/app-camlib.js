// 相机参数库:用户可把常用相机参数(品牌/型号/焦距/光圈/ISO/快门)存入库,
// 一键填入当前照片;EXIF 识别后还会自动匹配库条目补齐缺失字段。
window.App = Object.assign(window.App || {}, {
    camLibKey: 'qfs_cam_lib',

    getCamLib() {
        try { return JSON.parse(localStorage.getItem(this.camLibKey) || '[]'); } catch (e) { return []; }
    },
    setCamLib(arr) {
        try { localStorage.setItem(this.camLibKey, JSON.stringify(arr)); } catch (e) {}
        this._camLibCache = null;
    },

    // 当前 EXIF 输入框值(与 syncManualExif 同口径)
    _exifInputValues() {
        const $ = this.$;
        const efs = ['tfExifBrand', 'tfExifModel', 'tfExifFocal', 'tfExifAperture', 'tfExifIso', 'tfExifShutter'];
        const keys = ['brand', 'model', 'focal', 'aperture', 'iso', 'shutter'];
        const v = {};
        efs.forEach((id, i) => { const el = $(id); v[keys[i]] = el ? String(el.value).trim() : ''; });
        return v;
    },

    // 填充参数库下拉(保留当前选中)
    refreshCamLibSelect() {
        const sel = this.$('cbCamLib');
        if (!sel) return;
        const lib = this.getCamLib();
        const cur = sel.value;
        sel.innerHTML = '';
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = '-- 选择已存参数(自动填入) --';
        sel.appendChild(empty);
        lib.forEach(e => {
            const o = document.createElement('option');
            o.value = e.id;
            const brief = [e.brand, e.model, e.focal].filter(Boolean).join(' ');
            o.textContent = e.name + (brief ? ' · ' + brief : '');
            sel.appendChild(o);
        });
        if (cur && lib.some(e => e.id === cur)) sel.value = cur;
        const any = lib.length > 0;
        if (this.$('btnCamLibRename')) this.$('btnCamLibRename').style.display = any ? '' : 'none';
        if (this.$('btnCamLibDel')) this.$('btnCamLibDel').style.display = any ? '' : 'none';
    },

    // 选中库条目 → 填入输入框 + manualExif + 渲染
    applyCamLibEntry(id) {
        const entry = this.getCamLib().find(e => e.id === id);
        if (!entry) return;
        const $ = this.$;
        const efs = ['tfExifBrand', 'tfExifModel', 'tfExifFocal', 'tfExifAperture', 'tfExifIso', 'tfExifShutter'];
        const keys = ['brand', 'model', 'focal', 'aperture', 'iso', 'shutter'];
        keys.forEach((k, i) => { const el = $(efs[i]); if (el) el.value = entry[k] || ''; });
        this.syncManualExif();
        this.onSettingCommit();
        this.setStatus('已从参数库填入「' + entry.name + '」');
    },

    // 把当前输入框参数保存为新库条目(用户命名)
    async saveCurrentCamLib() {
        const v = this._exifInputValues();
        if (!v.brand && !v.model && !v.focal && !v.aperture && !v.iso && !v.shutter) {
            this.setStatus('当前没有可保存的相机参数'); return;
        }
        const name = await this.promptText('保存到参数库(起个名字,如"我的A7M4")', (v.brand + ' ' + v.model).trim() || '相机参数');
        if (!name) return;
        const lib = this.getCamLib();
        lib.push({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            name: String(name).trim(),
            brand: v.brand, model: v.model, focal: v.focal,
            aperture: v.aperture, iso: v.iso, shutter: v.shutter
        });
        this.setCamLib(lib);
        this.refreshCamLibSelect();
        const sel = this.$('cbCamLib');
        if (sel) sel.value = lib[lib.length - 1].id;
        this.setStatus('已保存参数库「' + name + '」');
    },

    // 重命名当前选中条目
    async renameCamLibEntry() {
        const sel = this.$('cbCamLib');
        const id = sel && sel.value;
        const lib = this.getCamLib();
        const entry = lib.find(e => e.id === id);
        if (!entry) return;
        const name = await this.promptText('重命名参数库条目', entry.name);
        if (!name || String(name).trim() === entry.name) return;
        entry.name = String(name).trim();
        this.setCamLib(lib);
        this.refreshCamLibSelect();
        this.setStatus('已重命名为「' + entry.name + '」');
    },

    // 删除当前选中条目
    deleteCamLibEntry() {
        const sel = this.$('cbCamLib');
        const id = sel && sel.value;
        const lib = this.getCamLib();
        const entry = lib.find(e => e.id === id);
        if (!entry) return;
        if (!confirm('删除参数库条目「' + entry.name + '」？')) return;
        this.setCamLib(lib.filter(e => e.id !== id));
        this.refreshCamLibSelect();
        if (sel) sel.value = '';
        this.setStatus('已删除「' + entry.name + '」');
    },

    // EXIF 自动匹配库条目:识别出品牌+型号后,用库中同名机型的完整参数补齐缺失字段。
    // 结果按图片 EXIF 做缓存,避免每次 refreshUI 重复匹配。
    camLibMatchExif(autoExif) {
        if (!autoExif || typeof autoExif !== 'object') return autoExif || {};
        const key = String(autoExif.make || '') + '|' + String(autoExif.model || '');
        if (this._camLibCache && this._camLibCache.key === key) return this._camLibCache.val;
        const lib = this.getCamLib();
        const out = Object.assign({}, autoExif);
        if (key !== '|') {
            const make = String(autoExif.make || '').toLowerCase().trim();
            const model = String(autoExif.model || '').toLowerCase().trim();
            const hit = lib.find(e => {
                const eb = String(e.brand || '').toLowerCase().trim();
                const em = String(e.model || '').toLowerCase().trim();
                if (!eb && !em) return false;
                const bHit = make && eb && (make.includes(eb) || eb.includes(make));
                const mHit = model && em && (model.includes(em) || em.includes(model));
                return bHit || mHit;
            });
            if (hit) {
                for (const k of ['brand', 'model', 'focal', 'aperture', 'iso', 'shutter']) {
                    if (!String(out[k === 'brand' ? 'make' : k] || '').trim() && hit[k]) {
                        out[k === 'brand' ? 'make' : k] = hit[k];
                    }
                }
            }
        }
        this._camLibCache = { key, val: out };
        return out;
    }
});
