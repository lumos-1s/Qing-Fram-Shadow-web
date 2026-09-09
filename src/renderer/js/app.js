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
    _draftPending: false,
    _puzzleSlot: 's0',       // 拼图当前编辑项('s0'..槽位 / 'v0'/'h0'..间隙)
    _editingGap: null,       // 正在编辑的字幕门牌号('H0'/'V1'/'S2'),无则收起编辑器
    _activePuzzleSlot: null, // 画布选中槽位(高亮 + 换图)
    _puzzlePick: null,       // 拖拽抓取预览 {mode:'target'|'float',...}
    _puzzleDropTarget: null, // 拖拽互换预备目标格
    _skipPuzzleCapture: false,

    init() {
        this.cacheDom();
        this.bind();
        this.loadPresets();
        this.loadLogos();
        this.loadTextures();
        this.populateFonts();
        this.setupShortcuts();
        this.setupPanelInteractions();
        this.updateHistoryButtons();
    },

    cacheDom() {
        const $ = id => document.getElementById(id);
        this.dom = {
            btnOpen: $('btnOpen'), btnSave: $('btnSave'), selFormat: $('selFormat'),
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
        };
    },

    $(id) { return document.getElementById(id); },

    bind() {
        const d = this.dom;
        d.btnOpen.addEventListener('click', () => this.openImages());
        d.btnSave.addEventListener('click', () => this.exportImage());
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
        d.btnCompare.addEventListener('mousedown', () => this.setCompare(true));
        d.btnCompare.addEventListener('mouseup', () => this.setCompare(false));
        d.btnCompare.addEventListener('mouseleave', () => this.setCompare(false));
        this.setupDragDrop();
        this.bindInteractive();
    },

    /* ══ 画布元素 / 缩放平移交互 ══ */
    bindInteractive() {
        const pane = this.dom.canvasPane, stage = this.dom.stage, canvas = this.dom.canvas;
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
                this.clearActivePuzzleSlot();
            }
            const pt = this.screenToCanvas(e);
            const el = this.pickElement(pt);
            if (el) {
                e.preventDefault();
                this.selectedEls = this.hasEl(this.selectedEls, el) ? this.selectedEls : [el];
                this._dragEl = { kind: el.kind, ref: el.obj, sx: e.screenX, sy: e.screenY, x: el.x0, y: el.y0, moved: false };
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
                if (moved) this.commitNoPush();
            }
            if (this._pan) { this._pan = null; canvas.style.cursor = ''; }
        });
        canvas.addEventListener('dblclick', e => {
            const pk = this.tplPuzzle();
            if (!pk) return;
            const si = this.puzzleSlotAt(e);
            if (si == null) return;
            e.preventDefault();
            this.setActivePuzzleSlot(si);
            this.openSlotImage(si);
        });
        // 桌面右键菜单:拼图格子
        canvas.addEventListener('contextmenu', e => {
            const pk = this.tplPuzzle();
            if (!pk) return;
            const hp = this.puzzleHitTest(e);
            if (!hp) return;
            e.preventDefault();
            this.setActivePuzzleSlot(hp.slot);
            this.openCtx(e.clientX, e.clientY, [
                ['替换照片(打开图片)', () => this.openSlotImage(hp.slot)],
                ['在此位置插入照片', () => this.insertImageFromPick(hp.slot)],
                ['清空该格', () => this.clearSlotImage(hp.slot)],
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

    logoPos(el, cw, ch, size) {
        if (typeof el.x === 'number' && typeof el.y === 'number') {
            return { cx: el.x, cy: el.y };
        }
        const hAlign = el.x || 'right', vAlign = el.y || 'bottom';
        const ox = el.offsetX || 20, oy = el.offsetY || 20;
        const tx = hAlign === 'left' ? ox + size / 2 : hAlign === 'center' ? cw / 2 : cw - ox - size / 2;
        const ty = vAlign === 'top' ? oy + size / 2 : vAlign === 'center' ? ch / 2 : ch - oy - size / 2;
        return { cx: tx, cy: ty };
    },

    nudgeElement(el, mode, dir) {
        const e = el.obj;
        if (el.kind === 'logo') {
            if (typeof e.x !== 'number') { e.x = this.logoPos(e, this.dom.canvas.width, this.dom.canvas.height, e.size || 60).cx; e.y = this.logoPos(e, this.dom.canvas.width, this.dom.canvas.height, e.size || 60).cy; }
            if (mode === 'rot') e.rotation = (e.rotation || 0) + dir * 5;
            else e.size = clampNum((e.size || 60) + dir * 6, 8, 400);
        } else if (el.kind === 'sticker') {
            if (mode === 'rot') e.rotation = (e.rotation || 0) + dir * 5;
            else e.scale = clampNum((e.scale || 1) * (dir > 0 ? 1.1 : 0.9), 0.02, 3);
        } else if (el.kind === 'text') {
            if (mode === 'rot') e.rotation = (e.rotation || 0) + dir * 5;
            else { e.fontSize = clampNum((e.fontSize || 18) + dir * 2, 6, 300); if (e.autoSize) e.autoSize = 0; }
        }
        this.syncSliderFromEl(el);
        this.onSettingChanged();
    },

    moveElement(drag, x, y) {
        const e = drag.ref;
        if (drag.kind === 'logo') { e.x = x; e.y = y; e.offsetX = 0; e.offsetY = 0; }
        else if (drag.kind === 'sticker') { e.x = x; e.y = y; }
        else if (drag.kind === 'text') { e.x = x; e.y = y; }
        this.onSettingChanged();
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
        const rot = $('slElementRotation'), op = $('slActiveIconOpacity');
        if (rot) rot.value = Math.round(e.rotation || 0);
        if (op) op.value = Math.round(e.opacity != null ? e.opacity : 100);
        this.updateLabel('lblElementRotation', Math.round(e.rotation || 0) + '°');
        this.updateLabel('lblActiveIconOpacity', Math.round(e.opacity != null ? e.opacity : 100) + '%');
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
            paramFontSize: 100, paramType: 0, paramPosition: 'CENTER',
            puzzle: {
                enabled: 0, layout: 'single', layoutType: 0, gap: 6, slotFill: 'cover', bgMode: 0,
                canvasRatio: 'auto', borderColor: 'ffffff', offsetX: 0, offsetY: 0, zoom: 100,
                slots: {}, axisVals: {}, captions: {}, gapCaptions: {},
            },
        };
    },

    /* ══ 四方法核心 ══ */
    // 高频修改(拖滑块/输入文字):仅同步 + 防抖渲染,不压撤销栈
    onSettingChanged() {
        this.syncModelFromUI();
        this.saveCurrentTemplate();
        this.scheduleRender();
    },

    // 一次性提交(切换/勾选/按钮/change):压撤销栈 -> 清重做 -> 同步 -> 立即渲染
    // 若处于手势中(滑块下按/文本框聚焦时已压过快照),则不重复压栈
    onSettingCommit() {
        if (!this._gesture) this.pushUndo();
        this._commit();
    },

    // 手势开始:滑块 pointerdown / 文本框 focus 时压入手势前快照
    beginGesture() {
        if (this._gesture || !this.template || !this.image) return;
        this._gesture = true;
        this.pushUndo();
        // 拖拽/拖动滑块期间用 900px 低分辨率即时渲染,松手后恢复全分辨率,桌面交互更流畅
        if (this._gesturePrevMax == null) {
            this._gesturePrevMax = this.displayMax !== undefined ? this.displayMax : 1800;
            this.displayMax = 900;
        }
    },
    // 手势结束:pointerup / blur
    endGesture() {
        if (this._gesture) this._gesture = false;
        if (this._gesturePrevMax != null) {
            this.displayMax = this._gesturePrevMax;
            this._gesturePrevMax = null;
            this.scheduleRender(true);
        }
    },
    // 提交但不压栈(手势快照已在上一步压入)
    commitNoPush() { this._commit(); },
    _commit() {
        this.syncModelFromUI();
        this.saveCurrentTemplate();
        this.scheduleRender(true);
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

        cc.cornerLock = $('cbCornerLock') && $('cbCornerLock').checked ? 1 : 0;
        const r = $('slCornerRadius') ? parseInt($('slCornerRadius').value, 10) : (cc.cornerRadiusAll || 0);
        cc.cornerRadiusAll = r;
        cc.cornerRadiusTL = num($('slCornerTL'), r);
        cc.cornerRadiusTR = num($('slCornerTR'), r);
        cc.cornerRadiusBL = num($('slCornerBL'), r);
        cc.cornerRadiusBR = num($('slCornerBR'), r);

        this.template.paramPosition = $('cbParamPosition') ? $('cbParamPosition').value : 'CENTER';
        this.template.paramFontSize = $('slParamFontSize') ? parseInt($('slParamFontSize').value, 10) : 100;
        this.template.paramType = $('cbParamType') ? parseInt($('cbParamType').value, 10) : 0;
        this.syncManualExif();

        layer.visible = $('cbLayerVisible') && $('cbLayerVisible').checked ? 1 : 0;
        layer.marginTop = num($('tfLayerMarginTop'), layer.marginTop);
        layer.marginRight = num($('tfLayerMarginRight'), layer.marginRight);
        layer.marginBottom = num($('tfLayerMarginBottom'), layer.marginBottom);
        layer.marginLeft = num($('tfLayerMarginLeft'), layer.marginLeft);

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
        lcc.cornerLock = ($('cbLayerCornerLock') && $('cbLayerCornerLock').checked) ? 1 : 0;
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

        decor.exifAutoText = ($('cbExifText') && $('cbExifText').checked) ? 1 : 0;
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
        const de = $('decorExifLine'), dt = $('decorExifLineText');
        if (de && dt) {
            const e = this.image && this.image.exif ? this.image.exif : {};
            const parts = [e.make && e.model ? `${e.make} ${e.model}` : (e.make || e.model), e.shutter, e.aperture, e.iso, e.focal].filter(Boolean);
            if (parts.length) { dt.textContent = parts.join(' · '); de.style.display = ''; }
            else de.style.display = 'none';
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
            if ($('slCornerTL')) $('slCornerTL').value = cc.cornerRadiusTL || 0;
            if ($('slCornerTR')) $('slCornerTR').value = cc.cornerRadiusTR || 0;
            if ($('slCornerBL')) $('slCornerBL').value = cc.cornerRadiusBL || 0;
            if ($('slCornerBR')) $('slCornerBR').value = cc.cornerRadiusBR || 0;
            this.updateLabel('lblCornerTL', cc.cornerRadiusTL || 0); this.updateLabel('lblCornerTR', cc.cornerRadiusTR || 0);
            this.updateLabel('lblCornerBL', cc.cornerRadiusBL || 0); this.updateLabel('lblCornerBR', cc.cornerRadiusBR || 0);

            if ($('cbParamPosition')) $('cbParamPosition').value = this.template.paramPosition || 'CENTER';
            if ($('slParamFontSize')) $('slParamFontSize').value = this.template.paramFontSize != null ? this.template.paramFontSize : 100;
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
            if ($('cbLayerVisible')) $('cbLayerVisible').checked = (layer.visible || 1) === 1;
            if ($('tfLayerMarginTop')) $('tfLayerMarginTop').value = layer.marginTop || 0;
            if ($('tfLayerMarginRight')) $('tfLayerMarginRight').value = layer.marginRight || 0;
            if ($('tfLayerMarginBottom')) $('tfLayerMarginBottom').value = layer.marginBottom || 0;
            if ($('tfLayerMarginLeft')) $('tfLayerMarginLeft').value = layer.marginLeft || 0;

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

            if ($('cbExifText')) $('cbExifText').checked = (decor.exifAutoText || 0) === 1;
            if ($('cbCornerDecor')) $('cbCornerDecor').checked = (decor.cornerDecorEnable || 0) === 1;
            if ($('cbCornerDecorType')) $('cbCornerDecorType').value = decor.cornerDecorType || 'line';
            if ($('slCornerDecorSize')) $('slCornerDecorSize').value = decor.cornerDecorSize || 30;
            this.updateLabel('lblCornerDecorSize', decor.cornerDecorSize || 30);

            this.refreshElList();
            this.syncLayerSelect();
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
        const lightTab = document.querySelector('#inspTabs [data-tab="light"]');
        if (lightTab) lightTab.style.display = showLight ? '' : 'none';
        if (!showLight) {
            const active = document.querySelector('.tab.active');
            if (active && active.getAttribute('data-tab') === 'light') {
                const firstVis = document.querySelector('#inspTabs .tab:not([style*="display: none"])');
                if (firstVis) firstVis.click();
            }
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
        const v = this.template.paramFontSize != null ? this.template.paramFontSize : 100;
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

    renderPreview() {
        if (!this.image) return;
        const token = ++this.renderToken;
        this.draggingCompare = false;
        requestAnimationFrame(() => {
            if (token !== this.renderToken) return;
            // 交互进行中(格内拖动/平移/拖元素/手势)不得用旧快照替换当前模板,否则会将正在编辑的
            // 拼图平移/缩放瞬时回退到保存前的状态
            if (this.image && this.image.customSettings && !this._dragPz && !this._dragEl && !this._pan && !this._gesture) this.template = this.image.customSettings;
            this.normalizeTemplate();
            this.dom.stage.classList.toggle('has-img', !!this.image);
            const puzzle = this.template && this.template.puzzle && this.template.puzzle.enabled;
            if (puzzle && window.__renderPuzzle) window.__renderPuzzle(this, false);
            else window.__render(this, false);
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
        if (!t.layerList || !t.layerList.length) t.layerList = [this.defaultTemplate().layerList[0]];
        if (!t.logoElements) t.logoElements = [];
        if (!t.puzzle) t.puzzle = this.defaultTemplate().puzzle;
        if (t.baseMargin.refTop == null) {
            t.baseMargin.refTop = t.baseMargin.marginTop != null ? t.baseMargin.marginTop : 80;
            t.baseMargin.refBottom = t.baseMargin.marginBottom != null ? t.baseMargin.marginBottom : 120;
            t.baseMargin.refLeft = t.baseMargin.marginLeft != null ? t.baseMargin.marginLeft : 80;
            t.baseMargin.refRight = t.baseMargin.marginRight != null ? t.baseMargin.marginRight : 80;
        }
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

    /* ══ 撤销 / 重做 ══ */
    // 无条件压栈(离散操作/手势开始调用);连续手势的快照由 beginGesture 去重
    pushUndo() {
        this.undoStack.push(this.cloneTemplate());
        if (this.undoStack.length > 60) this.undoStack.shift();
        this.redoStack = [];
        this.updateHistoryButtons();
    },

    undo() {
        if (!this.undoStack.length) { this.setStatus('没有可撤销的操作'); return; }
        this.redoStack.push(this.cloneTemplate());
        this.template = this.undoStack.pop();
        this.normalizeTemplate();
        this.selectedEls = [];
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus('已撤销');
    },

    redo() {
        if (!this.redoStack.length) { this.setStatus('没有可重做的操作'); return; }
        this.undoStack.push(this.cloneTemplate());
        this.template = this.redoStack.pop();
        this.normalizeTemplate();
        this.selectedEls = [];
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus('已重做');
    },

    updateHistoryButtons() {
        if (!this.dom.btnUndo) return;
        this.dom.btnUndo.disabled = !this.undoStack.length;
        this.dom.btnRedo.disabled = !this.redoStack.length;
    },

    cloneTemplate() { return JSON.parse(JSON.stringify(this.template || null)); },

    saveCurrentTemplate() {
        if (!this.image) return;
        const snap = this.cloneTemplate();
        this.imageTemplates.set(this.image, snap);
        this.image.customSettings = snap;
        this.queueThumb(this.image);
    },

    /* ══ 图片选择 / 每图模板 ══ */
    afterImageSelect() {
        if (!this.image) return;
        this.dom.placeholder.style.display = 'none';
        this.dom.canvas.style.display = 'block';
        const saved = this.imageTemplates.get(this.image);
        if (saved) this.template = saved;
        else this.normalizeTemplate();
        this.selectedEls = [];
        this.updateStatusBar();
        this.refreshUI();
        this.autoFit = true;
        this.scheduleRender(true);
    },

    selectImage(idx) {
        this.selectedIdx = [idx];
        this.currentIdx = idx;
        this.image = this.images[idx];
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
                if (!loadedOk || !img.naturalWidth) { tick(images[i].name); return null; }
                const rawExif = (r.buffer && window.__parseExif) ? window.__parseExif(r.buffer) : {};
                const exif = window.__exifSummary ? window.__exifSummary(rawExif) : {};
                const oriented = await this.applyOrientation(img, exif.orientation);
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
        const url = await new Promise(res => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.onerror = () => res(null);
            r.readAsDataURL(file);
        });
        if (!url) return null;
        const buf = await new Promise(res => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.onerror = () => res(null);
            r.readAsArrayBuffer(file);
        });
        return { url, buffer: buf };
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

    // 把系统选择框返回的单个文件构造成胶片条照片对象(不插入)
    async imageFromPick(res) {
        if (!res) return null;
        const img = new Image();
        const dataUrl = 'data:image/jpeg;base64,' + res.data;
        await new Promise(r => { img.onload = r; img.onerror = r; img.src = dataUrl; });
        if (!img.naturalWidth) return null;
        let exif = {};
        if (window.__parseExif) {
            try {
                const bin = atob(res.data);
                const buf = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
                const raw = window.__parseExif(buf.buffer);
                exif = window.__exifSummary ? window.__exifSummary(raw) : {};
            } catch (e) { /* EXIF 解析失败不影响加载 */ }
        }
        const oriented = await this.applyOrientation(img, exif.orientation);
        const useEl = oriented ? oriented.el : img;
        const w = oriented ? oriented.w : img.naturalWidth;
        const h = oriented ? oriented.h : img.naturalHeight;
        const im = { el: useEl, name: res.name, w, h, exif, customSettings: null };
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
            const cls = ['thumb'];
            if (isSel) cls.push('active');
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
            strip.appendChild(wrap);
        });
        strip.style.display = this.images.length > 1 ? 'flex' : 'none';
    },

    // 把当前主图的边框模板复制给指定缩略图(每图边框独立,同步后该图也恢复此边框)
    syncBorderTo(i) {
        const tgt = this.images[i];
        if (!tgt || !this.image) return;
        this.imageTemplates.set(tgt, this.cloneTemplate());
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
        ['cbTextFont', 'cbCapFont1', 'cbCapFont2'].forEach(id => {
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
            'slParamFontSize', 'slFillOpacity', 'slGradientAngle', 'slTextureScale', 'slStrokeWidth', 'slStrokeOpacity',
            'slShadowX', 'slShadowY', 'slShadowBlur', 'slShadowSpread', 'slShadowOpacity', 'slGlowBlur', 'slGlowOpacity',
            'slTearStrength', 'slTearDensity', 'slVignetteStrength', 'slVignetteFeather', 'slLeakOpacity', 'slLeakAngle',
            'slCornerDecorSize', 'slTextSize', 'slActiveIconOpacity', 'slElementRotation', 'slPuzzleGap',
            'slCapSize1', 'slCapSize2', 'slCapSpacing', 'slSlotOffsetX', 'slSlotOffsetY', 'slSlotZoom',
            'slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR', 'slLayerCornerRadius',
        ]);
        const onEdit = ['slGlobalMargin', 'slImgScale', 'slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR', 'slCornerRadius', 'slParamFontSize',
            'slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR', 'slLayerCornerRadius'];
        (onEdit).forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('input', () => this.onSliderCustom(id, parseInt(el.value, 10)));
        });

        // 复选框 -> onSettingCommit
        const chks = ['cbCornerLock', 'cbLayerVisible', 'cbShadow', 'cbGlow', 'cbTearEnable',
            'cbVignette', 'cbLightLeak', 'cbExifText', 'cbCornerDecor', 'cbCapBgBar', 'cbLayerCornerLock'];
        chks.forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('change', () => this.onSettingCommit());
        });
        // 光照页签复制的阴影/发光已移除,统一收敛到「边框」页签

        // select 变更 -> commit
        const sels = ['cbCanvasRatio', 'cbParamPosition', 'cbParamType', 'cbFillType', 'cbGradientType', 'cbTextureBlend',
            'cbStrokePos', 'cbLeakType', 'cbCornerDecorType', 'cbTextFont', 'cbLayerSelect', 'cbPuzzleBg', 'cbPuzzleCanvas',
            'cbSlotFill', 'cbCapFont1', 'cbCapFont2', 'cbRecipeFilter'];
        sels.forEach(id => {
            const el = $(id);
            if (el) el.addEventListener('change', () => this.onSelectCustom(id));
        });

        // 数字/文本输入:input 即时同步(防抖),change 提交
        const nums = ['tfImgOffsetX', 'tfImgOffsetY',
            'tfLayerMarginTop', 'tfLayerMarginRight', 'tfLayerMarginBottom', 'tfLayerMarginLeft'];
        nums.forEach(id => {
            const el = $(id);
            if (!el) return;
            el.addEventListener('focus', () => this.beginGesture());
            el.addEventListener('blur', () => this.endGesture());
            el.addEventListener('input', () => this.onSettingChanged());
            el.addEventListener('change', () => this.onSettingCommit());
        });
        const texts = ['tfExifBrand', 'tfExifModel', 'tfExifFocal', 'tfExifAperture', 'tfExifIso', 'tfExifShutter',
            'tfStrokeDash', 'tfCustomText', 'tfTemplateName', 'tfTemplateTag', 'tfCapLine1', 'tfCapLine2'];
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
        bindBtn('btnAddLayer', () => this.addLayer());
        bindBtn('btnRemoveLayer', () => this.removeLayer());
        bindBtn('btnResetLayer', () => this.resetLayer());
        bindBtn('btnBuiltinTexture', () => this.pickBuiltinTexture());
        bindBtn('btnSelectTexture', () => this.pickTexture());
        bindBtn('btnAddTextLine', () => this.addTextLine());
        bindBtn('btnDeleteSelectedTextLine', () => this.deleteSelectedTextLine());
        bindBtn('btnAddSticker', () => this.addSticker());
        bindBtn('btnAddCustomIcon', () => this.addCustomIcon());
        bindBtn('btnCopySelectedElement', () => this.copyElement());
        bindBtn('btnPasteClipboardElement', () => this.pasteElement());
        bindBtn('btnDeleteActiveIcon', () => this.deleteElement());
        bindBtn('btnClearAllIcons', () => this.clearElements());
        bindBtn('btnZOrderTop', () => this.moveZOrder(2));
        bindBtn('btnZOrderBottom', () => this.moveZOrder(-2));
        bindBtn('btnZOrderUp', () => this.moveZOrder(1));
        bindBtn('btnZOrderDown', () => this.moveZOrder(-1));
        bindBtn('btnSaveTemplate', () => this.saveTemplate());
        bindBtn('btnLoadTemplate', () => this.loadTemplate());
        bindBtn('btnExportTemplate', () => this.exportTemplate());
        bindBtn('btnImportTemplate', () => this.importTemplate());
        bindBtn('btnQuickFilm', () => this.applyQuickPreset('film'));
        bindBtn('btnQuickIdCard', () => this.applyQuickPreset('idcard'));
        bindBtn('btnAutoColorBorder', () => this.autoColorBorder());
        bindBtn('btnOpenMarket', () => this.setStatus('云市场：WEB 版未接入(可导出/导入 .qfs)'));
        bindBtn('btnLoadPreset', () => this.loadPresetFromList());
        bindBtn('btnEditGapCaption', () => this.addEditGapCaption());
        bindBtn('btnDeleteGapCaption', () => this.deleteCaption());
        bindBtn('btnClearCapSlot', () => this.clearCaption());
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
                const main = this.$(id === 'slCornerTL' ? 'lblCornerTL' : id === 'slCornerTR' ? 'lblCornerTR' : id === 'slCornerBL' ? 'lblCornerBL' : 'lblCornerBR');
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

    onSelectCustom(id) {
        switch (id) {
            case 'cbLayerSelect':
                this.selectedLayer = parseInt(this.$('cbLayerSelect').value, 10) || 0;
                this.refreshUI();
                break;
            case 'cbTextFont': this._draftPending = true; this.previewDraftText(); break;
            default: break;
        }
        this.onSettingCommit();
    },

    onTextCustom(id) {
        switch (id) {
            case 'tfCustomText': case 'cbTextFont': this.previewDraftText(); break;
            default: this.onSettingChanged(); break;
        }
    },

    previewDraftText() {
        if (!this.template) return;
        const $ = this.$;
        const t = this.$('tfCustomText') ? this.$('tfCustomText').value : '';
        if (!t) { this._draftPending = false; this.onSettingChanged(); return; }
        const fs = this.$('slTextSize') ? parseInt(this.$('slTextSize').value, 10) : 18;
        this.template._draftText = {
            text: t, align: 'live', fontSize: fs,
            colorHex: (this.$('cpTextColor') ? this.$('cpTextColor').value.replace('#', '') : '000000'),
            opacity: 85, fontFamily: this.$('cbTextFont') ? this.$('cbTextFont').value : 'Microsoft YaHei', fontWeight: 400,
        };
        // 写回滑块同步
        if (this.$('slTextSize')) {
            // 实时预览字号走草稿
        }
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
            slLeakOpacity: ['lblLeakOpacity', v + '%'], slLeakAngle: ['lblLeakAngle', v + '°'],
            slCornerDecorSize: ['lblCornerDecorSize', v], slTextSize: ['lblTextSize', v],
            slPuzzleGap: ['lblPuzzleGap', v], slCapSize1: ['lblCapSize1', v], slCapSize2: ['lblCapSize2', v],
            slCapSpacing: ['lblCapSpacing', v + '%'], slSlotOffsetX: ['lblSlotOffsetX', v], slSlotOffsetY: ['lblSlotOffsetY', v],
            slSlotZoom: ['lblSlotZoom', v + '%'],
        };
        const entry = map[id];
        if (entry) this.updateLabel(entry[0], entry[1]);
    },

    onSliderLive(id, v) {
        if (['slGlobalMargin', 'slImgScale', 'slCornerTL', 'slCornerTR', 'slCornerBL', 'slCornerBR', 'slCornerRadius', 'slParamFontSize',
            'slLayerCornerTL', 'slLayerCornerTR', 'slLayerCornerBL', 'slLayerCornerBR', 'slLayerCornerRadius'].includes(id)) return; // 由 onSliderCustom 处理
        if (id === 'slTextSize') { this.previewDraftText(); return; }
        if (id === 'slPuzzleGap' || id === 'slCapSize1' || id === 'slCapSize2' || id === 'slCapSpacing' || id === 'slSlotOffsetX' || id === 'slSlotOffsetY' || id === 'slSlotZoom') {
            this.syncPuzzleFromUI(); this.onSettingChanged(); return;
        }
        this.onSettingChanged();
    },

    /* ══ 图层管理 ══ */
    addLayer() {
        this.onSettingCommit();
        const def = this.defaultTemplate().layerList[0];
        const layer = JSON.parse(JSON.stringify(def));
        layer.fillConfig.fillHex = 'eeeeee';
        this.template.layerList.unshift(layer);
        this.selectedLayer = 0;
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus('已添加图层');
    },

    removeLayer() {
        if (!this.template.layerList || this.template.layerList.length <= 1) { this.setStatus('至少保留一个图层'); return; }
        this.onSettingCommit();
        const i = clampNum(this.selectedLayer || 0, 0, this.template.layerList.length - 1);
        this.template.layerList.splice(i, 1);
        this.selectedLayer = Math.min(i, this.template.layerList.length - 1);
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus('已删除图层');
    },

    resetLayer() {
        this.onSettingCommit();
        const layer = this.currentLayer();
        const def = this.defaultTemplate().layerList[0];
        layer.fillConfig = JSON.parse(JSON.stringify(def.fillConfig));
        layer.strokeConfig = JSON.parse(JSON.stringify(def.strokeConfig));
        layer.shadowGlowConfig = JSON.parse(JSON.stringify(def.shadowGlowConfig));
        layer.cornerConfig = JSON.parse(JSON.stringify(def.cornerConfig));
        layer.marginTop = 0; layer.marginRight = 0; layer.marginBottom = 0; layer.marginLeft = 0;
        layer.visible = 1;
        this.refreshUI();
        this.scheduleRender(true);
    },

    syncLayerSelect() {
        const $ = this.$;
        const sel = $('cbLayerSelect');
        if (!sel || !this.template || !this.template.layerList) return;
        const n = this.template.layerList.length;
        sel.innerHTML = '';
        for (let i = 0; i < n; i++) {
            const o = document.createElement('option');
            o.value = i;
            o.textContent = `图层 ${n - i}${!this.template.layerList[i].visible ? ' (隐藏)' : ''}`;
            if (i === (this.selectedLayer || 0)) o.selected = true;
            sel.appendChild(o);
        }
    },

    /* ══ 纹理 ══ */
    pickBuiltinTexture() {
        const builtin = ['denim', 'frost', 'grain', 'kraft', 'leather', 'linen', 'metal', 'paper', 'watercolor', 'wood'];
        const opts = builtin.map(n => `${n} 内置`).join('\n');
        const choice = window.prompt('选择内置纹理:\n' + opts + '\n(输入名称,留空取消)', 'denim');
        if (!choice) return;
        const name = choice.trim().split(' ')[0];
        this.setLayerTexture(name);
    },

    pickTexture() {
        if (!this.textures.length) { this.setStatus('纹理库未加载'); return; }
        const opts = this.textures.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
        const choice = window.prompt('选择纹理(输入序号或名称,留空取消):\n' + opts, '1');
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

    /* ══ 文字 / 贴纸 ══ */
    addTextLine() {
        const $ = this.$;
        const text = $('tfCustomText') ? $('tfCustomText').value.trim() : '';
        if (!text) { this.setStatus('请先输入文字内容'); return; }
        this.onSettingCommit();
        const decor = this.template.decorConfig || (this.template.decorConfig = {});
        if (!decor.textLines) decor.textLines = [];
        const cw = this.dom.canvas.width, ch = this.dom.canvas.height;
        const line = {
            text, align: 'free', x: cw / 2, y: ch / 2,
            fontSize: $('slTextSize') ? parseInt($('slTextSize').value, 10) : 24,
            colorHex: ($('cpTextColor') ? $('cpTextColor').value : '#000000').replace('#', ''),
            opacity: 100, rotation: 0,
            fontFamily: $('cbTextFont') ? $('cbTextFont').value : 'Microsoft YaHei', fontWeight: 400,
        };
        decor.textLines.push(line);
        this.selectedEls = [{ kind: 'text', obj: line }];
        this._draftPending = false;
        if ($('tfCustomText')) $('tfCustomText').value = '';
        delete this.template._draftText;
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus('已添加文字(拖拽移动,滚轮缩放, Ctrl+滚轮旋转)');
    },

    deleteSelectedTextLine() {
        const selected = this.selectedEls.filter(x => x.kind === 'text');
        if (!selected.length) { this.setStatus('请先在画布选中文字'); return; }
        this.onSettingCommit();
        const decor = this.template.decorConfig || {};
        const lines = decor.textLines || [];
        selected.forEach(s => { const i = lines.indexOf(s.obj); if (i >= 0) lines.splice(i, 1); });
        this.selectedEls = [];
        this.refreshUI();
        this.scheduleRender(true);
    },

    async addSticker() {
        const res = await window.qingframe.openImage();
        if (!res || !res.data) { this.setStatus('已取消添加贴纸'); return; }
        const dataUrl = 'data:image/jpeg;base64,' + res.data;
        // 预加载到缓存,避免后续每次渲染重新解码(保持真实 JPEG MIME,不伪造 PNG 头)
        await new Promise(r => { const im = new Image(); im.onload = r; im.onerror = r; im.src = dataUrl; });
        if (!this.logoImgCache) this.logoImgCache = {};
        this.logoImgCache[dataUrl] = new Image();
        await new Promise(r => { this.logoImgCache[dataUrl].onload = r; this.logoImgCache[dataUrl].onerror = r; this.logoImgCache[dataUrl].src = dataUrl; });
        this.onSettingCommit();
        const decor = this.template.decorConfig || (this.template.decorConfig = {});
        if (!decor.stickers) decor.stickers = [];
        const cw = this.dom.canvas.width, ch = this.dom.canvas.height;
        const w = this.image.w || 1000;
        const scale = clampNum((cw * 0.25) / Math.max(1, Math.max(w, 1000)), 0.02, 3);
        decor.stickers.push({
            src: dataUrl,
            x: cw / 2, y: ch / 2, scale, rotation: 0, opacity: 100, z: 20,
        });
        this.selectedEls = [{ kind: 'sticker', obj: decor.stickers[decor.stickers.length - 1] }];
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus('已添加贴纸(拖拽移动,滚轮缩放, Ctrl+滚轮旋转)');
    },

    /* ══ Logo 页签 ══ */
    renderLogoPools() {
        const $ = this.$;
        const pools = ['brandIconBox', 'photoDecorBox', 'simpleIconBox', 'weatherIconBox', 'customIconBox'];
        // 简单分类:前四类按名称关键字,自定义留空待用户添加
        const cats = { brandIconBox: [], photoDecorBox: [], simpleIconBox: [], weatherIconBox: [], customIconBox: [] };
        this.logos.forEach(l => {
            const n = l.name || '';
            if (/brand|logo|品牌/i.test(n)) cats.brandIconBox.push(l);
            else if (/weather|天/i.test(n)) cats.weatherIconBox.push(l);
            else if (/deco|decor|装饰|花/i.test(n)) cats.photoDecorBox.push(l);
            else cats.simpleIconBox.push(l);
        });
        pools.forEach((boxId, pi) => {
            const box = $(boxId);
            if (!box) return;
            box.innerHTML = '';
            const list = pi === 4 ? [] : cats[boxId];
            if (!list.length) {
                const e = document.createElement('div');
                e.className = 'icon-cell empty';
                e.textContent = pi === 4 ? '点击下方添加' : '无';
                box.appendChild(e);
                return;
            }
            list.forEach(l => {
                const c = document.createElement('div');
                c.className = 'icon-cell';
                c.title = l.name;
                const img = document.createElement('img');
                img.src = l.dataUrl;
                c.appendChild(img);
                c.addEventListener('click', () => this.addLogoElement(l));
                box.appendChild(c);
            });
            const cnt = this.$({ brandIconBox: 'brandCnt', photoDecorBox: 'photoDecorCnt', simpleIconBox: 'simpleIconCnt', weatherIconBox: 'weatherIconCnt', customIconBox: 'customIconCnt' }[boxId]);
            if (cnt) cnt.textContent = `(${list.length})`;
        });
    },

    addLogoElement(logo) {
        if (!logo) return;
        this.onSettingCommit();
        if (!this.template) return;
        if (!this.template.logoElements) this.template.logoElements = [];
        const cw = this.dom.canvas.width, ch = this.dom.canvas.height;
        const el = {
            name: logo.name, dataUrl: logo.dataUrl, img: null,
            x: cw - 40, y: ch - 40, size: 60, opacity: 100, rotation: 0, z: 10, free: 1,
        };
        this.template.logoElements.push(el);
        this.selectedEls = [{ kind: 'logo', obj: el }];
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus(`已添加 Logo「${logo.name}」`);
    },

    async addCustomIcon() {
        const res = await window.qingframe.openImage();
        if (!res || !res.data) return;
        const dataUrl = 'data:image/jpeg;base64,' + res.data;
        const im = new Image();
        await new Promise(r => { im.onload = r; im.onerror = r; im.src = dataUrl; });
        if (!im.naturalWidth) { this.setStatus('图片加载失败'); return; }
        const logo = { name: res.name || '自定义', dataUrl };
        this.logos.push(logo);
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
            r.addEventListener('click', () => {
                const cur = this.selectedEls.some(x => x.kind === it.kind && x.obj === it.obj);
                if (cur) this.selectedEls = this.selectedEls.filter(x => !(x.kind === it.kind && x.obj === it.obj));
                else this.selectedEls = [{ kind: it.kind, obj: it.obj }];
                this.refreshElList();
            });
            list.appendChild(r);
        });
        const first = this.selectedEls.length ? this.selectedEls[0] : null;
        status.textContent = first ? `${tagMap[first.kind]}「${this.elLabel(first.obj)}」已选中` : `共 ${items.length} 个元素,点击选择`;
        if (first) this.syncSliderFromEl({ kind: first.kind, obj: first.obj });
    },

    elLabel(el) {
        if (!el) return '';
        return el.name || el.text || '元素';
    },

    applyToSelectedEls(fn) {
        this.selectedEls.forEach(s => fn(s.obj));
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
                const n = els.length;
                els[i].z = (els[i].z || 0) + delta;
                // 通过 z 排序实现层级:直接赋序
                els[i].z = clampNum(els[i].z, -100, 100);
            });
            // 依据 z 排序后按新序重排数组(等效 Java 中 moveZOrder 1/-1/2/-2)
            els.sort((a, b) => (a.z || 0) - (b.z || 0));
        });
        this.refreshUI();
        this.scheduleRender(true);
    },

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
        const name = (this.$('tfTemplateName') ? this.$('tfTemplateName').value : '').trim() || 'template';
        this.syncModelFromUI();
        const r = await window.qingframe.exportTemplate(name, this.cloneTemplate());
        this.setStatus(r.ok ? '模板已导出' : (r.canceled ? '已取消' : '导出失败'));
    },

    async importTemplate() {
        const r = await window.qingframe.importTemplate();
        if (!r.ok) { this.setStatus(r.canceled ? '已取消' : '导入失败：' + (r.error || '')); return; }
        this.onSettingCommit();
        this.template = JSON.parse(JSON.stringify(r.data));
        this.normalizeTemplate();
        this.saveCurrentTemplate();
        this.refreshUI();
        this.scheduleRender(true);
        this.setStatus(`已导入模板「${r.name}」`);
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

    /* ══ 拼图页签 ══ */
    puzzleLayouts() {
        return [
            ['single', '单张'], ['h2', '2·左右'], ['v2', '2·上下'], ['as2', '一大一小'],
            ['h3', '3·横排'], ['v3', '3·竖排'], ['grid4', '4·宫格'], ['as4', '1大3小'],
            ['h4', '4·横排'], ['v4', '4·竖排'], ['grid6', '6·宫格'], ['grid9', '9·宫格'],
        ];
    },

    layoutTypeOf(layout) {
        const map = { single: 0, h2: 1, v2: 2, as2: 3, h3: 4, v3: 5, grid4: 6, as4: 7, h4: 8, v4: 9, grid6: 10, grid9: 11 };
        return map[layout] != null ? map[layout] : 0;
    },

    layoutKeyOf(type) {
        const keys = ['single', 'h2', 'v2', 'as2', 'h3', 'v3', 'grid4', 'as4', 'h4', 'v4', 'grid6', 'grid9'];
        return (type >= 0 && type < keys.length) ? keys[type] : 'single';
    },

    buildPuzzleLayoutBtns() {
        const box = this.$('puzzleLayouts');
        if (!box) return;
        box.innerHTML = '';
        this.puzzleLayouts().forEach(([val, label]) => {
            const b = document.createElement('button');
            b.className = 'mini-btn';
            b.textContent = label;
            b.dataset.val = val;
            b.addEventListener('click', () => {
                this.onSettingCommit();
                this.setPuzzleLayout(this.layoutTypeOf(val));
                this.setStatus(`已启用拼图布局「${label}」`);
            });
            box.appendChild(b);
        });
    },

    // 切换布局并尽量保留各照片槽位(imageIndex 不改)
    setPuzzleLayout(layoutType) {
        if (!this.template) return;
        const pk = this.template.puzzle || (this.template.puzzle = this.defaultTemplate().puzzle);
        const oldAxes = pk.axisVals;
        pk.layout = this.layoutKeyOf(layoutType);
        pk.layoutType = layoutType;
        pk.axisVals = oldAxes || {};
        pk.enabled = 1;
        this.migratePuzzle();
        this.ensurePuzzleSlotsCount(pk);
        this.reconcilePuzzleCaptions(pk);
        this.autoFillPuzzleSlots();
        this.saveCurrentTemplate();
        this.switchTab('puzzle');
        this.refreshPuzzleUI();
        this.scheduleRender(true);
    },

    // 批量放图:勾选照片按勾选顺序填各格,勾选不够用当前打开的主图补位;
    // 无勾选时只做布局几何更新(重算格子位置/大小),绝不改动已有格子内容
    // (图片 / 平移 / 缩放 / 双击替换全部保留),即使重复点击当前布局也不重填
    autoFillPuzzleSlots() {
        const pk = this.template && this.template.puzzle;
        if (!pk || !pk.enabled) return;
        const n = this.puzzleSlotCount(pk.layout || 'single');
        const main = this.image ? this.images.indexOf(this.image) : -1;
        if (!this.batchSel.length) return;
        // 按勾选顺序依次填格(不排序),不够用当前主图补位
        const order = this.batchSel.slice();
        for (let i = 0; i < n; i++) {
            const idx = i < order.length ? order[i] : main;
            const sc = pk.slots[i] || (pk.slots[i] = {});
            if (idx >= 0) { sc.imageIndex = idx; sc.imagePath = undefined; }
            else { sc.imageIndex = undefined; sc.imagePath = undefined; }
        }
        this.batchSel = [];
        // 勾选已被填格消费,随后“导出图片”应回到导出当前单张,而不是残留的多选
        this.selectedIdx = [];
    },

    // 兼容旧模型:补 layoutType/axisVals/gapCaptions,并把旧 slots 数组升级为 dict
    migratePuzzle() {
        const pk = this.template.puzzle;
        if (!pk) return;
        if (pk.layoutType == null) pk.layoutType = this.layoutTypeOf(pk.layout || 'single');
        if (!pk.slots) pk.slots = {};
        if (pk.axisVals == null) pk.axisVals = {};
        if (!pk.gapCaptions) pk.gapCaptions = {};
        if (Array.isArray(pk.slots)) {
            const arr = pk.slots;
            pk.slots = {};
            arr.forEach((sc, i) => { if (sc) pk.slots[i] = sc; });
        }
    },

    // 确保每个槽位有配置对象
    ensurePuzzleSlotsCount(pk) {
        const n = this.puzzleSlotCount(pk.layout || 'single');
        this.migratePuzzle();
        for (let i = 0; i < n; i++) {
            if (!pk.slots[i]) pk.slots[i] = { fillMode: pk.slotFill || 'cover', zoom: pk.zoom || 100, offsetX: 0, offsetY: 0 };
        }
    },

    // 布局切换巡检字幕:绑定的分割轴在新布局不存在的间隙字幕直接删;格子字幕仅在下标越界时删
    reconcilePuzzleCaptions(pk) {
        if (!pk) return;
        const n = this.puzzleSlotCount(pk.layout || 'single');
        if (pk.captions) {
            for (const k in pk.captions) {
                const idx = parseInt(k, 10);
                if (!isNaN(idx) && idx >= n) delete pk.captions[k];
            }
        }
        const axes = window.__clampPuzzleAxes ? window.__clampPuzzleAxes(pk.layout || 'single', pk.axisVals) : { v: [], h: [] };
        if (pk.gapCaptions) {
            for (const key in pk.gapCaptions) {
                const m = /^([vh])(\d+)$/.exec(key);
                if (!m) continue;
                // h 字幕按行计数(行数 = 横轴数 + 1,含底部字幕带);v 字幕按竖轴计数
                const maxN = m[1] === 'h' ? ((axes.h || []).length + 1) : (axes.v || []).length;
                if (parseInt(m[2], 10) >= maxN) delete pk.gapCaptions[key];
            }
        }
    },

    puzzleSlotCount(layout) {
        const n = { single: 1, as2: 2, h2: 2, v2: 2, h3: 3, v3: 3, as4: 4, grid4: 4, h4: 4, v4: 4, grid6: 6, grid9: 9 };
        return n[layout] || 1;
    },

    syncPuzzleFromUI() {
        if (!this.template) return;
        const pk = this.template.puzzle || (this.template.puzzle = this.defaultTemplate().puzzle);
        const $ = this.$;
        pk.gap = $('slPuzzleGap') ? parseInt($('slPuzzleGap').value, 10) : pk.gap;
        pk.bgMode = $('cbPuzzleBg') ? parseInt($('cbPuzzleBg').value, 10) : 0;
        pk.canvasRatio = $('cbPuzzleCanvas') ? $('cbPuzzleCanvas').value : 'auto';
        pk.borderColor = $('cpPuzzleBorder') ? $('cpPuzzleBorder').value.replace('#', '') : 'ffffff';
        pk.slotFill = $('cbSlotFill') ? $('cbSlotFill').value : 'cover';
        this.ensurePuzzleSlotsCount(pk);
        // 选中槽位 per-slot 写回(整体偏移/缩放滑块 = 该槽配置)
        if (typeof this._puzzleSlot === 'string' && this._puzzleSlot.charAt(0) === 's') {
            const si = parseInt(this._puzzleSlot.substring(1), 10);
            const sc = pk.slots[si] || (pk.slots[si] = {});
            sc.offsetX = $('slSlotOffsetX') ? parseInt($('slSlotOffsetX').value, 10) : (sc.offsetX || 0);
            sc.offsetY = $('slSlotOffsetY') ? parseInt($('slSlotOffsetY').value, 10) : (sc.offsetY || 0);
            sc.zoom = $('slSlotZoom') ? parseInt($('slSlotZoom').value, 10) : (sc.zoom != null ? sc.zoom : 100);
            sc.fillMode = pk.slotFill || 'cover';
        }
        // 间隙字幕捕获(v/h 键)
        if (!this._skipPuzzleCapture && this._puzzleSlot != null) this.captureCaptionToModel(this._puzzleSlot);
    },

    // 槽位/间隙下拉改变:先把当前编辑字幕写回旧项,再提交/加载新项
    onPuzzleSlotChange() {
        const $ = this.$;
        if (this._puzzleSlot != null) this.captureCaptionToModel(this._puzzleSlot);
        this._skipPuzzleCapture = true;
        try {
            this.onSettingCommit();
        } finally {
            this._skipPuzzleCapture = false;
        }
        if ($('cbPuzzleGapPick')) this._puzzleSlot = $('cbPuzzleGapPick').value;
        if (this._puzzleSlot === '') this._activePuzzleSlot = null;
        if (/^s\d+$/.test(this._puzzleSlot)) {
            const si = parseInt(this._puzzleSlot.substring(1), 10);
            if (this._activePuzzleSlot !== si) { this._activePuzzleSlot = si; this.scheduleRender(); }
        }
        this.loadCaptionFromModel();
        this.renderCaptionEditorVisibility();
    },

    refreshPuzzleUI() {
        if (!this.template) return;
        const pk = this.template.puzzle || (this.template.puzzle = this.defaultTemplate().puzzle);
        this.ensurePuzzleSlotsCount(pk);
        this.reconcilePuzzleCaptions(pk);
        // 「重拼(按序填满)」:拼图内存在图片内容时可用,拼图为空时置灰
        const rep = this.$('btnPuzzleRepuzzle');
        if (rep) {
            const hasContent = pk.slots && Object.keys(pk.slots).some(k => {
                const sc = pk.slots[k];
                return sc && (sc.imageIndex != null || sc.imagePath != null);
            });
            rep.disabled = !hasContent;
        }
        const $ = this.$;
        const n = this.puzzleSlotCount(pk.layout);
        if ($('slPuzzleGap')) $('slPuzzleGap').value = pk.gap != null ? pk.gap : 6;
        this.updateLabel('lblPuzzleGap', pk.gap != null ? pk.gap : 6);
        if ($('cbPuzzleBg')) $('cbPuzzleBg').value = String(pk.bgMode || 0);
        if ($('cbPuzzleCanvas')) $('cbPuzzleCanvas').value = pk.canvasRatio || 'auto';
        if ($('cpPuzzleBorder')) $('cpPuzzleBorder').value = '#' + (pk.borderColor || 'ffffff');
        if ($('cbSlotFill')) $('cbSlotFill').value = pk.slotFill || 'cover';
        // 字幕门牌下拉:列出全部分割间隙与全部格子;已绑定字幕的项带圆点标记
        const pick = $('cbPuzzleGapPick');
        if (pick) {
            pick.innerHTML = '';
            const noneOpt = document.createElement('option');
            noneOpt.value = '';
            noneOpt.textContent = '不选中（点格子选中/点空白取消）';
            pick.appendChild(noneOpt);
            const mark = (bound) => bound ? '● ' : '';
            for (let i = 0; i < n; i++) {
                const o = document.createElement('option');
                o.value = 's' + i;
                o.textContent = mark(!!(pk.captions && pk.captions[i])) + `格子 ${i + 1}`;
                pick.appendChild(o);
            }
            const axes = window.__clampPuzzleAxes ? window.__clampPuzzleAxes(pk.layout || 'single', pk.axisVals) : { v: [], h: [] };
            const vAxes = axes.v || [], hAxes = axes.h || [];
            // 横间隙:每行图片下方一条全宽字幕带(行数 = 横轴数 + 1,最末一条为底部字幕带)
            const capRowN = hAxes.length + 1;
            for (let i = 0; i < capRowN; i++) {
                const o = document.createElement('option');
                o.value = 'h' + i;
                o.textContent = mark(!!(pk.gapCaptions && pk.gapCaptions['h' + i])) + `横间隙 ${i + 1}`;
                pick.appendChild(o);
            }
            vAxes.forEach((_, i) => {
                const o = document.createElement('option');
                o.value = 'v' + i;
                o.textContent = mark(!!(pk.gapCaptions && pk.gapCaptions['v' + i])) + `竖间隙 ${i + 1}`;
                pick.appendChild(o);
            });
            const isNone = this._puzzleSlot == null || this._puzzleSlot === '';
            if (isNone) {
                pick.value = '';
            } else if (typeof this._puzzleSlot === 'string' && pick.querySelector('option[value="' + this._puzzleSlot + '"]')) {
                pick.value = this._puzzleSlot;
            } else { this._puzzleSlot = 's0'; if (pick.querySelector('option[value="s0"]')) pick.value = 's0'; }
            // 活跃槽位范围 + per-slot 滑块回读(未选中时跳过,避免自动回到槽位 0)
            if (!isNone) {
                if (this._activePuzzleSlot == null || this._activePuzzleSlot < 0 || this._activePuzzleSlot >= n) this._activePuzzleSlot = 0;
                const sc = pk.slots[this._activePuzzleSlot] || {};
                this.setSlotOffsetSliders(sc);
                if ($('slSlotZoom')) $('slSlotZoom').value = sc.zoom != null ? sc.zoom : 100;
                this.updateLabel('lblSlotZoom', (sc.zoom != null ? sc.zoom : 100) + '%');
            }
            const lbl = $('lblPuzzleSlot');
            if (lbl) {
                if (!pk.enabled) lbl.textContent = '当前槽位：无（未启用）';
                else if (isNone) lbl.textContent = `当前槽位:未选中 (布局 ${pk.layout})`;
                else {
                    const ai = this._activePuzzleSlot != null ? this._activePuzzleSlot : 0;
                    const nm = this.slotImageName(ai);
                    lbl.textContent = `当前槽位:${ai + 1}/${n}${nm ? ` · ${nm}` : '（空）'} (布局 ${pk.layout})`;
                    lbl.title = nm || '';
                }
            }
        }
        this.loadCaptionFromModel();
        this.renderCaptionEditorVisibility();
    },

    // 将槽位偏移同步到滑块 + 标签(拖动/回读共用;松手 commit 从滑块回写,需先同步防止被旧值覆盖)
    setSlotOffsetSliders(sc) {
        const $ = this.$;
        if ($('slSlotOffsetX')) $('slSlotOffsetX').value = clampNum((sc && sc.offsetX) || 0, -100, 100);
        if ($('slSlotOffsetY')) $('slSlotOffsetY').value = clampNum((sc && sc.offsetY) || 0, -100, 100);
        this.updateLabel('lblSlotOffsetX', (sc && sc.offsetX) || 0);
        this.updateLabel('lblSlotOffsetY', (sc && sc.offsetY) || 0);
    },

    loadCaptionFromModel() {
        const $ = this.$;
        const pk = this.template.puzzle || {};
        const key = $('cbPuzzleGapPick') ? $('cbPuzzleGapPick').value : 's0';
        const isGap = /^[vh]\d+$/.test(key);
        let cap = null;
        if (isGap) cap = (pk.gapCaptions && pk.gapCaptions[key]) || null;
        else if (key) { const idx = parseInt(key.substring(1), 10); cap = (pk.captions && pk.captions[idx]) || null; }
        // 记录正在编辑的门牌号(与选中的项绑定)
        this._editingGap = key ? key.toUpperCase() : null;
        const lblEdit = $('lblEditingCap');
        if (lblEdit) {
            const nLabel = isGap ? (key.charAt(0) === 'h' ? '横间隙 ' : '竖间隙 ') : (/^s\d+$/.test(key) ? '格子 ' : '');
            lblEdit.textContent = this._editingGap ? `正在编辑：${nLabel}${this._editingGap}${cap ? '' : '（未绑定，输入即新建）'}` : '';
        }
        const cbV = $('cbCapVertical');
        if (cbV) { cbV.disabled = !isGap; cbV.checked = !!(isGap && cap && cap.direction === 'vertical'); }
        const set = (id, v) => { const e = $(id); if (e) e.value = v == null ? '' : v; };
        if (cap) {
            set('tfCapLine1', cap.line1); set('tfCapLine2', cap.line2);
            set('slCapSize1', cap.size1 || 28); set('slCapSize2', cap.size2 || 20);
            set('cbCapFont1', cap.font1 || 'Microsoft YaHei'); set('cbCapFont2', cap.font2 || 'Microsoft YaHei');
            if ($('cpCapColor')) $('cpCapColor').value = '#' + (cap.color || 'ffffff');
            if ($('cbCapBgBar')) $('cbCapBgBar').checked = (cap.bgBar || 0) === 1;
            set('slCapSpacing', cap.spacing != null ? cap.spacing : 0);
            this.updateLabel('lblCapSize1', cap.size1 || 28); this.updateLabel('lblCapSize2', cap.size2 || 20);
            this.updateLabel('lblCapSpacing', (cap.spacing != null ? cap.spacing : 0) + '%');
        } else {
            set('tfCapLine1', ''); set('tfCapLine2', '');
            set('slCapSize1', 28); set('slCapSize2', 20);
            set('cbCapFont1', 'Microsoft YaHei'); set('cbCapFont2', 'Microsoft YaHei');
            if ($('cpCapColor')) $('cpCapColor').value = '#ffffff';
            if ($('cbCapBgBar')) $('cbCapBgBar').checked = false;
            set('slCapSpacing', 0);
            this.updateLabel('lblCapSize1', 28); this.updateLabel('lblCapSize2', 20); this.updateLabel('lblCapSpacing', '0%');
        }
    },

    // 字幕写入:槽位键 's0'.. → captions[数字];间隙键 'v0'/'h0'.. → gapCaptions[key]
    captureCaptionToModel(key) {
        if (!this.template || key == null) return;
        const pk = this.template.puzzle || (this.template.puzzle = this.defaultTemplate().puzzle);
        const isGap = typeof key === 'string' && /^[vh]\d+$/.test(key);
        if (isGap) return this.captureGapCaptionToModel(key);
        const idx = typeof key === 'string' ? parseInt(key.substring(1), 10) : key;
        if (isNaN(idx)) return;
        if (!pk.captions) pk.captions = {};
        const $ = this.$;
        const line1 = $('tfCapLine1') ? $('tfCapLine1').value.trim() : '';
        const line2 = $('tfCapLine2') ? $('tfCapLine2').value.trim() : '';
        if (!line1 && !line2) { delete pk.captions[idx]; if (this._editingGap === ('S' + idx)) this._editingGap = null; return; }
        pk.captions[idx] = {
            line1, line2, gapId: 'S' + idx,
            size1: $('slCapSize1') ? parseInt($('slCapSize1').value, 10) : 28,
            size2: $('slCapSize2') ? parseInt($('slCapSize2').value, 10) : 20,
            font1: $('cbCapFont1') ? $('cbCapFont1').value : 'Microsoft YaHei',
            font2: $('cbCapFont2') ? $('cbCapFont2').value : 'Microsoft YaHei',
            color: ($('cpCapColor') ? $('cpCapColor').value : '#ffffff').replace('#', ''),
            bgBar: ($('cbCapBgBar') && $('cbCapBgBar').checked) ? 1 : 0,
            spacing: $('slCapSpacing') ? parseInt($('slCapSpacing').value, 10) : 0,
        };
    },

    captureGapCaptionToModel(key) {
        if (!this.template || key == null) return;
        const pk = this.template.puzzle || (this.template.puzzle = this.defaultTemplate().puzzle);
        if (!pk.gapCaptions) pk.gapCaptions = {};
        const $ = this.$;
        const line1 = $('tfCapLine1') ? $('tfCapLine1').value.trim() : '';
        const line2 = $('tfCapLine2') ? $('tfCapLine2').value.trim() : '';
        if (!line1 && !line2) { delete pk.gapCaptions[key]; if (this._editingGap === key.toUpperCase()) this._editingGap = null; return; }
        pk.gapCaptions[key] = {
            line1, line2, gapId: key.toUpperCase(),
            size1: $('slCapSize1') ? parseInt($('slCapSize1').value, 10) : 28,
            size2: $('slCapSize2') ? parseInt($('slCapSize2').value, 10) : 20,
            font1: $('cbCapFont1') ? $('cbCapFont1').value : 'Microsoft YaHei',
            font2: $('cbCapFont2') ? $('cbCapFont2').value : 'Microsoft YaHei',
            color: ($('cpCapColor') ? $('cpCapColor').value : '#ffffff').replace('#', ''),
            bgBar: ($('cbCapBgBar') && $('cbCapBgBar').checked) ? 1 : 0,
            spacing: $('slCapSpacing') ? parseInt($('slCapSpacing').value, 10) : 0,
            direction: ($('cbCapVertical') && $('cbCapVertical').checked) ? 'vertical' : 'horizontal',
        };
    },

    toggleCaptionEditor(show) {
        const editor = this.$('vbCaptionEditor');
        if (editor) editor.style.display = show ? 'block' : 'none';
    },

    renderCaptionEditorVisibility() {
        this.toggleCaptionEditor(this._editingGap != null);
    },

    // 「添加/编辑字幕」:按选中项的门牌号到字幕列表找对应,没有则新建一条并绑定,然后打开编辑
    addEditGapCaption() {
        const $ = this.$;
        const key = $('cbPuzzleGapPick') ? $('cbPuzzleGapPick').value : '';
        if (!key) { this.setStatus('请先在上方选择一条分割间隙或格子'); return; }
        const pk = this.template.puzzle || (this.template.puzzle = this.defaultTemplate().puzzle);
        const isGap = /^[vh]\d+$/.test(key);
        let cap = null;
        if (isGap) { if (!pk.gapCaptions) pk.gapCaptions = {}; cap = pk.gapCaptions[key]; if (!cap) cap = pk.gapCaptions[key] = { size1: 28, size2: 20, color: 'ffffff', bgBar: 0, spacing: 0, direction: 'horizontal' }; }
        else { if (!pk.captions) pk.captions = {}; const idx = parseInt(key.substring(1), 10); cap = pk.captions[idx]; if (!cap) cap = pk.captions[idx] = { size1: 28, size2: 20, color: 'ffffff', bgBar: 0, spacing: 0 }; }
        if (cap && !cap.gapId) cap.gapId = key.toUpperCase();
        this._editingGap = key.toUpperCase();
        this.loadCaptionFromModel();
        this.renderCaptionEditorVisibility();
        this.setStatus(`已绑定字幕到 ${this._editingGap}，编辑输入即时生效`);
    },

    deleteCaption() {
        const $ = this.$;
        const key = $('cbPuzzleGapPick') ? $('cbPuzzleGapPick').value : 's0';
        if (!key) { this.setStatus('请先在上方选择要删除的一条字幕'); return; }
        this.onSettingCommit();
        const pk = this.template.puzzle || {};
        if (/^[vh]\d+$/.test(key)) { if (pk.gapCaptions) delete pk.gapCaptions[key]; }
        else if (pk.captions) delete pk.captions[parseInt(key.substring(1), 10)];
        if (this._editingGap === key.toUpperCase()) this._editingGap = null;
        this.refreshPuzzleUI();
        this.scheduleRender(true);
        this.setStatus('已删除字幕 ' + key.toUpperCase());
    },

    clearCaption() {
        this.deleteCaption();
    },

    // 清空全部格子图片(保留布局/间距/缩放,便于重新放入)
    clearPuzzleSlots() {
        const pk = this.template && this.template.puzzle;
        if (!pk || Object.keys(pk.slots || {}).length === 0) { this.setStatus('格子已是空的'); return; }
        this.onSettingCommit();
        Object.keys(pk.slots).forEach(k => {
            const sc = pk.slots[k];
            if (sc) { sc.imageIndex = undefined; sc.imagePath = undefined; }
        });
        pk.offsetX = 0; pk.offsetY = 0; pk.zoom = 100;
        this.saveCurrentTemplate();
        this.refreshPuzzleUI();
        this.scheduleRender(true);
        this.setStatus('已清空全部格子图片，可重新勾选照片放图');
    },

    // 重拼:按胶片条中勾选的照片顺序填格(勾选不够用当前主图补位,无勾选用主图铺满),
    // 同时重置全部格子的平移/缩放,恢复默认填充状态。会覆盖用户所有手工编辑。
    rePuzzleFill() {
        const pk = this.template && this.template.puzzle;
        if (!pk || !pk.enabled) { this.setStatus('拼图未启用'); return; }
        this.onSettingCommit();
        this.ensurePuzzleSlotsCount(pk);
        const n = this.puzzleSlotCount(pk.layout || 'single');
        const main = this.image ? this.images.indexOf(this.image) : -1;
        const order = this.batchSel.slice();
        this.batchSel = [];
        this.selectedIdx = this.batchSel.slice();
        for (let i = 0; i < n; i++) {
            const idx = i < order.length ? order[i] : main;
            const sc = pk.slots[i] || (pk.slots[i] = {});
            if (idx >= 0) { sc.imageIndex = idx; sc.imagePath = undefined; }
            else { sc.imageIndex = undefined; sc.imagePath = undefined; }
            sc.zoom = 100;
            sc.offsetX = 0;
            sc.offsetY = 0;
        }
        this.saveCurrentTemplate();
        this.refreshPuzzleUI();
        this.buildThumbnails();
        this.scheduleRender(true);
        this.setStatus(order.length ? `已按勾选照片顺序重新拼接${n} 个格子，平移/缩放已重置` : '无勾选照片，已用当前主图铺满 ' + n + ' 个格子，平移/缩放已重置');
    },

    // 只清空指定格子的图片(照片仍保留在胶片条,可再放)
    clearSlotImage(i) {
        const pk = this.tplPuzzle();
        if (!pk) return;
        this.onSettingCommit();
        this.ensurePuzzleSlotsCount(pk);
        const sc = pk.slots[i];
        if (sc) { sc.imageIndex = undefined; sc.imagePath = undefined; }
        this.saveCurrentTemplate();
        this.refreshPuzzleUI();
        this.scheduleRender(true);
        this.setStatus('已清空槽位 ' + (i + 1) + '(照片仍保留在胶片条)');
    },

    // 完全退出拼图(回到单照片编辑)
    disablePuzzle() {
        if (!this.template || !this.template.puzzle) return;
        this.onSettingCommit();
        const pk = this.template.puzzle;
        pk.enabled = 0;
        this._puzzleSlot = 's0';
        this._activePuzzleSlot = null;
        this.saveCurrentTemplate();
        this.refreshPuzzleUI();
        this.toggleCaptionEditor(false);
        this.scheduleRender(true);
        this.setStatus('已退出拼图');
    },

    /* ══ 拼图画布交互(Canva/PicsArt 式:格内平移,拖出格=放下即互换) ══ */
    tplPuzzle() {
        const pk = this.template && this.template.puzzle;
        return (pk && pk.enabled) ? pk : null;
    },

    // 屏幕坐标→画布像素坐标(计入 CSS zoom 与 pan)
    puzzlePx(e) {
        const canvas = this.dom.canvas;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return { x: 0, y: 0 };
        return {
            x: (e.clientX - rect.left) / rect.width * canvas.width,
            y: (e.clientY - rect.top) / rect.height * canvas.height,
        };
    },

    // 命中:轴 / 槽位
    puzzleHitTest(e) {
        const pk = this.tplPuzzle();
        if (!pk || !window.__buildPuzzleSlots) return null;
        const p = this.puzzlePx(e);
        const hit = this.puzzleSlotAtPx(p.x, p.y);
        return hit != null ? { type: 'slot', slot: hit, x: p.x, y: p.y } : null;
    },

    // 画布像素→槽位索引(按引擎可见区域内缩 gap,间隙/边框处返回 null)
    puzzleSlotAtPx(x, y) {
        const pk = this.tplPuzzle();
        if (!pk || !window.__buildPuzzleSlots) return null;
        const W = this.dom.canvas.width, H = this.dom.canvas.height;
        const layout = pk.layout || 'single';
        const axes = window.__clampPuzzleAxes ? window.__clampPuzzleAxes(layout, pk.axisVals) : (pk.axisVals || {});
        const rects = window.__buildPuzzleSlots(layout, axes);
        const gapPx = Math.max(0, (pk.gap == null ? 6 : pk.gap) * (Math.min(W, H) / 1000) * 0.5);
        const shiftX = gapPx / W, shiftY = gapPx / H;
        const EPS = 1e-6;
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            let x0 = r[0], y0 = r[1], x1 = r[0] + r[2], y1 = r[1] + r[3];
            if (x0 <= EPS) x0 += shiftX;
            if (x1 >= 1 - EPS) x1 -= shiftX;
            if (y0 <= EPS) y0 += shiftY;
            if (y1 >= 1 - EPS) y1 -= shiftY;
            const hx0 = x0 * W + gapPx, hy0 = y0 * H + gapPx;
            const hx1 = x1 * W - gapPx, hy1 = y1 * H - gapPx;
            if (x >= hx0 && x <= hx1 && y >= hy0 && y <= hy1) return i;
        }
        return null;
    },

    puzzleSlotAt(e) {
        const p = this.puzzlePx(e);
        return this.puzzleSlotAtPx(p.x, p.y);
    },

    // 该格的图片对象(严格按槽位配置解析;空格返回 null,不再按胶片条顺序兜底)
    puzzleImageFor(pk, i) {
        const srcs = (this.images && this.images.length) ? this.images : (this.image ? [this.image] : []);
        if (!srcs.length) return null;
        const sc = pk.slots[i] || {};
        let im = null;
        if (sc.imageIndex != null && srcs[sc.imageIndex]) im = srcs[sc.imageIndex];
        else if (sc.imagePath) im = srcs.find(x => x.name === sc.imagePath) || null;
        return (im && im.el) ? im : null;
    },

    puzzleImageAt(pk, i) {
        const im = this.puzzleImageFor(pk, i);
        return im ? { iw: im.el.naturalWidth || 1, ih: im.el.naturalHeight || 1 } : { iw: 1, ih: 1 };
    },

    // 该格"可平移余量"(画布像素)
    slotSlackPx(pk, i) {
        if (!window.__puzzleFit) return { x: 0, y: 0 };
        const r = this.slotRectPx(pk, i);
        if (!r) return { x: 0, y: 0 };
        const sc = pk.slots[i] || (pk.slots[i] = {});
        const gap = (this.template && this.template.puzzle && this.template.puzzle.gap) || 6;
        const W = this.dom.canvas.width, H = this.dom.canvas.height;
        const gapPx = Math.max(0, gap * (Math.min(W, H) / 1000) * 0.5);
        const cw = Math.max(1, r.w - gapPx * 2), chh = Math.max(1, r.h - gapPx * 2);
        const im = this.puzzleImageAt(pk, i);
        const fillMode = sc.fillMode || (this.template.puzzle.slotFill) || 'cover';
        const zoom = sc.zoom != null ? sc.zoom : 100;
        const fit = window.__puzzleFit({ x: 0, y: 0, w: cw, h: chh }, im.iw, im.ih, fillMode, zoom, 0, 0);
        if (!fit) return { x: 0, y: 0 };
        return { x: cw - fit.dw, y: chh - fit.dh };
    },

    slotRectPx(pk, i) {
        if (!window.__buildPuzzleSlots) return null;
        const W = this.dom.canvas.width, H = this.dom.canvas.height;
        const axes = window.__clampPuzzleAxes ? window.__clampPuzzleAxes(pk.layout, pk.axisVals) : (pk.axisVals || {});
        const rects = window.__buildPuzzleSlots(pk.layout, axes);
        const r = rects[i];
        if (!r) return null;
        return { x: r[0] * W, y: r[1] * H, w: r[2] * W, h: r[3] * H };
    },

    // 拖拽:格内→图片精确跟随(anchor+余量换算);进入其他格→"放下即互换"预备态
    puzzleDragMove(pk, d, e) {
        const W = this.dom.canvas.width, H = this.dom.canvas.height;
        this.ensurePuzzleSlotsCount(pk);
        const src = d.slot;
        const p = this.puzzlePx(e);
        const sc = pk.slots[src] || (pk.slots[src] = {});
        const im0 = this.puzzleImageFor(pk, src);
        // 指针在另一格:冻结平移,标记互换目标,抓取预览;但位移过小或仅是蹭过格沿时仍按"格内平移"对待,
        // 避免用户小幅拖动误触"放下即互换"(中途挪出格沿即被误判换图)
        const j = this.puzzleSlotAtPx(p.x, p.y);
        const rr0 = this.slotRectPx(pk, src);
        const travel = Math.hypot(p.x - (d.x0 != null ? d.x0 : p.x), p.y - (d.y0 != null ? d.y0 : p.y));
        const swapThresh = rr0 ? Math.min(rr0.w, rr0.h) * 0.5 : 60;
        // "落入目标中心区"判定:指针需在目标格中央 60% 范围内才视为真正想放下
        let deepIn = false;
        if (j != null && j !== src) {
            const W = this.dom.canvas.width, H = this.dom.canvas.height;
            const rj = this.slotRectPx(pk, j);
            if (rj) {
                const nx = p.x / W, ny = p.y / H;
                const jcx = rj.x / W + rj.w / W / 2, jcy = rj.y / H + rj.h / H / 2;
                const hw = rj.w / W / 2, hh = rj.h / H / 2;
                deepIn = Math.abs(nx - jcx) <= hw * 0.6 && Math.abs(ny - jcy) <= hh * 0.6;
            }
        }
        if (j != null && j !== src && travel >= swapThresh && deepIn) {
            if (d.swap !== j) { d.swap = j; this.dom.canvas.style.cursor = 'alias'; }
            if (im0) {
                const rr = this.slotRectPx(pk, src);
                this._puzzlePick = {
                    mode: 'target', target: j, el: im0.el,
                    iw: im0.el.naturalWidth || 1, ih: im0.el.naturalHeight || 1,
                    w0: rr ? Math.max(1, rr.w) : 1, h0: rr ? Math.max(1, rr.h) : 1,
                };
            }
            return;
        }
        // 间隙/外沿:图片浮空跟手,不互换
        if (j == null) {
            if (d.swap != null) { d.swap = null; this.dom.canvas.style.cursor = 'move'; }
            if (im0) {
                const rr = this.slotRectPx(pk, src);
                this._puzzlePick = {
                    mode: 'float', x: p.x, y: p.y, el: im0.el,
                    iw: im0.el.naturalWidth || 1, ih: im0.el.naturalHeight || 1,
                    w0: rr ? Math.max(1, rr.w) : 1, h0: rr ? Math.max(1, rr.h) : 1,
                };
            }
            return;
        }
        // 回源格:收起草图,重设锚点,继续平移
        if (d.swap != null) { d.swap = null; this.dom.canvas.style.cursor = 'move'; d._anchored = false; }
        this._puzzlePick = null;
        if (!d._anchored) { d._anchored = true; d._ax = p.x; d._ay = p.y; d._oaX = sc.offsetX || 0; d._oaY = sc.offsetY || 0; }
        const slack = this.slotSlackPx(pk, src);
        const mdx = p.x - d._ax, mdy = p.y - d._ay;
        if (Math.abs(slack.x) > 2) sc.offsetX = clampNum(d._oaX + (mdx / slack.x) * 100, -100, 100);
        if (Math.abs(slack.y) > 2) sc.offsetY = clampNum(d._oaY + (mdy / slack.y) * 100, -100, 100);
        // 拖动结果同步到滑块(松手 commit 时会从滑块回写,不同步则会被旧值覆盖)
        this.setSlotOffsetSliders(sc);
    },

    // 互换两格图片(imageIndex/imagePath)
    swapSlotImages(pk, a, b) {
        const sa = pk.slots[a] || (pk.slots[a] = {}), sb = pk.slots[b] || (pk.slots[b] = {});
        const tmpIdx = sa.imageIndex, tmpPath = sa.imagePath;
        sa.imageIndex = sb.imageIndex;
        sa.imagePath = sb.imagePath;
        sb.imageIndex = tmpIdx;
        sb.imagePath = tmpPath;
        // 绑在格子上的字幕跟图:交换两个格子的字幕并更新其门牌号
        if (pk.captions) {
            const ka = String(a), kb = String(b);
            const ta = pk.captions[ka], tb = pk.captions[kb];
            if (tb !== undefined) { pk.captions[ka] = tb; tb.gapId = 'S' + a; } else delete pk.captions[ka];
            if (ta !== undefined) { pk.captions[kb] = ta; ta.gapId = 'S' + b; } else delete pk.captions[kb];
        }
    },

    // 点击画布选择当前编辑/渲染的槽位
    setActivePuzzleSlot(i) {
        this._activePuzzleSlot = i;
        const oldKey = this._puzzleSlot;
        if (typeof oldKey === 'string' && /^[vh]\d+$/.test(oldKey)) this.captureGapCaptionToModel(oldKey);
        this._puzzleSlot = 's' + i;
        const pick = this.$('cbPuzzleGapPick');
        if (pick) pick.value = 's' + i;
        this.refreshPuzzleUI();
        this.scheduleRender();
        this.setStatus(`已选中槽位 ${i + 1}`);
    },

    // 点击拼图以外画布 → 取消拼图内图片选取(清除选中高亮/槽位编辑态)
    clearActivePuzzleSlot() {
        if (this._activePuzzleSlot == null && this._puzzleSlot == null) return;
        const oldKey = this._puzzleSlot;
        if (typeof oldKey === 'string' && oldKey.charAt(0) === 's') this.captureCaptionToModel(oldKey);
        else if (typeof oldKey === 'string' && /^[vh]\d+$/.test(oldKey)) this.captureGapCaptionToModel(oldKey);
        this._puzzleSlot = null;
        this._activePuzzleSlot = null;
        this.refreshPuzzleUI();
        this.scheduleRender();
        this.setStatus('已取消选中拼图格');
    },

    // 胶片条照片→当前选中槽(拼图模式下 buildThumbnails 点击调用)
    assignSlotImage(pk, slotIdx, imgIdx) {
        if (!this.images || this.images[imgIdx] == null) return;
        this.onSettingCommit();
        this.ensurePuzzleSlotsCount(pk);
        const sc = pk.slots[slotIdx] || (pk.slots[slotIdx] = {});
        sc.imageIndex = imgIdx;
        sc.imagePath = undefined;
        this.saveCurrentTemplate();
        this.refreshPuzzleUI();
        this.scheduleRender(true);
        const im = this.images[imgIdx];
        this.setStatus(`槽位 ${slotIdx + 1} 已使用「${im && im.name ? im.name : '照片' + (imgIdx + 1)}」`);
    },

    // 滚轮缩放该格图片(100%–400%,100% 即图片自然铺满格的"最小限度")
    puzzleWheelSlot(i, factor) {
        const pk = this.tplPuzzle();
        if (!pk) return;
        this.ensurePuzzleSlotsCount(pk);
        const sc = pk.slots[i] || (pk.slots[i] = {});
        const cur = sc.zoom != null ? sc.zoom : 100;
        const z = clampNum(Math.round(cur * factor), 100, 400);
        if (Math.abs(z - cur) < 1) return;
        if (!this._wheelUndo) { this._wheelUndo = setTimeout(() => this._wheelUndo = null, 600); this.pushUndo(); }
        sc.zoom = z;
        const sl = this.$('slSlotZoom');
        if (sl) { sl.value = String(z); this.updateLabel('lblSlotZoom', z + '%'); }
        this.saveCurrentTemplate();
        this.scheduleRender();
    },

    // 双击切换该格图片;Ctrl/Shift 双击与前一格交换
    puzzleSwapSlotImage(pk, i, swapWithPrev) {
        const srcs = (this.images && this.images.length) ? this.images : (this.image ? [this.image] : []);
        if (!srcs.length) { this.setStatus('拼图:尚无胶片照片'); return; }
        this.onSettingCommit();
        this.ensurePuzzleSlotsCount(pk);
        if (swapWithPrev) {
            const j = Math.max(0, i - 1);
            if (j !== i && pk.slots[j]) {
                const a = pk.slots[i], b = pk.slots[j];
                const tmp = a.imageIndex != null ? a.imageIndex : a.imagePath || null;
                a.imageIndex = b.imageIndex != null ? b.imageIndex : (b.imagePath != null ? this.images.findIndex(x => x.name === b.imagePath) : null);
                a.imagePath = undefined;
                b.imageIndex = typeof tmp === 'number' ? tmp : (typeof tmp === 'string' ? this.images.findIndex(x => x.name === tmp) : null);
                b.imagePath = undefined;
            }
        } else {
            const sc = pk.slots[i] || (pk.slots[i] = {});
            const cur = sc.imageIndex != null ? sc.imageIndex : (sc.imagePath != null ? this.images.findIndex(x => x.name === sc.imagePath) : 0);
            sc.imageIndex = ((cur == null ? 0 : cur) + 1) % srcs.length;
            sc.imagePath = undefined;
        }
        this.saveCurrentTemplate();
        this.refreshPuzzleUI();
        this.scheduleRender(true);
    },

    // 桌面右键菜单:画布槽位 / 胶片条缩略图共用
    openCtx(x, y, items) {
        this.closeCtx();
        const m = document.createElement('div');
        m.className = 'ctx-menu';
        items.forEach(it => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = it[0];
            b.addEventListener('click', () => { this.closeCtx(); it[1](); });
            m.appendChild(b);
        });
        document.body.appendChild(m);
        const mw = m.offsetWidth || 0, mh = m.offsetHeight || 0;
        m.style.left = Math.min(x, Math.max(8, window.innerWidth - mw - 8)) + 'px';
        m.style.top = Math.min(y, Math.max(8, window.innerHeight - mh - 8)) + 'px';
        this._ctx = m;
    },

    closeCtx() {
        if (this._ctx) { this._ctx.remove(); this._ctx = null; }
    },

    async exportPuzzle() {
        const exportPuzzleNow = () => {
            if (!window.__renderPuzzle) { this.setStatus('拼图渲染不可用'); return Promise.resolve(false); }
            const prev = this.displayMax;
            this.displayMax = 4000;
            return new Promise(res => requestAnimationFrame(() => {
                window.__renderPuzzle(this, false, true);
                const data = this.dom.canvas.toDataURL('image/png');
                const base64 = data.split(',')[1];
                if (prev === undefined) delete this.displayMax;
                else this.displayMax = prev;
                res(base64);
            }));
        };
        const base64 = await exportPuzzleNow();
        if (!base64) return;
        const im0 = this.images && this.images.length ? this.images[this.currentIdx != null ? this.currentIdx : 0] : null;
        const pzName = im0 ? (im0.name || 'photo').replace(/\.[^.]+$/, '') : '';
        const filename = pzName ? `${pzName}_拼图.png` : '拼图.png';
        const r = await window.qingframe.saveImage(base64, filename);
        if (r) this.setStatus('拼图已导出');
        else this.setStatus('导出失败');
    },

    /* ══ 预设加载 ══ */
    async loadPresets() {
        this.presets = await window.__loadAllPresets();
        this.buildTree();
        if (this.presets.length) this.selectPreset(this.presets[0]);
    },

    async loadLogos() {
        try { this.logos = (await window.qingframe.listLogos()) || []; }
        catch (e) { this.logos = []; }
        if (this.dom.stRes) this.renderLogoPools();
    },

    async loadTextures() {
        try { this.textures = (await window.qingframe.listTextures()) || []; }
        catch (e) { this.textures = []; }
    },

    buildTree(filter) {
        const tree = this.dom.presetTree;
        tree.innerHTML = '';
        const f = (filter || '').toLowerCase();
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
            for (const p of groups.get(grp)) {
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
            }
        }
    },
    filterTree(v) { this.buildTree(v); },

    selectPreset(p, itemEl) {
        this.pushUndo();
        this.applyPreset(p);
        document.querySelectorAll('.preset-item').forEach(el => el.classList.remove('active'));
        if (itemEl) itemEl.classList.add('active');
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
        const src = this.cloneTemplate();
        this.selectedIdx.forEach(i => {
            if (i === this.currentIdx) return;
            const im = this.images[i];
            im.customSettings = JSON.parse(JSON.stringify(src));
            this.imageTemplates.set(im, JSON.parse(JSON.stringify(src)));
        });
        this.setStatus(`已将边框效果同步到 ${this.selectedIdx.length - 1} 张选中照片`);
        this.scheduleRender(true);
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
        const canvas = this.dom.canvas;
        if (!canvas.width) return;
        const stage = this.dom.stage;
        const sw = stage.clientWidth - 8, sh = Math.max(60, stage.clientHeight - 8);
        const z = Math.min(sw / canvas.width, sh / canvas.height);
        this.panX = 0; this.panY = 0;
        this.setZoom(Math.max(0.1, z));
    },
    applyZoomStyle() {
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
            if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); this.openImages(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
            else if ((e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); this.redo(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectAllEls(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'c') { this.copyElement(); }
            else if (e.ctrlKey && e.key.toLowerCase() === 'v') { e.preventDefault(); this.pasteElement(); }
            else if (e.key === 'Delete' && this.selectedEls.length) { e.preventDefault(); this.deleteElement(); }
        });
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
                const dataUrl = this.dom.canvas.toDataURL(mime, fmt === 'jpeg' ? 0.92 : 1);
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