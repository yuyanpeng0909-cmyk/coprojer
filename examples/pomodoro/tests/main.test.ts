import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { DEFAULT_SETTINGS } from "../src/shared/timer";

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const loginSettings = { openAtLogin: true };
  const setLoginItemSettings = vi.fn((next: { openAtLogin?: boolean }) => {
    if (typeof next.openAtLogin === "boolean") loginSettings.openAtLogin = next.openAtLogin;
  });
  const userDataDir = `${process.env.TEMP || "."}/pomodoro-main-test-${process.pid}-${Date.now()}`;
  return {
    handlers,
    loginSettings,
    setLoginItemSettings,
    userDataDir,
    app: {
      getPath: vi.fn(() => userDataDir),
      requestSingleInstanceLock: vi.fn(() => false),
      quit: vi.fn(),
      on: vi.fn(),
      whenReady: vi.fn(),
      setLoginItemSettings,
      getLoginItemSettings: vi.fn(() => ({ ...loginSettings })),
    },
    ipcMain: {
      handle: vi.fn((name: string, handler: (...args: any[]) => unknown) => {
        handlers.set(name, handler);
      }),
    },
  };
});

vi.mock("electron", () => ({
  app: electronMock.app,
  BrowserWindow: class {},
  Tray: class {},
  Menu: { buildFromTemplate: vi.fn() },
  Notification: class {},
  ipcMain: electronMock.ipcMain,
  shell: { openPath: vi.fn() },
  nativeImage: { createFromDataURL: vi.fn() },
}));

describe("主进程开机自启设置", () => {
  beforeAll(async () => {
    mkdirSync(electronMock.userDataDir, { recursive: true });
    await import("../src/main/main");
  });

  beforeEach(() => {
    electronMock.setLoginItemSettings.mockClear();
    electronMock.loginSettings.openAtLogin = true;
  });

  afterAll(() => {
    electronMock.handlers.clear();
    rmSync(electronMock.userDataDir, { recursive: true, force: true });
  });

  it("保存普通设置不会关闭已开启的开机自启", async () => {
    const handler = electronMock.handlers.get("set-settings");
    expect(handler).toBeDefined();

    await handler!(null, { ...DEFAULT_SETTINGS, theme: "dark" });

    expect(electronMock.setLoginItemSettings).not.toHaveBeenCalled();
    expect(electronMock.handlers.get("get-autostart")!(null)).toBe(true);
  });

  it("开机自启状态只由 set-autostart 修改", async () => {
    const handler = electronMock.handlers.get("set-autostart");
    expect(handler).toBeDefined();

    await handler!(null, false);

    expect(electronMock.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      args: [],
    });
    expect(electronMock.handlers.get("get-autostart")!(null)).toBe(false);
  });
});
