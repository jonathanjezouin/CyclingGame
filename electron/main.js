const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

const isDev = process.env.NODE_ENV !== 'production'

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Vélo Manager / Rider — POC',
    backgroundColor: '#1a1a2e',
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// IPC — SLM placeholder
ipcMain.handle('slm:generate', async (event, { context, dsProfile }) => {
  // Placeholder : retourne un message DS simulé
  const messages = [
    `Reste dans ta roue, économise tes forces.`,
    `Attention, la montée arrive dans 2 km. Passe en mode Éco.`,
    `Beau travail. Continue à ce rythme.`,
    `Ne te laisse pas distancer, reviens dans le groupe.`,
    `Tu as les jambes aujourd'hui. Attaque si tu te sens bien.`,
  ]
  const msg = messages[Math.floor(Math.random() * messages.length)]
  return { text: msg, timestamp: Date.now() }
})
