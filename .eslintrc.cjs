// 清框影 ESLint 配置(宽松起步:只拦未定义变量/语法级问题,样式类一律 warn)
module.exports = {
    root: true,
    env: {
        browser: true,
        es2021: true,
        node: true
    },
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'script'
    },
    extends: ['eslint:recommended'],
    overrides: [
        {
            // 主进程/预加载(CommonJS)
            files: ['src/main/**/*.js'],
            env: { node: true, browser: false },
            rules: { 'no-undef': 'error', 'no-inner-declarations': 'warn', 'no-useless-escape': 'warn' }
        },
        {
            // 渲染进程(经典 <script> 多文件共享全局,跨文件符号由使用者保证)
            files: ['src/renderer/**/*.js'],
            env: { browser: true, node: false },
            globals: {
                qingframe: 'readonly',
                module: 'readonly',
                __render: 'readonly',
                __renderPuzzle: 'readonly',
                __loadAllPresets: 'readonly',
                __parseExif: 'readonly',
                __exifSummary: 'readonly'
            },
            rules: { 'no-undef': 'off', 'no-inner-declarations': 'warn', 'no-useless-escape': 'warn', 'no-empty': ['warn', { allowEmptyCatch: true }] }
        }
    ],
    rules: {
        'no-unused-vars': 'warn',
        'no-var': 'warn',
        'prefer-const': 'off',
        eqeqeq: ['warn', 'smart'],
        'no-mixed-spaces-and-tabs': 'error',
        'no-undef': 'error'
    }
};