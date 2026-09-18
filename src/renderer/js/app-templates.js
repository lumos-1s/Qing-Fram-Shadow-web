// 模板模块：模板页签 + 预设加载/预设树 —— 从 app.js 拆分
window.App = Object.assign(window.App || {}, {
    /* ══ 模板页签 ══ */
    refreshTemplateFields() {
        const $ = this.$;
        const t = this.template || {};
        if ($('tfTemplateName')) $('tfTemplateName').value = t.templateName || '';
        if ($('tfTemplateTag')) $('tfTemplateTag').value = t.templateTag || '';
    },

    async refreshTemplates() {
        const box = this.$('lvPresets');
        if (!box) return;
        const names = (await window.qingframe.listTemplates()) || [];
        this._savedTemplates = names;
        box.innerHTML = '';
        if (!names.length) { box.innerHTML = '<div class="empty">暂无已存模板</div>'; return; }
        names.forEach(n => {
            const row = document.createElement('div');
            row.className = 'tpl-row';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = n; // 用 textContent,避免恶意名称注入 HTML(XSS)
            const btnBox = document.createElement('div');
            const btnLoad = document.createElement('button');
            btnLoad.className = 'mini-btn'; btnLoad.textContent = '应用';
            const btnDel = document.createElement('button');
            btnDel.className = 'mini-btn danger'; btnDel.textContent = '删除';
            btnBox.appendChild(btnLoad); btnBox.appendChild(btnDel);
            row.appendChild(nameSpan); row.appendChild(btnBox);
            btnLoad.addEventListener('click', async () => this.loadTemplateByName(n));
            btnDel.addEventListener('click', async () => { await window.qingframe.deleteTemplate(n); this.refreshTemplates(); });
            box.appendChild(row);
        });
    },

    async saveTemplate() {
        const $ = this.$;
        const name = ($('tfTemplateName') ? $('tfTemplateName').value : '').trim();
        if (!name) { this.setStatus('请输入模板名称'); return; }
        // 从回显字段刷新模板(名称/标签)
        if (this.template) {
            this.template.templateName = name;
            this.template.templateTag = $('tfTemplateTag') ? $('tfTemplateTag').value.trim() : '';
        }
        this.syncModelFromUI();
        const r = await window.qingframe.saveTemplate(name, this.cloneTemplate());
        this.setStatus(r.ok ? `已保存模板「${name}」` : '保存失败：' + (r.error || ''));
        this.refreshTemplates();
    },

    async loadTemplate() {
        if (!this._savedTemplates || !this._savedTemplates.length) {
            const names = (await window.qingframe.listTemplates()) || [];
            this._savedTemplates = names;
        }
        if (!this._savedTemplates.length) { this.setStatus('暂无已存模板'); return; }
        const opts = this._savedTemplates.map((n, i) => `${i + 1}. ${n}`).join('\n');
        const choice = window.prompt('选择要加载的模板(输入序号或名称,留空取消):\n' + opts, '1');
        if (!choice) { this.setStatus('已取消'); return; }
        const idx = parseInt(choice, 10) - 1;
        const name = this._savedTemplates[idx] || String(choice).trim();
        if (!name) return;
        await this.loadTemplateByName(name);
    },

    async loadTemplateByName(name) {
        if (window.qingframe.loadTemplate) {
            const data = await window.qingframe.loadTemplate(name);
            if (!data) { this.setStatus('加载模板失败'); return; }
            this.onSettingCommit();
            this.template = JSON.parse(JSON.stringify(data));
            this.normalizeTemplate();
            this.saveCurrentTemplate();
            this.refreshUI();
            this.scheduleRender(true);
            this.setStatus(`已应用模板「${name}」`);
            return;
        }
    },

    async exportTemplate() {
        // 导出 .qfs 工程(含照片)或旧版裸模板 JSON
        if (this.images && this.images.length) return this.exportQFS();
        const name = (this.$('tfTemplateName') ? this.$('tfTemplateName').value : '').trim() || 'template';
        this.syncModelFromUI();
        const r = await window.qingframe.exportTemplate(name, this.cloneTemplate());
        this.setStatus(r.ok ? '模板已导出' : (r.canceled ? '已取消' : '导出失败'));
    },

    async importTemplate() {
        // 导入 .qfs 工程或旧版裸模板 JSON
        return this.importQFS();
    },

    applyQuickPreset(kind) {
        if (!this.presets.length) { this.setStatus('预设库未加载'); return; }
        this.onSettingCommit();
        let p = null;
        if (kind === 'film') p = this.presets.find(x => /胶片/i.test(x.templateName)) || this.presets[0];
        else p = this.presets.find(x => /证件照/i.test(x.templateName)) || this.presets[0];
        if (p) {
            this.template = JSON.parse(JSON.stringify(p));
            this.normalizeTemplate();
            this.saveCurrentTemplate();
            this.refreshUI();
            this.scheduleRender(true);
            this.setStatus(`已应用预设「${p.templateName}」`);
        }
    },

    async autoColorBorder() {
        if (!this.image) { this.setStatus('请先导入照片'); return; }
        const color = window.EngineStyles && window.EngineStyles.extractDominant;
        if (typeof color !== 'function') { this.setStatus('自动取色不可用'); return; }
        try {
            const c = await color(this.image.el);
            this.onSettingCommit();
            const layer = this.currentLayer();
            layer.fillConfig.fillType = 'solid';
            layer.fillConfig.fillHex = c.replace('#', '');
            if (this.$('cpFillColor')) this.$('cpFillColor').value = c;
            this.refreshUI();
            this.scheduleRender(true);
            this.setStatus(`已应用自动取色边框 #${c}`);
        } catch (e) { this.setStatus('取色失败: ' + e.message); }
    },

    loadPresetFromList() {
        const li = this.$('lvPresets');
        const active = li && li.querySelector('.tpl-row span');
        if (!this._savedTemplates || !this._savedTemplates.length) { this.setStatus('模板列表为空'); return; }
        // 加载代码预设区:选择左侧预设树当前高亮
        const activeItem = document.querySelector('.preset-item.active');
        if (activeItem) { this.selectPresetFromTree(activeItem); return; }
        this.setStatus('请在左侧预设树选择一个预设');
    },

    selectPresetFromTree(item) {
        const label = item.querySelector('span:not(.dot)');
        const name = label ? label.textContent.trim() : '';
        const p = this.presets.find(x => x.templateName === name);
        if (!p) { this.setStatus('未找到该预设'); return; }
        this.onSettingCommit();
        this.applyPreset(p);
        this.refreshTemplates();
        this.setStatus(`已应用预设「${p.templateName}」`);
    },
    /* ══ 预设加载 ══ */
    async loadPresets() {
        this.splashStatus('正在加载预设…');
        try { this.presets = await window.__loadAllPresets(); }
        catch (e) { this.presets = []; }
        this.buildTree();
        if (this.presets.length) this.selectPreset(this.presets[0]);
        this.splashTick();
    },

    async loadLogos() {
        try { this.logos = (await window.qingframe.listLogos()) || []; }
        catch (e) { this.logos = []; }
        try {
            const saved = JSON.parse(localStorage.getItem('qfs_custom_icons') || '[]');
            saved.forEach(c => { if (c && c.dataUrl) this.logos.push(c); });
        } catch(e) {}
        this.splashTick();
        if (this.dom.stRes) this.renderLogoPools();
    },
    saveCustomIcon(logo) {
        try {
            const saved = JSON.parse(localStorage.getItem('qfs_custom_icons') || '[]');
            saved.push(logo);
            localStorage.setItem('qfs_custom_icons', JSON.stringify(saved));
        } catch(e) {}
    },
    deleteCustomIcon(logo) {
        try {
            let saved = JSON.parse(localStorage.getItem('qfs_custom_icons') || '[]');
            saved = saved.filter(c => c.dataUrl !== logo.dataUrl);
            localStorage.setItem('qfs_custom_icons', JSON.stringify(saved));
        } catch(e) {}
    },

    async loadTextures() {
        try { this.textures = (await window.qingframe.listTextures()) || []; }
        catch (e) { this.textures = []; }
        this.splashTick();
    },

    getFavorites() { try { return JSON.parse(localStorage.getItem("qfs_fav_presets") || "[]"); } catch(e) { return []; } },
    setFavorites(arr) { localStorage.setItem("qfs_fav_presets", JSON.stringify(arr)); },
    getRecent() { try { return JSON.parse(localStorage.getItem("qfs_recent_presets") || "[]"); } catch(e) { return []; } },
    pushRecent(name) {
        if (!name) return;
        let r = this.getRecent().filter(n => n !== name);
        r.unshift(name);
        if (r.length > 6) r = r.slice(0, 6);
        localStorage.setItem("qfs_recent_presets", JSON.stringify(r));
    },
    toggleFav(name) {
        let f = this.getFavorites();
        if (f.includes(name)) f = f.filter(n => n !== name);
        else f.push(name);
        this.setFavorites(f);
        this.buildTree(this._searchVal || "");
    },

    buildTree(filter) {
        const tree = this.dom.presetTree;
        tree.innerHTML = '';
        const f = (filter || '').toLowerCase();
        this._searchVal = filter || '';
        const favs = this.getFavorites();
        const recent = this.getRecent();
        const order = ['潮流', '高级感', '极简', '胶片', '质感', '复古', '杂志', '水印', '氛围', '比例', '票根'];
        const merge = { 创意: '潮流', 奢华: '高级感', 现代: '极简', 排版: '极简', 影院: '胶片', 星空: '氛围' };
        const groupIcons = {
            潮流: '🪩', 高级感: '💎', 极简: '⚪', 胶片: '🎞️', 质感: '🪵',
            复古: '📻', 杂志: '📰', 水印: '💧', 氛围: '🌙', 比例: '📐',
            票根: '🎫', 通用: '🖼️'
        };
        const iconFor = name => {
            const kw = [
                ['拼贴', '🧩'], ['霓虹', '🪩'], ['光环', '✨'], ['双', '📎'], ['星', '🌌'], ['极光', '🌈'],
                ['渐变', '🌈'], ['边框', '🖼️'], ['白框', '🖼️'], ['卡片', '💳'], ['卡', '🔲'], ['票根', '🎫'],
                ['相机', '📷'], ['胶片', '🎞️'], ['胶卷', '🎞️'], ['电影', '🎬'], ['银幕', '🎬'], ['宽银幕', '🎬'],
                ['撕裂', '💥'], ['双重曝光', '📸'], ['曝光', '📸'], ['杂志', '📰'], ['大刊头', '📰'], ['页眉', '📰'],
                ['封面', '📕'], ['报纸', '📰'], ['海报', '🖼️'], ['波普', '🌀'],
                ['极简', '⚪'], ['简约', '🗒️'], ['细线', '➖'], ['编号', '🔢'], ['日期', '📅'],
                ['复古', '📻'], ['登机牌', '🎫'], ['深色', '🌑'], ['身份卡', '🪪'], ['苹果', '🍎'],
                ['小红', '❤️'], ['cream', '🍰'], ['奶油', '🍰'], ['醒图', '🍰'], ['琉璃', '🍯'],
                ['牛仔', '👖'], ['布纹', '🧵'], ['磨砂', '🌫️'], ['毛玻璃', '🌫️'], ['玻璃', '🪟'],
                ['晨雾', '🌫️'], ['金箔', '🥇'], ['奢华', '👑'], ['丝绒', '🧶'], ['参数', '🔤'],
                ['logo', '🔤'], ['留白', '🌬️'], ['画廊', '🏛️'], ['画框', '🖼️'], ['分层', '🗂️'],
                ['胶片条', '🎞️'], ['比例', '📐'], ['信息条', 'ℹ️'], ['背景模糊', '🌫️'], ['模糊', '🌸']
            ];
            const n = String(name || '');
            for (const [k, ic] of kw) if (n.includes(k)) return ic;
            return '💠';
        };
        const groups = new Map();
        for (const p of this.presets) {
            if (f && !p.templateName.toLowerCase().includes(f) && !(p.templateTag || '').toLowerCase().includes(f)) continue;
            const grp = merge[p.templateTag] || p.templateTag || '通用';
            if (!groups.has(grp)) groups.set(grp, []);
            groups.get(grp).push(p);
        }
        const sorted = [...groups.keys()].sort((a, b) => {
            const ia = order.indexOf(a), ib = order.indexOf(b);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'zh');
        });
        const curName = (this.template && this.template.templateName) || '';
        const curGrp = curName ? [...sorted].find(g => (groups.get(g) || []).some(p => p.templateName === curName)) : null;
        const defOpen = curGrp || sorted[0] || null;
        const renderItem = (p, grp) => {
            const item = document.createElement('div');
            item.className = 'preset-item' + (p.templateName === curName ? ' active' : '');
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.textContent = iconFor(p.templateName);
            item.appendChild(dot);
            const label = document.createElement('span');
            label.textContent = p.templateName;
            item.appendChild(label);
            const star = document.createElement('span');
            star.textContent = favs.includes(p.templateName) ? '★' : '☆';
            star.style.cssText = 'margin-left:auto;cursor:pointer;font-size:14px;color:#f59e0b;padding:0 4px;';
            star.title = '收藏/取消收藏';
            star.addEventListener('click', (e) => { e.stopPropagation(); this.toggleFav(p.templateName); });
            item.appendChild(star);
            item.addEventListener('click', () => this.selectPreset(p, item));
            item.dataset.grp = grp;
            return item;
        };
        // 收藏分组
        if (!f || favs.some(n => n.toLowerCase().includes(f))) {
            const favPresets = favs.map(n => this.presets.find(p => p.templateName === n)).filter(Boolean);
            if (favPresets.length) {
                const gEl = document.createElement('div');
                gEl.className = 'preset-group open';
                const nm = document.createElement('div');
                nm.className = 'group-name';
                nm.innerHTML = '<span class="caret">▸</span><span class="g-icon">⭐</span><span>收藏 · ' + favPresets.length + '</span>';
                nm.addEventListener('click', () => gEl.classList.toggle('open'));
                gEl.appendChild(nm);
                favPresets.forEach(p => gEl.appendChild(renderItem(p, '收藏')));
                tree.appendChild(gEl);
            }
        }
        // 最近使用分组
        if (!f) {
            const recPresets = recent.map(n => this.presets.find(p => p.templateName === n)).filter(Boolean);
            if (recPresets.length) {
                const gEl = document.createElement('div');
                gEl.className = 'preset-group open';
                const nm = document.createElement('div');
                nm.className = 'group-name';
                nm.innerHTML = '<span class="caret">▸</span><span class="g-icon">🕐</span><span>最近使用 · ' + recPresets.length + '</span>';
                nm.addEventListener('click', () => gEl.classList.toggle('open'));
                gEl.appendChild(nm);
                recPresets.forEach(p => gEl.appendChild(renderItem(p, '最近使用')));
                tree.appendChild(gEl);
            }
        }
        for (const grp of sorted) {
            const groupEl = document.createElement('div');
            groupEl.className = 'preset-group' + ((f && groups.get(grp).length) || grp === defOpen ? ' open' : '');
            const name = document.createElement('div');
            name.className = 'group-name';
            name.title = '点击展开/收起';
            const caret = document.createElement('span');
            caret.className = 'caret';
            caret.textContent = '\u25B8';
            name.appendChild(caret);
            const gic = document.createElement('span');
            gic.className = 'g-icon';
            gic.textContent = groupIcons[grp] || '🖼️';
            name.appendChild(gic);
            const tag = document.createElement('span');
            tag.textContent = `${grp} · ${groups.get(grp).length}`;
            name.appendChild(tag);
            name.addEventListener('click', () => {
                groupEl.classList.toggle('open');
            });
            groupEl.appendChild(name);
            tree.appendChild(groupEl);
            for (const p of groups.get(grp)) groupEl.appendChild(renderItem(p, grp));
        }
    },
    filterTree(v) { this.buildTree(v); },

    selectPreset(p, itemEl) {
        this.pushUndo();
        this.applyPreset(p);
        this.pushRecent(p.templateName);
        document.querySelectorAll('.preset-item').forEach(el => el.classList.remove('active'));
        if (itemEl) itemEl.classList.add('active');
        this.buildTree(this._searchVal || '');
    },

    applyPreset(p) {
        this.template = JSON.parse(JSON.stringify(p));
        this.normalizeTemplate();
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
    },

    resetParams() {
        if (!this.template) return;
        this.pushUndo();
        this.template = this.defaultTemplate();
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus('参数已重置');
    },

    randomBorder() {
        if (!this.presets.length) return;
        this.pushUndo();
        let p = this.presets[Math.floor(Math.random() * this.presets.length)];
        this.template = JSON.parse(JSON.stringify(p));
        this.normalizeTemplate();
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus(`已应用随机边框：${p.templateName}`);
    },

    syncToSelected() {
        if (this.selectedIdx.length <= 1) { this.setStatus('请先在胶片条中多选需要同步的照片(Ctrl/Shift+点击)'); return; }
        const srcIdx = this.selectedIdx[0];
        const srcIm = this.images[srcIdx];
        const srcTpl = srcIm && (srcIm.customSettings || this.imageTemplates.get(srcIm));
        // 同步内容 = 边框/照片/光影等参数;Logo/贴纸/自由文字/拼图布局按“每张图片独立记忆”不随同步迁移
        const applied = JSON.parse(JSON.stringify(srcTpl || this.template));
        if (Array.isArray(applied.logoElements)) applied.logoElements = [];
        if (applied.decorConfig) { delete applied.decorConfig.stickers; delete applied.decorConfig.textLines; }
        delete applied.puzzle;
        let count = 0;
        this.selectedIdx.slice(1).forEach(i => {
            const im = this.images[i];
            if (!im) return;
            im.customSettings = JSON.parse(JSON.stringify(applied));
            this.imageTemplates.set(im, JSON.parse(JSON.stringify(applied)));
            this.queueThumb(im);
            count++;
        });
        // 若当前显示的照片也在同步目标中,立刻以第一张的参数刷新界面
        if (this.currentIdx !== srcIdx && this.selectedIdx.includes(this.currentIdx)) {
            this.template = JSON.parse(JSON.stringify(applied));
            this.selectedEls = [];
            this.refreshUI();
        }
        this.setStatus(`已将第 ${srcIdx + 1} 张的参数同步到其余 ${count} 张选中照片（Logo/元素按各图独立记忆）`);
        this.scheduleRender(true);
    }
});
