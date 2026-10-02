// 主进程：托盘常驻、全局热键、悬浮翻译窗
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  Tray,
  Menu,
  clipboard,
  shell,
  nativeImage,
} = require('electron');

// —— 兼容性开关（必须在 app ready 之前）——
// 在无显卡驱动 / 虚拟机 / 受限环境里，GPU 子进程会反复被杀、连带渲染进程崩溃
// （表现为窗口白屏、托盘无图标）。这套组合把 GPU 收进主进程并禁用其沙箱，实测稳定。
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.disableHardwareAcceleration();
const path = require('path');
const { translate } = require('./translate');
const { grabSelection, hasNativeInput } = require('./grab');

// 单实例（测试模式豁免，避免用户正开着工具时自测被锁踢出）
const IS_TEST = process.argv.includes('--selftest') || process.argv.includes('--grabtest');
const gotLock = IS_TEST ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ---------- 日志（写入 userData/run.log，便于排查）----------
const LOG_PATH = path.join(app.getPath('userData'), 'run.log');
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    require('fs').appendFileSync(LOG_PATH, line);
  } catch {}
  if (process.env.HUACI_DEBUG === '1') process.stdout.write('[huaci] ' + msg + '\n');
}
log('=== 启动 v1.0.0 (electron ' + process.versions.electron + ') ===');

let tray = null;
let popup = null;
let settingsWin = null;
let lastText = '';
let lastAt = 0;

// 热键（可在设置里改）
// 注意：不要用 Alt+Shift+X / Ctrl+Shift+X —— Alt+Shift 与 Ctrl+Shift 是 Windows
// 切换键盘布局/输入法的系统组合键，极易冲突（2026-10-03 用户实测反馈）。
const DEFAULT_HOTKEY = 'F9';

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
function loadConfig() {
  try {
    return JSON.parse(require('fs').readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return { hotkey: DEFAULT_HOTKEY, autoHideMs: 0 };
  }
}
function saveConfig(cfg) {
  try {
    require('fs').writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {}
}
let config = loadConfig();

// ---------- 悬浮窗 ----------
function createPopup() {
  popup = new BrowserWindow({
    width: 460,
    height: 260,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: false,
    backgroundColor: '#1b1d22',
    webPreferences: {
      preload: path.join(__dirname, 'preload-popup.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popup.loadFile(path.join(__dirname, 'ui', 'popup.html'));
  popup.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`popup 加载失败 code=${code} ${desc} ${url}`);
  });
  popup.webContents.on('did-finish-load', () => log('popup 加载完成'));
  popup.webContents.on('render-process-gone', (_e, d) => log('popup 渲染进程退出 ' + JSON.stringify(d)));
  popup.setAlwaysOnTop(true, 'screen-saver');
  popup.on('blur', () => {
    // 失焦不立即关，避免刚弹出就消失；由用户点关闭或按 Esc
  });
  popup.on('closed', () => {
    popup = null;
  });
}

function showPopupAtCursor() {
  if (!popup || popup.isDestroyed()) createPopup();
  const pt = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(pt);
  const [w, h] = popup.getSize();
  let x = Math.round(pt.x - w / 2);
  let y = Math.round(pt.y + 22);
  // 约束在屏幕内
  const wa = disp.workArea;
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - w - 8));
  if (y + h > wa.y + wa.height - 8) {
    y = Math.max(wa.y + 8, pt.y - h - 22); // 下方放不下就翻到上方
  }
  popup.setPosition(x, y);
  popup.showInactive();
  popup.setAlwaysOnTop(true, 'screen-saver');
}

// ---------- 翻译主流程 ----------
let busy = false;
async function doTranslate() {
  if (busy) return;
  busy = true;
  log('doTranslate 触发');
  try {
    // 若上一次的浮窗还开着且持有了焦点，Ctrl+C 会发到浮窗上（浮窗无选区 → 取词失败）。
    // 先让浮窗让位，焦点回到用户原本操作的窗口。
    if (popup && !popup.isDestroyed() && popup.isFocused()) {
      popup.hide();
      await new Promise((r) => setTimeout(r, 90));
    }
    const { text, mode, tries } = await grabSelection();
    log('取词结果 mode=' + mode + ' len=' + (text ? text.length : 0) + (tries ? ' tries=' + tries : ''));
    if (!text) {
      showPopupAtCursor();
      sendToPopup({ type: 'state', status: 'empty', mode, hotkey: config.hotkey });
      return;
    }
    // 去重：同一段文本 1.5s 内重复触发不重复请求
    const now = Date.now();
    if (text === lastText && now - lastAt < 1500) {
      showPopupAtCursor();
      return;
    }
    lastText = text;
    lastAt = now;

    showPopupAtCursor();
    sendToPopup({ type: 'state', status: 'loading', src: text, mode });

    const res = await translate(text);
    sendToPopup({ type: 'result', ...res, mode });
  } catch (e) {
    sendToPopup({ type: 'state', status: 'error', error: String(e && e.message ? e.message : e) });
  } finally {
    busy = false;
  }
}

function sendToPopup(payload) {
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send('popup:data', payload);
  }
}

// ---------- 托盘 ----------
function trayIcon() {
  // 用项目内 PNG 图标（SVG 在 Electron 里 createFromDataURL 会渲染为空）
  const fs = require('fs');
  const candidates = [
    path.join(__dirname, 'assets', 'tray-32.png'),
    path.join(__dirname, 'assets', 'tray-24.png'),
    path.join(__dirname, 'assets', 'tray-16.png'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img;
      }
    } catch {}
  }
  // 兜底：画一个纯色方块（保证托盘里至少有个点，不至于完全看不见）
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[i] = 47; buf[i + 1] = 111; buf[i + 2] = 237; buf[i + 3] = 255;
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function buildTray() {
  tray = new Tray(trayIcon());
  refreshTrayMenu();
  tray.setToolTip('划词翻译 · 选中文本后按 ' + config.hotkey);
  tray.on('double-click', () => doTranslate());
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '划词翻译', enabled: false },
    { type: 'separator' },
    { label: '翻译当前选中/剪贴板', click: () => doTranslate() },
    { label: `热键：${config.hotkey}`, enabled: false },
    { type: 'separator' },
    { label: '设置', click: () => openSettings() },
    { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ---------- 设置窗 ----------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 300,
    title: '划词翻译 · 设置',
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-popup.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'ui', 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// ---------- IPC ----------
ipcMain.handle('cfg:get', () => ({
  ...config,
  nativeInput: hasNativeInput(),
  hotkey: config.hotkey,
}));

ipcMain.handle('cfg:set', (_e, patch) => {
  const oldHotkey = config.hotkey;
  config = { ...config, ...patch };
  saveConfig(config);
  if (patch.hotkey && patch.hotkey !== oldHotkey) {
    registerHotkey();
  }
  refreshTrayMenu();
  if (tray) tray.setToolTip('划词翻译 · 选中文本后按 ' + config.hotkey);
  return { ...config, nativeInput: hasNativeInput() };
});

ipcMain.handle('popup:copy', (_e, text) => {
  clipboard.writeText(text || '');
  return true;
});

ipcMain.handle('popup:retranslate', () => {
  lastText = '';
  doTranslate();
  return true;
});

ipcMain.handle('popup:close', () => {
  if (popup && !popup.isDestroyed()) popup.hide();
  return true;
});

ipcMain.handle('popup:resize', (_e, { width, height }) => {
  if (popup && !popup.isDestroyed()) {
    // 保持左上角不动，按内容调整高度
    const b = popup.getBounds();
    popup.setBounds({ x: b.x, y: b.y, width: b.width, height: Math.max(120, Math.min(700, Math.round(height))) });
  }
  return true;
});

ipcMain.handle('open:settings', () => {
  openSettings();
  return true;
});

// ---------- 热键注册 ----------
function registerHotkey() {
  globalShortcut.unregisterAll();
  try {
    const ok = globalShortcut.register(config.hotkey, () => doTranslate());
    if (!ok) {
      console.error('热键注册失败（可能被占用）:', config.hotkey);
    }
    return ok;
  } catch (e) {
    console.error('热键注册异常:', e.message);
    return false;
  }
}

// ---------- 生命周期 ----------
app.on('second-instance', () => {
  doTranslate();
});

// 命令行自测：electron . --selftest
// 依次验证 翻译引擎 / 取词模块 / 热键注册，打印结果后退出
const SELFTEST = process.argv.includes('--selftest');
if (SELFTEST) {
  // 抑制 GPU 报错刷屏
  app.commandLine.appendSwitch('log-level', '3');
}

// 命令行取词自测：electron . --grabtest
// 端到端验证「模拟 Ctrl+C 取词」是否真的能拿到当前选中内容，
// 以及取不到时是否会错误地回退到旧剪贴板（回归测试 2026-10-02 的 bug）。
const GRABTEST = process.argv.includes('--grabtest');
if (GRABTEST) app.commandLine.appendSwitch('log-level', '3');

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.lulu.huaci');

  if (GRABTEST) {
    const out = (k, v) => console.log('GRABTEST>>' + k + ' ' + JSON.stringify(v));
    out('electron', process.versions.electron);
    out('nativeInput', hasNativeInput());

    // 造一个带「已全选」文本框的窗口，模拟用户在别的程序里选中文字
    const os = require('os');
    const fsp = require('fs');
    const tmpHtml = path.join(os.tmpdir(), 'huaci-grabtest.html');
    fsp.writeFileSync(
      tmpHtml,
      '<!doctype html><meta charset="utf-8"><body style="margin:0">'
        + '<textarea id="t" style="width:98vw;height:60vh;font-size:18px">'
        + 'SENTINEL-NEW-SELECTION-42 sodium adsorption ratio'
        + '</textarea>'
        + '<script>window.addEventListener("load",function(){'
        + 'var t=document.getElementById("t");t.focus();t.setSelectionRange(0,t.value.length);'
        + '});</script></body>',
      'utf8'
    );
    const win = new BrowserWindow({
      width: 640, height: 360, show: true, title: 'grabtest',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    await win.loadFile(tmpHtml);
    win.focus();
    await new Promise((r) => setTimeout(r, 500));

    // 用例 A：剪贴板里先放一句「旧句子」，且当前有选区。
    // 期望：取到的是选区内容（SENTINEL…），且随后剪贴板被还原成旧句子。
    clipboard.writeText('STALE-OLD-CLIPBOARD-CONTENT');
    const rA = await grabSelection({ guardMs: 0 });
    out('caseA_fresh', { mode: rA.mode, tries: rA.tries, len: rA.text.length, head: rA.text.slice(0, 45) });
    out('caseA_clipboardRestored', clipboard.readText());

    // 用例 B：没有任何选区（把选区折叠、并让文本框失焦），剪贴板里是旧句子。
    // 期望：mode=failed、text 为空 —— 绝不能返回旧剪贴板内容。
    const info = await win.webContents.executeJavaScript(
      'var t=document.getElementById("t");'
        + 'window.getSelection().removeAllRanges();'
        + 't.setSelectionRange(t.value.length,t.value.length);'
        + 't.blur();'
        + 'JSON.stringify({active:document.activeElement&&document.activeElement.tagName,'
        + 'ss:t.selectionStart,se:t.selectionEnd,len:t.value.length})'
    );
    out('caseB_selectionState', info);
    await new Promise((r) => setTimeout(r, 300));
    clipboard.writeText('STALE-OLD-CLIPBOARD-CONTENT');
    const rB = await grabSelection({ guardMs: 0, tries: 2, waitMs: 250 });
    out('caseB_noSelection', { mode: rB.mode, tries: rB.tries, len: rB.text.length, head: rB.text.slice(0, 45) });

    out('verdict', {
      A_ok: rA.mode === 'auto' && rA.text.indexOf('SENTINEL') >= 0,
      A_clipboard_ok: clipboard.readText().indexOf('STALE') >= 0,
      B_ok: rB.mode === 'failed' && rB.text === '',
    });
    app.exit(0);
    return;
  }

  if (SELFTEST) {
    const out = (k, v) => console.log('SELFTEST>>' + k + ' ' + JSON.stringify(v));
    out('electron', process.versions.electron);
    out('nativeInput', hasNativeInput());

    const cases = [
      'The sodium adsorption ratio (SAR) ranged from 1.2 to 8.5, indicating moderate sodicity hazard.',
      '灌溉水质评价',
      'Groundwater salinization in arid regions is mainly caused by evaporation and irrigation return flow.',
    ];
    for (const c of cases) {
      const r = await translate(c);
      out('trans', { ok: r.ok, from: r.from, to: r.to, dst: r.dst, engine: r.engine, ms: r.ms, err: r.error });
    }
    // 热键可用性（不注册，仅检查 API 存在）
    out('globalShortcutAPI', typeof globalShortcut.register === 'function');
    app.exit(0);
    return;
  }

  createPopup();
  buildTray();
  const hkOk = registerHotkey();
  log('初始化完成 tray=' + !!tray + ' hotkey=' + config.hotkey + ' hkOk=' + hkOk + ' nativeInput=' + hasNativeInput());

  // 首次启动给个提示
  setTimeout(() => {
    showPopupAtCursor();
    sendToPopup({
      type: 'state',
      status: 'ready',
      hotkey: config.hotkey,
      nativeInput: hasNativeInput(),
    });
  }, 600);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// 托盘常驻，不因窗口全关而退出
app.on('window-all-closed', (e) => {
  // 什么都不做，保持托盘运行
});
