const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,  // Cho phép Node.js trong renderer (cần cho IndexedDB và libs)
      contextIsolation: false  // Tắt isolation để tương thích với mã cũ
    }
  });

  // Load file HTML của bạn
  win.loadFile('index.html');  // Giả sử file HTML của bạn là index.html

  // Mở DevTools để debug (tùy chọn, xóa khi build)
  // win.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});