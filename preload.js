const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window
  minimize: ()   => ipcRenderer.invoke('win-minimize'),
  maximize: ()   => ipcRenderer.invoke('win-maximize'),
  close:    ()   => ipcRenderer.invoke('win-close'),

  // Data
  getServers:   ()       => ipcRenderer.invoke('get-servers'),
  saveServer:   (s)      => ipcRenderer.invoke('save-server', s),
  deleteServer: (id)     => ipcRenderer.invoke('delete-server', id),
  getGames:     ()       => ipcRenderer.invoke('get-games'),

  // Checks
  checkSteamCmd: ()     => ipcRenderer.invoke('check-steamcmd'),
  checkGame:     (id)   => ipcRenderer.invoke('check-game', id),
  checkJava:     ()     => ipcRenderer.invoke('check-java'),
  getStatus:     (id)   => ipcRenderer.invoke('get-status', id),
  openFolder:    (id)   => ipcRenderer.invoke('open-folder', id),
  getLocalIp:    ()     => ipcRenderer.invoke('get-local-ip'),
  getGateway:    ()     => ipcRenderer.invoke('get-gateway'),
  openPorts:     (p)    => ipcRenderer.invoke('open-ports', p),
  openUrl:       (url)  => ipcRenderer.invoke('open-url', url),

  // Install
  installSteamCmd: ()   => ipcRenderer.invoke('install-steamcmd'),
  installMinecraft: ()  => ipcRenderer.invoke('install-minecraft'),
  installGame:  (id)    => ipcRenderer.invoke('install-game', id),
  installJava:      ()  => ipcRenderer.invoke('install-java'),
  writeGameConfig:  (p) => ipcRenderer.invoke('write-game-config', p),

  // Settings
  getDataPaths:      ()    => ipcRenderer.invoke('get-data-paths'),
  openDataFolder:    ()    => ipcRenderer.invoke('open-data-folder'),
  getInstalledGames: ()    => ipcRenderer.invoke('get-installed-games'),

  // License
  getLicenseInfo:    ()    => ipcRenderer.invoke('get-license-info'),
  activateLicense:   (key) => ipcRenderer.invoke('activate-license', key),

  // Server control
  startServer:  (p)     => ipcRenderer.invoke('start-server', p),
  stopServer:   (id)    => ipcRenderer.invoke('stop-server', id),
  sendCommand:  (p)     => ipcRenderer.invoke('send-command', p),

  // Events
  on: (channel, cb) => ipcRenderer.on(channel, (_, ...a) => cb(...a)),
  off: (channel)    => ipcRenderer.removeAllListeners(channel),
});
