// 清框影 App 控制器 —— 依据 Java 版 MainController 交互逻辑重写
// 核心:onSettingChanged(高频防抖)/onSettingCommit(提交压栈)/scheduleRender(防抖渲染)/refreshUI(回显)
// 撤销/重做栈 + 每图独立模板(imageTemplates) + 画布元素(logo/贴纸/文字)管理
window.App = {
    image: null,          // 当前图片 {el, name, w, h, exif, customSettings}
    images: [],
    selectedIdx: [],
    batchSel: [],         // 胶片条勾选的照片索引(批量放图数据源)
    currentIdx: 0,
    template: null,       // 当前模板 JSON
    imageTemplates: new Map(), // 每图独立模板(深拷贝快照)
    presets: [],
    zoom: 1,
    panX: 0, panY: 0,
    _pan: null,
    renderToken: 0,
    _renderTimer: null,
    undoStack: [],
    redoStack: [],
    _gesture: false,
    isUpdating: false,
    draggingCompare: false,
    logos: [],
    logoImgCache: {},
    textures: [],
    curatedFonts: ['Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'FangSong', 'Arial', 'Arial Black', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Segoe UI', 'PingFang SC',
        // 中文艺术字/印章体
        '华文彩云', '华文琥珀', '华文行楷', '华文新魏', '幼圆', '隶书', '方正舒体', '方正姚体', '方正报宋', '汉仪雪峰体', '汉仪旗黑',
        // 西文艺术字
        'Segoe Script', 'Brush Script MT', 'Comic Sans MS', 'Impact', 'Papyrus', 'Ravie', 'Gigi', 'Chiller', 'Edwardian Script ITC', 'Monotype Corsiva', 'Snap ITC', 'Lucida Handwriting', 'Trebuchet MS', 'Copperplate Gothic Bold', 'Book Antiqua', 'Informal Roman', 'Bodoni MT'],
    _lastTplName: '',
    _firstRenderDone: false,
    selectedEls: [],      // 画布元素选中集(引用自模板数组)
    _elClip: null,        // 复制的元素快照 {kind, el}
    _puzzleSlot: 's0',       // 拼图当前编辑项('s0'..槽位 / 'v0'/'h0'..间隙)
    _editingGap: null,       // 正在编辑的字幕门牌号('H0'/'V1'/'S2'),无则收起编辑器
    _activePuzzleSlot: null, // 画布选中槽位(高亮 + 换图)
    _puzzlePick: null,       // 拖拽抓取预览 {mode:'target'|'float',...}
    _puzzleDropTarget: null, // 拖拽互换预备目标格
    _skipPuzzleCapture: false,

    restoreLastState() {
        try {
            const raw = localStorage.getItem('qfs_last_state');
            if (!raw) return;
            const s = JSON.parse(raw);
            // 找到对应预设并选中
            if (s.presetName && this.presets) {
                const p = this.presets.find(x => x.name === s.presetName);
                if (p) { this.selectPreset(p); return; }
            }
            // 没找到预设就只恢复关键字段
            if (s.photoFrameStyle && this.template) {
                this.template.photoFrameStyle = s.photoFrameStyle;
                if (s.userSignature) this.template.userSignature = s.userSignature;
                if (s.signFont) this.template.signFont = s.signFont;
                if (s.signColor) this.template.signColor = s.signColor;
                if (s.signIncludeModel != null) this.template.signIncludeModel = s.signIncludeModel;
                if (s.avatarScale) this.template.avatarScale = s.avatarScale;
                if (s.signSize) this.template.signSize = s.signSize;
                if (s.signBgBlur != null) this.template.signBgBlur = s.signBgBlur;
                if (s.paramColor) this.template.paramColor = s.paramColor;
                if (s.paramFontSize) this.template.paramFontSize = s.paramFontSize;
                if (s.brandSize) this.template.brandSize = s.brandSize;
                if (s.brandLogo != null) this.template.brandLogo = s.brandLogo;
                if (s.paramScale) this.template.paramScale = s.paramScale;
                this.refreshUI();
                this.scheduleRender();
            }
        } catch (_) {}
    },

    init() {
        this.initSplash();
        this.cacheDom();
        this.bind();
        this.loadPrefs();
        this.loadPresets();
        this.restoreLastState();
        this.loadLogos();
        this.loadTextures();
        this.populateFonts();
        this.setupShortcuts();
        this.setupPanelInteractions();
        // 工具栏按钮tooltip
        const tips = {
            btnUndo: '撤销 (Ctrl+Z)', btnRedo: '重做 (Ctrl+Y)',
            btnReset: '重置', btnRandom: '随机预设',
            btnFit: '适应窗口', btnOpen: '导入照片',
        };
        Object.entries(tips).forEach(([id, tip]) => {
            const el = document.getElementById(id);
            if (el) el.title = tip;
        });
        document.querySelectorAll('.pg-title.collapsible').forEach(t => {
            if (t._bound) return;
            t._bound = true;
            t.addEventListener('click', () => {
                const g = t.parentElement;
                if (g) g.classList.toggle('collapsed');
            });
        });
        const tplSearch = document.getElementById('tfTemplateSearch');
        if (tplSearch) tplSearch.addEventListener('input', () => this._applyTplFilter());
        this.updateHistoryButtons();
        this.initLogin();
        this.initDraft();
    },

    // 恢复上次的界面偏好(导出质量等)
    async loadPrefs() {
        try {
            const p = await window.qingframe.getPrefs();
            if (p && p.exportQuality && this.dom.slExportQuality) {
                this.dom.slExportQuality.value = p.exportQuality;
            }
        } catch (_) {}
    },

    cacheDom() {
        const $ = id => document.getElementById(id);
        this.dom = {
            btnOpen: $('btnOpen'), btnSave: $('btnSave'), selFormat: $('selFormat'), selExportSize: $('selExportSize'),
            slExportQuality: $('slExportQuality'),
            btnExportSettings: $('btnExportSettings'), exportPop: $('exportPop'),
            btnSyncSel: $('btnSyncSel'), btnUndo: $('btnUndo'), btnRedo: $('btnRedo'),
            btnReset: $('btnReset'), btnRandom: $('btnRandom'), btnFit: $('btnFit'),
            zoomInput: $('zoomInput'), zoomRange: $('zoomRange'), btnTheme: $('btnTheme'),
            presetTree: $('presetTree'), presetSearch: $('presetSearch'),
            canvas: $('previewCanvas'), canvasPane: $('canvasPane'), placeholder: $('placeholder'),
            stage: document.querySelector('.stage'),
            thumbStrip: $('thumbStrip'), dropOverlay: $('dropOverlay'),
            importProgress: $('importProgress'), importProgressFill: $('importProgressFill'), importProgressText: $('importProgressText'),
            tabs: $('inspTabs'), panels: Array.from(document.querySelectorAll('.tab-panel')),
            stRes: $('stRes'), stInfo: $('stInfo'), stCanvas: $('stCanvas'),
            btnCompare: $('btnCompare'),
            loginStatus: $('loginStatus'),
            loginModal: $('loginModal'),
            loginModalClose: $('loginModalClose'),
            loginUsername: $('loginUsername'),
            loginNickname: $('loginNickname'),
            loginSubmit: $('loginSubmit'),
            loginLogout: $('loginLogout'),
            loginFormView: $('loginFormView'),
            loginProfileView: $('loginProfileView'),
            loginAvatar: $('loginAvatar'),
            loginDisplayName: $('loginDisplayName'),
            loginUsernameDisplay: $('loginUsernameDisplay'),
        };
    },

    $(id) { return document.getElementById(id); },

    bind() {
        const d = this.dom;
        d.btnOpen.addEventListener('click', () => this.openImages());
        d.btnSave.addEventListener('click', () => this.exportImage());
        if (d.btnExportSettings && d.exportPop) {
            d.btnExportSettings.addEventListener('click', (e) => {
                e.stopPropagation();
                d.exportPop.style.display = d.exportPop.style.display === 'block' ? 'none' : 'block';
            });
            document.addEventListener('click', (ev) => {
                if (d.exportPop.style.display === 'block' && d.exportPop && ev.target !== d.btnExportSettings && !d.exportPop.contains(ev.target)) {
                    d.exportPop.style.display = 'none';
                }
            });
        }
        if (d.slExportQuality) {
            d.slExportQuality.addEventListener('change', () => {
                // 异步调用,静默忽略失败(旧主进程无该 handler 时不报未处理错误)
                window.qingframe.savePrefs({ exportQuality: d.slExportQuality.value }).catch(() => {});
            });
        }
        d.btnSyncSel.addEventListener('click', () => this.syncToSelected());
        d.btnUndo.addEventListener('click', () => this.undo());
        d.btnRedo.addEventListener('click', () => this.redo());
        d.btnReset.addEventListener('click', () => this.resetParams());
        d.btnRandom.addEventListener('click', () => this.randomBorder());
        d.btnFit.addEventListener('click', () => this.fitZoom());
        d.btnTheme.addEventListener('click', () => this.toggleTheme());
        d.zoomRange.addEventListener('input', e => this.setZoom(parseInt(e.target.value, 10) / 100));
        d.zoomInput.addEventListener('change', e => {
            const v = parseFloat(String(e.target.value).replace('%', ''));
            if (!isNaN(v)) this.setZoom(Math.min(3, Math.max(0.1, v / 100)));
        });
        d.presetSearch.addEventListener('input', () => this.filterTree(d.presetSearch.value.trim()));
        d.tabs.addEventListener('click', e => {
            const btn = e.target.closest('.tab');
            if (btn) this.switchTab(btn.dataset.tab);
        });
        // 对比原图:Pointer 统一鼠标/触屏;另支持 Shift 按住短按。
        // (不用 Alt:窗口是 autoHideMenuBar,Windows 上 Alt 会唤出菜单栏并抢走按键)
        d.btnCompare.addEventListener('pointerdown', e => { e.preventDefault(); this.setCompare(true); });
        d.btnCompare.addEventListener('pointerup', () => this.setCompare(false));
        d.btnCompare.addEventListener('pointercancel', () => this.setCompare(false));
        d.btnCompare.addEventListener('pointerleave', () => this.setCompare(false));
        document.addEventListener('keydown', e => {
            if (e.key !== 'Shift' || e.ctrlKey || e.altKey) return;
            const el = document.activeElement;
            const tag = (el && el.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
            this.setCompare(true);
        });
        document.addEventListener('keyup', e => { if (e.key === 'Shift') this.setCompare(false); });
        window.addEventListener('blur', () => { if (this.draggingCompare) this.setCompare(false); });
        const btnCancel = document.getElementById('btnExportCancel');
        if (btnCancel) btnCancel.addEventListener('click', () => { this._exportAbort = true; });
        this.updateTopBar();
            d.loginStatus.addEventListener('click', () => this.openLoginModal());
        d.loginModalClose.addEventListener('click', () => this.closeLoginModal());
        d.loginModal.addEventListener('mousedown', e => { if (e.target === d.loginModal) this.closeLoginModal(); });
        d.loginSubmit.addEventListener('click', () => this.doLogin());
        d.loginLogout.addEventListener('click', () => this.doLogout());
        d.loginUsername.addEventListener('keydown', e => { if (e.key === 'Enter') this.doLogin(); });
        d.loginNickname.addEventListener('keydown', e => { if (e.key === 'Enter') this.doLogin(); });
        this.loadUserAvatar();
        this.setupDragDrop();
        // 签名输入
        const inpSig = document.getElementById('inpSignature');
        if (inpSig) inpSig.addEventListener('input', () => { this.template.userSignature = inpSig.value; this.onSettingChanged(); });
        const cbF = document.getElementById('cbSignFont');
        if (cbF) cbF.addEventListener('change', () => { this.template.signFont = cbF.value; this.onSettingChanged(); });
        const cbC = document.getElementById('cbSignColor');
        if (cbC) cbC.addEventListener('change', () => { this.template.signColor = cbC.value; this.onSettingChanged(); });
        const chkSM = document.getElementById('chkSignModel');
        if (chkSM) chkSM.addEventListener('change', () => { this.template.signIncludeModel = chkSM.checked ? 1 : 0; this.onSettingChanged(); });
        const chkBL = document.getElementById('chkBrandLogo');
        if (chkBL) chkBL.addEventListener('change', () => { this.template.brandLogo = Number(chkBL.value) || 0; this.onSettingChanged(); });
        const rgAS = document.getElementById('rgAvatarScale');
        if (rgAS) rgAS.addEventListener('input', () => {
            this.template.avatarScale = Number(rgAS.value) / 100;
            const v = document.getElementById('valAvatarScale');
            if (v) v.textContent = rgAS.value + '%';
            this.onSettingChanged();
        });
        const rgSS = document.getElementById('rgSignSize');
        if (rgSS) rgSS.addEventListener('input', () => {
            this.template.signSize = Number(rgSS.value) / 100;
            const v = document.getElementById('valSignSize');
            if (v) v.textContent = rgSS.value + '%';
            this.onSettingChanged();
        });
        const chkBB = document.getElementById('chkBgBlur');
        if (chkBB) chkBB.addEventListener('change', () => {
            this.template.signBgBlur = chkBB.checked ? 1 : 0;
            const rowBI = document.getElementById('rowBgBlurInt');
            if (rowBI) rowBI.style.display = chkBB.checked ? '' : 'none';
            this.onSettingChanged();
        });
        const slBI = document.getElementById('slBgBlurInt');
        if (slBI) {
            this.updateLabel('lblBgBlurInt', slBI.value + '%');
            slBI.addEventListener('input', () => {
                this.template.blurIntensity = Number(slBI.value);
                this.updateLabel('lblBgBlurInt', slBI.value + '%');
                this.onSettingChanged();
            });
        }
        const cbPC = document.getElementById('cbParamColor');
        if (cbPC) cbPC.addEventListener('change', () => {
            this.template.paramColor = cbPC.value;
            this.onSettingChanged();
        });
        // 头像上传(存全局)
        const btnAv = document.getElementById('btnUploadAvatar'), fileAv = document.getElementById('fileAvatar');
        if (btnAv && fileAv) {
            btnAv.addEventListener('click', () => fileAv.click());
            fileAv.addEventListener('change', (e) => {
                const f = e.target.files[0]; if (!f) return;
                const reader = new FileReader();
                reader.onload = (ev) => this.saveUserAvatar(ev.target.result);
                reader.readAsDataURL(f);
            });
        }
        this.bindAvatarUpload();
        this.bindInteractive();
    },

    updateTopBar() {
        const name = localStorage.getItem('qfs_username') || localStorage.getItem('qfs_nickname') || '';
        const topName = document.getElementById('topUserName');
        const topAv = document.getElementById('topAvatar');
        if (topName) topName.textContent = name || '未登录';
        if (topAv) {
            const av = localStorage.getItem('qfs_user_avatar');
            if (av) { topAv.style.background = 'url(' + av + ') center/cover'; topAv.textContent = ''; }
            else { topAv.style.background = '#444'; topAv.textContent = '头'; }
        }
    },
    loadUserAvatar() {
        this.updateTopBar();
        if (this.template && !this.template.userSignature) {
            const un = (this.user && this.user.nickname) || localStorage.getItem('qfs_nickname') || localStorage.getItem('qfs_username') || '';
            if (un) this.template.userSignature = '— ' + un + ' —';
        }
        const saved = localStorage.getItem('qfs_user_avatar');
        if (saved) {
            const img = new Image();
            img.onload = () => { window.__qfsAvatarImg = img; this.onSettingChanged(); };
            img.src = saved;
        }
    },
    openAvatarCrop(dataUrl) {
        const modal = document.getElementById('avatarCropModal');
        const img = document.getElementById('cropImg');
        if (!modal || !img) { this.saveUserAvatar(dataUrl); return; }
        modal.style.display = 'flex'; modal.style.alignItems = 'center'; modal.style.justifyContent = 'center';
        img.src = dataUrl;
        this._cropScale = 1;
        this._cropX = 0;
        this._cropY = 0;
        const apply = () => {
            const wrap = img.parentElement;
            const w = wrap.clientWidth;
            // 图片按cover填,初始scale按宽度
            const iw = img.naturalWidth || 300;
            const ih = img.naturalHeight || 300;
            const s = Math.max(w / iw, w / ih);
            this._cropScale = s;
            this._cropX = 0; this._cropY = 0;
            img.style.width = iw * s + 'px';
            img.style.height = ih * s + 'px';
            img.style.left = (w - iw * s) / 2 + 'px';
            img.style.top = (w - ih * s) / 2 + 'px';
        };
        img.onload = apply;
        if (img.complete && img.naturalWidth) apply();
        // 拖动
        let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        img.onmousedown = (e) => { dragging = true; sx = e.clientX; sy = e.clientY; ox = this._cropX; oy = this._cropY; e.preventDefault(); };
        window.onmousemove = (e) => { if (!dragging) return; this._cropX = ox + e.clientX - sx; this._cropY = oy + e.clientY - sy; img.style.left = this._cropX + 'px'; img.style.top = this._cropY + 'px'; };
        window.onmouseup = () => { dragging = false; };
        // 滚轮缩放
        img.onwheel = (e) => {
            e.preventDefault();
            const old = this._cropScale;
            this._cropScale *= (e.deltaY < 0 ? 1.1 : 0.9);
            this._cropScale = Math.max(old * 0.3, Math.min(this._cropScale, old * 5));
            const iw = img.naturalWidth, ih = img.naturalHeight;
            img.style.width = iw * this._cropScale + 'px';
            img.style.height = ih * this._cropScale + 'px';
        };
        // 确认
        document.getElementById('cropOk').onclick = () => {
            const wrap = img.parentElement;
            const c = document.createElement('canvas');
            c.width = 200; c.height = 200;
            const ctx = c.getContext('2d');
            // 从img位置映射到canvas
            const scale = this._cropScale;
            const imgX = -parseFloat(img.style.left) / scale;
            const imgY = -parseFloat(img.style.top) / scale;
            const cropSize = wrap.clientWidth / scale;
            ctx.drawImage(img, imgX, imgY, cropSize, cropSize, 0, 0, 200, 200);
            const out = c.toDataURL('image/jpeg', 0.85);
            modal.style.display = 'none';
            this.saveUserAvatar(out);
        };
        document.getElementById('cropCancel').onclick = () => { modal.style.display = 'none'; };
    },
    saveUserAvatar(dataUrl) {
        // 先压缩到200x200再存,避免localStorage配额超限
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas');
            const size = 200;
            c.width = size; c.height = size;
            const ctx = c.getContext('2d');
            // cover裁剪
            const s = Math.max(size / img.width, size / img.height);
            const dw = img.width * s, dh = img.height * s;
            ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
            const compressed = c.toDataURL('image/jpeg', 0.85);
            try {
                localStorage.setItem('qfs_user_avatar', compressed);
            } catch(e) { console.warn('头像存储失败:', e); }
            window.__qfsAvatarImg = img;
            this.onSettingChanged();
            const pv = document.getElementById('loginAvatarPreview');
            if (pv) { pv.style.background = 'url(' + compressed + ') center/cover'; pv.textContent = ''; }
            const la = document.getElementById('loginAvatar');
            if (la) { la.style.background = 'url(' + compressed + ') center/cover'; }
            this.updateTopBar();
        };
        img.src = dataUrl;
    },
    bindAvatarUpload() {
        const pick = document.getElementById('btnPickAvatar'), file1 = document.getElementById('fileLoginAvatar');
        const change = document.getElementById('btnChangeAvatar'), file2 = document.getElementById('fileChangeAvatar');
        const readFile = (f) => {
            if (!f) return;
            const reader = new FileReader();
            reader.onload = (ev) => this.openAvatarCrop(ev.target.result);
            reader.readAsDataURL(f);
        };
        if (pick && file1) { pick.addEventListener('click', () => file1.click()); file1.addEventListener('change', (e) => readFile(e.target.files[0])); }
        if (change && file2) { change.addEventListener('click', () => file2.click()); file2.addEventListener('change', (e) => readFile(e.target.files[0])); }
    },

    /* ══ 画布元素 / 缩放平移交互 ══ */
    bindInteractive() {
        const pane = this.dom.canvasPane, stage = this.dom.stage, canvas = this.dom.canvas;
        const hscrollWheel = (el) => {
            if (!el) return;
            el.addEventListener('wheel', e => {
                if (el.scrollWidth <= el.clientWidth) return;
                e.preventDefault();
                e.stopPropagation();
                el.scrollLeft += (e.deltaY || e.deltaX);
            }, { passive: false });
        };
        hscrollWheel(this.dom.thumbStrip);
        hscrollWheel(this.$('brandIconBox'));
        hscrollWheel(this.$('customIconBox'));
        pane.addEventListener('wheel', e => {
            const pk = this.tplPuzzle();
            if (pk) {
                // 拼图模式:滚轮只有悬停在"已选中"的格图上时才缩放该格图片;
                // 其余情况(未悬停选中格)滚轮控制整个拼图(视口缩放),不依赖主图 this.image
                const si = this.puzzleSlotAt(e);
                if (si != null && si === this._activePuzzleSlot) { e.preventDefault(); this.puzzleWheelSlot(si, e.deltaY < 0 ? 1.1 : 1 / 1.1); return; }
                if (this.image && stage.classList.contains('has-img')) { e.preventDefault(); this.zoomAt(e, stage, e.deltaY < 0 ? 1.1 : 1 / 1.1); }
                return;
            }
            if (!this.image || !stage.classList.contains('has-img')) return;
            e.preventDefault();
            const sel = this.selectedEls[0];
            if (sel && sel.kind) {
                // 元素操作:Ctrl+滚轮 旋转,普通滚轮 缩放
                const rot = e.ctrlKey || e.shiftKey;
                this.nudgeElement(sel, rot ? 'rot' : 'scale', e.deltaY < 0 ? 1 : -1);
                return;
            }
            this.zoomAt(e, stage, e.deltaY < 0 ? 1.1 : 1 / 1.1);
        }, { passive: false });
        canvas.addEventListener('mousedown', e => {
            const pk = this.tplPuzzle();
            if ((!this.image && !pk) || e.button !== 0) return;
            if (pk) {
                const hp = this.puzzleHitTest(e);
                if (hp) {
                    e.preventDefault();
                    this.selectedEls = [];
                    this.refreshElList();
                    // 拖拽分隔线调轴位
                    if (hp.type === 'axis') {
                        this._dragPz = { type: 'axis', dim: hp.dim, idx: hp.idx, sx: e.screenX, sy: e.screenY, moved: false };
                        canvas.style.cursor = (hp.dim === 'v') ? 'col-resize' : 'row-resize';
                        return;
                    }
                    // 只有"已选中"的格图才能被移动:第一次点击仅选中(并清掉旧拖动态),
                    // 已经选中时按下才进入该格图片的移动
                    if (this._activePuzzleSlot !== hp.slot) {
                        this.setActivePuzzleSlot(hp.slot);
                        this._puzzlePick = null;
                        return;
                    }
                    this._dragPz = { type: 'slot', slot: hp.slot, sx: e.screenX, sy: e.screenY, x0: hp.x, y0: hp.y, moved: false, swap: null };
                    this.setActivePuzzleSlot(hp.slot);
                    this._dragPzInitOff = {};
                    this.ensurePuzzleSlotsCount(pk);
                    for (let si = 0; si < this.puzzleSlotCount(pk.layout || 'single'); si++) {
                        this._dragPzInitOff[si] = { x: pk.slots[si].offsetX || 0, y: pk.slots[si].offsetY || 0 };
                    }
                    this._puzzlePick = null;
                    canvas.style.cursor = 'move';
                    return;
                }
                // 背景板/分割间隙:保持当前图片选择不取消,继续走右侧命中/画布平移
            }
            const pt = this.screenToCanvas(e);
            const el = this.pickElement(pt);
            if (el) {
                e.preventDefault();
                this.selectedEls = this.hasEl(this.selectedEls, el) ? this.selectedEls : [el];
                this._dragEl = { kind: el.kind, ref: el.obj, sx: e.screenX, sy: e.screenY, x: el.x0, y: el.y0, moved: false };
                // 整帧渲染时排除被拖元素,使其余内容可作为静态背景缓存(见 renderPreview)
                this._skipUserEl = el.obj;
                this._dropDragBase();
                this._logoSnapV = null; this._logoSnapH = null;
                this._logoSnapEdgeV = null; this._logoSnapEdgeH = null;
                this.refreshElList();
                canvas.style.cursor = 'pointer';
                this.requestRender();
                return;
            }
            this.selectedEls = [];
            this.refreshElList();
            this._pan = { sx: e.screenX, sy: e.screenY, px: this.panX, py: this.panY };
            canvas.style.cursor = 'grabbing';
        });
        window.addEventListener('mousemove', e => {
            if (this._dragPz) {
                const pk = this.tplPuzzle();
                if (pk) {
                    const dx = e.screenX - this._dragPz.sx, dy = e.screenY - this._dragPz.sy;
                    if (!this._dragPz.moved && this._dragPz.type === 'slot' && Math.abs(dx) + Math.abs(dy) > 4) { this._dragPz.moved = true; this.pushUndo(); }
                    if (this._dragPz.type === 'axis' && Math.abs(dx) + Math.abs(dy) > 1 && !this._dragPz.moved) { this._dragPz.moved = true; this.pushUndo(); }
                    this.puzzleDragMove(pk, this._dragPz, e);
                    this.scheduleRender();
                }
                return;
            }
            if (this._dragEl) {
                const dx = e.screenX - this._dragEl.sx, dy = e.screenY - this._dragEl.sy;
                if (Math.abs(dx) + Math.abs(dy) > 2) {
                    if (!this._dragEl.moved) { this._dragEl.moved = true; this.pushUndo(); }
                    const rect = canvas.getBoundingClientRect();
                    const kx = canvas.width / rect.width, ky = canvas.height / rect.height;
                    this.moveElement(this._dragEl, this._dragEl.x + dx * kx, this._dragEl.y + dy * ky);
                }
                return;
            }
            if (!this._pan) return;
            this.panX = this._pan.px + (e.screenX - this._pan.sx);
            this.panY = this._pan.py + (e.screenY - this._pan.sy);
            this.applyZoomStyle();
        });
        window.addEventListener('mouseup', () => {
            if (this._dragPz) {
                const d = this._dragPz;
                const pk = this.tplPuzzle();
                const moved = d.moved;
                // "放下即互换":松开时指针仍在目标格 → 执行互换
                if (pk && d.type === 'slot' && d.swap != null && d.swap !== d.slot) {
                    if (!moved) this.pushUndo();
                    this.swapSlotImages(pk, d.slot, d.swap);
                    if (this._dragPzInitOff) {
                        [d.slot, d.swap].forEach(i => {
                            if (this._dragPzInitOff[i]) {
                                const so = pk.slots[i] || (pk.slots[i] = {});
                                so.offsetX = this._dragPzInitOff[i].x;
                                so.offsetY = this._dragPzInitOff[i].y;
                            }
                        });
                    }
                    if (!moved) this.saveCurrentTemplate();
                }
                this._puzzlePick = null;
                this._dragPzInitOff = null;
                this._dragPz = null;
                if (moved) {
                    const pkNow = this.tplPuzzle();
                    // 记录拖动最终偏移(commit 会从滑块回写旧值,可能清成 0)
                    let saveOff = null, saveIdx = -1;
                    if (pkNow && d.type === 'slot' && typeof this._puzzleSlot === 'string' && this._puzzleSlot.charAt(0) === 's') {
                        const ai = parseInt(this._puzzleSlot.substring(1), 10);
                        if (!isNaN(ai) && pkNow.slots[ai]) { saveIdx = ai; saveOff = { x: pkNow.slots[ai].offsetX, y: pkNow.slots[ai].offsetY }; }
                    }
                    this.commitNoPush();
                    // 恢复拖动结果,避免模型被旧滑块值覆盖;随后滑块/UI 以模型为准刷新
                    if (saveOff) {
                        pkNow.slots[saveIdx].offsetX = saveOff.x;
                        pkNow.slots[saveIdx].offsetY = saveOff.y;
                        this.setSlotOffsetSliders(pkNow.slots[saveIdx]);
                    }
                    this.refreshPuzzleUI();
                    this.saveCurrentTemplate();
                }
                canvas.style.cursor = '';
            }
            if (this._dragEl) {
                const moved = this._dragEl.moved;
                this._dragEl = null;
                this._skipUserEl = null;
                this._dropDragBase();
                this._logoSnapV = null; this._logoSnapH = null;
                this._logoSnapEdgeV = null; this._logoSnapEdgeH = null;
                if (moved) this.commitNoPush();
            }
            if (this._pan) { this._pan = null; canvas.style.cursor = ''; }
        });
        // 鼠标移出窗口/窗口失焦时,强制清理所有拖动态(防止卡住)
        const cancelDrags = () => {
            if (this._dragPz) {
                this._puzzlePick = null;
                this._dragPzInitOff = null;
                this._dragPz = null;
                canvas.style.cursor = '';
            }
            if (this._dragEl) { this._dragEl = null; this._skipUserEl = null; this._dropDragBase(); this._logoSnapV = null; this._logoSnapH = null; this._logoSnapEdgeV = null; this._logoSnapEdgeH = null; }
            if (this._pan) { this._pan = null; canvas.style.cursor = ''; }
        };
        window.addEventListener('blur', cancelDrags);
        canvas.addEventListener('mouseleave', cancelDrags);
        canvas.addEventListener('dblclick', e => {
            const pk = this.tplPuzzle();
            if (!pk) return;
            const si = this.puzzleSlotAt(e);
            if (si == null) return;
            e.preventDefault();
            this.setActivePuzzleSlot(si);
            this.openSlotImage(si);
        });
        // 桌面右键菜单:拼图格子 / 画布空白处
        canvas.addEventListener('contextmenu', e => {
            const pk = this.tplPuzzle();
            if (pk) {
                const hp = this.puzzleHitTest(e);
                if (hp) {
                    e.preventDefault();
                    this.setActivePuzzleSlot(hp.slot);
                    this.openCtx(e.clientX, e.clientY, [
                        ['替换照片(打开图片)', () => this.openSlotImage(hp.slot)],
                        ['在此位置插入照片', () => this.insertImageFromPick(hp.slot)],
                        ['旋转 90°', () => this.rotatePuzzleSlot(hp.slot)],
                        ['重置本格', () => this.resetPuzzleSlot(hp.slot)],
                        ['清空该格', () => this.clearSlotImage(hp.slot)],
                    ]);
                    return;
                }
            }
            e.preventDefault();
            this.openCtx(e.clientX, e.clientY, [
                ['适应窗口', () => this.fitZoom && this.fitZoom()],
                ['1:1 实际大小', () => this.zoomActual && this.zoomActual()],
                ['对比原图', () => this.toggleCompare && this.toggleCompare()],
                ['—', null],
                ['撤销 (Ctrl+Z)', () => this.undo()],
                ['重做 (Ctrl+Y)', () => this.redo()],
                ['—', null],
                ['导出图片', () => this.doExport && this.doExport()],
            ]);
        });
        document.addEventListener('mousedown', e => {
            if (this._ctx && !this._ctx.contains(e.target)) this.closeCtx();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') this.closeCtx();
        });
        document.addEventListener('click', e => {
            if (e.target === canvas) return;
            if (e.target.closest('#inspector') || e.target.closest('.tabs')) return;
            if (this.selectedEls.length && this._dragElMoved !== true) {
                // 画布外点击取消选中
            }
        });
    },

    screenToCanvas(e) {
        const canvas = this.dom.canvas;
        const rect = canvas.getBoundingClientRect();
        // 与 puzzlePx 一致:用 DOM 渲染尺寸(已含 CSS 缩放/平移)的比例换算到画布像素,避免二次除以 zoom
        const cx = (rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0) * canvas.width;
        const cy = (rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0) * canvas.height;
        return { x: cx, y: cy, cw: canvas.width, ch: canvas.height };
    },

    hasEl(list, el) { return list.some(x => x.kind === el.kind && x.obj === el.obj); },

    // 命中检测:logo/贴纸/自由文字
    pickElement(pt) {
        const hitLogo = this.hitTestLogos(pt);
        const hitStk = this.hitTestStickers(pt);
        const hitTxt = this.hitTestTexts(pt);
        const cands = [hitLogo, hitStk, hitTxt].filter(Boolean);
        if (!cands.length) return null;
        cands.sort((a, b) => (b.z || 0) - (a.z || 0));
        return cands[0];
    },

    hitTestLogos(pt) {
        const els = (this.template && this.template.logoElements) || [];
        for (let i = els.length - 1; i >= 0; i--) {
            const el = els[i];
            const size = el.size || 60;
            const pos = this.logoPos(el, pt.cw, pt.ch, size);
            if (Math.abs(pt.x - pos.cx) <= size / 2 && Math.abs(pt.y - pos.cy) <= size / 2) {
                return { kind: 'logo', obj: el, x0: pos.cx, y0: pos.cy, z: el.z || 0 };
            }
        }
        return null;
    },

    hitTestStickers(pt) {
        const stickers = (this.template && this.template.decorConfig && this.template.decorConfig.stickers) || [];
        for (let i = stickers.length - 1; i >= 0; i--) {
            const el = stickers[i];
            const tex = this.textureEl(el.src);
            if (!tex) continue;
            const sw = tex.naturalWidth * (el.scale || 1), sh = tex.naturalHeight * (el.scale || 1);
            if (Math.abs(pt.x - el.x) <= sw / 2 && Math.abs(pt.y - el.y) <= sh / 2) {
                return { kind: 'sticker', obj: el, x0: el.x, y0: el.y, z: (el.z || 0) + 5 };
            }
        }
        return null;
    },

    hitTestTexts(pt) {
        const lines = (this.template && this.template.decorConfig && this.template.decorConfig.textLines) || [];
        for (let i = lines.length - 1; i >= 0; i--) {
            const el = lines[i];
            if (!el.text || el.align !== 'free') continue;
            const fs = el.autoSize ? 24 : (el.fontSize || 18);
            const w = Math.max(60, String(el.text).length * fs * 0.7), h = fs * 1.8;
            if (Math.abs(pt.x - el.x) <= w / 2 && Math.abs(pt.y - el.y) <= h / 2) {
                return { kind: 'text', obj: el, x0: el.x, y0: el.y, z: (el.z || 0) + 3 };
            }
        }
        return null;
    },

    // 元素在画布上的中心点(像素)。三种坐标形式并存,按优先级解析:
    //   ① el.rel + 相对比例 rx/ry —— 以「基准画布」的比例存储,换照片时按新画布还原,不会错位
    //   ② el.x 为数字            —— 绝对像素坐标(旧模板的格式;新写入时与 ① 同时保存以兼容旧版)
    //   ③ el.x 为字符串          —— 锚点定位('right'/'bottom' + offsetX/offsetY),天然随画布自适应
    // baseW/baseH 取「基准画布」而非显示画布:拖动时 displayMax 会临时降到 900,
    // 若按显示画布换算,比例会失真。
    logoPos(el, cw, ch, size) {
        if (!el) return { cx: cw / 2, cy: ch / 2 };
        if (el.rel && typeof el.rx === 'number' && typeof el.ry === 'number') {
            const base = this.logoBaseSize();
            // 基准画布未知时(例如尚未渲染)退回像素值,避免用错误的基准算出偏移
            if (base && base.w > 1 && base.h > 1) {
                return { cx: el.rx * cw, cy: el.ry * ch };
            }
        }
        if (typeof el.x === 'number' && typeof el.y === 'number') {
            return { cx: el.x, cy: el.y };
        }
        const hAlign = el.x || 'right', vAlign = el.y || 'bottom';
        const ox = el.offsetX || 20, oy = el.offsetY || 20;
        // 半高按元素真实纵横比算(Logo 的 size 是宽度,高度 = size * ratio);
        // 原先上下都用 size/2,等于把非正方形 Logo 当正方形,导致上下留白与左右不一致。
        const ratio = (typeof el.ratio === 'number' && el.ratio > 0) ? el.ratio : 1;
        const hw = size / 2, hh = (size * ratio) / 2;
        const tx = hAlign === 'left' ? ox + hw : hAlign === 'center' ? cw / 2 : cw - ox - hw;
        const ty = vAlign === 'top' ? oy + hh : vAlign === 'center' ? ch / 2 : ch - oy - hh;
        return { cx: tx, cy: ty };
    },

    // 当前照片的「基准画布」尺寸(不含显示缩放与 DPR),rel 比例的换算基准。
    // 注意 _logW/_logH 由引擎渲染时写入,切换照片后到下一次渲染完成前仍是「上一张图」的值。
    // 因此校验 canvas.width ≈ _logW × devicePixelRatio:两者对不上说明 _log 是上一张图的残留,
    // 此时返回 null,调用方退回像素坐标(绝不拿错误基准去算比例)。
    logoBaseSize() {
        const cv = this.dom && this.dom.canvas;
        const im = this.image;
        if (cv && cv._logW > 1 && cv._logH > 1 && im) {
            const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
            const expect = cv._logW * dpr;
            if (Math.abs(cv.width - expect) <= Math.max(2, expect * 0.02)) {
                return { w: cv._logW, h: cv._logH };
            }
        }
        return null;
    },

    // 「最终画布 → 基准画布」的换算尺寸。叠加层/参考线画在最终画布上(canvas.width,含 DPR 与
    // displayMax 缩放),而元素比例 rx/ry 以基准画布为分母,两者在拖动降分辨率或 DPR>1 时并不相等。
    // 传给 logoPos 的 cw/ch 必须是基准口径,否则元素会画偏。
    logoBaseForOverlay() {
        const cv = this.dom && this.dom.canvas;
        const b = this.logoBaseSize();
        if (b) return b;
        return { w: (cv && cv.width) || 1, h: (cv && cv.height) || 1 };
    },

    // 把像素中心写回元素:优先用相对比例存储(可跨照片尺寸),锚点模式则保留锚点只反算 offset。
    setLogoPixelPos(el, cx, cy) {
        if (!el) return;
        const base = this.logoBaseSize();
        if (typeof el.x === 'string' || typeof el.y === 'string') {
            // 锚点模式:保持锚点不变 → 它本来就能随画布自适应,无需转成比例
            if (!base) return;
            const dim = this._logoDrawSize(el);
            const hAlign = el.x || 'right', vAlign = el.y || 'bottom';
            const halfW = dim.w / 2, halfH = dim.h / 2;
            if (hAlign === 'left') el.offsetX = Math.max(0, Math.round(cx - halfW));
            else if (hAlign === 'center') el.offsetX = 0;
            else el.offsetX = Math.max(0, Math.round(base.w - cx - halfW));
            if (vAlign === 'top') el.offsetY = Math.max(0, Math.round(cy - halfH));
            else if (vAlign === 'center') el.offsetY = 0;
            else el.offsetY = Math.max(0, Math.round(base.h - cy - halfH));
            return;
        }
        // 像素值照旧写入(旧版程序打开同一模板时仍能定位),额外记录相对比例供新版跨尺寸还原
        el.x = Math.round(cx);
        el.y = Math.round(cy);
        if (!base) return;
        el.rel = 1;
        el.rx = Math.max(0, Math.min(1, cx / base.w));
        el.ry = Math.max(0, Math.min(1, cy / base.h));
    },

    nudgeElement(el, mode, dir) {
        const e = el.obj;
        if (el.kind === 'logo') {
            if (typeof e.x !== 'number') { const p = this.logoPos(e, this.dom.canvas.width, this.dom.canvas.height, e.size || 60); this.setLogoPixelPos(e, p.cx, p.cy); }
            if (mode === 'rot') e.rotation = (e.rotation || 0) + dir * 5;
            else e.size = clampNum((e.size || 60) + dir * 25, 8, 10000);
        } else if (el.kind === 'sticker') {
            if (mode === 'rot') e.rotation = (e.rotation || 0) + dir * 5;
            else e.scale = clampNum((e.scale || 1) * (dir > 0 ? 1.1 : 0.9), 0.02, 3);
        } else if (el.kind === 'text') {
            if (mode === 'rot') e.rotation = (e.rotation || 0) + dir * 5;
            else { e.fontSize = clampNum((e.fontSize || 18) + dir * 2, 6, 300); if (e.autoSize) e.autoSize = 0; }
        }
        this.syncSliderFromEl(el);
        this.saveCurrentTemplate();
        this.scheduleRender();
    },

    rebindSelectedEls() { /* template引用稳定,无需重绑 */ },

    moveElement(drag, x, y) {
        const e = drag.ref;
        const cw = this.dom.canvas.width || 0, ch = this.dom.canvas.height || 0;
        const clampV = (v, max, half) => half > 0 ? Math.max(half, Math.min(v, max - half)) : Math.max(0, Math.min(v, max));
        if (drag.kind === 'logo') {
            const snap = this.snapLogoToGuides(x, y, cw, ch, e);
            // 用相对比例写回,换照片尺寸时不会跑到画布外
            this.setLogoPixelPos(e, snap.x, snap.y);
            this._logoSnapV = snap.v; this._logoSnapH = snap.h;
            this._logoSnapEdgeV = snap.vEdge; this._logoSnapEdgeH = snap.hEdge;
        }
        else if (drag.kind === 'sticker') { e.x = clampV(x, cw, 20); e.y = clampV(y, ch, 20); }
        else if (drag.kind === 'text') { e.x = clampV(x, cw, 30); e.y = clampV(y, ch, 20); }
        this.onSettingChanged();
    },

    // 参考线 + 四边吸附:吸附 logo 中心并记录命中的位置(供高亮)
    //  - 参考线:1/3、1/2、2/3 六条,吸附中心
    //  - 边缘  :贴左/右/上/下,吸附到「元素完整可见 + 最小边距」的位置
    //    水印最常见用法就是贴四角(右下角品牌、左下角日期),原实现只有三分线,贴角全靠手感,
    //    而且容易贴得太靠外——大 logo 会有一半落在画布外。
    // 位移量按元素实际绘制尺寸推导(而非固定比例),因此大 logo 会自动留出更大的贴边距离。
    _logoDrawSize(el) {
        const size = Math.max(2, (el && el.size) || 60);
        let ratio = (el && el.ratio) || 0;
        if (!ratio && el && el.dataUrl) {
            const im = window.getElementBitmap ? window.getElementBitmap(el.dataUrl) : null;
            if (im && im.naturalWidth) ratio = im.naturalHeight / im.naturalWidth;
        }
        if (!ratio) ratio = 0.4;   // 图片尚未就绪时的兜底纵横比
        return { w: size, h: size * ratio };
    },

    snapLogoToGuides(x, y, cw, ch, el) {
        const vLines = [cw / 3, cw / 2, cw * 2 / 3];
        const hLines = [ch / 3, ch / 2, ch * 2 / 3];
        const tol = 8;
        let sv = -1, sh = -1, dv = tol, dh = tol;
        for (let i = 0; i < vLines.length; i++) {
            const d = Math.abs(x - vLines[i]);
            if (d < dv) { dv = d; sv = i; }
        }
        for (let i = 0; i < hLines.length; i++) {
            const d = Math.abs(y - hLines[i]);
            if (d < dh) { dh = d; sh = i; }
        }
        let nx = sv >= 0 ? vLines[sv] : x;
        let ny = sh >= 0 ? hLines[sh] : y;

        const dim = this._logoDrawSize(el);
        const dx = dim.w / 2, dy = dim.h / 2;
        const kx = Math.max(10, Math.min(cw * 0.05, dx));
        const ky = Math.max(10, Math.min(ch * 0.05, dy));
        const glx = Math.min(dx + kx, cw / 2);
        const gly = Math.min(dy + ky, ch / 2);

        // 分别记录「该方向是否真的发生了边缘约束」,不用"哪个更近"判断——
        // 例如元素在右上角时,左右两个候选的 x 距离可能相同。
        let vEdge = null, hEdge = null;
        let bestX = tol, bestY = tol;
        for (const [d, tag] of [[x - glx, 'left'], [cw - glx - x, 'right'], [Math.abs(x - cw / 2), 'hcenter']]) {
            if (d < bestX) { bestX = d; vEdge = tag; }
        }
        for (const [d, tag] of [[y - gly, 'top'], [ch - gly - y, 'bottom'], [Math.abs(y - ch / 2), 'vcenter']]) {
            if (d < bestY) { bestY = d; hEdge = tag; }
        }
        if (vEdge === 'left') nx = glx; else if (vEdge === 'right') nx = cw - glx;
        else if (vEdge === 'hcenter') nx = cw / 2;
        if (hEdge === 'top') ny = gly; else if (hEdge === 'bottom') ny = ch - gly;
        else if (hEdge === 'vcenter') ny = ch / 2;

        return {
            x: nx, y: ny,
            v: sv >= 0 ? sv : null,
            h: sh >= 0 ? sh : null,
            vEdge, hEdge,
        };
    },

    textureEl(src) {
        if (!src) return null;
        if (this.logoImgCache[src]) return this.logoImgCache[src];
        if (this.textures) {
            const t = this.textures.find(x => x.name === src);
            if (t) { const im = new Image(); im.src = t.dataUrl; this.logoImgCache[src] = im; return im; }
        }
        const im = new Image(); im.src = src; this.logoImgCache[src] = im; return im;
    },

    syncSliderFromEl(el) {
        if (!el || !el.kind) return;
        const e = el.obj;
        const $ = this.$;
        const rot = $('slElementRotation'), op = $('slActiveIconOpacity'), sz = $('slElementSize');
        if (rot) rot.value = ((e.rotation || 0) % 360 + 360) % 360;
        if (op) op.value = Math.round(e.opacity != null ? e.opacity : 100);
        const sizeVal = el.kind === 'logo' ? Math.round(e.size || 60) : el.kind === 'sticker' ? Math.round((e.scale || 1) * 60) : 60;
        // 缩放滑块用平方映射覆盖 16~10000:低值端(常用的小 Logo)分度仍然细,高值端也能拖到
        if (sz) sz.value = Math.round(1000 * Math.sqrt(clampNum((sizeVal - 16) / (10000 - 16), 0, 1)));
        this.updateLabel('lblElementRotation', ((e.rotation || 0) % 360 + 360) % 360 + '°');
        this.updateLabel('lblActiveIconOpacity', Math.round(e.opacity != null ? e.opacity : 100) + '%');
        this.updateLabel('lblElementSize', sizeVal);
    },

    drawSelectionBox() {
        try {
            const canvas = this.dom.canvas;
            if (!canvas || !this.selectedEls || !this.selectedEls.length) return;
            const ctx = canvas.getContext('2d');
            for (const sel of this.selectedEls) {
                const e = sel.obj;
                if (!e) continue;
                let cx = e.x, cy = e.y, size = e.size || 60;
                if (typeof cx !== 'number' || typeof cy !== 'number') {
                    const p = this.logoPos(e, canvas.width, canvas.height, size);
                    cx = p.cx; cy = p.cy;
                }
                ctx.save();
                ctx.strokeStyle = '#00e5a0';
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 4]);
                ctx.strokeRect(cx - size / 2 - 6, cy - size / 2 - 6, size + 12, size + 12);
                ctx.setLineDash([]);
                ctx.fillStyle = '#00e5a0';
                const h = 5;
                [[cx-size/2-6, cy-size/2-6],[cx+size/2+6-h, cy-size/2-6],
                 [cx-size/2-6, cy+size/2+6-h],[cx+size/2+6-h, cy+size/2+6-h]].forEach(([x,y])=>{
                    ctx.fillRect(x, y, h, h);
                });
                ctx.restore();
            }
        } catch(err) { console.warn('drawSelectionBox', err); }
    },

    // 拖 logo 时叠加参考线:三分/中心线、四边吸附高亮、安全区提示
    drawLogoGuides() {
        try {
            if (!this._dragEl || this._dragEl.kind !== 'logo') return;
            const canvas = this.dom.canvas;
            if (!canvas || !canvas.width) return;
            const ctx = canvas.getContext('2d');
            const cw = canvas.width, ch = canvas.height;
            const vLines = [cw / 3, cw / 2, cw * 2 / 3];
            const hLines = [ch / 3, ch / 2, ch * 2 / 3];
            ctx.save();
            const drawLine = (x1, y1, x2, y2, active) => {
                // 深色衬底 + 亮线两层,保证深/浅背景都清晰
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                ctx.lineWidth = active ? 5 : 3;
                ctx.stroke();
                ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                ctx.strokeStyle = active ? '#00e5a0' : 'rgba(255,255,255,0.8)';
                ctx.lineWidth = active ? 2.5 : 1.5;
                if (active) {
                    ctx.shadowColor = '#00e5a0';
                    ctx.shadowBlur = 8;
                }
                ctx.stroke();
                ctx.shadowBlur = 0;
            };
            vLines.forEach((x, i) => drawLine(x, 0, x, ch, i === this._logoSnapV));
            hLines.forEach((y, i) => drawLine(0, y, cw, y, i === this._logoSnapH));

            // 边缘吸附:高亮贴住的那条画布边,让"已贴边"有明确反馈
            const ev = this._logoSnapEdgeV, eh = this._logoSnapEdgeH;
            if (ev === 'left') drawLine(1, 0, 1, ch, true);
            else if (ev === 'right') drawLine(cw - 1, 0, cw - 1, ch, true);
            if (eh === 'top') drawLine(0, 1, cw, 1, true);
            else if (eh === 'bottom') drawLine(0, ch - 1, cw, ch - 1, true);

            // 安全区:提示"贴到这里以内不会被裁"。(居中吸附时不画,避免与中心线视觉混淆)
            const dim = this._logoDrawSize(this._dragEl.ref);
            const kx = Math.max(10, Math.min(cw * 0.05, dim.w / 2));
            const ky = Math.max(10, Math.min(ch * 0.05, dim.h / 2));
            ctx.setLineDash([7, 6]);
            ctx.strokeStyle = 'rgba(255,255,255,0.45)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(kx, ky, Math.max(1, cw - kx * 2), Math.max(1, ch - ky * 2));
            ctx.setLineDash([]);

            // 命中反馈:在 logo 中心画瞄准环
            if (this._logoSnapV != null || this._logoSnapH != null || ev || eh) {
                const el = this._dragEl.ref;
                const size = el.size || 60;
                const cx0 = this.logoPos(el, cw, ch, size).cx, cy0 = this.logoPos(el, cw, ch, size).cy;
                ctx.beginPath();
                ctx.arc(cx0, cy0, size * 0.42, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(0,0,0,0.55)';
                ctx.lineWidth = 4;
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(cx0, cy0, size * 0.42, 0, Math.PI * 2);
                ctx.strokeStyle = '#00e5a0';
                ctx.lineWidth = 2;
                ctx.shadowColor = '#00e5a0';
                ctx.shadowBlur = 10;
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.beginPath();
                ctx.arc(cx0, cy0, 3, 0, Math.PI * 2);
                ctx.fillStyle = '#00e5a0';
                ctx.fill();
            }
            ctx.restore();
        } catch(err) { console.warn('drawLogoGuides', err); }
    },

    /* ══ 默认模板 ══ */
    defaultTemplate() {
        return {
            templateName: '', templateTag: '', photoFrameStyle: '', canvasRatio: 'original',
            baseMargin: {
                marginLock: 1, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
                imgScale: 1, imgOffsetX: 0, imgOffsetY: 0,
                refTop: 0, refBottom: 0, refLeft: 0, refRight: 0, globalMargin: 1,
            },
            exportDpi: 300,
            layerList: [{
                visible: 1, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
                fillConfig: {
                    fillType: 'transparent', fillHex: 'eeeeee', fillOpacity: 100,
                    gradientType: 'linear', gradientAngle: 45,
                    gradientStops: [{ position: 0, color: 'eeeeee' }, { position: 1, color: 'bbbbbb' }],
                    gradientOpacity: 100,
                    textureSrc: '', textureScale: 1, textureOffsetX: 0, textureOffsetY: 0,
                    textureOpacity: 100, textureBlend: 'normal',
                },
                strokeConfig: {
                    strokeWidth: 0, strokePos: 'inside', strokeColorHex: '000000', strokeOpacity: 100,
                    strokeDashArray: [], strokeDashOffset: 0,
                },
                cornerConfig: {
                    cornerLock: 0, cornerRadiusAll: 0, cornerRadiusTL: 0, cornerRadiusTR: 0,
                    cornerRadiusBL: 0, cornerRadiusBR: 0,
                },
                shadowGlowConfig: {
                    shadowEnable: 0, shadowOffsetX: 0, shadowOffsetY: 8, shadowBlur: 20, shadowSpread: 0,
                    shadowColorHex: '000000', shadowOpacity: 35,
                    glowEnable: 0, glowColorHex: 'ffffff', glowBlur: 30, glowSpread: 0, glowOpacity: 60, glowType: 'center',
                },
            }],
            cornerConfig: {
                cornerLock: 0, cornerRadiusAll: 0, cornerRadiusTL: 0, cornerRadiusTR: 0,
                cornerRadiusBL: 0, cornerRadiusBR: 0, shapeType: 'rounded', customShapeSvg: '',
            },
            filmTearConfig: {
                tearEnable: 0, tearStrength: 50, tearDensity: 8,
                filmPerforationEnable: 0, filmPerforationType: 'square', filmPerforationSize: 20, filmPerforationSpacing: 20,
                dustScratchEnable: 0, dustScratchIntensity: 0, yellowingEnable: 0, yellowingStrength: 0,
            },
            lightEffect: {
                vignetteEnable: 0, vignetteStrength: 0, vignetteFeather: 50,
                lightLeakEnable: 0, lightLeakType: 'warm', lightLeakOpacity: 40, lightLeakAngle: 225,
                filmGrainEnable: 0, filmGrainIntensity: 0,
            },
            decorConfig: {
                exifAutoText: 0, textLines: [], stickers: [],
                cornerDecorEnable: 0, cornerDecorType: 'line', cornerDecorSize: 30,
            },
            logoElements: [],
            paramFontSize: 33, paramType: 0, paramPosition: 'CENTER',
            puzzle: {
                enabled: 0, layout: 'single', layoutType: 0, gap: 6, slotFill: 'cover', bgMode: 0,
                canvasRatio: 'auto', borderColor: 'ffffff', offsetX: 0, offsetY: 0, zoom: 100,
                slots: {}, axisVals: {}, captions: {}, gapCaptions: {},
            },
        };
    },


    syncModelFromUI() {
        if (this.isUpdating || !this.template || !this.image) return;
        const $ = this.$;
        const m = this.template.baseMargin || (this.template.baseMargin = {});
        const layer = this.currentLayer() || {};
        const fill = layer.fillConfig || (layer.fillConfig = {});
        const stroke = layer.strokeConfig || (layer.strokeConfig = {});
        const sg = layer.shadowGlowConfig || (layer.shadowGlowConfig = {});
        const cc = this.template.cornerConfig || (this.template.cornerConfig = {});
        const ft = this.template.filmTearConfig || (this.template.filmTearConfig = {});
        const le = this.template.lightEffect || (this.template.lightEffect = {});
        const decor = this.template.decorConfig || (this.template.decorConfig = {});

        this.template.canvasRatio = $('cbCanvasRatio') ? $('cbCanvasRatio').value : 'original';
        const gm = $('slGlobalMargin') ? parseInt($('slGlobalMargin').value, 10) / 100 : 1;
        m.globalMargin = gm;
        this.applyGlobalMargin(gm, false);

        m.imgScale = $('slImgScale') ? parseInt($('slImgScale').value, 10) / 100 : (m.imgScale || 1);
        m.imgOffsetX = num($('tfImgOffsetX'), m.imgOffsetX);
        m.imgOffsetY = num($('tfImgOffsetY'), m.imgOffsetY);

        if ($('cbCornerLock')) cc.cornerLock = $('cbCornerLock').checked ? 1 : 0;
        const r = $('slCornerRadius') ? parseInt($('slCornerRadius').value, 10) : (cc.cornerRadiusAll || 0);
        cc.cornerRadiusAll = r;
        cc.cornerRadiusTL = num($('slCornerTL'), r);
        cc.cornerRadiusTR = num($('slCornerTR'), r);
        cc.cornerRadiusBL = num($('slCornerBL'), r);
        cc.cornerRadiusBR = num($('slCornerBR'), r);

        this.template.paramPosition = $('cbParamPosition') ? $('cbParamPosition').value : 'CENTER';
        this.template.paramFontSize = $('slParamFontSize') ? parseInt($('slParamFontSize').value, 10) : 33;
        this.template.userSignature = $('inpSignature') ? $('inpSignature').value : '';
        this.template.paramType = $('cbParamType') ? parseInt($('cbParamType').value, 10) : 0;
        this.syncManualExif();

        if ($('cbLayerVisible')) layer.visible = $('cbLayerVisible').checked ? 1 : 0;

        fill.fillType = $('cbFillType') ? $('cbFillType').value : 'solid';
        fill.fillHex = $('cpFillColor') ? $('cpFillColor').value.replace('#', '') : 'eeeeee';
        fill.fillOpacity = $('slFillOpacity') ? parseInt($('slFillOpacity').value, 10) : 100;
        fill.gradientType = $('cbGradientType') ? $('cbGradientType').value : 'linear';
        fill.gradientAngle = $('slGradientAngle') ? parseInt($('slGradientAngle').value, 10) : 45;
        fill.textureSrc = fill.textureSrc || '';
        fill.textureScale = $('slTextureScale') ? parseInt($('slTextureScale').value, 10) / 100 : 1;
        fill.textureBlend = $('cbTextureBlend') ? $('cbTextureBlend').value : 'normal';

        stroke.strokeWidth = $('slStrokeWidth') ? parseInt($('slStrokeWidth').value, 10) : 0;
        stroke.strokePos = $('cbStrokePos') ? $('cbStrokePos').value : 'inside';
        stroke.strokeColorHex = $('cpStrokeColor') ? $('cpStrokeColor').value.replace('#', '') : '000000';
        stroke.strokeOpacity = $('slStrokeOpacity') ? parseInt($('slStrokeOpacity').value, 10) : 100;
        stroke.strokeDashArray = $('tfStrokeDash') ? dashToArray($('tfStrokeDash').value) : [];

        const lcc = layer.cornerConfig || (layer.cornerConfig = {});
        if ($('cbLayerCornerLock')) lcc.cornerLock = $('cbLayerCornerLock').checked ? 1 : 0;
        const lr = $('slLayerCornerRadius') ? parseInt($('slLayerCornerRadius').value, 10) : (lcc.cornerRadiusAll || 0);
        lcc.cornerRadiusAll = lr;
        lcc.cornerRadiusTL = num($('slLayerCornerTL'), lr);
        lcc.cornerRadiusTR = num($('slLayerCornerTR'), lr);
        lcc.cornerRadiusBL = num($('slLayerCornerBL'), lr);
        lcc.cornerRadiusBR = num($('slLayerCornerBR'), lr);

        sg.shadowEnable = ($('cbShadow') && $('cbShadow').checked) ? 1 : 0;
        sg.shadowOffsetX = $('slShadowX') ? parseInt($('slShadowX').value, 10) : 0;
        sg.shadowOffsetY = $('slShadowY') ? parseInt($('slShadowY').value, 10) : 8;
        sg.shadowBlur = $('slShadowBlur') ? parseInt($('slShadowBlur').value, 10) : 20;
        sg.shadowSpread = $('slShadowSpread') ? parseInt($('slShadowSpread').value, 10) : 0;
        sg.shadowColorHex = $('cpShadowColor') ? $('cpShadowColor').value.replace('#', '') : '000000';
        sg.shadowOpacity = $('slShadowOpacity') ? parseInt($('slShadowOpacity').value, 10) : 35;
        sg.glowEnable = ($('cbGlow') && $('cbGlow').checked) ? 1 : 0;
        sg.glowColorHex = $('cpGlowColor') ? $('cpGlowColor').value.replace('#', '') : 'ffffff';
        sg.glowBlur = $('slGlowBlur') ? parseInt($('slGlowBlur').value, 10) : 30;
        sg.glowOpacity = $('slGlowOpacity') ? parseInt($('slGlowOpacity').value, 10) : 60;

        ft.tearEnable = ($('cbTearEnable') && $('cbTearEnable').checked) ? 1 : 0;
        ft.tearStrength = $('slTearStrength') ? parseInt($('slTearStrength').value, 10) : 50;
        ft.tearDensity = $('slTearDensity') ? parseInt($('slTearDensity').value, 10) : 8;

        le.vignetteEnable = ($('cbVignette') && $('cbVignette').checked) ? 1 : 0;
        le.vignetteStrength = $('slVignetteStrength') ? parseInt($('slVignetteStrength').value, 10) : 0;
        le.vignetteFeather = $('slVignetteFeather') ? parseInt($('slVignetteFeather').value, 10) : 50;
        le.lightLeakEnable = ($('cbLightLeak') && $('cbLightLeak').checked) ? 1 : 0;
        le.lightLeakType = $('cbLeakType') ? $('cbLeakType').value : 'warm';
        le.lightLeakOpacity = $('slLeakOpacity') ? parseInt($('slLeakOpacity').value, 10) : 40;
        le.lightLeakAngle = $('slLeakAngle') ? parseInt($('slLeakAngle').value, 10) : 225;

        if ($('cbExifText')) decor.exifAutoText = $('cbExifText').checked ? 1 : 0;
        decor.cornerDecorEnable = ($('cbCornerDecor') && $('cbCornerDecor').checked) ? 1 : 0;
        decor.cornerDecorType = $('cbCornerDecorType') ? $('cbCornerDecorType').value : 'line';
        decor.cornerDecorSize = $('slCornerDecorSize') ? parseInt($('slCornerDecorSize').value, 10) : 30;

        this.syncPuzzleFromUI();
    },

    syncManualExif() {
        const $ = this.$;
        const efs = ['tfExifBrand', 'tfExifModel', 'tfExifFocal', 'tfExifAperture', 'tfExifIso', 'tfExifShutter'];
        const v = ['brand', 'model', 'focal', 'aperture', 'iso', 'shutter'].map((k, i) => {
            const inp = $(efs[i]);
            return [k, inp ? String(inp.value).trim() : ''];
        });
        const manual = {};
        v.forEach(([k, val]) => { if (val) manual[k] = val; });
        this.template.manualExif = Object.keys(manual).length ? manual : null;
        this.updateExifLine();
    },

    updateExifLine() {
        const $ = this.$;
        const m = this.template && this.template.manualExif;
        const el = $('exifLine'), txt = $('exifLineText');
        if (el && txt) {
            if (m && (m.brand || m.model || m.focal || m.aperture || m.iso || m.shutter)) {
                const parts = [m.brand && m.model ? `${m.brand} ${m.model}` : (m.brand || m.model), m.focal, m.aperture, m.iso, m.shutter].filter(Boolean);
                txt.textContent = parts.join(' · ');
                el.style.display = '';
            } else { el.style.display = 'none'; }
        }
        },

    // 全局边距:按参考值等比缩放四边
    applyGlobalMargin(scale, setSlider) {
        const m = this.template.baseMargin || {};
        if (m.refTop == null) { m.refTop = m.marginTop != null ? m.marginTop : 80; m.refBottom = m.marginBottom != null ? m.marginBottom : 120; m.refLeft = m.marginLeft != null ? m.marginLeft : 80; m.refRight = m.marginRight != null ? m.marginRight : 80; }
        m.marginTop = Math.round((m.refTop || 0) * scale);
        m.marginBottom = Math.round((m.refBottom || 0) * scale);
        m.marginLeft = Math.round((m.refLeft || 0) * scale);
        m.marginRight = Math.round((m.refRight || 0) * scale);
        m.globalMargin = scale;
        const $ = this.$;
        if (setSlider && $('slGlobalMargin')) $('slGlobalMargin').value = Math.round(scale * 100);
        if (this.image) this.refreshMarginFields();
        this.updateLabel('lblGlobalMargin', Math.round(scale * 100) + '%');
    },

    refreshMarginFields() {
        const $ = this.$;
        const m = this.template.baseMargin || {};
        if ($('slGlobalMargin')) { const g = m.globalMargin != null ? m.globalMargin : 1; $('slGlobalMargin').value = Math.round(g * 100); this.updateLabel('lblGlobalMargin', Math.round(g * 100) + '%'); }
    },

    updatePersonalVisibility() {
        if (!this.template) return;
        const s = this.template.photoFrameStyle || '';
        const isPersonal = ['SIGNATURE','SIGN_PARAM','AVATAR_MEMO','AV_OVERLAY','AV_OVERLAY_TR','AV_OVERLAY_BR','AV_OVERLAY_BC','AV_OVERLAY_BC2'].includes(s);
        const showSig = isPersonal || s === 'CARD_3D';
        // 个人/签名/头像/参数相关行:默认随 showSig 整组显隐(原 grpPersonal 语义)
        const personalRowsAll = ['rowSignModel','rowSignText','rowSignFont','rowSignColor','rowAvatarScale','rowSignSize','rowParamColor','rowParamType','rowParamPos'];
        personalRowsAll.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = showSig ? '' : 'none'; });
        // 品牌行含型号:仅签名+参数(SIGN_PARAM,底部右区域品牌/参数行)有此选项
        const rowSM = document.getElementById('rowSignModel');
        if (rowSM) rowSM.style.display = (s === 'SIGN_PARAM') ? '' : 'none';
        if (s === 'CARD_3D') {
            ['rowParamFontSize','rowSignFont','rowSignColor','rowAvatarScale','rowSignSize','rowParamColor','rowParamType','rowParamPos','rowBgBlur','rowBgBlurInt'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = 'none';
            });
        }
        // 印象留白预设也显示背景模糊开关
        const isOverlay = ['OVERLAY_PARAM_LEFT','OVERLAY_PARAM_RIGHT','OVERLAY_PARAM_BOTTOM'].includes(s);
        const isLogoParam = (s === 'CARD_LOGO_PARAM');
        const rowBgBlur = document.getElementById('rowBgBlur');
        if (rowBgBlur) rowBgBlur.style.display = (isPersonal || isOverlay || isLogoParam) ? '' : 'none';
        // 背景模糊经典/日期:常驻模糊样式,直接显示"模糊程度"滑块(不设开关)
        const isBlurStyle = ['BLUR_CLASSIC','BLUR_DATE'].includes(s);
        if (isBlurStyle) {
            const rowBgBlurInt = document.getElementById('rowBgBlurInt');
            if (rowBgBlurInt) rowBgBlurInt.style.display = '';
            const rowBgBlur2 = document.getElementById('rowBgBlur');
            if (rowBgBlur2) rowBgBlur2.style.display = 'none';
        }
        const rowPos = document.getElementById('rowParamPos');
        const rowType = document.getElementById('rowParamType');
        const isBottomBar = ['SIGNATURE','SIGN_PARAM','AVATAR_MEMO'].includes(s);
        if (rowPos) rowPos.style.display = isBottomBar ? '' : 'none';
        if (rowType) rowType.style.display = isBottomBar ? '' : 'none';
        // 品牌大小/参数缩放:印象毛玻璃/左右/下留白与 logo参数 显示
        const isImpression = ['IMP_FROSTED','OVERLAY_PARAM_LEFT','OVERLAY_PARAM_RIGHT','OVERLAY_PARAM_BOTTOM','CARD_LOGO_PARAM'].includes(s);
        // 富士系水印预设:参数水印/参数品牌水印画参数 → 给"参数缩放";品牌水印/参数品牌水印画品牌 → 给"品牌大小"
        const isWmParam = ['FUJI_WM','FUJI_WM_BRAND'].includes(s);
        const isWmBrand = ['FUJI_WM_BRAND','DARK_BRAND_ONLY'].includes(s);
        const rowBrand = document.getElementById('rowBrandSize');
        if (rowBrand) rowBrand.style.display = (isImpression || isWmBrand) ? '' : 'none';
        const rowParamScale = document.getElementById('rowParamScale');
        if (rowParamScale) rowParamScale.style.display = (isImpression || isBlurStyle || isWmParam) ? '' : 'none';
        // 品牌水印不画参数:隐藏"参数字号"(品牌行由"品牌大小"单独控制);CARD_3D 同理(上面已隐藏,这里保持)
        const rowPf = document.getElementById('rowParamFontSize');
        if (rowPf) rowPf.style.display = (s === 'DARK_BRAND_ONLY' || s === 'CARD_3D') ? 'none' : '';
        // 相机品牌 Logo:凡品牌名会渲染成行的样式都显示该勾选(匹配 by 品牌池)
        const brandShown = ['WM_CLASSIC','WM_BRAND_LOGO','IMP_FROSTED','IMP_CLASSIC',
            'OVERLAY_PARAM_LEFT','OVERLAY_PARAM_RIGHT','OVERLAY_PARAM_BOTTOM',
            'CARD_LEICA','CARD_LOGO_PARAM','CARD_PURE_LOGO','CARD_SIMPLE','CARD_IMMERSION',
            'FUJI_WM_BRAND','DARK_BRAND_ONLY','OVERLAY_LOGO_BOTTOM',
            'SIGN_PARAM','SIGN_BLUR','BLUR_CLASSIC','BLUR_DATE',
            'FUJI_WHITE','COLOR_CLASSIC','ART_CARD'].includes(s);
        const rowBrandLogo = document.getElementById('rowBrandLogo');
        if (rowBrandLogo) rowBrandLogo.style.display = brandShown ? '' : 'none';
    },

    // 回显:模板 -> 控件
    refreshUI() {
        if (!this.template) return;
        this.isUpdating = true;
        try {
            const $ = this.$;
            const m = this.template.baseMargin || {};
            const layer = this.currentLayer() || {};
            const fill = layer.fillConfig || {};
            const stroke = layer.strokeConfig || {};
            const sg = layer.shadowGlowConfig || {};
            const cc = this.template.cornerConfig || {};
            const decor = this.template.decorConfig || {};

            if ($('cbCanvasRatio')) $('cbCanvasRatio').value = this.template.canvasRatio || 'original';
            this.refreshMarginFields();
            if ($('slImgScale')) $('slImgScale').value = Math.round((m.imgScale || 1) * 100);
            this.updateLabel('lblImgScale', Math.round((m.imgScale || 1) * 100) + '%');
            if ($('tfImgOffsetX')) $('tfImgOffsetX').value = m.imgOffsetX || 0;
            if ($('tfImgOffsetY')) $('tfImgOffsetY').value = m.imgOffsetY || 0;

            if ($('cbCornerLock')) $('cbCornerLock').checked = (cc.cornerLock || 0) === 1;
            const r = cc.cornerRadiusAll != null ? cc.cornerRadiusAll : 0;
            if ($('slCornerRadius')) $('slCornerRadius').value = r;
            this.updateLabel('lblCornerRadius', r);
            const br = this.template.borderRadius || 0;
            if ($('slBorderRadius')) $('slBorderRadius').value = br;
            this.updateLabel('lblBorderRadius', br);
            if ($('slCornerTL')) $('slCornerTL').value = cc.cornerRadiusTL || 0;
            if ($('slCornerTR')) $('slCornerTR').value = cc.cornerRadiusTR || 0;
            if ($('slCornerBL')) $('slCornerBL').value = cc.cornerRadiusBL || 0;
            if ($('slCornerBR')) $('slCornerBR').value = cc.cornerRadiusBR || 0;
            this.updateLabel('lblCornerTL', cc.cornerRadiusTL || 0); this.updateLabel('lblCornerTR', cc.cornerRadiusTR || 0);
            this.updateLabel('lblCornerBL', cc.cornerRadiusBL || 0); this.updateLabel('lblCornerBR', cc.cornerRadiusBR || 0);

            if ($('cbParamPosition')) $('cbParamPosition').value = this.template.paramPosition || 'CENTER';
            if ($('slParamFontSize')) $('slParamFontSize').value = this.template.paramFontSize != null ? this.template.paramFontSize : 33;
            if ($('slBrandSize')) {
                const bs = Math.round((this.template.brandSize != null ? this.template.brandSize : 1) * 100);
                $('slBrandSize').value = bs;
                this.updateLabel('lblBrandSize', bs + '%');
            }
            if ($('slParamScale')) {
                const psc = Math.round((this.template.paramScale != null ? this.template.paramScale : 1) * 100);
                $('slParamScale').value = psc;
                this.updateLabel('lblParamScale', psc + '%');
            }
            if ($('inpSignature')) $('inpSignature').value = this.template.userSignature || '';
            if ($('cbSignFont')) $('cbSignFont').value = this.template.signFont || 'cursive';
            if ($('cbSignColor')) $('cbSignColor').value = this.template.signColor || '#555';
            if ($('chkSignModel')) $('chkSignModel').checked = !!(this.template.signIncludeModel);
            if ($('chkBrandLogo')) $('chkBrandLogo').value = String(this.template.brandLogo || 0);
            if ($('rgAvatarScale')) { const v = Math.round((this.template.avatarScale || 0.85) * 100); $('rgAvatarScale').value = v; if ($('valAvatarScale')) $('valAvatarScale').textContent = v + '%'; }
            if ($('rgSignSize')) { const v2 = Math.round((this.template.signSize || 1) * 100); $('rgSignSize').value = v2; if ($('valSignSize')) $('valSignSize').textContent = v2 + '%'; }
            if ($('chkBgBlur')) $('chkBgBlur').checked = !!this.template.signBgBlur;
            const biV = this.template.blurIntensity != null ? this.template.blurIntensity : 50;
            if ($('slBgBlurInt')) $('slBgBlurInt').value = biV;
            this.updateLabel('lblBgBlurInt', biV + '%');
            const rowBI2 = document.getElementById('rowBgBlurInt');
            if (rowBI2) rowBI2.style.display = $('chkBgBlur') && $('chkBgBlur').checked ? '' : 'none';
            if ($('cbParamColor')) $('cbParamColor').value = this.template.paramColor || 'auto';
            this.updatePersonalVisibility();
            if (this.template.userAvatar) {
                const img = new Image();
                img.onload = () => { this.avatarImg = img; window.__qfsAvatarImg = img; this.renderPreview(); };
                img.src = this.template.userAvatar;
            }
            this.updateParamFontLabel();
            if ($('cbParamType')) $('cbParamType').value = String(this.template.paramType != null ? this.template.paramType : 0);

            // EXIF 输入框回填:手动(manualExif)优先,自动识别(image.exif)兜底
            const manExif = (this.template.manualExif && typeof this.template.manualExif === 'object') ? this.template.manualExif : {};
            const autoExif = (this.image && this.image.exif) || {};
            const exifMap = [
                ['tfExifBrand', 'brand', 'make'], ['tfExifModel', 'model', 'model'],
                ['tfExifFocal', 'focal', 'focal'], ['tfExifAperture', 'aperture', 'aperture'],
                ['tfExifIso', 'iso', 'iso'], ['tfExifShutter', 'shutter', 'shutter'],
            ];
            exifMap.forEach(([id, mk, ek]) => {
                const el = $(id);
                if (el) el.value = (manExif[mk] || '').trim() || (autoExif[ek] || '');
            });
            if ($('cbFillType')) $('cbFillType').value = fill.fillType || 'solid';
            if ($('cpFillColor')) $('cpFillColor').value = '#' + (fill.fillHex || 'eeeeee');
            if ($('slFillOpacity')) $('slFillOpacity').value = fill.fillOpacity != null ? fill.fillOpacity : 100;
            this.updateLabel('lblFillOpacity', (fill.fillOpacity != null ? fill.fillOpacity : 100) + '%');
            if ($('cbGradientType')) $('cbGradientType').value = fill.gradientType || 'linear';
            if ($('slGradientAngle')) $('slGradientAngle').value = fill.gradientAngle || 45;
            this.updateLabel('lblGradientAngle', fill.gradientAngle || 45);
            if ($('slTextureScale')) $('slTextureScale').value = Math.round((fill.textureScale || 1) * 100);
            this.updateLabel('lblTextureScale', Math.round((fill.textureScale || 1) * 100) + '%');
            if ($('cbTextureBlend')) $('cbTextureBlend').value = fill.textureBlend || 'normal';

            if ($('slStrokeWidth')) $('slStrokeWidth').value = stroke.strokeWidth || 0;
            this.updateLabel('lblStrokeWidth', stroke.strokeWidth || 0);
            if ($('cbStrokePos')) $('cbStrokePos').value = stroke.strokePos || 'inside';
            if ($('cpStrokeColor')) $('cpStrokeColor').value = '#' + (stroke.strokeColorHex || '000000');
            if ($('slStrokeOpacity')) $('slStrokeOpacity').value = stroke.strokeOpacity != null ? stroke.strokeOpacity : 100;
            this.updateLabel('lblStrokeOpacity', (stroke.strokeOpacity != null ? stroke.strokeOpacity : 100) + '%');
            if ($('tfStrokeDash')) $('tfStrokeDash').value = (stroke.strokeDashArray || []).join(',');

            const lcc = layer.cornerConfig || {};
            if ($('cbLayerCornerLock')) $('cbLayerCornerLock').checked = (lcc.cornerLock || 0) === 1;
            const lr = lcc.cornerRadiusAll != null ? lcc.cornerRadiusAll : 0;
            if ($('slLayerCornerRadius')) $('slLayerCornerRadius').value = lr;
            if ($('slLayerCornerTL')) $('slLayerCornerTL').value = lcc.cornerRadiusTL || 0;
            if ($('slLayerCornerTR')) $('slLayerCornerTR').value = lcc.cornerRadiusTR || 0;
            if ($('slLayerCornerBL')) $('slLayerCornerBL').value = lcc.cornerRadiusBL || 0;
            if ($('slLayerCornerBR')) $('slLayerCornerBR').value = lcc.cornerRadiusBR || 0;
            this.updateLabel('lblLayerCornerTL', lcc.cornerRadiusTL || 0); this.updateLabel('lblLayerCornerTR', lcc.cornerRadiusTR || 0);
            this.updateLabel('lblLayerCornerBL', lcc.cornerRadiusBL || 0); this.updateLabel('lblLayerCornerBR', lcc.cornerRadiusBR || 0);
            this.updateLabel('lblLayerCornerRadius', lr);

if ($('cbShadow')) $('cbShadow').checked = (sg.shadowEnable || 0) === 1;
            this.syncShadowL();

            if ($('cbGlow')) $('cbGlow').checked = (sg.glowEnable || 0) === 1;

            const ft = this.template.filmTearConfig || {};
            if ($('cbTearEnable')) $('cbTearEnable').checked = (ft.tearEnable || 0) === 1;
            if ($('slTearStrength')) $('slTearStrength').value = ft.tearStrength || 0;
            if ($('slTearDensity')) $('slTearDensity').value = ft.tearDensity || 8;
            this.updateLabel('lblTearStrength', ft.tearStrength || 0);
            this.updateLabel('lblTearDensity', ft.tearDensity || 8);

            const le = this.template.lightEffect || {};
            if ($('cbVignette')) $('cbVignette').checked = (le.vignetteEnable || 0) === 1;
            if ($('slVignetteStrength')) $('slVignetteStrength').value = le.vignetteStrength || 0;
            if ($('slVignetteFeather')) $('slVignetteFeather').value = le.vignetteFeather != null ? le.vignetteFeather : 50;
            this.updateLabel('lblVignetteStrength', (le.vignetteStrength || 0) + '%');
            this.updateLabel('lblVignetteFeather', le.vignetteFeather != null ? le.vignetteFeather : 50);
            if ($('cbLightLeak')) $('cbLightLeak').checked = (le.lightLeakEnable || 0) === 1;
            if ($('cbLeakType')) $('cbLeakType').value = le.lightLeakType || 'warm';
            if ($('slLeakOpacity')) $('slLeakOpacity').value = le.lightLeakOpacity != null ? le.lightLeakOpacity : 40;
            if ($('slLeakAngle')) $('slLeakAngle').value = le.lightLeakAngle != null ? le.lightLeakAngle : 225;
            this.updateLabel('lblLeakOpacity', (le.lightLeakOpacity != null ? le.lightLeakOpacity : 40) + '%');
            this.updateLabel('lblLeakAngle', (le.lightLeakAngle != null ? le.lightLeakAngle : 225) + '°');

            if ($('cbCornerDecor')) $('cbCornerDecor').checked = (decor.cornerDecorEnable || 0) === 1;
            if ($('cbCornerDecorType')) $('cbCornerDecorType').value = decor.cornerDecorType || 'line';
            if ($('slCornerDecorSize')) $('slCornerDecorSize').value = decor.cornerDecorSize || 30;
            this.updateLabel('lblCornerDecorSize', decor.cornerDecorSize || 30);

            if ($('cbExifText')) $('cbExifText').checked = (decor.exifAutoText || 0) === 1;

            this.refreshElList();
            this.refreshTemplateFields();
            this.refreshPuzzleUI();
            this.updateHistoryButtons();
            this.applyModeControls();
        } finally {
            this.isUpdating = false;
        }
    },

    // 面板联动:图层组只服务默认模板样式;光影组在相框样式下不生效,整页隐藏
    applyModeControls() {
        const t = this.template;
        if (!t) return;
        const pf = String(t.photoFrameStyle || '').toUpperCase();
        const frame = !!(pf && pf !== 'NONE');
        const card = !frame && (t.baseMargin || {}).bgBlurEnable === 1;
        const showLayers = !frame && !card;
        const showLight = !frame;
        const q = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));
        q('.ctl-grp-layers').forEach(el => { el.style.display = showLayers ? '' : 'none'; });
        q('.ctl-grp-light').forEach(el => { el.style.display = showLight ? '' : 'none'; });
        // 撕边(胶片齿孔掩膜)只在默认图层管线读 filmTearConfig;相框样式 / 卡片(模糊底)渲染不走该管线,整组隐藏
        const torn = document.getElementById('pbTornFilm');
        if (torn) torn.style.display = showLayers ? '' : 'none';
        const lightTab = document.querySelector('#inspTabs [data-tab="light"]');
        if (lightTab) lightTab.style.display = showLight ? '' : 'none';
        if (!showLight) {
            const active = document.querySelector('.tab.active');
            if (active && active.getAttribute('data-tab') === 'light') {
                const firstVis = document.querySelector('#inspTabs .tab:not([style*="display: none"])');
                if (firstVis) firstVis.click();
            }
        }
        // 当前样式条:把"现在走哪条渲染管线"显性化,解释为何部分控件消失
        const ms = document.getElementById('modeStatus');
        if (ms) {
            const frameName = String(t.photoFrameStyle || '').toUpperCase();
            const isFrame = !!(frameName && frameName !== 'NONE');
            const isCard = !isFrame && (t.baseMargin || {}).bgBlurEnable === 1;
            let kind, name;
            if (isFrame) {
                kind = '相框样式';
                const preset = this.presets.find(p => String(p.photoFrameStyle || '').toUpperCase() === frameName);
                name = preset ? (preset.templateName || frameName) : frameName;
            } else if (isCard) {
                kind = '卡片 / 模糊底';
                name = t.templateName || '';
            } else {
                kind = '图层模板';
                name = t.templateName || '';
            }
            ms.style.display = '';
            ms.textContent = '当前样式：' + kind + (name ? ' · ' + name : '');
        }
    },

    syncShadowL() {
        const $ = this.$;
        const layer = this.currentLayer() || {};
        const sg = layer.shadowGlowConfig || {};
        const map = [
            ['slShadowX', 'slShadowXL', 'lblShadowX', 'lblShadowXL', 'shadowOffsetX'],
            ['slShadowY', 'slShadowYL', 'lblShadowY', 'lblShadowYL', 'shadowOffsetY'],
            ['slShadowBlur', 'slShadowBlurL', 'lblShadowBlur', 'lblShadowBlurL', 'shadowBlur'],
            ['slShadowSpread', 'slShadowSpreadL', 'lblShadowSpread', 'lblShadowSpreadL', 'shadowSpread'],
        ];
        map.forEach(([a, b, la, lb, key]) => {
            const v = sg[key] != null ? sg[key] : 0;
            if ($(a)) $(a).value = v;
            if ($(b)) $(b).value = v;
            this.updateLabel(la, v);
            this.updateLabel(lb, v);
        });
        const c = sg.shadowColorHex || '000000', o = sg.shadowOpacity != null ? sg.shadowOpacity : 35;
        if ($('cpShadowColor')) $('cpShadowColor').value = '#' + c;
        if ($('cpShadowColorL')) $('cpShadowColorL').value = '#' + c;
        this.updateLabel('lblShadowOpacity', o + '%');
        this.updateLabel('lblShadowOpacityL', o + '%');
        const g = sg.glowBlur || 30, go = sg.glowOpacity != null ? sg.glowOpacity : 60;
        if ($('slGlowBlur')) $('slGlowBlur').value = g; if ($('slGlowBlurL')) $('slGlowBlurL').value = g;
        if ($('slGlowOpacity')) $('slGlowOpacity').value = go; if ($('slGlowOpacityL')) $('slGlowOpacityL').value = go;
        this.updateLabel('lblGlowBlur', g); this.updateLabel('lblGlowBlurL', g);
        this.updateLabel('lblGlowOpacity', go + '%'); this.updateLabel('lblGlowOpacityL', go + '%');
        if ($('cpGlowColor')) $('cpGlowColor').value = '#' + (sg.glowColorHex || 'ffffff');
        if ($('cpGlowColorL')) $('cpGlowColorL').value = '#' + (sg.glowColorHex || 'ffffff');
    },

    updateLabel(id, text) {
        const el = this.$(id);
        if (el) el.textContent = String(text);
    },

    updateParamFontLabel() {
        const v = this.template.paramFontSize != null ? this.template.paramFontSize : 33;
        if (v <= 0) {
            const s = this.image ? Math.min(Math.max(Math.round(Math.min(this.image.w, this.image.h) / 45), 20), 64) : 24;
            this.updateLabel('lblParamFontSize', `自适应(≈${s}px)`);
        } else this.updateLabel('lblParamFontSize', v + 'px');
    },

    currentLayer() {
        if (!this.template || !this.template.layerList || !this.template.layerList.length) {
            if (this.template) this.template.layerList = [this.defaultTemplate().layerList[0]];
            return this.template.layerList[0];
        }
        const idx = clampNum(this.selectedLayer || 0, 0, this.template.layerList.length - 1);
        return this.template.layerList[idx];
    },

    /* ══ 渲染调度 ══ */
    scheduleRender(immediate) {
        if (!this.image) return;
        if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
        // 手势拖动中(滑块/文本框聚焦)延迟更长,减少连续渲染压力
        const dly = immediate ? 0 : (this._gesture ? 120 : 50);
        this._renderTimer = setTimeout(() => { this._renderTimer = null; this.renderPreview(); }, dly);
    },

    // 照片切换时清空 AWT 样式缓存(模糊底/取色/高斯核)
    invalidateStyleCaches() {
        const es = window.EngineStyles;
        if (!es || typeof es.clearCaches !== 'function') return;
        try { es.clearCaches(); } catch (e) {}
    },

    // 模板是否已含有效边框设置(区别于默认原图模板)
    hasBorderSettings(t) {
        if (!t) return false;
        if (t.templateName || t.templateTag || t.photoFrameStyle) return true;
        const m = t.baseMargin;
        if (m) {
            if (m.marginTop || m.marginBottom || m.marginLeft || m.marginRight) return true;
            if (m.imgScale && m.imgScale !== 1) return true;
        }
        return false;
    },

    /* ══ 拖动叠加层:拖拽期间避免每帧全量重合成 ══
       问题:移动 logo/贴纸/文字时每帧都会走完整引擎(实测 52~143ms/帧,见 tools/measure-drag.js),
       而 logo 是最后绘制的一层,前面所有内容(照片+边框+光影)在拖动期间完全不变。
       做法:拖动首帧把"不含被拖元素"的整帧结果缓存成背景位图,之后每帧只 blit 背景 +
       重绘被拖元素 + 选择框/参考线,把每帧成本从「全量合成」降到「一次位图拷贝」。
       正确性:缓存键包含画布尺寸/模板引用/图源,任一变化即重建;拖动结束后清缓存并整帧重渲染。 */
    _dragBaseValid() {
        const c = this._dragBase;
        const cv = this.dom.canvas;
        return !!(c
            && c.bmp
            && c.w === cv.width && c.h === cv.height
            && c.tpl === this.template
            && c.img === (this.image && this.image.el));
    },

    _dragBaseBuild() {
        const canvas = this.dom.canvas;
        const bmp = document.createElement('canvas');
        bmp.width = canvas.width;
        bmp.height = canvas.height;
        // 此时被拖元素已从整帧绘制中排除,拷出来即是干净背景
        bmp.getContext('2d').drawImage(canvas, 0, 0);
        this._dragBase = { bmp, w: canvas.width, h: canvas.height, tpl: this.template, img: this.image && this.image.el };
    },

    _blitDragBase() {
        const canvas = this.dom.canvas;
        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // 背景位图是在「拖动态当时」的画布尺寸下建的,而拖动期间 displayMax 会变(降级到 900 再复原),
        // 因此要按当前画布尺寸缩放贴回,否则会把小图直接摊在画布一角
        const b = this._dragBase.bmp;
        if (b.width === canvas.width && b.height === canvas.height) ctx.drawImage(b, 0, 0);
        else ctx.drawImage(b, 0, 0, b.width, b.height, 0, 0, canvas.width, canvas.height);
    },

    // 注意不再接收 cw/ch:元素几何一律按「基准画布」口径计算(与引擎 drawLogoElements 一致),
    // 传入最终画布尺寸反而会误用。保留参数位会让调用方以为尺寸有效,故直接去掉。
    _drawDraggedEl(ctx, el, kind) {
        if (!el) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // 关键:引擎在 drawLogoElements 里用 canvas._logW/_logH(基准画布)作为 rel 比例的分母,
        // 即 rx/ry 是「相对基准画布」的比例,元素几何也在基准口径下计算。
        // 叠加层必须与引擎完全一致,否则拖动中元素位置/大小会与松手后不同(会跳一下)。
        // 因此这里不做额外缩放,直接按基准口径绘制(与引擎同一坐标系)。
        const ovBase = this.logoBaseForOverlay();
        if (kind === 'logo' || kind === 'sticker') {
            const src = kind === 'logo' ? el.dataUrl : el.src;
            if (!src) return;
            // 复用引擎的同一份位图缓存,避免拖动中重复解码
            const img = window.getElementBitmap ? window.getElementBitmap(src) : null;
            if (!img || !img.complete || !img.naturalWidth) return;
            const size = kind === 'logo' ? Math.max(2, el.size || 60) : 0;
            let dw, dh, cx, cy;
            if (kind === 'logo') {
                const ratio = img.naturalHeight / img.naturalWidth || 1;
                dw = size; dh = size * ratio;
                // 走 logoPos 统一解析 rel / 锚点 / 旧像素三种形式,并传基准口径尺寸
                const bp = this.logoPos(el, ovBase.w, ovBase.h, size);
                cx = bp.cx; cy = bp.cy;
            } else {
                dw = img.naturalWidth * (el.scale || 1);
                dh = img.naturalHeight * (el.scale || 1);
                cx = el.x || 0; cy = el.y || 0;
            }
            const op = el.opacity == null ? 100 : el.opacity;
            ctx.save();
            ctx.globalAlpha = Math.max(0, Math.min(1, op / 100));
            ctx.translate(cx, cy);
            if (el.rotation) ctx.rotate(el.rotation * Math.PI / 180);
            ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
            ctx.restore();
        } else if (kind === 'text') {
            // 自由文字复用引擎绘制,同样传基准口径(引擎也是这么调的)
            if (el.text && el.align === 'free' && window.drawTextLine) {
                window.drawTextLine(ctx, el, ovBase.w, ovBase.h, false, 0, 0);
            }
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    },

    _dropDragBase() { this._dragBase = null; },

    renderPreview() {
        if (!this.image) return;
        const token = ++this.renderToken;
        this.draggingCompare = false;
        requestAnimationFrame(() => {
            if (token !== this.renderToken) return;
            // 交互进行中(格内拖动/平移/拖元素/手势)不得用旧快照替换当前模板,否则会将正在编辑的
            // 拼图平移/缩放瞬时回退到保存前的状态
            // 不再用 customSettings 替换 this.template,保持编辑对象引用稳定
            this.normalizeTemplate();
            this.dom.stage.classList.toggle('has-img', !!this.image);
            // 拖动中且背景缓存有效 → 只拷贝背景 + 重绘被拖元素,跳过整帧合成
            // (缓存键在校验尺寸/模板/图源,任一变即回落到正常整帧渲染)
            const dragRef = this._dragEl && this._dragEl.ref;
            if (dragRef && this._dragBaseValid()) {
                this._blitDragBase();
                this._drawDraggedEl(this.dom.canvas.getContext('2d'), dragRef, this._dragEl.kind);
                this.drawSelectionBox();
                this.drawLogoGuides();
                this.updateStatusBar();
                return;
            }
            // 未使用预设的图:画布直接展示原图;当前图只要有边框设置,就把最新模板写回该图记录
            // (既标记“已用预设”,也保证切走再切回时保留最新编辑)
            const im = this.image;
            if (this.hasBorderSettings(this.template)) {
                im.customSettings = JSON.parse(JSON.stringify(this.template));
                this.imageTemplates.set(im, im.customSettings);
            }
            const assigned = !!(im.customSettings || this.imageTemplates.get(im));
            const previewTpl = assigned ? this.template : this.defaultTemplate();
            const prevTpl = this.template;
            this.template = previewTpl;
            // 拖动首帧:合成完整帧(此时被拖元素已被 _skipUserEl 排除)后缓存为背景,供后续帧复用
            const needDragBase = !!(dragRef && this._dragEl
                && (!this._dragBase || !this._dragBaseValid()));
            try {
                const puzzle = previewTpl && previewTpl.puzzle && previewTpl.puzzle.enabled;
                const fire = () => {
                    if (puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false);
                    else window.__render(this, false);
                };
                fire();
                // 引擎在分辨率刚变化时首帧不稳定(实测同一路径连渲两次,首帧与次帧最大通道差可达 86),
                // 而缓存一旦建在这种帧上,整个拖动过程都会沿用错误背景。再渲一次取其稳定结果。
                if (needDragBase) fire();
            } finally {
                this.template = prevTpl;
            }
            if (needDragBase && this._dragEl) this._dragBaseBuild();
            this.drawSelectionBox();
            this.drawLogoGuides();
            if (this.autoFit) {
                this.autoFit = false;
                requestAnimationFrame(() => this.fitZoom());
            }
            this.updateStatusBar();
        });
    },

    normalizeTemplate() {
        if (!this.template) this.template = this.defaultTemplate();
        const t = this.template;
        if (!t.baseMargin) t.baseMargin = {};
        if (!t.cornerConfig) t.cornerConfig = {};
        if (!t.filmTearConfig) t.filmTearConfig = {};
        if (!t.lightEffect) t.lightEffect = {};
        if (!t.decorConfig) t.decorConfig = {};
        if (t._draftText) delete t._draftText;
        if (!t.layerList || !t.layerList.length) t.layerList = [this.defaultTemplate().layerList[0]];
        if (!t.logoElements) t.logoElements = [];
        if (!t.puzzle) t.puzzle = this.defaultTemplate().puzzle;
        if (t.baseMargin.refTop == null) {
            t.baseMargin.refTop = t.baseMargin.marginTop != null ? t.baseMargin.marginTop : 80;
            t.baseMargin.refBottom = t.baseMargin.marginBottom != null ? t.baseMargin.marginBottom : 120;
            t.baseMargin.refLeft = t.baseMargin.marginLeft != null ? t.baseMargin.marginLeft : 80;
            t.baseMargin.refRight = t.baseMargin.marginRight != null ? t.baseMargin.marginRight : 80;
        }
        const stripHash = (v) => (v == null ? '' : String(v)).replace(/^#+/, '');
        (t.layerList || []).forEach(lay => {
            if (lay.visible !== undefined) lay.visible = (lay.visible === false || lay.visible === 0) ? 0 : 1;
            const f = lay.fillConfig || {}, s = lay.strokeConfig || {}, sg = lay.shadowGlowConfig || {};
            if (f.fillHex) f.fillHex = stripHash(f.fillHex);
            (f.gradientStops || []).forEach(g => { if (g && g.color) g.color = stripHash(g.color); });
            if (s.strokeColorHex) s.strokeColorHex = stripHash(s.strokeColorHex);
            (s.gradientStops || []).forEach(g => { if (g && g.color) g.color = stripHash(g.color); });
            if (sg.shadowColorHex) sg.shadowColorHex = stripHash(sg.shadowColorHex);
            if (sg.glowColorHex) sg.glowColorHex = stripHash(sg.glowColorHex);
        });
    },

    requestRender() { this.scheduleRender(true); },

    setCompare(on) {
        if (!this.image) return;
        this.draggingCompare = on;
        if (this.image.customSettings) this.template = this.image.customSettings;
        this.normalizeTemplate();
        const token = ++this.renderToken;
        requestAnimationFrame(() => {
            if (token !== this.renderToken) return;
            window.__render(this, on);
            this.updateStatusBar();
        });
    },


    saveCurrentTemplate() {
        if (!this.image) return;
        const snap = this.cloneTemplate();
        this.imageTemplates.set(this.image, snap);
        // customSettings 保持指向当前 this.template,避免克隆后 selectedEls 引用失效
        // undo/redo 时才会把 customSettings 换成新快照
        this.queueThumb(this.image);
        if (typeof this.scheduleDraft === 'function') this.scheduleDraft();
    },

    /* ══ 图片选择 / 每图模板 ══ */
    afterImageSelect() {
        if (!this.image) return;
        this.dom.placeholder.style.display = 'none';
        this.dom.canvas.style.display = 'block';
        const btn = document.getElementById('btnRestoreDraft');
        if (btn) btn.style.display = 'none';
        const saved = this.imageTemplates.get(this.image);
        if (saved) this.template = saved;
        else this.normalizeTemplate();
        // 拼图模式下:如果当前已启用拼图,切换照片时保持拼图配置不丢失
        if (this.template && this.template.puzzle && this.template.puzzle.enabled) {
            // 确保 puzzle.enabled 保持(新照片的 normalizeTemplate 可能把它设为0)
            this.template.puzzle.enabled = 1;
        }
        this.selectedEls = [];
        this.updateStatusBar();
        this.refreshUI();
        this.autoFit = true;
        this.scheduleRender(true);
    },

    selectImage(idx) {
        this.selectedIdx = [idx];
        // 普通单击/切换 = 单选:连批量勾选也一并取消,只保留当前这张
        this.batchSel = [idx];
        this.currentIdx = idx;
        this.image = this.images[idx];
        // 有独立预设的图恢复其自身模板;没有独立预设的以默认(原图)开始,画布显示原图
        const saved = this.image && (this.image.customSettings || this.imageTemplates.get(this.image));
        this.template = saved ? JSON.parse(JSON.stringify(saved)) : this.defaultTemplate();
        this.invalidateStyleCaches();
        this.buildThumbnails();
        this.afterImageSelect();
    },

    /* ══ 照片导入(拖拽/多选共用) ══ */
    async addImageFiles(files) {
        const images = files.filter(f => /^image\//i.test(f.type) || /\.(jpe?g|png|webp|bmp)$/i.test(f.name));
        if (!images.length) { this.setStatus('不支持的文件格式'); return; }
        const skipped = files.length - images.length;
        const total = images.length;
        this.showImportProgress(total);
        let done = 0;
        const tick = (name) => { done++; this.setImportProgress(done, total, name); };
        try {
            const results = await Promise.allSettled(images.map(async (file, i) => {
                const r = await this.loadFile(file);
                if (!r || !r.url) { tick(images[i].name); return null; }
                const img = new Image();
                const loadedOk = await new Promise(res => { img.onload = () => res(true); img.onerror = () => res(false); img.src = r.url; });
                if (!loadedOk || !img.naturalWidth) { tick(images[i].name); if (r.revoke) r.revoke(); return null; }
                const rawExif = (r.buffer && window.__parseExif) ? window.__parseExif(r.buffer) : {};
                const exif = window.__exifSummary ? window.__exifSummary(rawExif) : {};
                const oriented = await this.applyOrientation(img, exif.orientation);
                if (r.revoke) r.revoke();
                const useEl = oriented ? oriented.el : img;
                const w = oriented ? oriented.w : img.naturalWidth;
                const h = oriented ? oriented.h : img.naturalHeight;
                const im = { el: useEl, name: images[i].name, w, h, exif, customSettings: null };
                tick(images[i].name);
                return im;
            }));
            let loaded = 0;
            for (let i = 0; i < results.length; i++) {
                const im = results[i].status === 'fulfilled' ? results[i].value : null;
                if (!im) continue;
                this.images.push(im);
                this.queueThumb(im);
                loaded++;
            }
            if (loaded) {
                this.buildThumbnails();
                this.template = this.defaultTemplate();
                this.normalizeTemplate();
                this.selectImage(this.images.length - loaded);
                this.setStatus(`已导入 ${loaded} 张图片${skipped ? '，跳过 ' + skipped + ' 个不支持的文件' : ''}`);
            } else if (skipped) this.setStatus('不支持的文件格式');
        } finally {
            this.finishImportProgress();
        }
    },

    // 导入进度条:total>0 显示;set 更新百分比/文案;finish 置满后淡出
    showImportProgress(total) {
        const prog = this.dom.importProgress;
        if (!prog) return;
        this._importTotal = total;
        this._importDone = 0;
        prog.style.display = 'flex';
        this.setImportProgress(0, total, null);
    },
    setImportProgress(done, total, name) {
        const prog = this.dom.importProgress;
        if (!prog) return;
        const pct = Math.max(0, Math.min(100, Math.round(done / Math.max(1, total || 1) * 100)));
        if (this.dom.importProgressFill) this.dom.importProgressFill.style.width = pct + '%';
        if (this.dom.importProgressText) this.dom.importProgressText.textContent = `正在导入 ${done}/${total}${name ? ' · ' + name : ''}`;
    },
    finishImportProgress() {
        const prog = this.dom.importProgress;
        if (!prog) return;
        if (this.dom.importProgressFill) this.dom.importProgressFill.style.width = '100%';
        if (this.dom.importProgressText) this.dom.importProgressText.textContent = '导入完成';
        setTimeout(() => { prog.style.display = 'none'; }, 420);
    },

    async loadFile(file) {
        // ObjectURL 直接引用磁盘(内存不再产生 base64 字符串);buffer 仅临时用于 EXIF 解析
        const url = URL.createObjectURL(file);
        const buf = await file.arrayBuffer().catch(() => null);
        return { url, buffer: buf, revoke: () => URL.revokeObjectURL(url) };
    },

    async applyOrientation(img, orientation) {
        if (!orientation || orientation === 1 || orientation === 0) return null;
        orientation = orientation | 0;
        const W = img.naturalWidth, H = img.naturalHeight;
        // 旋转类(3/6/8,含镜像的 5/7)需要交换宽高;纯翻转(2/4)保持宽高
        const swapsWH = (orientation === 6 || orientation === 8 || orientation === 5 || orientation === 7);
        const canvas = document.createElement('canvas');
        canvas.width = swapsWH ? H : W;
        canvas.height = swapsWH ? W : H;
        const ctx = canvas.getContext('2d');
        ctx.translate(canvas.width / 2, canvas.height / 2);
        switch (orientation) {
            case 2: ctx.scale(-1, 1); break;                  // 水平翻转
            case 3: ctx.rotate(Math.PI); break;               // 180°
            case 4: ctx.scale(1, -1); break;                  // 垂直翻转
            case 5: ctx.rotate(Math.PI / 2); ctx.scale(1, -1); break; // 转置+镜像
            case 6: ctx.rotate(Math.PI / 2); break;           // 90°
            case 7: ctx.rotate(-Math.PI / 2); ctx.scale(1, -1); break; // 横转+镜像
            case 8: ctx.rotate(-Math.PI / 2); break;          // 270°
            default: return null;
        }
        ctx.drawImage(img, -W / 2, -H / 2);
        const out = new Image();
        await new Promise(res => { out.onload = res; out.onerror = res; out.src = canvas.toDataURL('image/jpeg', 0.95); });
        if (!out.naturalWidth) return null;
        return { el: out, w: canvas.width, h: canvas.height };
    },

    // 本地照片引用 URL(经 qflocal: 协议由主进程直接流式读取,不产生 base64 副本)
    photoUrl(filePath) { return 'qflocal://img?p=' + encodeURIComponent(filePath); },

    // 把系统选择框返回的单个文件构造成胶片条照片对象(不插入)
    async imageFromPick(res) {
        if (!res) return null;
        if (!res.path) { this.setStatus('图片加载失败：缺少文件路径'); return null; }
        const img = new Image();
        const src = this.photoUrl(res.path);
        await new Promise(r => { img.onload = r; img.onerror = r; img.src = src; });
        if (!img.naturalWidth) return null;
        const exif = res.exif || {};
        const oriented = await this.applyOrientation(img, exif.orientation);
        const useEl = oriented ? oriented.el : img;
        const w = oriented ? oriented.w : img.naturalWidth;
        const h = oriented ? oriented.h : img.naturalHeight;
        const im = { el: useEl, name: res.name, path: res.path, w, h, exif, customSettings: null };
        this.queueThumb(im);
        return im;
    },

    // 把系统选择框返回的单个文件载入胶片条,返回其索引
    async appendImageFromPick(res) {
        const im = await this.imageFromPick(res);
        if (!im) return -1;
        this.images.push(im);
        return this.images.length - 1;
    },

    // 在胶片条指定位置插入新照片(打开系统选择框)。修改列表后只重新计算布局几何,
    // 保留已有格子图片与编辑状态(不自动重拼;需要完整复原请点「重拼(按序填满)」)
    async insertImageFromPick(k) {
        const res = await window.qingframe.openImage();
        if (!res) return;
        const im = await this.imageFromPick(res);
        if (!im) { this.setStatus('图片加载失败，未插入'); return; }
        const pos = Math.max(0, Math.min(k, this.images.length));
        this.images.splice(pos, 0, im);
        // 插入照片会右移列表索引:平移槽位/勾选/选中引用,保持已有格子内容与编辑状态对应正确
        const pik = this.template && this.template.puzzle;
        if (pik && pik.slots) {
            for (const si in pik.slots) {
                const sc = pik.slots[si];
                if (sc && sc.imageIndex != null && sc.imageIndex >= pos) sc.imageIndex++;
            }
        }
        this.batchSel = this.batchSel.map(x => (x >= pos ? x + 1 : x));
        this.selectedIdx = this.selectedIdx.map(x => (x >= pos ? x + 1 : x));
        this.buildThumbnails();
        const pk = this.tplPuzzle();
        if (pk) {
            this.ensurePuzzleSlotsCount(pk);
            this.saveCurrentTemplate();
            this.refreshPuzzleUI();
            this.scheduleRender(true);
            this.setStatus('已插入「' + res.name + '」，保留现有拼图编辑结果');
        } else {
            this.selectImage(pos);
        }
    },

    // 从胶片条移除某张照片:槽位 imageIndex 引用平移,不再自动重拼,
    // 只重算布局几何并保留剩余格子图片与编辑状态(需要复原请点「重拼」)
    removeImage(i) {
        if (i < 0 || i >= this.images.length) return;
        if (this.images.length <= 1) { this.setStatus('至少保留一张照片'); return; }
        const name = this.images[i].name;
        this.batchSel = this.batchSel.filter(x => x !== i).map(x => (x > i ? x - 1 : x));
        this.selectedIdx = this.selectedIdx.filter(x => x !== i).map(x => (x > i ? x - 1 : x));
        const pk = this.template && this.template.puzzle;
        if (pk && pk.slots) {
            for (const k in pk.slots) {
                const sc = pk.slots[k];
                if (sc && sc.imageIndex != null) {
                    if (sc.imageIndex === i) { sc.imageIndex = undefined; sc.imagePath = undefined; }
                    else if (sc.imageIndex > i) sc.imageIndex--;
                }
            }
        }
        this.images.splice(i, 1);
        if (this.currentIdx > i) this.currentIdx--;
        const needReselect = !this.images.includes(this.image);
        this.buildThumbnails();
        if (this.tplPuzzle()) {
            const pk2 = this.tplPuzzle();
            this.ensurePuzzleSlotsCount(pk2);
            this.saveCurrentTemplate();
            this.refreshPuzzleUI();
            this.scheduleRender(true);
            this.setStatus('已移除「' + name + '」，保留剩余格子编辑结果');
            return;
        }
        if (needReselect) {
            this.currentIdx = Math.min(Math.max(0, this.currentIdx), this.images.length - 1);
            this.selectImage(this.currentIdx);
        } else if (this.image) {
            this.selectedIdx = this.selectedIdx.filter(x => x >= 0 && x < this.images.length);
            this.scheduleRender(true);
        }
        this.setStatus('已移除「' + name + '」');
    },

    // 打开图片加入胶片条并设为当前图
    async openImage() {
        const res = await window.qingframe.openImage();
        if (!res) return;
        const idx = await this.appendImageFromPick(res);
        if (idx < 0) { this.setStatus('图片加载失败'); return; }
        this.buildThumbnails();
        this.selectImage(idx);
    },

    // 多选导入:第一张成为当前主图,其余按所选顺序追加进胶片条
    async openImages() {
        const res = await window.qingframe.openImages();
        if (!res || !res.length) return;
        this.showImportProgress(res.length);
        let loaded = 0;
        try {
            for (let i = 0; i < res.length; i++) {
                const idx = await this.appendImageFromPick(res[i]);
                if (idx >= 0) loaded++;
                this.setImportProgress(i + 1, res.length, res[i].name);
            }
        } finally {
            this.finishImportProgress();
        }
        if (!loaded) { this.setStatus('图片加载失败'); return; }
        this.selectImage(this.images.length - loaded);
        this.setStatus('已导入 ' + loaded + ' 张图片');
    },

    // 双击格子:系统文件选择框替换该格照片(自动加入胶片条并合成刷新)
    async openSlotImage(slotIdx) {
        const res = await window.qingframe.openImage();
        if (!res) return;
        const idx = await this.appendImageFromPick(res);
        if (idx < 0) { this.setStatus('图片加载失败，未替换'); return; }
        const pk = this.tplPuzzle();
        if (!pk) { this.buildThumbnails(); this.selectImage(idx); return; }
        this.onSettingCommit();
        this.ensurePuzzleSlotsCount(pk);
        const sc = pk.slots[slotIdx] || (pk.slots[slotIdx] = {});
        sc.imageIndex = idx;
        sc.imagePath = undefined;
        this.saveCurrentTemplate();
        this.buildThumbnails();
        this.refreshPuzzleUI();
        this.scheduleRender(true);
        this.setStatus(`槽位 ${slotIdx + 1} 已替换为「${res.name}」`);
    },

    // 指定槽位当前照片的文件名
    slotImageName(i) {
        const pk = this.template && this.template.puzzle;
        if (!pk || !pk.slots || !pk.slots[i]) return null;
        const sc = pk.slots[i];
        let idx = sc.imageIndex;
        if (idx == null && sc.imagePath != null) idx = this.images.findIndex(x => x.name === sc.imagePath);
        return (idx != null && idx >= 0 && this.images[idx]) ? this.images[idx].name : null;
    },

    /* ── 缩略图:异步原图占位 + 后台队列渲染"带边框成品预览" ── */
    // 入队生成该图的装框缩略图(先保持原图占位,不卡界面);已有缩略图时防抖 350ms 避免连续编辑反复重渲染
    queueThumb(im) {
        if (!im) return;
        if (im.thumb != null && Date.now() - (im._tqAt || 0) < 350) return;
        im._tqAt = Date.now();
        if (!this._thumbQueue) this._thumbQueue = [];
        if (this._thumbQueue.indexOf(im) >= 0) return;
        this._thumbQueue.push(im);
        this.startThumbTick();
    },

    startThumbTick() {
        if (this._thumbBusy) return;
        this._thumbBusy = true;
        setTimeout(() => {
            const im = (this._thumbQueue || []).shift();
            this._thumbBusy = false;
            if (!im) return;
            this.renderFramedThumb(im);
            if ((this._thumbQueue || []).length) setTimeout(() => this.startThumbTick(), 16);
        }, 16);
    },

    // 用该图自己的模板(没有则用当前模板快照)在 200px 离屏画布渲染装框成品,替换占位
    renderFramedThumb(im) {
        if (!window.__render || !im) return;
        const prevCanvas = this.dom.canvas;
        const prevMax = this.displayMax;
        const prevImg = this.image;
        const prevTpl = this.template;
        const cv = document.createElement('canvas');
        cv.width = 1; cv.height = 1;
        cv.style.position = 'absolute'; cv.style.visibility = 'hidden';
        try {
            this.dom.canvas = cv;
            this.displayMax = 200;
            this.image = im;
            const saved = this.imageTemplates.get(im);
            this.template = saved ? JSON.parse(JSON.stringify(saved)) : (prevTpl ? JSON.parse(JSON.stringify(prevTpl)) : null);
            if (!this.template) return;
            window.__render(this, false);
            im.thumb = cv.toDataURL('image/jpeg', 0.8);
            const strip = this.dom.thumbStrip ? this.dom.thumbStrip.querySelectorAll('img.thumb') : [];
            strip.forEach(t => {
                const ti = t.dataset.idx != null ? parseInt(t.dataset.idx, 10) : -1;
                if (ti >= 0 && this.images[ti] === im) t.src = im.thumb;
            });
        } catch (_) { /* 装框缩略图失败:保留原图占位 */ }
        finally {
            this.image = prevImg;
            this.template = prevTpl;
            if (this.dom.canvas === cv) this.dom.canvas = prevCanvas;
            if (prevMax === undefined) delete this.displayMax;
            else this.displayMax = prevMax;
        }
    },

    buildThumbnails() {
        const strip = this.dom.thumbStrip;
        strip.innerHTML = '';
        this.images.forEach((im, i) => {
            const wrap = document.createElement('div');
            wrap.className = 'thumb-item';
            wrap.draggable = false;
            const t = document.createElement('img');
            const isSel = this.batchSel.includes(i);
            const isSrc = isSel && this.batchSel.length > 1 && this.selectedIdx[0] === i;
            const cls = ['thumb'];
            if (isSel) cls.push('active');
            if (isSrc) cls.push('src');
            if (this.image && this.images.indexOf(this.image) === i) cls.push('main');
            t.className = cls.join(' ');
            t.draggable = false;
            t.src = im.thumb || im.el.src;
            t.dataset.idx = i;
            t.title = im.name;
            t.addEventListener('click', e => {
                // 单击 = 选中并切换为当前主图(恢复该图自己的边框模板);Ctrl/Shift+单击 = 追加/取消多选
                if (e.shiftKey || e.ctrlKey) { e.stopPropagation(); this.toggleSelect(i); return; }
                this.selectImage(i);
            });
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'thumb-check';
            cb.title = '勾选用于批量放图';
            cb.checked = isSel;
            cb.addEventListener('click', e => { e.stopPropagation(); this.toggleBatch(i, cb); });
            // 桌面右键菜单:同步边框 / 删除
            const ctxI = i;
            wrap.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
                this.openCtx(e.clientX, e.clientY, [
                    ['同步边框', () => this.syncBorderTo(ctxI)],
                    ['删除', () => this.removeImage(ctxI)],
                ]);
            });
            wrap.appendChild(t);
            wrap.appendChild(cb);
            if (isSrc) {
                const tag = document.createElement('span');
                tag.className = 'thumb-src';
                tag.textContent = '源';
                tag.title = '同步源：选中图片中的第一张（同步时以它为准）';
                wrap.appendChild(tag);
            }
            strip.appendChild(wrap);
        });
        strip.style.display = this.images.length > 1 ? 'flex' : 'none';
    },

    // 把当前主图的边框模板复制给指定缩略图(每图边框独立,同步后该图也恢复此边框;
    // Logo/贴纸/自由文字/拼图布局不随迁移,保持各图独立记忆)
    syncBorderTo(i) {
        const tgt = this.images[i];
        if (!tgt || !this.image) return;
        const prev = this.imageTemplates.get(tgt);
        const prevManual = (prev && prev.manualExif && typeof prev.manualExif === 'object') ? prev.manualExif : null;
        const snap = this.cloneTemplate();
        // Logo/贴纸/自由文字的位置已改为「相对比例」存储,可跨照片尺寸还原,
        // 因此同步边框时一并带上(原先会清空 logoElements,等于放弃多图统一元素布局)。
        // 旧模板里的绝对像素坐标也会随模板复制过去 —— 目标图尺寸不同时位置会偏,
        // 但引擎/app 在首次拖动该元素时就会补写成相对比例。
        if (snap.decorConfig) { delete snap.decorConfig.stickers; delete snap.decorConfig.textLines; }
        delete snap.puzzle;
        // 相机数据:同步只动边框。目标图自己能识别 EXIF → 用自己的(清除历史同步/兜底写入的手动参数);
        // 没有 EXIF 但手动填过 → 保留该图自己的手动参数;都无 → 沿用当前图的有效相机数据
        const ownExif = (tgt.exif && typeof tgt.exif === 'object') ? tgt.exif : {};
        const hasOwn = ['make', 'model', 'focal', 'aperture', 'iso', 'shutter'].some(k => String(ownExif[k] || '').trim() !== '');
        if (hasOwn) {
            delete snap.manualExif;
        } else if (prevManual) {
            delete snap.manualExif;
            if (Object.keys(prevManual).length) snap.manualExif = JSON.parse(JSON.stringify(prevManual));
        } else {
            const srcManual = (this.template.manualExif && typeof this.template.manualExif === 'object') ? this.template.manualExif : {};
            const srcAuto = (this.image.exif && typeof this.image.exif === 'object') ? this.image.exif : {};
            const base = {
                brand: String(srcManual.brand || '').trim() || String(srcAuto.make || '').trim(),
                model: String(srcManual.model || '').trim() || String(srcAuto.model || '').trim(),
                focal: String(srcManual.focal || '').trim() || String(srcAuto.focal || '').trim(),
                aperture: String(srcManual.aperture || '').trim() || String(srcAuto.aperture || '').trim(),
                iso: String(srcManual.iso || '').trim() || String(srcAuto.iso || '').trim(),
                shutter: String(srcManual.shutter || '').trim() || String(srcAuto.shutter || '').trim()
            };
            const hasCam = ['brand', 'model', 'focal', 'aperture', 'iso', 'shutter'].some(k => base[k] !== '');
            delete snap.manualExif;
            if (hasCam) snap.manualExif = base;
        }
        this.imageTemplates.set(tgt, snap);
        this.queueThumb(tgt);
        this.setStatus('已将当前边框同步到「' + tgt.name + '」');
    },

    // 勾选切换(checkbox;与 Ctrl/Shift 多选同一份 batchSel,按勾选顺序排队)
    toggleBatch(i, cb) {
        const k = this.batchSel.indexOf(i);
        if (k >= 0) this.batchSel.splice(k, 1);
        else this.batchSel.push(i);
        if (cb) cb.checked = this.batchSel.includes(i);
        this.selectedIdx = this.batchSel.slice();
        this.buildThumbnails();
        this.setStatus(this.batchSel.length ? `已勾选 ${this.batchSel.length} 张照片，点布局按勾选顺序放入` : '已取消批量勾选');
    },

    toggleSelect(i) {
        const k = this.batchSel.indexOf(i);
        if (k >= 0) this.batchSel.splice(k, 1);
        else this.batchSel.push(i);
        this.selectedIdx = this.batchSel.slice();
        this.buildThumbnails();
        this.setStatus(this.batchSel.length ? `已框选 ${this.batchSel.length} 张照片，点布局按勾选顺序放入` : '已取消框选');
    },

    /* ══ 字体下拉填充(装饰文字/拼图字幕共用 curatedFonts) ══ */
    populateFonts() {
        ['cbCapFont1', 'cbCapFont2'].forEach(id => {
            const sel = this.$(id);
            if (!sel) return;
            sel.innerHTML = '';
            this.curatedFonts.forEach((f, i) => {
                const o = document.createElement('option');
                o.value = f;
                o.textContent = f;
                if (i === 0) o.selected = true;
                sel.appendChild(o);
            });
        });
    },

    /* ══ 静态控件绑定 ══ */
    setupPanelInteractions() {
        const $ = this.$;

        // 通用:range 拖拽时即时同步,change/pointerup 提交;select/checkbox 变更即提交
        this.bindRanges([
            'slGlobalMargin', 'slImgScale', 'slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR', 'slCornerRadius',
            'slParamFontSize', 'slBrandSize', 'slParamScale', 'slFillOpacity', 'slGradientAngle', 'slTextureScale', 'slStrokeWidth', 'slStrokeOpacity',
            'slShadowX', 'slShadowY', 'slShadowBlur', 'slShadowSpread', 'slShadowOpacity', 'slGlowBlur', 'slGlowOpacity',
            'slTearStrength', 'slTearDensity', 'slVignetteStrength', 'slVignetteFeather', 'slLeakOpacity', 'slLeakAngle',
            'slCornerDecorSize', 'slActiveIconOpacity', 'slElementRotation', 'slPuzzleGap', 'slPuzzleCorner',
            'slCapSize1', 'slCapSize2', 'slCapSpacing', 'slSlotOffsetX', 'slSlotOffsetY', 'slSlotZoom',
            'slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR', 'slLayerCornerRadius',
        ]);
        const onEdit = ['slGlobalMargin', 'slImgScale', 'slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR', 'slCornerRadius', 'slParamFontSize', 'slBrandSize', 'slParamScale',
            'slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR', 'slLayerCornerRadius'];
        (onEdit).forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('input', () => this.onSliderCustom(id, parseInt(el.value, 10)));
        });

        // 复选框 -> onSettingCommit
        const chks = ['cbCornerLock', 'cbShadow', 'cbGlow', 'cbTearEnable',
            'cbVignette', 'cbLightLeak', 'cbCornerDecor', 'cbCapBgBar', 'cbLayerCornerLock', 'cbExifText'];
        chks.forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('change', () => this.onSettingCommit());
        });
        // 光照页签复制的阴影/发光已移除,统一收敛到「边框」页签

        // select 变更 -> commit
        const sels = ['cbCanvasRatio', 'cbParamPosition', 'cbParamType', 'cbFillType', 'cbGradientType', 'cbTextureBlend',
            'cbStrokePos', 'cbLeakType', 'cbCornerDecorType', 'cbPuzzleBg', 'cbPuzzleCanvas',
            'cbSlotFill', 'cbCapFont1', 'cbCapFont2'];
        sels.forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('change', () => this.onSelectCustom(id));
        });

        // 数字/文本输入:input 即时同步(防抖),change 提交
        const nums = ['tfImgOffsetX', 'tfImgOffsetY'];
        nums.forEach(id => {
            const el = $(id);
            if (!el) return;
            el.addEventListener('focus', () => this.beginGesture());
            el.addEventListener('blur', () => this.endGesture());
            el.addEventListener('input', () => this.onSettingChanged());
            el.addEventListener('change', () => this.onSettingCommit());
        });
        const texts = ['tfExifBrand', 'tfExifModel', 'tfExifFocal', 'tfExifAperture', 'tfExifIso', 'tfExifShutter',
            'tfStrokeDash', 'tfTemplateName', 'tfTemplateTag', 'tfCapLine1', 'tfCapLine2'];
        texts.forEach(id => {
            const el = $(id);
            if (!el) return;
            el.addEventListener('focus', () => this.beginGesture());
            el.addEventListener('blur', () => this.endGesture());
            el.addEventListener('input', () => this.onTextCustom(id));
            el.addEventListener('change', () => this.onSettingCommit());
        });

        // 图层按钮
        const bindBtn = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => fn()); };
        bindBtn('btnBuiltinTexture', () => this.pickBuiltinTexture());
        bindBtn('btnSelectTexture', () => this.pickTexture());
        bindBtn('btnAddCustomIcon', () => this.addCustomIcon());
        bindBtn('btnCopySelectedElement', () => this.copyElement());
        bindBtn('btnPasteClipboardElement', () => this.pasteElement());
        bindBtn('btnDeleteActiveIcon', () => this.deleteElement());
        bindBtn('btnClearAllIcons', () => this.clearElements());
        bindBtn('btnZOrderTop', () => this.moveZOrder(2));
        bindBtn('btnZOrderBottom', () => this.moveZOrder(-2));
        bindBtn('btnZOrderUp', () => this.moveZOrder(1));
        bindBtn('btnZOrderDown', () => this.moveZOrder(-1));
        // 元素对齐 / 均分 / 统一尺寸(需多选;列表中 Ctrl/Shift 点击即可多选)
        bindBtn('btnAlignLeft', () => this.alignSelectedEls('left'));
        bindBtn('btnAlignHCenter', () => this.alignSelectedEls('hcenter'));
        bindBtn('btnAlignRight', () => this.alignSelectedEls('right'));
        bindBtn('btnAlignTop', () => this.alignSelectedEls('top'));
        bindBtn('btnAlignVCenter', () => this.alignSelectedEls('vcenter'));
        bindBtn('btnAlignBottom', () => this.alignSelectedEls('bottom'));
        bindBtn('btnDistributeH', () => this.alignSelectedEls('distH'));
        bindBtn('btnDistributeV', () => this.alignSelectedEls('distV'));
        bindBtn('btnSameSize', () => this.alignSelectedEls('sameSize'));
        bindBtn('btnSaveTemplate', () => this.saveTemplate());
        bindBtn('btnExportTemplate', () => this.exportTemplate());
        bindBtn('btnImportTemplate', () => this.importTemplate());
        bindBtn('btnQuickFilm', () => this.applyQuickPreset('film'));
        bindBtn('btnQuickIdCard', () => this.applyQuickPreset('idcard'));
        bindBtn('btnAutoColorBorder', () => this.autoColorBorder());
        bindBtn('btnEditGapCaption', () => this.addEditGapCaption());
        bindBtn('btnDeleteGapCaption', () => this.deleteCaption());
bindBtn('btnResetAllSlots', () => this.resetAllSlots());
                bindBtn('btnPuzzleClearSlots', () => this.clearPuzzleSlots());
        bindBtn('btnPuzzleDisable', () => this.disablePuzzle());
        bindBtn('btnExportPuzzle', () => this.exportPuzzle());
        bindBtn('btnPuzzleAddImg', () => this.openImage());
        bindBtn('btnPuzzleRepuzzle', () => this.rePuzzleFill());

        // 元素管理
        if ($('slActiveIconOpacity')) $('slActiveIconOpacity').addEventListener('input', () => {
            const v = parseInt($('slActiveIconOpacity').value, 10);
            this.updateLabel('lblActiveIconOpacity', v + '%');
            this.applyToSelectedEls(el => { el.opacity = v; });
            this.batchElOps();
        });
        if ($('slElementRotation')) $('slElementRotation').addEventListener('input', () => {
            const v = parseInt($('slElementRotation').value, 10);
            this.updateLabel('lblElementRotation', v + '°');
            this.applyToSelectedEls(el => { el.rotation = v; });
            this.batchElOps();
        });
        if ($('slElementSize')) $('slElementSize').addEventListener('input', () => {
            // 平方映射:滑块 0~1000 → 尺寸 16~10000(L 为滑块长度,平方项在低端更精细)
            const pos = parseInt($('slElementSize').value, 10);
            const k = pos / 1000;
            const v = Math.round(16 + (10000 - 16) * k * k);
            this.updateLabel('lblElementSize', v);
            this.applyToSelectedEls((el, kind) => {
                if (kind === 'logo') el.size = v;
                else if (kind === 'sticker') el.scale = clampNum(v / 60, 0.02, 3);
            });
            this.batchElOps();
        });

        // 拼图布局
        this.buildPuzzleLayoutBtns();

        // 槽位下拉:切换前先把当前编辑的字幕写入旧槽位,再加载新槽位
        if ($('cbPuzzleGapPick')) $('cbPuzzleGapPick').addEventListener('change', () => this.onPuzzleSlotChange());

        // 每个页签滚轮加速 x4(防冒泡影响画布)
        this.dom.panels.forEach(p => {
            p.addEventListener('wheel', e => {
                if (e.target && e.target.classList && e.target.classList.contains('ctl-rng')) return;
                const d = e.deltaY;
                if (p.scrollHeight > p.clientHeight) { p.scrollTop += d * 3; e.preventDefault(); }
            }, { passive: false });
        });
    },

    onSliderCustom(id, v) {
        switch (id) {
            case 'slGlobalMargin': this.applyGlobalMargin(v / 100, false); this.onSettingChanged(); break;
            case 'slImgScale': this.updateLabel('lblImgScale', v + '%'); this.onSettingChanged(); break;
            case 'slCornerTL': case 'slCornerTR': case 'slCornerBL': case 'slCornerBR': {
                const cc = this.template.cornerConfig || {};
                const key = 'slCornerTL' === id ? 'cornerRadiusTL' : 'slCornerTR' === id ? 'cornerRadiusTR' : 'slCornerBL' === id ? 'cornerRadiusBL' : 'cornerRadiusBR';
                cc[key] = v;
                this.updateLabel('lbl' + id.slice(2), v);
                if ((this.template.cornerConfig.cornerLock || 0) === 1) {
                    cc.cornerRadiusTL = v; cc.cornerRadiusTR = v; cc.cornerRadiusBL = v; cc.cornerRadiusBR = v;
                    ['slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR'].forEach(c => { const el = this.$(c); if (el) el.value = v; });
                }
                cc.cornerRadiusAll = v;
                if (this.$('slCornerRadius')) this.$('slCornerRadius').value = v;
                this.updateLabel('lblCornerRadius', v);
                this.onSettingChanged();
                break;
            }
            case 'slCornerRadius': {
                const cc = this.template.cornerConfig || {};
                cc.cornerRadiusAll = v;
                cc.cornerRadiusTL = v; cc.cornerRadiusTR = v; cc.cornerRadiusBL = v; cc.cornerRadiusBR = v;
                ['slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR'].forEach(c => { const el = this.$(c); if (el) el.value = v; });
                this.updateLabel('lblCornerRadius', v);
                if (this.$('lblCornerTL')) this.$('lblCornerTL').textContent = v;
                if (this.$('lblCornerTR')) this.$('lblCornerTR').textContent = v;
                if (this.$('lblCornerBL')) this.$('lblCornerBL').textContent = v;
                if (this.$('lblCornerBR')) this.$('lblCornerBR').textContent = v;
                this.onSettingChanged();
                break;
            }
            case 'slParamFontSize': {
                this.template.paramFontSize = v;
                this.updateParamFontLabel();
                this.onSettingChanged();
                break;
            }
            case 'slBrandSize': {
                this.template.brandSize = v / 100;
                this.updateLabel('lblBrandSize', v + '%');
                this.onSettingChanged();
                break;
            }
            case 'slParamScale': {
                this.template.paramScale = v / 100;
                this.updateLabel('lblParamScale', v + '%');
                this.onSettingChanged();
                break;
            }
            case 'slLayerCornerTL': case 'slLayerCornerTR': case 'slLayerCornerBL': case 'slLayerCornerBR': {
                const layer = this.currentLayer ? this.currentLayer() : null;
                if (!layer) break;
                const lcc = layer.cornerConfig || (layer.cornerConfig = {});
                const key = 'slLayerCornerTL' === id ? 'cornerRadiusTL' : 'slLayerCornerTR' === id ? 'cornerRadiusTR' : 'slLayerCornerBL' === id ? 'cornerRadiusBL' : 'cornerRadiusBR';
                lcc[key] = v;
                const lbl = 'lbl' + id.slice(2);
                this.updateLabel(lbl, v);
                this.updateLabel('lblLayerCornerRadius', v);
                if ((lcc.cornerLock || 0) === 1) {
                    lcc.cornerRadiusTL = v; lcc.cornerRadiusTR = v; lcc.cornerRadiusBL = v; lcc.cornerRadiusBR = v;
                    ['slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR'].forEach(c => { const el = this.$(c); if (el) el.value = v; });
                }
                lcc.cornerRadiusAll = v;
                if (this.$('slLayerCornerRadius')) this.$('slLayerCornerRadius').value = v;
                this.updateLabel('lblLayerCornerRadius', v);
                this.onSettingChanged();
                break;
            }
            case 'slLayerCornerRadius': {
                const layer = this.currentLayer ? this.currentLayer() : null;
                if (!layer) break;
                const lcc = layer.cornerConfig || (layer.cornerConfig = {});
                lcc.cornerRadiusAll = v;
                lcc.cornerRadiusTL = v; lcc.cornerRadiusTR = v; lcc.cornerRadiusBL = v; lcc.cornerRadiusBR = v;
                ['slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR'].forEach(c => { const el = this.$(c); if (el) el.value = v; });
                this.updateLabel('lblLayerCornerRadius', v);
                this.updateLabel('lblLayerCornerTL', v); this.updateLabel('lblLayerCornerTR', v);
                this.updateLabel('lblLayerCornerBL', v); this.updateLabel('lblLayerCornerBR', v);
                this.updateLabel('lblLayerCornerRadius', v);
                this.onSettingChanged();
                break;
            }
            default: break;
        }
    },

    onSelectCustom() {
        this.onSettingCommit();
    },

    onTextCustom() {
        this.onSettingChanged();
    },

    bindRanges(ids) {
        const $ = this.$;
        ids.forEach(id => {
            const el = $(id);
            if (!el) return;
            let v = parseInt(el.value, 10);
            el.addEventListener('pointerdown', () => this.beginGesture());
            el.addEventListener('input', () => {
                v = parseInt(el.value, 10);
                this.sliderLiveLabel(id, v);
                this.onSliderLive(id, v);
            });
            el.addEventListener('pointerup', () => {
                this.endGesture();
                this.commitNoPush();
            });
        });
    },

    sliderLiveLabel(id, v) {
        const map = {
            slFillOpacity: ['lblFillOpacity', v + '%'], slGradientAngle: ['lblGradientAngle', v], slTextureScale: ['lblTextureScale', v + '%'],
            slStrokeWidth: ['lblStrokeWidth', v], slStrokeOpacity: ['lblStrokeOpacity', v + '%'],
            slShadowBlur: ['lblShadowBlur', v], slShadowSpread: ['lblShadowSpread', v], slShadowOpacity: ['lblShadowOpacity', v + '%'],
            slGlowBlur: ['lblGlowBlur', v], slGlowOpacity: ['lblGlowOpacity', v + '%'],
            slTearStrength: ['lblTearStrength', v], slTearDensity: ['lblTearDensity', v],
            slVignetteStrength: ['lblVignetteStrength', v + '%'], slVignetteFeather: ['lblVignetteFeather', v],
            slBrandSize: ['lblBrandSize', v + '%'], slParamScale: ['lblParamScale', v + '%'],
            slLeakOpacity: ['lblLeakOpacity', v + '%'], slLeakAngle: ['lblLeakAngle', v + '°'],
            slCornerDecorSize: ['lblCornerDecorSize', v],
            slPuzzleGap: ['lblPuzzleGap', v], slPuzzleCorner: ['lblPuzzleCorner', v + '%'], slCapSize1: ['lblCapSize1', v], slCapSize2: ['lblCapSize2', v],
            slCapSpacing: ['lblCapSpacing', v + '%'], slSlotOffsetX: ['lblSlotOffsetX', v], slSlotOffsetY: ['lblSlotOffsetY', v],
            slSlotZoom: ['lblSlotZoom', v + '%'],
        };
        const entry = map[id];
        if (entry) this.updateLabel(entry[0], entry[1]);
    },

    onSliderLive(id) {
        if (['slGlobalMargin', 'slImgScale', 'slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR', 'slCornerRadius', 'slParamFontSize', 'slBrandSize', 'slParamScale',
            'slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR', 'slLayerCornerRadius'].includes(id)) return; // 由 onSliderCustom 处理
        if (id === 'slPuzzleGap' || id === 'slPuzzleCorner' || id === 'slCapSize1' || id === 'slCapSize2' || id === 'slCapSpacing' || id === 'slSlotOffsetX' || id === 'slSlotOffsetY' || id === 'slSlotZoom') {
            this.syncPuzzleFromUI(); this.onSettingChanged(); return;
        }
        this.onSettingChanged();
    },

    /* ══ 纹理 ══ */
    async pickBuiltinTexture() {
        const builtin = ['denim', 'frost', 'grain', 'kraft', 'leather', 'linen', 'metal', 'paper', 'watercolor', 'wood'];
        const opts = builtin.map(n => `${n} 内置`).join('\n');
        const choice = await this.promptText('选择内置纹理:\n' + opts + '\n(输入名称,留空取消)', 'denim');
        if (!choice) return;
        const name = choice.trim().split(' ')[0];
        this.setLayerTexture(name);
    },

    async pickTexture() {
        if (!this.textures.length) { this.setStatus('纹理库未加载'); return; }
        const opts = this.textures.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
        const choice = await this.promptText('选择纹理(输入序号或名称,留空取消):\n' + opts, '1');
        if (!choice) return;
        const idx = parseInt(choice, 10) - 1;
        const t = this.textures[idx];
        if (!t) { this.setStatus('未找到该纹理'); return; }
        this.setLayerTexture(t.name);
    },

    setLayerTexture(name) {
        this.onSettingCommit();
        const layer = this.currentLayer();
        layer.fillConfig.fillType = 'texture';
        layer.fillConfig.textureSrc = name;
        if (this.$('cbFillType')) this.$('cbFillType').value = 'texture';
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus(`已应用纹理 ${name}`);
    },

    _brandRank(n) {
        const ranking = {"APPLE":100,"SAMSUNG":95,"XIAOMI":90,"VIVO":80,"OPPO":78,"HONOR":72,"HUAWEI":70,"GOOGLE":65,"ONEPLUS":62,"REALME":58,"MOTOROLA":55,"LENOVO":50,"ASUS":48,"NOTHING":45,"NUBIA":42,"REDMI":88,"REDMAGIC":38,"IQOO":52,"TECNO":38,"INFINIX":35,"ITEL":33,"DOOGEE":25,"ULEFONE":22,"BLACKSHARK":30,"VERTU":20,"NOKIA":48,"LG":45,"HTC":40,"MEIZU":35,"CANON":98,"SONY":92,"FUJIFILM":85,"NIKON":80,"PANASONIC":60,"RICOH":45,"OLYMPUS":42,"PENTAX":38,"SIGMA":40,"LEICA":55,"HASSELBLAD":48,"POLAROID":50,"GOPRO":52,"DJI":58,"INSTA360":50,"RED":35,"CONTAX":25,"ALPA":15,"LINHOF":12,"MAMIYA":18,"ROLLEI":20,"PHASEONE":25,"HORSEMAN":10,"TOYO":8,"VOIGTLÄNDER":15,"SEAGULL":20,"TAMRON":30,"AGFA":18,"KODAK":45,"LUMIX":40,"LOMO":30,"BLACKMAGIC":42,"ZEISS":50,"CASIO":25,"CAT":5,"SONYALPHA":52,"OSMO":56};
        // 变体名(如 Apple_Black / Meizu-White / SONY_White)去掉后缀后按品牌热度排名
        const base = (n||'').replace(/\.png$/i,'').replace(/_(WHITE|BLACK|COLOR)$/i,'').replace(/-(WHITE|BLACK)$/i,'').toUpperCase();
        return ranking[base] ?? 5;
    },
    /* ══ Logo 页签 ══ */
    renderLogoPools() {
        const $ = this.$;
        const pools = ['brandIconBox', 'customIconBox'];
        const cats = { brandIconBox: [], customIconBox: [] };
        this.logos.forEach(l => {
            // 自定义图标归到自定义图标池
            if (l.custom) { cats.customIconBox.push(l); return; }
            // 其余品牌logo归到品牌Logo池,按市场热度排序
            cats.brandIconBox.push(l);
        });
        cats.brandIconBox.sort((a,b) => this._brandRank(b.name) - this._brandRank(a.name));
        // 发行版不再内置品牌 Logo 包,新用户进这个页签会看到"整组被隐藏、只剩一个按钮"。
        // 空池时给出引导,说明可以自己导入、以及文件名按品牌命名可自动匹配。
        const hint = $('logoPoolHint');
        if (hint) hint.style.display = this.logos.length ? 'none' : '';
        pools.forEach((boxId) => {
            const box = $(boxId);
            if (!box) return;
            box.innerHTML = '';
            const list = cats[boxId];
            if (!list.length) {
                // 空池隐藏整个组
                const title = box.previousElementSibling;
                if (title) title.style.display = 'none';
                box.style.display = 'none';
                return;
            }
            // 有数据则显示
            const title = box.previousElementSibling;
            if (title) title.style.display = '';
            box.style.display = '';
            list.forEach(l => {
                const c = document.createElement('div');
                c.className = 'icon-cell';
                c.title = l.custom ? (l.name + '(点×删除)') : l.name;
                const img = document.createElement('img');
                img.src = l.dataUrl;
                c.appendChild(img);
                c.addEventListener('click', () => this.armLogoPlacement(l));
                // 自定义图标右上角加×删除按钮
                // 自定义图标双击可重命名
                if (l.custom) {
                    c.addEventListener('dblclick', async (ev) => {
                        ev.stopPropagation();
                        const nn = await this.promptText('重命名自定义图标', l.name);
                        if (!nn || !nn.trim() || nn.trim() === l.name) return;
                        l.name = nn.trim();
                        try {
                            let saved = JSON.parse(localStorage.getItem('qfs_custom_icons') || '[]');
                            saved.forEach(s => { if (s.dataUrl === l.dataUrl) s.name = l.name; });
                            localStorage.setItem('qfs_custom_icons', JSON.stringify(saved));
                        } catch(e) {}
                        this.renderLogoPools();
                        this.setStatus('已重命名');
                    });
                }
                if (l.custom) {
                    const del = document.createElement('span');
                    del.textContent = '×';
                    del.style.cssText = 'position:absolute;top:2px;right:4px;font-size:14px;line-height:1;color:#ea6668;cursor:pointer;font-weight:bold;';
                    del.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (confirm('删除自定义图标「' + l.name + '」?')) {
                            this.deleteCustomIcon(l);
                            this.logos = this.logos.filter(x => x !== l);
                            this.renderLogoPools();
                            this.setStatus('已删除');
                        }
                    });
                    c.style.position = 'relative';
                    c.appendChild(del);
                }
                box.appendChild(c);
            });
            const cnt = this.$({ brandIconBox: 'brandCnt', customIconBox: 'customIconCnt' }[boxId]);
            if (cnt) cnt.textContent = `(${list.length})`;
        });
    },

    armLogoPlacement(logo) {
        // 直接加到画布中央,然后用户可拖动
        this.addLogoElement(logo);
    },

    async addLogoElement(logo, px, py) {
        if (!logo) return;
        this.onSettingCommit();
        if (!this.template) return;
        // 预加载图标到缓存,确保渲染时图片已就绪(避免首帧因 Image 未加载完而跳过绘制)
        const bmp = this.logoImgCache[logo.dataUrl] || new Image();
        this.logoImgCache[logo.dataUrl] = bmp;
        if (!bmp.complete || !bmp.naturalWidth) {
            await new Promise(res => { bmp.onload = res; bmp.onerror = res; bmp.src = logo.dataUrl; });
        }
        if (!this.template.logoElements) this.template.logoElements = [];
        const cw = this.dom.canvas.width, ch = this.dom.canvas.height;
        // 默认按画布宽度取比例(原为写死的 500px):固定值在 800px 画布上占 62%,在 3600px 上只占 14%,
        // 用户每次都得手动调。改为约 12% 画布宽并夹在 80~2000,大小观感在不同分辨率下保持一致。
        const size = clampNum(Math.round(cw * 0.12), 80, 2000);
        const el = {
            name: logo.name, dataUrl: logo.dataUrl, img: null,
            x: px != null ? px : Math.round(cw / 2), y: py != null ? py : Math.round(ch / 2), size, opacity: 100, rotation: 0, z: 10, free: 1,
            ratio: bmp.naturalHeight / bmp.naturalWidth || 1,
        };
        // 补记相对比例:新加的 Logo 默认在画布中央,换照片尺寸时应仍在中央,而不是按像素算偏
        this.setLogoPixelPos(el, el.x, el.y);
        this.template.logoElements.push(el);
        this.selectedEls = [{ kind: 'logo', obj: el }];
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus(`已添加 Logo「${logo.name}」`);
    },

    focusElement(el, factor) {
        if (!el || !this.image) return;
        const canvas = this.dom.canvas;
        if (!canvas.width) return;
        const stage = this.dom.stage;
        const rect = stage.getBoundingClientRect();
        const z0 = this.zoom || 0.1;
        const z1 = Math.min(3, Math.max(0.1, z0 * (factor || 2.5)));
        const lw = canvas._logW || canvas.width, lh = canvas._logH || canvas.height;
        const fx = (el.x / canvas.width) * lw, fy = (el.y / canvas.height) * lh;
        this.panX = Math.round(rect.width / 2 - fx * z1);
        this.panY = Math.round(rect.height / 2 - fy * z1);
        this.setZoom(z1);
    },

    async addCustomIcon() {
        const res = await window.qingframe.openStickerImage();
        if (!res || !res.data) return;
        // 按扩展名判断 MIME:主进程只回传文件名与 base64。此前一律标成 image/jpeg,
        // 会把带透明通道的 PNG 图标当作 JPEG 解码,导致透明底变黑、边缘出现杂色块。
        const ext = String(res.name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
        const mime = { png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' }[ext ? ext[1] : ''] || 'image/jpeg';
        const dataUrl = 'data:' + mime + ';base64,' + res.data;
        const im = new Image();
        await new Promise(r => { im.onload = r; im.onerror = r; im.src = dataUrl; });
        if (!im.naturalWidth) { this.setStatus('图片加载失败'); return; }
        const defaultName = String(res.name || '自定义').replace(/\.[a-z0-9]+$/i, '');
        const typed = await this.promptText('给这个 Logo 起个名字(留空则用文件名)', defaultName);
        if (typed === null) { this.setStatus('已取消添加'); return; }
        const logo = { name: (typed || '').trim() || defaultName, dataUrl, custom: true };
        this.logos.push(logo);
        this.saveCustomIcon(logo);
        this.addLogoElement(logo);
        this.renderLogoPools();
    },

    refreshElList() {
        const $ = this.$;
        const list = $('elList'), status = $('elStatus');
        if (!list) return;
        const t = this.template;
        const items = [];
        (t && t.logoElements || []).forEach((el, i) => items.push({ kind: 'logo', i, label: el.name || 'Logo', src: el.dataUrl, obj: el }));
        (t && t.decorConfig && t.decorConfig.stickers || []).forEach((el, i) => items.push({ kind: 'sticker', i, label: '贴纸', src: el.src, obj: el }));
        (t && t.decorConfig && t.decorConfig.textLines || []).forEach((el, i) => {
            if (el.align === 'free') items.push({ kind: 'text', i, label: el.text.substring(0, 8), src: null, obj: el });
        });
        list.innerHTML = '';
        if (!items.length) {
            status.textContent = '未选中元素';
            const e = document.createElement('div');
            e.className = 'el-row';
            e.textContent = '画布上暂无文字/贴纸/Logo';
            list.appendChild(e);
            return;
        }
        const tagMap = { logo: 'Logo', sticker: '贴纸', text: '文字' };
        items.forEach(it => {
            const r = document.createElement('div');
            r.className = 'el-row';
            if (it.kind === 'logo' || it.kind === 'sticker') {
                const img = document.createElement('img');
                img.src = it.src;
                r.appendChild(img);
            }
            const span = document.createElement('span');
            span.textContent = it.label;
            r.appendChild(span);
            const tag = document.createElement('span');
            tag.className = 'tag';
            tag.textContent = tagMap[it.kind];
            r.appendChild(tag);
            const sel = this.selectedEls.some(x => x.kind === it.kind && x.obj === it.obj);
            if (sel) r.classList.add('active');
            // 列表多选:普通点击=单选;Ctrl/Cmd 点击=加选/取消;Shift 点击=范围选取。
            // 底层 selectedEls / applyToSelectedEls / 批量滑块早就支持多选,此前列表点击会
            // 直接覆盖选中集,导致"给多个 Logo 统一调透明度"只能在画布上逐个 Shift 点选。
            r.addEventListener('click', (ev) => {
                const cur = this.selectedEls.some(x => x.kind === it.kind && x.obj === it.obj);
                if (ev.shiftKey && this._elListAnchor) {
                    const i0 = items.findIndex(x => x.obj === this._elListAnchor.obj && x.kind === this._elListAnchor.kind);
                    const i1 = items.indexOf(it);
                    if (i0 >= 0 && i1 >= 0) {
                        const [a, b] = i0 <= i1 ? [i0, i1] : [i1, i0];
                        const range = items.slice(a, b + 1).map(x => ({ kind: x.kind, obj: x.obj }));
                        // 叠加去重,保留已有选中项
                        const merged = this.selectedEls.slice();
                        range.forEach(r2 => {
                            if (!merged.some(m => m.kind === r2.kind && m.obj === r2.obj)) merged.push(r2);
                        });
                        this.selectedEls = merged;
                    }
                } else if (ev.ctrlKey || ev.metaKey) {
                    if (cur) this.selectedEls = this.selectedEls.filter(x => !(x.kind === it.kind && x.obj === it.obj));
                    else this.selectedEls.push({ kind: it.kind, obj: it.obj });
                    this._elListAnchor = { kind: it.kind, obj: it.obj };
                } else {
                    this.selectedEls = [{ kind: it.kind, obj: it.obj }];
                    this._elListAnchor = { kind: it.kind, obj: it.obj };
                }
                this.refreshElList();
                this.scheduleRender(true);
            });
            list.appendChild(r);
        });
        const first = this.selectedEls.length ? this.selectedEls[0] : null;
        const n = this.selectedEls.length;
        status.textContent = !first ? `共 ${items.length} 个元素,点击选择(可 Ctrl/Shift 多选)`
            : (n > 1 ? `已选中 ${n} 个元素` : `${tagMap[first.kind]}「${this.elLabel(first.obj)}」已选中`);
        if (first) this.syncSliderFromEl({ kind: first.kind, obj: first.obj });
    },

    elLabel(el) {
        if (!el) return '';
        return el.name || el.text || '元素';
    },

    applyToSelectedEls(fn) {
        this.selectedEls.forEach(s => fn(s.obj, s.kind));
    },

    batchElOps() {
        this.saveCurrentTemplate();
        this.scheduleRender();
    },

    copyElement() {
        const first = this.selectedEls[0];
        if (!first) { this.setStatus('请先选中元素'); return; }
        this._elClip = { kind: first.kind, el: JSON.parse(JSON.stringify(first.obj)) };
        this.setStatus('已复制选中元素');
    },

    pasteElement() {
        if (!this._elClip) { this.setStatus('剪贴板为空'); return; }
        this.onSettingCommit();
        const t = this.template;
        const make = () => {
            const copy = JSON.parse(JSON.stringify(this._elClip.el));
            if (copy.x != null) copy.x += 24;
            if (copy.y != null) copy.y += 24;
            if (copy.offsetX != null) copy.offsetX += 24;
            if (copy.offsetY != null) copy.offsetY += 24;
            return copy;
        };
        let placed = null;
        if (this._elClip.kind === 'logo') {
            if (!t.logoElements) t.logoElements = [];
            const n = make(); t.logoElements.push(n); placed = { kind: 'logo', obj: n };
        } else if (this._elClip.kind === 'sticker') {
            const decor = t.decorConfig || (t.decorConfig = {});
            if (!decor.stickers) decor.stickers = [];
            const n = make(); decor.stickers.push(n); placed = { kind: 'sticker', obj: n };
        } else if (this._elClip.kind === 'text') {
            const decor = t.decorConfig || (t.decorConfig = {});
            if (!decor.textLines) decor.textLines = [];
            const n = make(); decor.textLines.push(n); placed = { kind: 'text', obj: n };
        }
        if (placed) this.selectedEls = [placed];
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
    },

    deleteElement() {
        const sel = this.selectedEls;
        if (!sel.length) { this.setStatus('请先选中元素'); return; }
        this.onSettingCommit();
        const t = this.template;
        sel.forEach(s => {
            if (s.kind === 'logo') { const i = (t.logoElements || []).indexOf(s.obj); if (i >= 0) t.logoElements.splice(i, 1); }
            else if (s.kind === 'sticker') { const a = (t.decorConfig && t.decorConfig.stickers) || []; const i = a.indexOf(s.obj); if (i >= 0) a.splice(i, 1); }
            else if (s.kind === 'text') { const a = (t.decorConfig && t.decorConfig.textLines) || []; const i = a.indexOf(s.obj); if (i >= 0) a.splice(i, 1); }
        });
        this.selectedEls = [];
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
    },

    clearElements() {
        if (!this.template) return;
        this.onSettingCommit();
        this.template.logoElements = [];
        if (this.template.decorConfig) { this.template.decorConfig.stickers = []; this.template.decorConfig.textLines = []; }
        this.selectedEls = [];
        delete this.template._draftText;
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        this.setStatus('已清空全部元素');
    },

    moveZOrder(delta) {
        if (!this.selectedEls.length) { this.setStatus('请先选中元素'); return; }
        this.onSettingCommit();
        const kinds = ['logo', 'sticker', 'text'];
        kinds.forEach(kind => {
            const els = (kind === 'logo') ? (this.template.logoElements || [])
                : (kind === 'sticker') ? (this.template.decorConfig && this.template.decorConfig.stickers || [])
                    : (this.template.decorConfig && this.template.decorConfig.textLines || []);
            this.selectedEls.forEach(s => {
                const i = els.indexOf(s.obj);
                if (i < 0) return;
                els[i].z = (els[i].z || 0) + delta;
                // 通过 z 排序实现层级:直接赋序
                els[i].z = clampNum(els[i].z, -100, 100);
            });
            // 依据 z 排序后按新序重排数组(等效 Java 中 moveZOrder 1/-1/2/-2)
            els.sort((a, b) => (a.z || 0) - (b.z || 0));
        });
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
    },



    // 元素对齐 / 均分 / 统一尺寸。基准取「所有选中元素的包围盒」(贴近常见编辑器行为)。
    // 兼容两种坐标:绝对像素(el.x 为数字)与锚点+偏移(el.x 为 'right'/'bottom' 等)。
    // 后者在写回时按目标点反算 offset,避免被强行转成像素坐标而失去"随画布自适应"的特性。
    alignSelectedEls(mode) {
        const sel = (this.selectedEls || []).filter(s => s && s.obj);
        if (sel.length < 2) { this.setStatus('请至少选中两个元素再对齐'); return; }
        const cv = this.dom.canvas;
        const cwM = Math.max(1, cv.width), chM = Math.max(1, cv.height);
        const lw = cv._logW || cwM, lh = cv._logH || chM;

        this.onSettingCommit();
        const boxes = sel.map(s => {
            const o = s.obj;
            const dim = this._elBoxSize(s);
            const cur = (typeof o.x === 'number' && typeof o.y === 'number')
                ? { cx: o.x, cy: o.y }
                : this.logoPos(o, lw, lh, dim.w);
            return { s, dim, cur, box: { x0: cur.cx - dim.w / 2, y0: cur.cy - dim.h / 2, x1: cur.cx + dim.w / 2, y1: cur.cy + dim.h / 2 } };
        });

        const L = Math.min(...boxes.map(b => b.box.x0));
        const R = Math.max(...boxes.map(b => b.box.x1));
        const T = Math.min(...boxes.map(b => b.box.y0));
        const B = Math.max(...boxes.map(b => b.box.y1));
        const HC = (L + R) / 2, VC = (T + B) / 2;

        if (mode === 'sameSize') {
            const avg = Math.round(boxes.reduce((sum, b) => sum + b.dim.w, 0) / boxes.length);
            boxes.forEach(b => { this._applyElSize(b.s.kind, b.s.obj, Math.max(2, avg)); });
        } else if (mode === 'distH' || mode === 'distV') {
            const horiz = mode === 'distH';
            const sorted = boxes.slice().sort((a, b) => (horiz ? a.cur.cx - b.cur.cx : a.cur.cy - b.cur.cy));
            const first = sorted[0], last = sorted[sorted.length - 1];
            const span = horiz ? (last.cur.cx - first.cur.cx) : (last.cur.cy - first.cur.cy);
            const step = span / (sorted.length - 1);
            sorted.forEach((b, i) => {
                const cx = horiz ? first.cur.cx + step * i : b.cur.cx;
                const cy = horiz ? b.cur.cy : first.cur.cy + step * i;
                this._applyElPos(b.s.obj, cx, cy, cwM, chM, lw, lh, b.dim);
            });
        } else {
            boxes.forEach(b => {
                let cx = b.cur.cx, cy = b.cur.cy;
                if (mode === 'left') cx = L + b.dim.w / 2;
                else if (mode === 'right') cx = R - b.dim.w / 2;
                else if (mode === 'hcenter') cx = HC;
                else if (mode === 'top') cy = T + b.dim.h / 2;
                else if (mode === 'bottom') cy = B - b.dim.h / 2;
                else if (mode === 'vcenter') cy = VC;
                this._applyElPos(b.s.obj, cx, cy, cwM, chM, lw, lh, b.dim);
            });
        }
        this.refreshUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
        const names = { left: '左对齐', hcenter: '水平居中', right: '右对齐', top: '顶对齐', vcenter: '垂直居中', bottom: '底对齐', distH: '水平均分', distV: '垂直均分', sameSize: '统一尺寸' };
        this.setStatus('已' + (names[mode] || mode));
    },

    // 元素在画布上的近似外接尺寸(对齐用)。Logo 为宽×宽×纵横比;贴纸按原图×scale;文字按字号方块。
    _elBoxSize(s) {
        const o = s.obj || {};
        if (s.kind === 'logo') return this._logoDrawSize(o);
        if (s.kind === 'sticker') {
            const im = window.getElementBitmap ? window.getElementBitmap(o.src) : null;
            const sc = o.scale || 1;
            const w = (im && im.naturalWidth ? im.naturalWidth : 100) * sc;
            const h = (im && im.naturalHeight ? im.naturalHeight : 100) * sc;
            return { w, h };
        }
        const f = (o.fontSize || 18) * 1.2;
        return { w: f * Math.max(1, String(o.text || '').length) * 0.6, h: f };
    },

    _applyElSize(kind, o, size) {
        if (kind === 'logo') o.size = clampNum(size, 8, 10000);
        else if (kind === 'sticker') o.scale = clampNum(size / 100, 0.02, 3);
        else if (kind === 'text') o.fontSize = clampNum(size, 6, 300);
    },

    _applyElPos(o, cx, cy, cwM, chM, lw, lh, dim) {
        if (typeof o.x === 'string' || typeof o.y === 'string') {
            // 锚点定位:保持锚点不变,按目标点反算偏移量,这样它仍能随画布尺寸自适应
            const hAlign = o.x || 'right', vAlign = o.y || 'bottom';
            const half = dim.w / 2, halfY = dim.h / 2;
            if (hAlign === 'left') o.offsetX = Math.round(cx - half);
            else if (hAlign === 'center') o.offsetX = 0;
            else o.offsetX = Math.round(lw - cx - half);
            if (vAlign === 'top') o.offsetY = Math.round(cy - halfY);
            else if (vAlign === 'center') o.offsetY = 0;
            else o.offsetY = Math.round(lh - cy - halfY);
            if (o.offsetX < 0) o.offsetX = 0;
            if (o.offsetY < 0) o.offsetY = 0;
            return;
        }
        // 绝对坐标:按测量画布→显示画布的缩放换算(与拖拽一致),并同步相对比例
        this.setLogoPixelPos(o, cx * (cwM / lw), cy * (chM / lh));
    },

    /* ══ 缩放 / 平移 / 状态栏 / 主题 ══ */
    zoomAt(e, stage, factor) {
        const rect = stage.getBoundingClientRect();
        const mx = e.clientX - rect.left, my = e.clientY - rect.top;
        const cx = rect.width / 2, cy = rect.height / 2;
        const z0 = this.zoom;
        const z1 = Math.min(3, Math.max(0.1, z0 * factor));
        if (z1 === z0) return;
        const px = (mx - cx - this.panX) / z0;
        const py = (my - cy - this.panY) / z0;
        this.panX = mx - cx - px * z1;
        this.panY = my - cy - py * z1;
        this.setZoom(z1);
    },

    setZoom(z) {
        this.zoom = z;
        this.dom.zoomInput.value = Math.round(z * 100) + '%';
        this.dom.zoomRange.value = Math.round(z * 100);
        this.applyZoomStyle();
    },
    fitZoom() {
        if (!this.image) return;
        // 导出渲染期间不动 CSS/缩放(画布只是临时放大),避免大导出时视图抖动
        if (this.uiDprOverride === 1) return;
        const canvas = this.dom.canvas;
        if (!canvas.width) return;
        const stage = this.dom.stage;
        const sw = stage.clientWidth - 8, sh = Math.max(60, stage.clientHeight - 8);
        const z = Math.min(sw / canvas.width, sh / canvas.height);
        this.panX = 0; this.panY = 0;
        this.setZoom(Math.max(0.1, z));
    },
    applyZoomStyle() {
        // 导出渲染期间不动 CSS 显示样式(见 fitZoom 守卫)
        if (this.uiDprOverride === 1) return;
        const canvas = this.dom.canvas;
        const z = this.zoom;
        // 显示尺寸用逻辑像素(backing/DPR),高分屏不放大,文字保持清晰
        const lw = canvas._logW || canvas.width, lh = canvas._logH || canvas.height;
        canvas.style.width = Math.max(1, Math.round(lw * z)) + 'px';
        canvas.style.height = Math.max(1, Math.round(lh * z)) + 'px';
        canvas.style.transform = `translate(${Math.round(this.panX)}px, ${Math.round(this.panY)}px)`;
    },

    switchTab(name) {
        this.dom.tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
        this.dom.panels.forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
        if (name === 'logo') this.renderLogoPools();
        if (name === 'template') this.refreshTemplates();
        if (name === 'puzzle') this.refreshPuzzleUI();
    },

    setupShortcuts() {
        document.addEventListener('keydown', e => {
            // 输入框/文本域聚焦时不触发快捷键(避免打字冲突)
            const tag = (document.activeElement && document.activeElement.tagName) || '';
            const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable);
            if (typing && !e.ctrlKey) return;

            if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); this.openImages(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
            else if ((e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); this.redo(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                // 有图片时全选缩略图(批量勾选),再按一次取消全选;无图片则回退画布元素全选
                if (this.images && this.images.length) {
                    const allSel = this.images.every((_, i) => this.batchSel.includes(i));
                    this.batchSel = allSel ? [] : this.images.map((_, i) => i);
                    this.selectedIdx = this.batchSel.slice();
                    this.buildThumbnails();
                    this.setStatus(allSel ? '已取消全选' : '已全选 ' + this.images.length + ' 张图片');
                } else {
                    this.selectAllEls();
                }
            }
            else if (e.ctrlKey && e.key.toLowerCase() === 'c') { if (!typing) this.copyElement(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'v') { if (typing) return; e.preventDefault(); this.pasteElement(); }
            else if (e.key === 'Delete' && !typing) {
                e.preventDefault();
                // 优先删拼图字幕(字幕面板打开时)
                if (this.template && this.template.puzzle && $('cbPuzzleGapPick') && $('cbPuzzleGapPick').value) {
                    this.deleteCaption();
                } else if (this.selectedEls.length) {
                    this.deleteElement();
                }
            }
            // 新增快捷键
            else if (e.ctrlKey && e.key.toLowerCase() === 'e') { e.preventDefault(); this.exportImage(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'd') { e.preventDefault(); this.applyBorderToSelected(); }
            else if (e.ctrlKey && e.key === '0') { e.preventDefault(); this.fitZoom(); }
            else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); this.saveTemplate(); }
            else if (e.key === 'ArrowLeft' && this.images && this.images.length > 1) { e.preventDefault(); this.selectImage((this.currentIdx - 1 + this.images.length) % this.images.length); }
            else if (e.key === 'ArrowRight' && this.images && this.images.length > 1) { e.preventDefault(); this.selectImage((this.currentIdx + 1) % this.images.length); }
        });
    },

    // 把当前边框参数应用到所有勾选的照片
    applyBorderToSelected() {
        if (!this.image) { this.setStatus('请先打开一张照片'); return; }
        const targets = (this.batchSel && this.batchSel.length) ? this.batchSel.slice() : [this.currentIdx];
        let n = 0;
        targets.forEach(i => {
            if (i !== this.currentIdx) { this.syncBorderTo(i); n++; }
        });
        this.setStatus(n ? `已把当前边框同步到 ${n} 张选中照片` : '没有需要同步的选中照片(仅当前张)');
    },

    selectAllEls() {
        if (!this.template) return;
        this.selectedEls = [];
        (this.template.logoElements || []).forEach(o => this.selectedEls.push({ kind: 'logo', obj: o }));
        (this.template.decorConfig && this.template.decorConfig.stickers || []).forEach(o => this.selectedEls.push({ kind: 'sticker', obj: o }));
        (this.template.decorConfig && this.template.decorConfig.textLines || []).forEach(o => { if (o.align === 'free') this.selectedEls.push({ kind: 'text', obj: o }); });
        this.refreshElList();
    },

    /* ── 拖拽导入 ── */
    setupDragDrop() {
        const pane = this.dom.canvasPane;
        let depth = 0;
        pane.addEventListener('dragenter', e => { e.preventDefault(); depth++; pane.classList.add('dragging'); });
        pane.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
        pane.addEventListener('dragleave', e => { e.preventDefault(); if (--depth <= 0) { depth = 0; pane.classList.remove('dragging'); } });
        pane.addEventListener('drop', e => {
            e.preventDefault(); depth = 0; pane.classList.remove('dragging');
            // 只接受操作系统文件拖放(类型为 "Files");应用内元素(缩略图等)的拖拽不触发重导入
            const types = Array.from(e.dataTransfer && e.dataTransfer.types || []);
            const osDrop = types.some(t => String(t).toLowerCase() === 'files');
            const files = osDrop ? Array.from(e.dataTransfer.files || []) : [];
            if (files.length) this.addImageFiles(files);
        });
    },

    /* 状态栏 / 主题 */
    statusMsg: '',
    setStatus(msg) {
        this.statusMsg = msg;
        if (this.dom.stCanvas) this.dom.stCanvas.textContent = `画布 ${this.canvasW()}×${this.canvasH()}` + (msg ? ` · ${msg}` : '');
    },
    canvasW() { return this.dom.canvas ? this.dom.canvas.width : 0; },
    canvasH() { return this.dom.canvas ? this.dom.canvas.height : 0; },

    // 通用文本输入弹窗(Electron 不支持 window.prompt),resolve 值或 null(取消)
    promptText(title, def) {
        return new Promise(resolve => {
            const ov = document.createElement('div');
            ov.className = 'modal-overlay';
            const card = document.createElement('div');
            card.className = 'modal-card';
            const head = document.createElement('div');
            head.className = 'modal-header';
            const t = document.createElement('div');
            t.className = 'modal-title';
            t.textContent = title || '输入';
            t.style.whiteSpace = 'pre-wrap';
            t.style.lineHeight = '1.5';
            t.style.maxHeight = '40vh';
            t.style.overflow = 'auto';
            const close = document.createElement('button');
            close.className = 'modal-close'; close.textContent = '\u00d7'; close.title = '取消';
            head.appendChild(t); head.appendChild(close);
            const body = document.createElement('div');
            body.className = 'modal-body';
            const input = document.createElement('input');
            input.type = 'text';
            input.value = def || '';
            input.className = 'ctl-tx';
            input.style.cssText = 'width:100%;box-sizing:border-box;font-size:13px;padding:8px 9px;';
            const btns = document.createElement('div');
            btns.className = 'btn-row btn-2';
            btns.style.cssText = 'padding:14px 0 0;';
            const btnCancel = document.createElement('button');
            btnCancel.className = 'mini-btn'; btnCancel.textContent = '取消';
            const btnOk = document.createElement('button');
            btnOk.className = 'mini-btn primary'; btnOk.textContent = '确定';
            btns.appendChild(btnCancel); btns.appendChild(btnOk);
            body.appendChild(input); body.appendChild(btns);
            card.appendChild(head); card.appendChild(body);
            ov.appendChild(card);
            document.body.appendChild(ov);
            const done = v => { document.body.removeChild(ov); resolve(v); };
            const ok = () => done(input.value);
            const cancel = () => done(null);
            btnOk.addEventListener('click', ok);
            btnCancel.addEventListener('click', cancel);
            close.addEventListener('click', cancel);
            ov.addEventListener('mousedown', e => { if (e.target === ov) cancel(); });
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter') ok();
                if (e.key === 'Escape') cancel();
            });
            input.focus();
            try { input.select(); } catch (_) { /* 忽略 */ }
        });
    },
    updateStatusBar() {
        if (!this.image) { this.setStatus(''); return; }
        const im = this.image;
        this.dom.stRes.textContent = `${im.w}×${im.h}`;
        this.dom.stInfo.textContent = `${this.currentIdx + 1}/${this.images.length} · ${im.name}`;
        this.setStatus(this.statusMsg && !this.statusMsg.startsWith('画布') ? this.statusMsg : '');
    },

    toggleTheme() {
        const root = document.documentElement;
        root.classList.toggle('dark');
    },

    /* ── 登录 / 用户 ── */
    user: null,

    async initLogin() {
        try {
            const u = await window.qingframe.getUser();
            this.user = u;
        } catch (e) {
            this.user = null;
        }
        this.refreshLoginStatus();
    },

    openLoginModal() {
        const d = this.dom;
        d.loginModal.style.display = 'flex';
        if (this.user) {
            d.loginFormView.style.display = 'none';
            d.loginProfileView.style.display = 'block';
            this.renderProfile();
        } else {
            d.loginFormView.style.display = 'block';
            d.loginProfileView.style.display = 'none';
            d.loginUsername.value = '';
            d.loginNickname.value = '';
            setTimeout(() => d.loginUsername.focus(), 60);
        }
    },

    closeLoginModal() {
        this.dom.loginModal.style.display = 'none';
    },

    renderProfile() {
        const d = this.dom;
        const name = (this.user.nickname || this.user.username).trim();
        const av = localStorage.getItem('qfs_user_avatar');
        if (av) { d.loginAvatar.style.background = 'url(' + av + ') center/cover'; d.loginAvatar.textContent = ''; }
        else { d.loginAvatar.style.background = '#444'; d.loginAvatar.textContent = ''; }
        d.loginDisplayName.textContent = name;
        d.loginUsernameDisplay.textContent = '@' + this.user.username;
    },

    async doLogin() {
        const username = this.dom.loginUsername.value.trim();
        if (!username) { this.setStatus('请输入用户名'); return; }
        const nickname = this.dom.loginNickname.value.trim() || username;
        this.user = { username, nickname, createdAt: Date.now() };
        try {
            await window.qingframe.saveUser(this.user);
            this.closeLoginModal();
            this.setStatus(`已登录「${nickname}」`);
        } catch (e) {
            this.setStatus('登录失败：' + e.message);
        }
        this.refreshLoginStatus();
    },

    async doLogout() {
        try {
            await window.qingframe.logoutUser();
            this.user = null;
            this.closeLoginModal();
            this.setStatus('已退出登录');
        } catch (e) {
            this.setStatus('退出失败：' + e.message);
        }
        this.refreshLoginStatus();
    },

    refreshLoginStatus() {
        const el = this.dom.loginStatus;
        if (this.user) {
            const name = (this.user.nickname || this.user.username).trim();
            el.textContent = name;
            el.classList.add('logged-in');
            el.title = '@' + this.user.username + ' · 点击管理';
        } else {
            el.textContent = '未登录';
            el.classList.remove('logged-in');
            el.title = '点击登录';
        }
    },

};

/* 工具 */
function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function num(el, def) {
    if (!el) return def == null ? 0 : def;
    const v = parseFloat(el.value);
    return isNaN(v) ? (def == null ? 0 : def) : v;
}
function dashToArray(v) {
    if (!v) return [];
    const arr = String(v).split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x) && x > 0);
    return arr;
}

document.addEventListener('DOMContentLoaded', () => App.init());