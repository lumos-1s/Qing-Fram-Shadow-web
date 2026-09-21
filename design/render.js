const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const dst = process.argv[3];
if (src && dst) {
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 512, height: 512, useContentSize: true, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
    await win.loadFile(path.resolve(src));
    await new Promise(r => setTimeout(r, 300));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(dst, img.toPNG());
    console.log('saved', dst, img.getSize().width + 'x' + img.getSize().height, img.toPNG().length + ' bytes');
    app.quit();
  });
} else {
  console.log('usage: electron render.js <in.svg> <out.png>');
  app.quit();
}