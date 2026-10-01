// 图片扩展名 → MIME。抽成独立模块便于用纯 node 验证(见 tools/test-main-io.js ⑦)。
// .svg 是给 shared/marks 的内置标记用的:矢量、单文件不到 1.5KB,直接以 dataUrl 进图标池。
'use strict';

function imageMimeOf(filename) {
    const l = String(filename || '').toLowerCase();
    if (l.endsWith('.svg')) return 'image/svg+xml';
    if (l.endsWith('.png')) return 'image/png';
    if (l.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
}

module.exports = { imageMimeOf };
