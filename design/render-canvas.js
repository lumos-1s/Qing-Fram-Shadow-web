const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const dst = process.argv[3];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 1100, useContentSize: true, show: false, webPreferences: { offscreen: true, deviceScaleFactor: 1 } });
  await win.loadFile(path.resolve(src));
  await new Promise(r => setTimeout(r, 400));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(dst, img.toPNG());
  console.log('saved', dst, img.getSize().width + 'x' + img.getSize().height);
  app.quit();
});