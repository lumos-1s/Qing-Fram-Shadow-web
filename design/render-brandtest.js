const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const dst = process.argv[3];
const st = process.argv[4] || 'IMP_FROSTED';
const pf = process.argv[5] || '33';
const bl = process.argv[6] || '2';
const bs = process.argv[7] || '1';
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } });
  const { pathToFileURL } = require('url');
  await win.loadURL(pathToFileURL(path.resolve(src)).href + '?st=' + st + '&pf=' + pf + '&bl=' + bl + '&bs=' + bs);
  await new Promise(r => setTimeout(r, 700));
  const dataUrl = await win.webContents.executeJavaScript("document.getElementById('c').toDataURL('image/png')");
  const metrics = await win.webContents.executeJavaScript("document.getElementById('metrics').textContent");
  fs.writeFileSync(dst, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('METRICS', metrics);
  console.log('saved', dst);
  app.quit();
});