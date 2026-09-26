import { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_SETTINGS,
  type TimerSettings,
  type TimerState,
  type Phase,
} from "../shared/timer";

const isMac = process.platform === "darwin";
const userDataDir = app.getPath("userData");
const settingsFile = path.join(userDataDir, "settings.json");
const historyFile = path.join(userDataDir, "history.json");

interface HistoryRecord {
  date: string; // YYYY-MM-DD（本地时间）
  phase: Phase;
  minutes: number;
  at: number;
  /** 旧记录没有该字段时按自然完成兼容。 */
  completed?: boolean;
  source?: "auto" | "manual" | "recovery";
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, "utf-8")) };
  } catch {
    return fallback;
  }
}

function readHistory(): HistoryRecord[] {
  try {
    const data = JSON.parse(fs.readFileSync(historyFile, "utf-8"));
    return Array.isArray(data.records) ? data.records : [];
  } catch {
    return [];
  }
}

function writeHistory(records: HistoryRecord[]) {
  // 预留导出/热力图等迭代字段
  fs.writeFileSync(historyFile, JSON.stringify({ version: 1, records }, null, 2));
}

function localDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: TimerSettings = { ...DEFAULT_SETTINGS };
let state: TimerState;

function loadAll() {
  settings = readJson<TimerSettings>(settingsFile, DEFAULT_SETTINGS);
  state = readJson<TimerState>(path.join(userDataDir, "state.json"), {
    phase: "focus",
    remainingMs: settings.focusMinutes * 60_000,
    completedFocus: 0,
    running: false,
    endAt: null,
    cycleId: 0,
  });
  // 恢复后不自动继续计时，防止后台漂移
  state = { ...state, running: false, endAt: null };
}

function persistState(s: TimerState) {
  state = s;
  fs.writeFileSync(
    path.join(userDataDir, "state.json"),
    JSON.stringify({ ...s, savedAt: Date.now() }),
  );
}

function notify(title: string, body: string) {
  if (settings.notificationEnabled) {
    new Notification({ title, body, silent: !settings.soundEnabled }).show();
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send("phase-finished", { title, body });
  }
}

function playSound(kind: string) {
  if (win && !win.isDestroyed() && settings.soundEnabled) {
    win.webContents.send("play-sound", kind);
  }
}

function recordHistory(
  phase: Phase,
  minutes: number,
  completed = true,
  source: "auto" | "manual" | "recovery" = completed ? "auto" : "manual",
) {
  if (minutes <= 0) return;
  const now = Date.now();
  const records = readHistory();
  records.push({ date: localDate(now), phase, minutes, at: now, completed, source });
  writeHistory(records);
}

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: settings.theme === "dark" ? "#1e1e2e" : "#fafafa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.once("ready-to-show", () => win?.show());
  win.on("close", (e) => {
    // 最小化到托盘：关闭窗口隐藏而非退出
    if ((win as unknown as { forceClose?: boolean }).forceClose) return;
    e.preventDefault();
    win?.hide();
  });
  win.on("closed", () => {
    win = null;
  });
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible()) win.hide();
  else win.show();
}

function createTray() {
  // 16x16 单像素透明占位图标，实际项目可替换为图标资源
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  );
  tray = new Tray(icon);
  tray.setToolTip("番茄钟助手");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示/隐藏主界面", click: toggleWindow },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  tray.on("click", toggleWindow);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    loadAll();
    createWindow();
    createTray();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else win?.show();
    });
  });
}

app.on("before-quit", () => {
  if (win) (win as unknown as { forceClose?: boolean }).forceClose = true;
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

// ---------- IPC ----------
ipcMain.handle("get-init", () => ({ settings, state, history: readHistory() }));

ipcMain.handle("set-settings", (_e, s: TimerSettings) => {
  settings = s;
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  return true;
});

ipcMain.handle("set-state", (_e, s: TimerState) => {
  persistState(s);
  return true;
});

ipcMain.handle("set-autostart", (_e, enabled: boolean) => {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: enabled ? ["--hidden"] : [],
  });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle("get-autostart", () => app.getLoginItemSettings().openAtLogin);

ipcMain.handle(
  "record-history",
  (
    _e,
    rec: {
      phase: Phase;
      minutes: number;
      completed?: boolean;
      source?: "auto" | "manual" | "recovery";
    },
  ) => {
    recordHistory(rec.phase, rec.minutes, rec.completed ?? true, rec.source);
    return readHistory();
  },
);

ipcMain.handle("clear-history", () => {
  writeHistory([]);
  return [];
});

ipcMain.handle("notify", (_e, p: { title: string; body: string }) => {
  notify(p.title, p.body);
});

ipcMain.handle("open-data-dir", () => {
  shell.openPath(userDataDir);
});

// 托盘 tooltip 展示剩余时间
ipcMain.handle("set-tray-title", (_e, title: string) => {
  tray?.setToolTip(`番茄钟助手 ${title}`);
  if (isMac) tray?.setTitle(title);
});
