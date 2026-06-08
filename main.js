const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');
const { spawn, execSync } = require('child_process');
const os     = require('os');
const crypto = require('crypto');

// ─── LICENSE ──────────────────────────────────────────────────────────────────
// IMPORTANTE: Cambiar este secreto antes de distribuir. Usalo también en generate-key.js
const LICENSE_SECRET = 'InfernoHost-2025-X9k#mPqR';
const TRIAL_DAYS     = 30;

// ─── PATHS ──────────────────────────────────────────────────────────────────
const DATA_DIR     = app.getPath('userData');
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');

const STEAMCMD     = path.join(DATA_DIR, 'steamcmd');
const SERVERS_DIR  = path.join(DATA_DIR, 'servers');
const JAVA_DIR     = path.join(DATA_DIR, 'java');
const CLUSTERS_DIR = path.join(DATA_DIR, 'clusters');
const CONFIG_FILE  = path.join(DATA_DIR, 'servers.json');

[STEAMCMD, SERVERS_DIR, CLUSTERS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── GAME DEFINITIONS ────────────────────────────────────────────────────────
const GAMES = {
  minecraft: {
    name: 'Minecraft',
    icon: '⛏',
    color: '#65a30d',
    useSteam: false,
    minRam: 2,
    port: 25565,
  },
  ark: {
    name: 'ARK: Survival Ascended',
    icon: '🦖',
    color: '#d97706',
    useSteam: true,
    appId: '2430930',
    exe: ['ShooterGame','Binaries','Win64','ArkAscendedServer.exe'],
    minRam: 12,
    port: 7777,
  },
  valheim: {
    name: 'Valheim',
    icon: '⚔',
    color: '#3b82f6',
    useSteam: true,
    appId: '896660',
    exe: ['valheim_server.exe'],
    minRam: 4,
    port: 2456,
  },
  conan: {
    name: 'Conan Exiles',
    icon: '🗡',
    color: '#dc2626',
    useSteam: true,
    appId: '443030',
    exe: ['ConanSandbox','Binaries','Win64','ConanSandboxServer-Win64-Shipping.exe'],
    minRam: 6,
    port: 7777,
  },
  'ark-se': {
    name: 'ARK: Survival Evolved',
    icon: '🦕',
    color: '#92400e',
    useSteam: true,
    appId: '376030',
    exe: ['ShooterGame','Binaries','Win64','ShooterGameServer.exe'],
    minRam: 8,
    port: 7778,
  },
};

// ─── ACTIVE PROCESSES ────────────────────────────────────────────────────────
const procs = {};
let win;

// ─── WINDOW ──────────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 960,
    minHeight: 580,
    frame: false,
    backgroundColor: '#060a14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  Object.values(procs).forEach(p => { try { p.kill(); } catch(e) {} });
  app.quit();
});

// ─── WINDOW CONTROLS ─────────────────────────────────────────────────────────
ipcMain.handle('win-minimize', () => win.minimize());
ipcMain.handle('win-maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
ipcMain.handle('win-close',    () => { Object.values(procs).forEach(p => { try { p.kill(); } catch(e) {} }); app.quit(); });

// ─── CONFIG ──────────────────────────────────────────────────────────────────
ipcMain.handle('get-servers', () => {
  if (!fs.existsSync(CONFIG_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { return []; }
});

ipcMain.handle('save-server', (_, server) => {
  let list = [];
  if (fs.existsSync(CONFIG_FILE)) { try { list = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch {} }
  const idx = list.findIndex(s => s.id === server.id);
  if (idx >= 0) list[idx] = server; else list.push(server);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(list, null, 2));
  return true;
});

ipcMain.handle('delete-server', (_, id) => {
  let list = [];
  if (fs.existsSync(CONFIG_FILE)) { try { list = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch {} }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(list.filter(s => s.id !== id), null, 2));
  return true;
});

// ─── CHECKS ──────────────────────────────────────────────────────────────────
ipcMain.handle('check-steamcmd', () => fs.existsSync(path.join(STEAMCMD, 'steamcmd.exe')));

ipcMain.handle('check-game', (_, gameId) => {
  const dir = path.join(SERVERS_DIR, gameId);
  if (!fs.existsSync(dir)) return false;
  if (gameId === 'minecraft') return fs.existsSync(path.join(dir, 'server.jar'));
  return fs.readdirSync(dir).length > 3;
});

ipcMain.handle('get-games', () => GAMES);

ipcMain.handle('open-folder', (_, gameId) => {
  const dir = path.join(SERVERS_DIR, gameId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

ipcMain.handle('check-java', () => {
  if (getJavaExe() !== 'java') return true; // bundled java exists
  try { execSync('java -version', { stdio: 'ignore' }); return true; } catch { return false; }
});

// ─── INSTALL STEAMCMD ────────────────────────────────────────────────────────
ipcMain.handle('install-steamcmd', async (event) => {
  const send    = (d) => event.sender.send('install-log', d);
  const zipPath = path.join(STEAMCMD, 'steamcmd.zip');

  try {
    send({ text: 'Descargando SteamCMD desde Steam...', pct: 5 });
    await downloadFile(
      'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip',
      zipPath,
      (p) => send({ text: 'Descargando SteamCMD...', pct: Math.round(5 + p * 40) })
    );

    send({ text: 'Extrayendo archivos...', pct: 50 });

    // Escribimos un .ps1 temporal para evitar problemas con paths con espacios
    const psScript = path.join(os.tmpdir(), 'ih_extract.ps1');
    fs.writeFileSync(psScript,
      `Expand-Archive -Force "${zipPath}" "${STEAMCMD}"\n`, 'utf8');
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}"`,
      { timeout: 60000 }
    );

    send({ text: 'Inicializando SteamCMD (primera vez puede tardar)...', pct: 65 });

    // SteamCMD sale con código 7 cuando se auto-actualiza — es normal
    await runSteamCmd(['+quit'], (line) => send({ text: line, pct: 75 }), [0, 1, 7]);

    send({ text: '✓ SteamCMD instalado y listo.', pct: 100, done: true });
    return { success: true };
  } catch (err) {
    send({ text: '✗ Error: ' + err.message, pct: 0, error: true });
    return { success: false, error: err.message };
  }
});

// ─── INSTALL MINECRAFT ───────────────────────────────────────────────────────
ipcMain.handle('install-minecraft', async (event) => {
  const send = (d) => event.sender.send('install-log', d);
  const dir  = path.join(SERVERS_DIR, 'minecraft');

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    send({ text: 'Obteniendo versión más reciente de Minecraft...', pct: 5 });
    const manifest = await fetchJSON('https://launchermeta.mojang.com/mc/game/version_manifest.json');
    const latest   = manifest.latest.release;
    const verInfo  = manifest.versions.find(v => v.id === latest);
    if (!verInfo) throw new Error('No se encontró versión');

    send({ text: `Obteniendo datos de Minecraft ${latest}...`, pct: 15 });
    const verData  = await fetchJSON(verInfo.url);
    const jarUrl   = verData.downloads.server.url;

    send({ text: `Descargando Minecraft Server ${latest} (~50 MB)...`, pct: 20 });
    await downloadFile(jarUrl, path.join(dir, 'server.jar'),
      (p) => send({ text: `Descargando Minecraft ${latest}...`, pct: Math.round(20 + p * 70) })
    );

    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
    fs.writeFileSync(path.join(dir, 'server.properties'), [
      'server-name=Mi Server InfernoHost',
      'max-players=20',
      'server-port=25565',
      'gamemode=survival',
      'difficulty=normal',
      'pvp=true',
      'online-mode=false',
      'view-distance=10',
      'motd=Servidor powered by InfernoHost',
    ].join('\n'));

    send({ text: `✓ Minecraft ${latest} instalado correctamente.`, pct: 100, done: true, version: latest });
    return { success: true, version: latest };
  } catch (err) {
    send({ text: '✗ Error: ' + err.message, pct: 0, error: true });
    return { success: false, error: err.message };
  }
});

// ─── INSTALL GAME (via SteamCMD) ─────────────────────────────────────────────
ipcMain.handle('install-game', async (event, gameId) => {
  const send = (d) => event.sender.send('install-log', d);
  const game = GAMES[gameId];
  if (!game || !game.useSteam) return { success: false, error: 'Usar install-minecraft' };

  const dir = path.join(SERVERS_DIR, gameId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const sizesGB = { ark: 30, valheim: 3, conan: 35 };
  send({ text: `Iniciando instalación de ${game.name}...`, pct: 2 });
  send({ text: `⚠ Esto descargará ~${sizesGB[gameId] || 10}GB. Puede tomar tiempo.`, pct: 2, warn: true });

  try {
    await runSteamCmd(
      ['+force_install_dir', dir, '+login', 'anonymous', '+app_update', game.appId, 'validate', '+quit'],
      (line) => {
        const m = line.match(/(\d+\.\d+)%/);
        const pct = m ? Math.round(parseFloat(m[1])) : null;
        send({ text: line, pct });
      },
      [0, 1, 7]
    );
    send({ text: `✓ ${game.name} instalado correctamente.`, pct: 100, done: true });
    return { success: true };
  } catch (err) {
    if (err.message.includes('código 8')) {
      send({ text: '✗ SteamCMD no pudo conectarse a Steam (código 8).', error: true });
      send({ text: '💡 Causas posibles: servidores de Steam en mantenimiento, problema de red o firewall bloqueando SteamCMD.', warn: true });
      send({ text: '→ Esperá unos minutos y volvé a intentarlo.', warn: true });
    } else {
      send({ text: '✗ Error: ' + err.message, error: true });
    }
    return { success: false, error: err.message };
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
ipcMain.handle('start-server', async (event, { serverId, gameId, config }) => {
  if (procs[serverId]) return { success: false, error: 'Ya está corriendo' };

  const send = (d) => { try { event.sender.send('server-log-' + serverId, d); } catch {} };
  const dir  = path.join(SERVERS_DIR, gameId);
  const ram  = config.ram || GAMES[gameId]?.minRam || 2;
  const name = config.name || 'Mi Servidor';
  const pass = config.password || '';
  const maxP = config.maxPlayers || 20;

  let exe, args;

  try {
    if (gameId === 'minecraft') {
      exe  = getJavaExe();
      args = [`-Xmx${ram}G`, '-Xms512M', '-jar', path.join(dir,'server.jar'), '--nogui'];
    } else {
      const game = GAMES[gameId];
      exe  = path.join(dir, ...game.exe);
      if (gameId === 'ark') {
        const map    = config['MapName'] || 'TheIsland_WP';
        const sname  = config['SessionName'] || name;
        const maxp   = config['MaxPlayers'] || maxP;
        const apass  = config['ServerAdminPassword'] || 'admin123';
        const spass  = config['ServerPassword'] || '';
        const port   = config['Port'] || '7777';
        const qport  = config['QueryPort'] || String(parseInt(port) + 1);
        const clusterEnabled  = config['__cluster_enabled__'] === 'true';
        const clusterId       = (config['__cluster_id__'] || '').trim();
        const instanceName    = (config['__instance_name__'] || '').trim();
        const mods = (config['__mods__'] || '').split('\n').map(s=>s.trim()).filter(Boolean);

        // Create cluster dir if needed
        if (clusterEnabled && clusterId) {
          const cdir = path.join(CLUSTERS_DIR, clusterId);
          if (!fs.existsSync(cdir)) fs.mkdirSync(cdir, { recursive: true });
        }

        const query = [
          `${map}?listen`,
          `SessionName=${sname}`,
          `MaxPlayers=${maxp}`,
          `ServerAdminPassword=${apass}`,
          ...(spass ? [`ServerPassword=${spass}`] : []),
          ...(config['ServerPVE'] === 'true' ? ['ServerPVE=true'] : []),
        ].join('?');

        args = [
          query,
          `-port=${port}`,
          `-queryport=${qport}`,
          '-servergamelog',
          '-ServerRCONOutputTribeLogs',
          ...(instanceName ? [`-AltSaveDirectoryName=${instanceName}`] : []),
          ...(clusterEnabled && clusterId ? [
            `-clusterid=${clusterId}`,
            `-ClusterDirOverride=${path.join(CLUSTERS_DIR, clusterId)}`,
            '-NoTransferFromFiltering',
          ] : []),
          ...(mods.length ? [`-mods=${mods.join(',')}`] : []),
        ];
      } else if (gameId === 'ark-se') {
        const map    = config['MapName'] || 'TheIsland';
        const sname  = config['SessionName'] || name;
        const maxp   = config['MaxPlayers'] || maxP;
        const apass  = config['ServerAdminPassword'] || 'admin123';
        const spass  = config['ServerPassword'] || '';
        const port   = config['Port'] || '7778';
        const qport  = config['QueryPort'] || String(parseInt(port) + 1);
        const clusterEnabled = config['__cluster_enabled__'] === 'true';
        const clusterId      = (config['__cluster_id__'] || '').trim();
        const instanceName   = (config['__instance_name__'] || '').trim();
        const mods = (config['__mods__'] || '').split('\n').map(s=>s.trim()).filter(Boolean);

        if (clusterEnabled && clusterId) {
          const cdir = path.join(CLUSTERS_DIR, clusterId);
          if (!fs.existsSync(cdir)) fs.mkdirSync(cdir, { recursive: true });
        }

        const query = [
          `${map}?listen`,
          `SessionName=${sname}`,
          `MaxPlayers=${maxp}`,
          `ServerAdminPassword=${apass}`,
          ...(spass ? [`ServerPassword=${spass}`] : []),
          ...(config['ServerPVE'] === 'true' ? ['ServerPVE=true'] : []),
        ].join('?');

        args = [
          query,
          `-port=${port}`,
          `-queryport=${qport}`,
          '-servergamelog',
          '-ServerRCONOutputTribeLogs',
          ...(instanceName ? [`-AltSaveDirectoryName=${instanceName}`] : []),
          ...(clusterEnabled && clusterId ? [
            `-clusterid=${clusterId}`,
            `-ClusterDirOverride=${path.join(CLUSTERS_DIR, clusterId)}`,
            '-NoTransferFromFiltering',
          ] : []),
          ...(mods.length ? [`-mods=${mods.join(',')}`] : []),
        ];
      } else if (gameId === 'valheim') {
        args = ['-name', config['name']||name, '-port', config['port']||'2456',
                '-world', config['world']||'Dedicated', '-password', config['password']||pass,
                '-public', config['public']||'1'];
      } else if (gameId === 'conan') {
        args = ['-log', `-MaxPlayers=${config['MaxPlayers']||maxP}`];
      } else {
        args = [];
      }
    }

    send({ text: `Iniciando ${GAMES[gameId]?.name || gameId}...`, type: 'info' });

    // Abrir puerto en Firewall de Windows automáticamente
    const port = GAMES[gameId]?.port;
    if (port) {
      try {
        const proto = gameId === 'valheim' ? 'UDP' : 'TCP';
        execSync(`netsh advfirewall firewall add rule name="InfernoHost-${gameId}" dir=in action=allow protocol=${proto} localport=${port}`, { stdio: 'pipe' });
        send({ text: `✓ Firewall: puerto ${port} abierto.`, type: 'info' });
      } catch {
        send({ text: `⚠ No se pudo abrir el firewall automáticamente. Abrí el puerto ${port} manualmente.`, type: 'warn' });
      }
    }

    const proc = spawn(exe, args, { cwd: dir, windowsHide: true });
    procs[serverId] = proc;

    proc.stdout.on('data', d => send({ text: d.toString().trim(), type: 'info' }));
    proc.stderr.on('data', d => send({ text: d.toString().trim(), type: 'warn' }));
    proc.on('close', code => {
      delete procs[serverId];
      try { event.sender.send('server-stopped', serverId); } catch {}
      send({ text: `Servidor detenido (código ${code}).`, type: 'warn' });
    });
    proc.on('error', err => {
      delete procs[serverId];
      send({ text: '✗ ' + err.message, type: 'error' });
      try { event.sender.send('server-stopped', serverId); } catch {}
    });

    return { success: true, pid: proc.pid };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── WRITE GAME CONFIG FILES ──────────────────────────────────────────────────
ipcMain.handle('write-game-config', (_, { gameId, config }) => {
  const dir = path.join(SERVERS_DIR, gameId);
  if (!fs.existsSync(dir)) return { success: false, error: 'Servidor no instalado' };

  const v = (key, def = '') => (config[key] !== undefined && config[key] !== '') ? config[key] : def;

  try {
    // ── MINECRAFT ──────────────────────────────────────────────────────────────
    if (gameId === 'minecraft') {
      const props = [
        '#--- InfernoHost Manager ---',
        `server-name=${v('server-name','Mi Server InfernoHost')}`,
        `server-port=${v('server-port','25565')}`,
        `max-players=${v('max-players','20')}`,
        `motd=${v('motd','\\u00A7cInfernoHost \\u00A7fServer')}`,
        `online-mode=${v('online-mode','false')}`,
        `white-list=${v('white-list','false')}`,
        `enforce-whitelist=${v('enforce-whitelist','false')}`,
        `gamemode=${v('gamemode','survival')}`,
        `force-gamemode=${v('force-gamemode','false')}`,
        `difficulty=${v('difficulty','normal')}`,
        `hardcore=${v('hardcore','false')}`,
        `pvp=${v('pvp','true')}`,
        `allow-nether=${v('allow-nether','true')}`,
        `allow-flight=${v('allow-flight','false')}`,
        `spawn-monsters=${v('spawn-monsters','true')}`,
        `spawn-animals=${v('spawn-animals','true')}`,
        `spawn-npcs=${v('spawn-npcs','true')}`,
        `generate-structures=${v('generate-structures','true')}`,
        `level-name=${v('level-name','world')}`,
        `level-type=${v('level-type','minecraft:default')}`,
        `level-seed=${v('level-seed','')}`,
        `view-distance=${v('view-distance','10')}`,
        `simulation-distance=${v('simulation-distance','10')}`,
        `entity-broadcast-range-percentage=${v('entity-broadcast-range-percentage','100')}`,
        `max-world-size=${v('max-world-size','60000000')}`,
        `max-build-height=${v('max-build-height','384')}`,
        `enable-command-block=${v('enable-command-block','false')}`,
        `op-permission-level=${v('op-permission-level','4')}`,
        `function-permission-level=${v('function-permission-level','2')}`,
        `max-players=${v('max-players','20')}`,
        `max-tick-time=${v('max-tick-time','60000')}`,
        `network-compression-threshold=${v('network-compression-threshold','256')}`,
        `rate-limit=${v('rate-limit','0')}`,
        `sync-chunk-writes=${v('sync-chunk-writes','true')}`,
        `enforce-secure-profile=${v('enforce-secure-profile','false')}`,
        `prevent-proxy-connections=${v('prevent-proxy-connections','false')}`,
        `enable-rcon=${v('enable-rcon','false')}`,
        `rcon.port=${v('rcon.port','25575')}`,
        `rcon.password=${v('rcon.password','')}`,
        `broadcast-rcon-to-ops=${v('broadcast-rcon-to-ops','true')}`,
        `enable-query=${v('enable-query','false')}`,
        `query.port=${v('query.port','25565')}`,
        `spawn-protection=0`,
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'server.properties'), props + '\n');
    }

    // ── ARK: SURVIVAL ASCENDED ────────────────────────────────────────────────
    if (gameId === 'ark') {
      const cfgDir = path.join(dir, 'ShooterGame','Saved','Config','WindowsServer');
      if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });

      const gus = [
        '[ServerSettings]',
        `ServerAdminPassword=${v('ServerAdminPassword','admin123')}`,
        `ServerPassword=${v('ServerPassword','')}`,
        `MaxPlayers=${v('MaxPlayers','70')}`,
        `ServerPVE=${v('ServerPVE','false')}`,
        `RCONEnabled=${v('RCONEnabled','false')}`,
        `RCONPort=${v('RCONPort','32330')}`,
        `AdminLogging=${v('AdminLogging','true')}`,
        '',
        '# --- TASAS ---',
        `XPMultiplier=${v('XPMultiplier','1')}`,
        `TamingSpeedMultiplier=${v('TamingSpeedMultiplier','1')}`,
        `HarvestAmountMultiplier=${v('HarvestAmountMultiplier','1')}`,
        `HarvestHealthMultiplier=${v('HarvestHealthMultiplier','1')}`,
        `ResourcesRespawnPeriodMultiplier=${v('ResourcesRespawnPeriodMultiplier','1')}`,
        `ResourceNoReplenishRadiusPlayers=${v('ResourceNoReplenishRadiusPlayers','1')}`,
        `ResourceNoReplenishRadiusStructures=${v('ResourceNoReplenishRadiusStructures','1')}`,
        `PlayerCharacterFoodDrainMultiplier=${v('PlayerCharacterFoodDrainMultiplier','1')}`,
        `PlayerCharacterWaterDrainMultiplier=${v('PlayerCharacterWaterDrainMultiplier','1')}`,
        `PlayerCharacterStaminaDrainMultiplier=${v('PlayerCharacterStaminaDrainMultiplier','1')}`,
        `PlayerCharacterHealthRecoveryMultiplier=${v('PlayerCharacterHealthRecoveryMultiplier','1')}`,
        `DinoCharacterFoodDrainMultiplier=${v('DinoCharacterFoodDrainMultiplier','1')}`,
        `DinoCharacterStaminaDrainMultiplier=${v('DinoCharacterStaminaDrainMultiplier','1')}`,
        `DinoCharacterHealthRecoveryMultiplier=${v('DinoCharacterHealthRecoveryMultiplier','1')}`,
        '',
        '# --- BREEDING ---',
        `MatingIntervalMultiplier=${v('MatingIntervalMultiplier','1')}`,
        `MatingSpeedMultiplier=${v('MatingSpeedMultiplier','1')}`,
        `EggHatchSpeedMultiplier=${v('EggHatchSpeedMultiplier','1')}`,
        `BabyMatureSpeedMultiplier=${v('BabyMatureSpeedMultiplier','1')}`,
        `BabyFoodConsumptionSpeedMultiplier=${v('BabyFoodConsumptionSpeedMultiplier','1')}`,
        `BabyCuddleIntervalMultiplier=${v('BabyCuddleIntervalMultiplier','1')}`,
        `BabyCuddleGracePeriodMultiplier=${v('BabyCuddleGracePeriodMultiplier','1')}`,
        `BabyCuddleLoseImprintQualitySpeedMultiplier=${v('BabyCuddleLoseImprintQualitySpeedMultiplier','1')}`,
        `BabyImprintingStatScaleMultiplier=${v('BabyImprintingStatScaleMultiplier','1')}`,
        '',
        '# --- COMBATE ---',
        `PlayerDamageMultiplier=${v('PlayerDamageMultiplier','1')}`,
        `PlayerResistanceMultiplier=${v('PlayerResistanceMultiplier','1')}`,
        `DinoDamageMultiplier=${v('DinoDamageMultiplier','1')}`,
        `DinoResistanceMultiplier=${v('DinoResistanceMultiplier','1')}`,
        `TamedDinoResistanceMultiplier=${v('TamedDinoResistanceMultiplier','1')}`,
        `TamedDinoDamageMultiplier=${v('TamedDinoDamageMultiplier','1')}`,
        `StructureDamageMultiplier=${v('StructureDamageMultiplier','1')}`,
        `StructureResistanceMultiplier=${v('StructureResistanceMultiplier','1')}`,
        `DinoCountMultiplier=${v('DinoCountMultiplier','1')}`,
        `MaxPersonalTamedDinos=${v('MaxPersonalTamedDinos','40')}`,
        `MaxTamedDinos=${v('MaxTamedDinos','5000')}`,
        '',
        '# --- ENTORNO ---',
        `DayTimeSpeedScale=${v('DayTimeSpeedScale','1')}`,
        `NightTimeSpeedScale=${v('NightTimeSpeedScale','1')}`,
        `OverrideOfficialDifficulty=${v('OverrideOfficialDifficulty','5.0')}`,
        `DifficultyOffset=${v('DifficultyOffset','1.0')}`,
        `ServerHardcore=${v('ServerHardcore','false')}`,
        `AllowFlyerCarryPvE=${v('AllowFlyerCarryPvE','false')}`,
        `PreventDinoTaming=${v('PreventDinoTaming','false')}`,
        `AllowRaidDinoFeeding=${v('AllowRaidDinoFeeding','false')}`,
        `EnableExtraStructurePreventionVolumes=${v('EnableExtraStructurePreventionVolumes','false')}`,
        `EnableCryoSicknessPVE=${v('EnableCryoSicknessPVE','false')}`,
        '',
        '# --- CLUSTER / TRANSFERENCIAS ---',
        `noTributeDownloads=${v('noTributeDownloads','false')}`,
        `PreventDownloadSurvivors=${v('PreventDownloadSurvivors','false')}`,
        `PreventDownloadDinos=${v('PreventDownloadDinos','false')}`,
        `PreventDownloadItems=${v('PreventDownloadItems','false')}`,
        `PreventUploadSurvivors=${v('PreventUploadSurvivors','false')}`,
        `PreventUploadDinos=${v('PreventUploadDinos','false')}`,
        `PreventUploadItems=${v('PreventUploadItems','false')}`,
        `CrossARKAllowForeignDinoDownloads=${v('CrossARKAllowForeignDinoDownloads','false')}`,
        '',
        '# --- TRIBUS ---',
        `AllowTribeWarPvE=${v('AllowTribeWarPvE','false')}`,
        `AllowTribeWarCancelPvE=${v('AllowTribeWarCancelPvE','false')}`,
        `PreventTribeAlliances=${v('PreventTribeAlliances','false')}`,
        `TribeLogDestroyedEnemyStructures=${v('TribeLogDestroyedEnemyStructures','true')}`,
        '',
        '[SessionSettings]',
        `SessionName=${v('SessionName','Mi ARK Server')}`,
        `MultiHome=`,
        `Port=${v('Port','7777')}`,
        `QueryPort=${v('QueryPort','27016')}`,
        '',
        '[/Script/Engine.GameSession]',
        `MaxPlayers=${v('MaxPlayers','70')}`,
      ].join('\n');
      fs.writeFileSync(path.join(cfgDir, 'GameUserSettings.ini'), gus + '\n');

      // Game.ini — per-level stats and game mode settings
      const plsIdx = { pls_health:0, pls_stamina:1, pls_oxygen:3, pls_food:4,
                       pls_water:5, pls_weight:7, pls_damage:8, pls_speed:9, pls_crafting:11 };
      const dlsIdx = { dls_health:0, dls_stamina:1, dls_weight:7, dls_damage:8 };

      const plsLines = Object.entries(plsIdx)
        .filter(([k]) => v(k,'1') !== '1')
        .map(([k,i]) => `PerLevelStatsMultiplier_Player[${i}]=${v(k,'1')}`);

      const dlsLines = Object.entries(dlsIdx)
        .filter(([k]) => v(k,'1') !== '1')
        .map(([k,i]) => `PerLevelStatsMultiplier_DinoTamed[${i}]=${v(k,'1')}`);

      const gameIni = [
        '[/script/shootergame.shootergamemode]',
        `MaxNumberOfPlayersInTribe=${v('MaxNumberOfPlayersInTribe','10')}`,
        `MaxTribeAlliances=${v('MaxTribeAlliances','10')}`,
        `TribeNameChangeCooldown=${v('TribeNameChangeCooldown','15')}`,
        `bDisableFriendlyFire=False`,
        `bPvEDisableFriendlyFire=False`,
        ...plsLines,
        ...dlsLines,
      ].join('\n');
      fs.writeFileSync(path.join(cfgDir, 'Game.ini'), gameIni + '\n');
    }

    // ── ARK: SURVIVAL EVOLVED ─────────────────────────────────────────────────
    if (gameId === 'ark-se') {
      const cfgDir = path.join(dir, 'ShooterGame','Saved','Config','WindowsServer');
      if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });

      const gus = [
        '[ServerSettings]',
        `ServerAdminPassword=${v('ServerAdminPassword','admin123')}`,
        `ServerPassword=${v('ServerPassword','')}`,
        `MaxPlayers=${v('MaxPlayers','70')}`,
        `ServerPVE=${v('ServerPVE','false')}`,
        `RCONEnabled=${v('RCONEnabled','false')}`,
        `RCONPort=${v('RCONPort','32330')}`,
        `AdminLogging=${v('AdminLogging','true')}`,
        '',
        '# --- TASAS ---',
        `XPMultiplier=${v('XPMultiplier','1')}`,
        `TamingSpeedMultiplier=${v('TamingSpeedMultiplier','1')}`,
        `HarvestAmountMultiplier=${v('HarvestAmountMultiplier','1')}`,
        `HarvestHealthMultiplier=${v('HarvestHealthMultiplier','1')}`,
        `ResourcesRespawnPeriodMultiplier=${v('ResourcesRespawnPeriodMultiplier','1')}`,
        `ResourceNoReplenishRadiusPlayers=${v('ResourceNoReplenishRadiusPlayers','1')}`,
        `ResourceNoReplenishRadiusStructures=${v('ResourceNoReplenishRadiusStructures','1')}`,
        `PlayerCharacterFoodDrainMultiplier=${v('PlayerCharacterFoodDrainMultiplier','1')}`,
        `PlayerCharacterWaterDrainMultiplier=${v('PlayerCharacterWaterDrainMultiplier','1')}`,
        `PlayerCharacterStaminaDrainMultiplier=${v('PlayerCharacterStaminaDrainMultiplier','1')}`,
        `PlayerCharacterHealthRecoveryMultiplier=${v('PlayerCharacterHealthRecoveryMultiplier','1')}`,
        `DinoCharacterFoodDrainMultiplier=${v('DinoCharacterFoodDrainMultiplier','1')}`,
        `DinoCharacterStaminaDrainMultiplier=${v('DinoCharacterStaminaDrainMultiplier','1')}`,
        `DinoCharacterHealthRecoveryMultiplier=${v('DinoCharacterHealthRecoveryMultiplier','1')}`,
        '',
        '# --- BREEDING ---',
        `MatingIntervalMultiplier=${v('MatingIntervalMultiplier','1')}`,
        `MatingSpeedMultiplier=${v('MatingSpeedMultiplier','1')}`,
        `EggHatchSpeedMultiplier=${v('EggHatchSpeedMultiplier','1')}`,
        `BabyMatureSpeedMultiplier=${v('BabyMatureSpeedMultiplier','1')}`,
        `BabyFoodConsumptionSpeedMultiplier=${v('BabyFoodConsumptionSpeedMultiplier','1')}`,
        `BabyCuddleIntervalMultiplier=${v('BabyCuddleIntervalMultiplier','1')}`,
        `BabyCuddleGracePeriodMultiplier=${v('BabyCuddleGracePeriodMultiplier','1')}`,
        `BabyCuddleLoseImprintQualitySpeedMultiplier=${v('BabyCuddleLoseImprintQualitySpeedMultiplier','1')}`,
        `BabyImprintingStatScaleMultiplier=${v('BabyImprintingStatScaleMultiplier','1')}`,
        '',
        '# --- COMBATE ---',
        `PlayerDamageMultiplier=${v('PlayerDamageMultiplier','1')}`,
        `PlayerResistanceMultiplier=${v('PlayerResistanceMultiplier','1')}`,
        `DinoDamageMultiplier=${v('DinoDamageMultiplier','1')}`,
        `DinoResistanceMultiplier=${v('DinoResistanceMultiplier','1')}`,
        `TamedDinoResistanceMultiplier=${v('TamedDinoResistanceMultiplier','1')}`,
        `TamedDinoDamageMultiplier=${v('TamedDinoDamageMultiplier','1')}`,
        `StructureDamageMultiplier=${v('StructureDamageMultiplier','1')}`,
        `StructureResistanceMultiplier=${v('StructureResistanceMultiplier','1')}`,
        `DinoCountMultiplier=${v('DinoCountMultiplier','1')}`,
        `MaxPersonalTamedDinos=${v('MaxPersonalTamedDinos','40')}`,
        `MaxTamedDinos=${v('MaxTamedDinos','5000')}`,
        '',
        '# --- ENTORNO ---',
        `DayTimeSpeedScale=${v('DayTimeSpeedScale','1')}`,
        `NightTimeSpeedScale=${v('NightTimeSpeedScale','1')}`,
        `OverrideOfficialDifficulty=${v('OverrideOfficialDifficulty','5.0')}`,
        `DifficultyOffset=${v('DifficultyOffset','1.0')}`,
        `ServerHardcore=${v('ServerHardcore','false')}`,
        `AllowFlyerCarryPvE=${v('AllowFlyerCarryPvE','false')}`,
        `PreventDinoTaming=${v('PreventDinoTaming','false')}`,
        `AllowRaidDinoFeeding=${v('AllowRaidDinoFeeding','false')}`,
        `EnableCryoSicknessPVE=${v('EnableCryoSicknessPVE','false')}`,
        '',
        '# --- CLUSTER / TRANSFERENCIAS ---',
        `noTributeDownloads=${v('noTributeDownloads','false')}`,
        `PreventDownloadSurvivors=${v('PreventDownloadSurvivors','false')}`,
        `PreventDownloadDinos=${v('PreventDownloadDinos','false')}`,
        `PreventDownloadItems=${v('PreventDownloadItems','false')}`,
        `PreventUploadSurvivors=${v('PreventUploadSurvivors','false')}`,
        `PreventUploadDinos=${v('PreventUploadDinos','false')}`,
        `PreventUploadItems=${v('PreventUploadItems','false')}`,
        `CrossARKAllowForeignDinoDownloads=${v('CrossARKAllowForeignDinoDownloads','false')}`,
        '',
        '# --- TRIBUS ---',
        `AllowTribeWarPvE=${v('AllowTribeWarPvE','false')}`,
        `AllowTribeWarCancelPvE=${v('AllowTribeWarCancelPvE','false')}`,
        `PreventTribeAlliances=${v('PreventTribeAlliances','false')}`,
        `TribeLogDestroyedEnemyStructures=${v('TribeLogDestroyedEnemyStructures','true')}`,
        '',
        '[SessionSettings]',
        `SessionName=${v('SessionName','Mi ARK SE Server')}`,
        `MultiHome=`,
        `Port=${v('Port','7778')}`,
        `QueryPort=${v('QueryPort','27017')}`,
        '',
        '[/Script/Engine.GameSession]',
        `MaxPlayers=${v('MaxPlayers','70')}`,
      ].join('\n');
      fs.writeFileSync(path.join(cfgDir, 'GameUserSettings.ini'), gus + '\n');

      // Game.ini
      const plsIdx = { pls_health:0, pls_stamina:1, pls_oxygen:3, pls_food:4,
                       pls_water:5, pls_weight:7, pls_damage:8, pls_speed:9, pls_crafting:11 };
      const dlsIdx = { dls_health:0, dls_stamina:1, dls_weight:7, dls_damage:8 };

      const plsLines = Object.entries(plsIdx)
        .filter(([k]) => v(k,'1') !== '1')
        .map(([k,i]) => `PerLevelStatsMultiplier_Player[${i}]=${v(k,'1')}`);

      const dlsLines = Object.entries(dlsIdx)
        .filter(([k]) => v(k,'1') !== '1')
        .map(([k,i]) => `PerLevelStatsMultiplier_DinoTamed[${i}]=${v(k,'1')}`);

      const gameIni = [
        '[/script/shootergame.shootergamemode]',
        `MaxNumberOfPlayersInTribe=${v('MaxNumberOfPlayersInTribe','10')}`,
        `MaxTribeAlliances=${v('MaxTribeAlliances','10')}`,
        `TribeNameChangeCooldown=${v('TribeNameChangeCooldown','15')}`,
        `bDisableFriendlyFire=False`,
        `bPvEDisableFriendlyFire=False`,
        ...plsLines,
        ...dlsLines,
      ].join('\n');
      fs.writeFileSync(path.join(cfgDir, 'Game.ini'), gameIni + '\n');
    }

    // ── VALHEIM ───────────────────────────────────────────────────────────────
    // Valheim uses command line args only — no persistent config file to write

    // ── CONAN EXILES ──────────────────────────────────────────────────────────
    if (gameId === 'conan') {
      const cfgDir = path.join(dir, 'ConanSandbox','Saved','Config','WindowsServer');
      if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });

      const ini = [
        '[ServerSettings]',
        `ServerName=${v('ServerName','Mi Conan Server')}`,
        `MaxPlayers=${v('MaxPlayers','40')}`,
        `ServerPassword=${v('ServerPassword','')}`,
        `AdminPassword=${v('AdminPassword','admin123')}`,
        `IsBattleEyeEnabled=${v('IsBattleEyeEnabled','true')}`,
        `MaxNudity=${v('MaxNudity','2')}`,
        `PVPEnabled=${v('PVPEnabled','true')}`,
        `PVPBlitzServer=${v('PVPBlitzServer','false')}`,
        `DropOnDeath=${v('DropOnDeath','0')}`,
        '',
        '# --- TASAS ---',
        `XPRateMultiplier=${v('XPRateMultiplier','1')}`,
        `HarvestAmountMultiplier=${v('HarvestAmountMultiplier','1')}`,
        `ResourceRespawnSpeedMultiplier=${v('ResourceRespawnSpeedMultiplier','1')}`,
        `ItemSpoilRateScale=${v('ItemSpoilRateScale','1')}`,
        `ItemConvertionMultiplier=${v('ItemConvertionMultiplier','1')}`,
        `CraftingCostMultiplier=${v('CraftingCostMultiplier','1')}`,
        `DurabilityMultiplier=${v('DurabilityMultiplier','1')}`,
        '',
        '# --- SUPERVIVENCIA ---',
        `PlayerActiveThirstMult=${v('PlayerActiveThirstMult','1')}`,
        `PlayerIdleThirstMult=${v('PlayerIdleThirstMult','1')}`,
        `PlayerActiveHungerMult=${v('PlayerActiveHungerMult','1')}`,
        `PlayerIdleHungerMult=${v('PlayerIdleHungerMult','1')}`,
        `StaminaCostMultiplier=${v('StaminaCostMultiplier','1')}`,
        `PlayerHealthMultiplier=${v('PlayerHealthMultiplier','1')}`,
        `LogoutCharacterPersistenceTime=${v('LogoutCharacterPersistenceTime','0')}`,
        `UnconsciousnessDurationMultiplier=${v('UnconsciousnessDurationMultiplier','1')}`,
        '',
        '# --- COMBATE ---',
        `PlayerDamageMultiplier=${v('PlayerDamageMultiplier','1')}`,
        `NPCDamageMultiplier=${v('NPCDamageMultiplier','1')}`,
        `NPCHealthMultiplier=${v('NPCHealthMultiplier','1')}`,
        `PlayerKnockbackMultiplier=${v('PlayerKnockbackMultiplier','1')}`,
        `NPCKnockbackMultiplier=${v('NPCKnockbackMultiplier','1')}`,
        `AwarenessRangeMultiplier=${v('AwarenessRangeMultiplier','1')}`,
        '',
        '# --- CONSTRUCCIÓN ---',
        `BuildingDamageMultiplier=${v('BuildingDamageMultiplier','1')}`,
        `MaxBuildingBuildingHeight=${v('MaxBuildingBuildingHeight','128')}`,
        `ClanMaxSize=${v('ClanMaxSize','10')}`,
        `ContainerPreventLooting=${v('ContainerPreventLooting','0')}`,
        `NetherDamageMultiplier=${v('NetherDamageMultiplier','1')}`,
        `ThrallWakeupTime=${v('ThrallWakeupTime','420')}`,
        `ThrallConversionMultiplier=${v('ThrallConversionMultiplier','1')}`,
        `PetConversionMultiplier=${v('PetConversionMultiplier','1')}`,
        '',
        '# --- PURGA ---',
        `EnablePurge=${v('EnablePurge','true')}`,
        `PurgeLevel=${v('PurgeLevel','6')}`,
        `PurgeSuspectThreshold=${v('PurgeSuspectThreshold','42000')}`,
        `PurgeTriggerDelay=${v('PurgeTriggerDelay','5')}`,
        `PurgePreparationTime=${v('PurgePreparationTime','10')}`,
        `PurgeDuration=${v('PurgeDuration','30')}`,
        `PurgeMaxStoredActivations=${v('PurgeMaxStoredActivations','1')}`,
        `MinimumOnlinePlayersForPurge=${v('MinimumOnlinePlayersForPurge','1')}`,
      ].join('\n');
      fs.writeFileSync(path.join(cfgDir, 'ServerSettings.ini'), ini + '\n');
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── STOP SERVER ──────────────────────────────────────────────────────────────
ipcMain.handle('stop-server', (_, serverId) => {
  const p = procs[serverId];
  if (!p) return { success: false, error: 'No está corriendo' };
  try { p.kill(); delete procs[serverId]; return { success: true }; } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('get-status', (_, serverId) => ({ running: !!procs[serverId], pid: procs[serverId]?.pid }));

ipcMain.handle('get-local-ip', () => {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
});

ipcMain.handle('get-gateway', () => {
  try {
    const out = execSync('ipconfig', { encoding: 'utf8' });
    const m = out.match(/puerta de enlace predeterminada[^\d]*([\d.]+)/i)
           || out.match(/default gateway[^\d]*([\d.]+)/i);
    return m ? m[1] : null;
  } catch { return null; }
});

ipcMain.handle('open-url', (_, url) => shell.openExternal(url));

ipcMain.handle('open-ports', (_, { gameId }) => {
  const game = GAMES[gameId];
  if (!game) return { success: false, error: 'Juego no encontrado' };
  const port = game.port;
  const ruleName = `InfernoHost-${gameId}`;
  const protos = gameId === 'valheim' ? ['UDP'] : ['TCP'];

  const applyRule = (proto) => {
    try {
      execSync(
        `netsh advfirewall firewall add rule name="${ruleName}-${proto}" dir=in action=allow protocol=${proto} localport=${port}`,
        { stdio: 'pipe' }
      );
    } catch {
      // Elevate with UAC if permission denied
      execSync(
        `powershell -Command "Start-Process cmd -Verb RunAs -ArgumentList '/c netsh advfirewall firewall add rule name=${ruleName}-${proto} dir=in action=allow protocol=${proto} localport=${port}' -Wait"`,
        { stdio: 'pipe', timeout: 30000 }
      );
    }
  };

  try {
    for (const proto of protos) applyRule(proto);
    return { success: true, port };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── DATA PATHS / SETTINGS ───────────────────────────────────────────────────
ipcMain.handle('get-data-paths', () => ({ dataDir: DATA_DIR, serversDir: SERVERS_DIR }));

ipcMain.handle('open-data-folder', () => shell.openPath(DATA_DIR));

ipcMain.handle('get-installed-games', () => {
  const result = {};
  for (const id of Object.keys(GAMES)) {
    const dir = path.join(SERVERS_DIR, id);
    let installed = false;
    if (fs.existsSync(dir)) {
      if (id === 'minecraft') installed = fs.existsSync(path.join(dir, 'server.jar'));
      else { try { installed = fs.readdirSync(dir).length > 3; } catch {} }
    }
    result[id] = { installed, dir };
  }
  return result;
});

ipcMain.handle('send-command', (_, { serverId, cmd }) => {
  const p = procs[serverId];
  if (!p || !p.stdin) return { success: false };
  try { p.stdin.write(cmd + '\n'); return { success: true }; } catch { return { success: false }; }
});

// ─── LICENSE SYSTEM ───────────────────────────────────────────────────────────
// Supabase (validación online)
const SUPA_URL  = 'https://nxurvtvoqfsvgbfdphhp.supabase.co';
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im54dXJ2dHZvcWZzdmdiZmRwaGhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTM2ODQsImV4cCI6MjA5NjUyOTY4NH0.Nu-FMX-atRJrj_GaxUx-x-BUaXHgnODhApwMze8OnGE';

function getMachineId() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface) {
      if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
        return addr.mac.replace(/:/g, '').toUpperCase();
      }
    }
  }
  return crypto.createHash('md5')
    .update(os.hostname() + os.platform() + os.arch())
    .digest('hex').toUpperCase().substring(0, 12);
}

function formatDisplayId(mid) {
  return mid.substring(0,4)+'-'+mid.substring(4,8)+'-'+mid.substring(8,12);
}

function generateLicenseKey(machineId) {
  const hash = crypto.createHmac('sha256', LICENSE_SECRET)
    .update(machineId.toUpperCase()).digest('hex').toUpperCase();
  return `INFERNO-${hash.substring(0,4)}-${hash.substring(4,8)}-${hash.substring(8,12)}-${hash.substring(12,16)}`;
}

function validateLicenseKey(key, machineId) {
  if (!key) return false;
  return key.trim().toUpperCase() === generateLicenseKey(machineId.toUpperCase());
}

// Verificar licencia en Supabase (online)
async function checkLicenseOnline(machineId) {
  try {
    const res = await fetch(
      `${SUPA_URL}/rest/v1/licencias?machine_id=eq.${encodeURIComponent(machineId)}&select=activa,expira_en,license_key`,
      { headers: { 'apikey': SUPA_ANON, 'Authorization': `Bearer ${SUPA_ANON}` }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows || rows.length === 0) return null;
    const row = rows[0];
    if (!row.activa) return { valid: false, reason: 'revoked' };
    if (row.expira_en && new Date(row.expira_en) < new Date()) return { valid: false, reason: 'expired' };
    return { valid: true, key: row.license_key };
  } catch { return null; } // sin internet → null, usar validación local
}

// Registrar activación en Supabase
async function registerLicenseOnline(machineId, licenseKey) {
  try {
    await fetch(`${SUPA_URL}/rest/v1/licencias`, {
      method: 'POST',
      headers: {
        'apikey': SUPA_ANON, 'Authorization': `Bearer ${SUPA_ANON}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ machine_id: machineId, license_key: licenseKey }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {} // silencioso si no hay internet
}

function loadLicense() {
  const machineId = getMachineId();
  let data = { installDate: null, licenseKey: null };
  if (fs.existsSync(LICENSE_FILE)) {
    try { data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8')); } catch {}
  }
  if (!data.installDate) {
    data.installDate = new Date().toISOString();
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2));
  }
  const installDate  = new Date(data.installDate);
  const now          = new Date();
  const daysPassed   = Math.floor((now - installDate) / (1000 * 60 * 60 * 24));
  const daysLeft     = Math.max(0, TRIAL_DAYS - daysPassed);
  const trialExpired = daysLeft === 0;
  const licensed     = validateLicenseKey(data.licenseKey, machineId);
  return {
    machineId, displayId: formatDisplayId(machineId),
    installDate: data.installDate, daysPassed, daysLeft,
    trialExpired, licensed, active: licensed || !trialExpired,
  };
}

// get-license-info: primero local, luego verifica online en background
ipcMain.handle('get-license-info', async () => {
  const local = loadLicense();
  // Si ya está licenciado localmente, verificar online de fondo (no bloquear UI)
  if (local.licensed) {
    checkLicenseOnline(local.machineId).then(online => {
      if (online && !online.valid) {
        // Licencia revocada online → limpiar local
        let data = {};
        if (fs.existsSync(LICENSE_FILE)) { try { data = JSON.parse(fs.readFileSync(LICENSE_FILE,'utf-8')); } catch {} }
        data.licenseKey = null;
        fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2));
        if (win) win.webContents.send('license-revoked');
      }
    }).catch(() => {});
  }
  return local;
});

ipcMain.handle('activate-license', async (_, key) => {
  const machineId = getMachineId();
  if (!validateLicenseKey(key, machineId)) {
    return { success: false, error: 'Clave inválida para esta máquina.' };
  }
  // Guardar local
  let data = {};
  if (fs.existsSync(LICENSE_FILE)) { try { data = JSON.parse(fs.readFileSync(LICENSE_FILE,'utf-8')); } catch {} }
  data.licenseKey = key.trim().toUpperCase();
  fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2));
  // Registrar en Supabase (async, no bloquea)
  registerLicenseOnline(machineId, data.licenseKey).catch(() => {});
  return { success: true };
});

// ─── INSTALL JAVA ─────────────────────────────────────────────────────────────
ipcMain.handle('install-java', async (event) => {
  const send = (d) => event.sender.send('install-log', d);

  try {
    send({ text: 'Buscando Java 21 (Eclipse Temurin)...', pct: 5 });

    // Limpiar zips viejos que puedan estar bloqueados
    try {
      for (const f of fs.readdirSync(DATA_DIR)) {
        if (f.startsWith('java21') && f.endsWith('.zip')) {
          fs.unlinkSync(path.join(DATA_DIR, f));
        }
      }
    } catch {}

    const releases = await fetchJSON(
      'https://api.adoptium.net/v3/assets/latest/21/hotspot?os=windows&architecture=x64&image_type=jre&jvm_impl=hotspot&vendor=eclipse'
    );
    const pkg = releases?.[0]?.binary?.package;
    if (!pkg?.link) throw new Error('No se encontró descarga de Java 21');

    const sizeMB = Math.round((pkg.size || 50000000) / 1024 / 1024);
    // Nombre único para evitar conflictos con descargas previas bloqueadas
    const zipPath = path.join(DATA_DIR, `java21_${Date.now()}.zip`);

    send({ text: `Descargando Java 21 JRE (~${sizeMB} MB)...`, pct: 10 });
    await downloadFile(pkg.link, zipPath,
      (p) => send({ text: `Descargando Java 21 JRE...`, pct: Math.round(10 + p * 65) })
    );

    send({ text: 'Extrayendo Java...', pct: 78 });

    // Limpiar contenido viejo de JAVA_DIR antes de extraer
    if (fs.existsSync(JAVA_DIR)) {
      for (const e of fs.readdirSync(JAVA_DIR)) {
        try { fs.rmSync(path.join(JAVA_DIR, e), { recursive: true, force: true }); } catch {}
      }
    } else {
      fs.mkdirSync(JAVA_DIR, { recursive: true });
    }

    const psScript = path.join(os.tmpdir(), 'ih_java_extract.ps1');
    fs.writeFileSync(psScript,
      `Expand-Archive -Force "${zipPath}" "${JAVA_DIR}"\n`, 'utf8');
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${psScript}"`, { timeout: 180000 });

    try { fs.unlinkSync(zipPath); } catch {}

    // Mostrar qué se extrajo para diagnóstico
    const entries = fs.existsSync(JAVA_DIR) ? fs.readdirSync(JAVA_DIR) : [];
    send({ text: `Carpeta Java: ${entries.join(', ') || '(vacía)'}`, pct: 92 });

    const exe = getJavaExe();
    if (exe === 'java') {
      throw new Error(`java.exe no encontrado. Contenido: [${entries.join(', ') || 'vacío'}]`);
    }

    send({ text: '✓ Java 21 instalado. Continuando con Minecraft...', pct: 100 });
    return { success: true };
  } catch (err) {
    send({ text: '✗ Error instalando Java: ' + err.message, pct: 0, error: true });
    return { success: false, error: err.message };
  }
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getJavaExe() {
  if (fs.existsSync(JAVA_DIR)) {
    for (const entry of fs.readdirSync(JAVA_DIR)) {
      const candidate = path.join(JAVA_DIR, entry, 'bin', 'java.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'java';
}

function runSteamCmd(args, onLine, allowedCodes = [0]) {
  return new Promise((resolve, reject) => {
    const exe  = path.join(STEAMCMD, 'steamcmd.exe');
    const proc = spawn(exe, args);
    proc.stdout.on('data', d => d.toString().split('\n').forEach(l => l.trim() && onLine && onLine(l.trim())));
    proc.stderr.on('data', d => d.toString().split('\n').forEach(l => l.trim() && onLine && onLine(l.trim())));
    proc.on('close', code => {
      // Código 7 = SteamCMD se auto-actualizó y se reinició (normal en primera ejecución)
      if (allowedCodes.includes(code) || code === 7) resolve();
      else reject(new Error(`SteamCMD salió con código ${code}`));
    });
    proc.on('error', reject);
  });
}

function downloadFile(url, dest, onProgress, _hops = 0) {
  return new Promise((resolve, reject) => {
    if (_hops > 10) return reject(new Error('Demasiados redirects'));
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, res => {
      // Seguir redirects sin abrir el archivo todavía
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadFile(res.headers.location, dest, onProgress, _hops + 1)
          .then(resolve).catch(reject);
      }
      // Crear el WriteStream SOLO cuando tenemos la URL final
      const file  = fs.createWriteStream(dest);
      const total = parseInt(res.headers['content-length'], 10) || 0;
      let recv = 0;
      res.on('data', chunk => { recv += chunk.length; if (onProgress && total) onProgress(recv / total); });
      res.pipe(file);
      file.on('finish', () => { file.close(resolve); });
      file.on('error', err => { file.destroy(); reject(err); });
      res.on('error',  err => { file.destroy(); reject(err); });
    }).on('error', reject);
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      res.on('error', reject);
    }).on('error', reject);
  });
}
