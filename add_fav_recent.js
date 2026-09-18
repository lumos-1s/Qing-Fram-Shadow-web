const fs = require('fs');
let t = fs.readFileSync('src/renderer/js/app-templates.js', 'utf8').replace(/\r\n/g, '\n');

// 1. buildTree开头加收藏和最近分组
t = t.replace(
    `    buildTree(filter) {
        const tree = this.dom.presetTree;
        tree.innerHTML = '';
        const f = (filter || '').toLowerCase();`,
    `    getFavorites() { try { return JSON.parse(localStorage.getItem('qfs_fav_presets') || '[]'); } catch(e) { return []; } },
    setFavorites(arr) { localStorage.setItem('qfs_fav_presets', JSON.stringify(arr)); },
    getRecent() { try { return JSON.parse(localStorage.getItem('qfs_recent_presets') || '[]'); } catch(e) { return []; } },
    pushRecent(name) {
        if (!name) return;
        let r = this.getRecent().filter(n => n !== name);
        r.unshift(name);
        if (r.length > 6) r = r.slice(0, 6);
        localStorage.setItem('qfs_recent_presets', JSON.stringify(r));
    },
    toggleFav(name) {
        let f = this.getFavorites();
        if (f.includes(name)) f = f.filter(n => n !== name);
        else f.push(name);
        this.setFavorites(f);
        this.buildTree(this._searchVal || '');
    },

    buildTree(filter) {
        const tree = this.dom.presetTree;
        tree.innerHTML = '';
        const f = (filter || '').toLowerCase();
        this._searchVal = filter || '';
        const favs = this.getFavorites();
        const recent = this.getRecent();`
);

// 2. 在sorted循环前插入收藏和最近分组
t = t.replace(
    `        const curName = (this.template && this.template.templateName) || '';
        const curGrp = curName ? [...sorted].find(g => (groups.get(g) || []).some(p => p.templateName === curName)) : null;
        const defOpen = curGrp || sorted[0] || null;
        for (const grp of sorted) {`,
    `        const curName = (this.template && this.template.templateName) || '';
        const curGrp = curName ? [...sorted].find(g => (groups.get(g) || []).some(p => p.templateName === curName)) : null;
        const defOpen = curGrp || sorted[0] || null;
        // 渲染预设项的公共函数
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
            // 星标按钮
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
        // ⭐ 收藏分组
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
        // 🕐 最近使用分组
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
        for (const grp of sorted) {`
);

// 3. 替换原来的item渲染为renderItem
t = t.replace(
    `            for (const p of groups.get(grp)) {
                const item = document.createElement('div');
                item.className = 'preset-item';
                const dot = document.createElement('span');
                dot.className = 'dot';
                dot.textContent = iconFor(p.templateName);
                item.appendChild(dot);
                const label = document.createElement('span');
                label.textContent = p.templateName;
                item.appendChild(label);
                item.addEventListener('click', () => this.selectPreset(p, item));
                item.dataset.grp = grp;
                groupEl.appendChild(item);
            }`,
    `            for (const p of groups.get(grp)) groupEl.appendChild(renderItem(p, grp));`
);

// 4. selectPreset记录最近
t = t.replace(
    `    selectPreset(p, itemEl) {
        this.pushUndo();
        this.applyPreset(p);
        document.querySelectorAll('.preset-item').forEach(el => el.classList.remove('active'));
        if (itemEl) itemEl.classList.add('active');
    },`,
    `    selectPreset(p, itemEl) {
        this.pushUndo();
        this.applyPreset(p);
        this.pushRecent(p.templateName);
        document.querySelectorAll('.preset-item').forEach(el => el.classList.remove('active'));
        if (itemEl) itemEl.classList.add('active');
        this.buildTree(this._searchVal || '');
    },`
);
fs.writeFileSync('src/renderer/js/app-templates.js', t, 'utf8');
console.log('ok');
