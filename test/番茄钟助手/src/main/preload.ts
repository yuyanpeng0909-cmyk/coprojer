import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  getInit: () => ipcRenderer.invoke("get-init"),
  setSettings: (s: unknown) => ipcRenderer.invoke("set-settings", s),
  setState: (s: unknown) => ipcRenderer.invoke("set-state", s),
  setAutostart: (v: boolean) => ipcRenderer.invoke("set-autostart", v),
  getAutostart: () => ipcRenderer.invoke("get-autostart"),
  recordHistory: (rec: {
    phase: string;
    minutes: number;
    completed?: boolean;
    source?: "auto" | "manual" | "recovery";
  }) =>
    ipcRenderer.invoke("record-history", rec),
  clearHistory: () => ipcRenderer.invoke("clear-history"),
  notify: (p: { title: string; body: string }) => ipcRenderer.invoke("notify", p),
  openDataDir: () => ipcRenderer.invoke("open-data-dir"),
  setTrayTitle: (t: string) => ipcRenderer.invoke("set-tray-title", t),
  onPhaseFinished: (cb: (p: { title: string; body: string }) => void) => {
    const listener = (_e: unknown, p: { title: string; body: string }) => cb(p);
    ipcRenderer.on("phase-finished", listener);
    return () => ipcRenderer.removeListener("phase-finished", listener);
  },
  onPlaySound: (cb: (kind: string) => void) => {
    const listener = (_e: unknown, kind: string) => cb(kind);
    ipcRenderer.on("play-sound", listener);
    return () => ipcRenderer.removeListener("play-sound", listener);
  },
});
