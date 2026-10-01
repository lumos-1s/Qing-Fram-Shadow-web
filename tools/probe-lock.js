// 临时诊断:electron 进程内测锁文件创建 + requestSingleInstanceLock
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
    const dir = app.getPath('userData');
    console.log('userData =', dir);
    console.log('目录存在 =', fs.existsSync(dir));

    // 1) node fs 写测试
    const p = path.join(dir, '__probe_lock__');
    try {
        fs.writeFileSync(p, 'probe');
        console.log('[fs] 写入 OK,', fs.statSync(p).size, '字节');
        fs.unlinkSync(p);
        console.log('[fs] 删除 OK');
    } catch (e) {
        console.log('[fs] 失败:', e.code, e.message);
    }

    // 2) Chromium 单实例锁
    try {
        const ok = app.requestSingleInstanceLock();
        console.log('[lock] requestSingleInstanceLock =>', ok);
    } catch (e) {
        console.log('[lock] 抛异常:', e.message);
    }

    app.exit(0);
});
