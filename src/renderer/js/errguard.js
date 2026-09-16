// 全局错误兜底:未捕获异常 / 未处理 Promise 拒绝 → 状态栏提示 + 尝试立即保存草稿
(function () {
    function toast(msg, isError) {
        try {
            let el = document.getElementById('errToast');
            if (!el) {
                el = document.createElement('div');
                el.id = 'errToast';
                el.className = 'err-toast';
                document.body.appendChild(el);
            }
            el.textContent = msg;
            el.className = 'err-toast show' + (isError ? ' err' : '');
            clearTimeout(el._t);
            el._t = setTimeout(() => { el.className = 'err-toast'; }, 6000);
        } catch (e) { /* 提示失败不影响主流程 */ }
    }

    window.addEventListener('error', (e) => {
        const msg = (e && e.message) ? e.message : String(e);
        console.error('[未捕获异常]', e && e.error ? e.error : e);
        try { if (window.App && typeof window.App.saveDraftNow === 'function') window.App.saveDraftNow(); } catch (_) { /* 忽略 */ }
        toast('发生错误：' + msg, true);
    });

    window.addEventListener('unhandledrejection', (e) => {
        const r = e && e.reason;
        const msg = (r && (r.message || r.name)) ? (r.message || r.name) : String(r);
        console.error('[未处理拒绝]', r);
        try { if (window.App && typeof window.App.saveDraftNow === 'function') window.App.saveDraftNow(); } catch (_) { /* 忽略 */ }
        toast('异步错误：' + msg, true);
    });

    window.__showErrToast = toast;
})();