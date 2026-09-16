import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  DEFAULT_SETTINGS,
  createInitialState,
  formatMs,
  pause,
  reset,
  skip,
  start,
  tick,
  type Phase,
  type TimerSettings,
  type TimerState,
} from "../shared/timer";

declare global {
  interface Window {
    api: {
      getInit: () => Promise<{
        settings: TimerSettings;
        state: TimerState;
        history: { date: string; phase: Phase; minutes: number; at: number }[];
      }>;
      setSettings: (s: TimerSettings) => Promise<boolean>;
      setState: (s: TimerState) => Promise<boolean>;
      setAutostart: (v: boolean) => Promise<boolean>;
      getAutostart: () => Promise<boolean>;
      recordHistory: (rec: { phase: Phase; minutes: number }) => Promise<
        { date: string; phase: Phase; minutes: number; at: number }[]
      >;
      notify: (p: { title: string; body: string }) => Promise<void>;
      openDataDir: () => Promise<void>;
      setTrayTitle: (t: string) => Promise<void>;
      onPhaseFinished: (cb: (p: { title: string; body: string }) => void) => () => void;
      onPlaySound: (cb: (kind: string) => void) => () => void;
    };
  }
}

const PHASE_LABEL: Record<Phase, string> = {
  focus: "专注中",
  shortBreak: "短休息",
  longBreak: "长休息",
};

const PHASE_NOTICE: Record<Phase, string> = {
  focus: "专注开始",
  shortBreak: "短休息开始",
  longBreak: "长休息开始",
};

type History = { date: string; phase: Phase; minutes: number; at: number }[];

function beep(kind: string) {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const notes = kind === "long" ? [660, 660, 880, 880] : [880, 660];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = "sine";
      g.gain.setValueAtTime(0.12, ctx.currentTime + i * 0.25);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.25 + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.25);
      o.stop(ctx.currentTime + i * 0.25 + 0.24);
    });
    setTimeout(() => void ctx.close(), 1500);
  } catch {
    /* 忽略音频错误 */
  }
}

function localDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function phaseFullMs(s: TimerSettings, p: Phase): number {
  return (p === "focus" ? s.focusMinutes : p === "shortBreak" ? s.shortBreakMinutes : s.longBreakMinutes) * 60_000;
}

function App() {
  const [ready, setReady] = useState(false);
  const [settings, setSettingsState] = useState<TimerSettings>(DEFAULT_SETTINGS);
  const [state, setStateObj] = useState<TimerState>(createInitialState());
  const [history, setHistory] = useState<History>([]);
  const [autostart, setAutostartFlag] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [tab, setTab] = useState<"stats" | "settings">("stats");
  const stateRef = useRef(state);
  stateRef.current = state;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  };

  // 初始化
  useEffect(() => {
    void (async () => {
      const init = await window.api.getInit();
      setSettingsState(init.settings);
      setHistory(init.history);
      setStateObj(init.state);
      setAutostartFlag(await window.api.getAutostart());
      document.documentElement.dataset.theme = init.settings.theme;
      setReady(true);
    })();
  }, []);

  // 计时循环：500ms tick，基于绝对时间戳（规避后台节流）
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      const cur = stateRef.current;
      if (!cur.running) return;
      const { state: next, finished } = tick(settingsRef.current, cur, Date.now());
      if (finished.length > 0) {
        const lastPhase = finished[finished.length - 1];
        void window.api.notify({
          title: PHASE_NOTICE[next.phase],
          body: PHASE_LABEL[lastPhase] + "已结束，" + PHASE_NOTICE[next.phase],
        });
        beep(next.phase === "longBreak" ? "long" : "short");
        const focusCount = finished.filter((p) => p === "focus").length;
        if (focusCount > 0) {
          void window.api
            .recordHistory({
              phase: "focus",
              minutes: focusCount * settingsRef.current.focusMinutes,
            })
            .then(setHistory);
        }
        setStateObj(next);
        void window.api.setState(next);
      } else {
        setStateObj(next);
        void window.api.setTrayTitle(formatMs(next.remainingMs));
      }
    }, 500);
    return () => clearInterval(id);
  }, [ready]);

  useEffect(
    () =>
      window.api.onPhaseFinished((p) => {
        showToast(p.body);
      }),
    [],
  );
  useEffect(
    () =>
      window.api.onPlaySound((kind) => {
        beep(kind);
      }),
    [],
  );

  const updateState = (next: TimerState) => {
    setStateObj(next);
    void window.api.setState(next);
  };

  const applySettings = (next: TimerSettings) => {
    setSettingsState(next);
    void window.api.setSettings(next);
    document.documentElement.dataset.theme = next.theme;
    // 非运行状态下同步新时长到当前周期剩余时间
    const cur = stateRef.current;
    if (!cur.running) {
      updateState({
        ...cur,
        remainingMs: phaseFullMs(next, cur.phase),
        cycleId: cur.cycleId + 1,
      });
    }
  };

  const stats = useMemo(() => {
    const today = localDate(Date.now());
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    weekStart.setHours(0, 0, 0, 0);
    const monthPrefix = today.slice(0, 7);
    let day = 0;
    let week = 0;
    let month = 0;
    let pomodoros = 0;
    for (const r of history) {
      if (r.phase !== "focus") continue;
      pomodoros++;
      if (r.date === today) day += r.minutes;
      if (new Date(r.at) >= weekStart) week += r.minutes;
      if (r.date.startsWith(monthPrefix)) month += r.minutes;
    }
    return { day, week, month, pomodoros };
  }, [history]);

  if (!ready) return <div className="muted">加载中…</div>;

  const fullMs = phaseFullMs(settings, state.phase);
  const doneDots =
    state.completedFocus > 0 && state.completedFocus % settings.longBreakEvery === 0
      ? settings.longBreakEvery
      : state.completedFocus % settings.longBreakEvery;

  return (
    <>
      {toast && <div className="toast">{toast}</div>}
      <div className="card">
        <div className="phase-label">{PHASE_LABEL[state.phase]}</div>
        <div className="timer-display">{formatMs(state.remainingMs)}</div>
        <div className="dots">
          {Array.from({ length: settings.longBreakEvery }, (_, i) => (
            <span key={i} className={"dot" + (i < doneDots ? " done" : "")} />
          ))}
        </div>
        <div className="controls">
          {state.running ? (
            <button className="primary" onClick={() => updateState(pause(state, Date.now()))}>
              暂停
            </button>
          ) : (
            <button
              className="primary"
              onClick={() => updateState(start(settings, state, Date.now()))}
            >
              {state.remainingMs === fullMs && !state.running && state.cycleId === 0 ? "开始" : "继续"}
            </button>
          )}
          <button onClick={() => updateState(reset(settings, state, Date.now()))}>重置</button>
          <button
            onClick={() => {
              const { state: next, skippedFocusMs } = skip(settings, state, Date.now());
              const mins = Math.floor(skippedFocusMs / 60_000);
              if (mins >= 1) {
                void window.api
                  .recordHistory({ phase: "focus", minutes: mins })
                  .then(setHistory);
                showToast(`已手动结束，记录专注 ${mins} 分钟`);
              } else {
                showToast("已手动结束当前周期");
              }
              updateState(next);
            }}
          >
            结束本周期
          </button>
        </div>
        <div className="muted" style={{ textAlign: "center", marginTop: 10 }}>
          已完成番茄 {state.completedFocus} 个 · 每 {settings.longBreakEvery} 个后长休息 {settings.longBreakMinutes} 分钟
        </div>
      </div>

      <div className="tabs">
        <button className={tab === "stats" ? "active" : ""} onClick={() => setTab("stats")}>
          统计与历史
        </button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>
          设置
        </button>
      </div>

      {tab === "stats" ? (
        <>
          <div className="card">
            <h3>专注统计（分钟）</h3>
            <div className="stats-row">
              <div className="stat">
                <b>{stats.day}</b>
                <span>今日</span>
              </div>
              <div className="stat">
                <b>{stats.week}</b>
                <span>本周</span>
              </div>
              <div className="stat">
                <b>{stats.month}</b>
                <span>本月</span>
              </div>
              <div className="stat">
                <b>{stats.pomodoros}</b>
                <span>累计番茄</span>
              </div>
            </div>
          </div>
          <div className="card">
            <h3>最近记录</h3>
            <div className="history-list">
              {history.length === 0 && <div className="muted">暂无记录</div>}
              {[...history]
                .reverse()
                .slice(0, 30)
                .map((r, i) => (
                  <div className="history-item" key={i}>
                    <b>
                      {r.date} {PHASE_LABEL[r.phase]}
                    </b>
                    <span>{r.minutes} 分钟</span>
                  </div>
                ))}
            </div>
          </div>
        </>
      ) : (
        <div className="card">
          <h3>时长（分钟）</h3>
          {(
            [
              ["focusMinutes", "专注时长", 1, 120],
              ["shortBreakMinutes", "短休息", 1, 60],
              ["longBreakMinutes", "长休息", 1, 60],
              ["longBreakEvery", "每几个番茄后长休息", 2, 10],
            ] as const
          ).map(([key, label, min, max]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min={min}
                max={max}
                value={settings[key]}
                onChange={(e) =>
                  applySettings({ ...settings, [key]: Math.min(max, Math.max(min, +e.target.value || min)) })
                }
              />
            </label>
          ))}
          <h3 style={{ marginTop: 16 }}>提醒</h3>
          <label>
            音效提醒
            <input
              type="checkbox"
              checked={settings.soundEnabled}
              onChange={(e) => applySettings({ ...settings, soundEnabled: e.target.checked })}
            />
          </label>
          <label>
            桌面通知
            <input
              type="checkbox"
              checked={settings.notificationEnabled}
              onChange={(e) =>
                applySettings({ ...settings, notificationEnabled: e.target.checked })
              }
            />
          </label>
          <h3 style={{ marginTop: 16 }}>外观与系统</h3>
          <label>
            主题
            <select
              value={settings.theme}
              onChange={(e) =>
                applySettings({ ...settings, theme: e.target.value as "light" | "dark" })
              }
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label>
            开机自启
            <input
              type="checkbox"
              checked={autostart}
              onChange={async (e) =>
                setAutostartFlag(await window.api.setAutostart(e.target.checked))
              }
            />
          </label>
          <label>
            数据目录
            <button onClick={() => void window.api.openDataDir()}>打开</button>
          </label>
          <div className="muted">所有数据本地存储，无网络请求。</div>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
