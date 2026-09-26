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

type HistoryRecord = {
  date: string;
  phase: Phase;
  minutes: number;
  at: number;
  /** 旧记录缺少该字段时按自然完成兼容。 */
  completed?: boolean;
  source?: "auto" | "manual" | "recovery";
};

declare global {
  interface Window {
    api: {
      getInit: () => Promise<{
        settings: TimerSettings;
        state: TimerState;
        history: HistoryRecord[];
      }>;
      setSettings: (s: TimerSettings) => Promise<boolean>;
      setState: (s: TimerState) => Promise<boolean>;
      setAutostart: (v: boolean) => Promise<boolean>;
      getAutostart: () => Promise<boolean>;
      recordHistory: (rec: {
        phase: Phase;
        minutes: number;
        completed?: boolean;
        source?: "auto" | "manual" | "recovery";
      }) => Promise<HistoryRecord[]>;
      clearHistory: () => Promise<HistoryRecord[]>;
      notify: (p: { title: string; body: string }) => Promise<void>;
      openDataDir: () => Promise<void>;
      setTrayTitle: (t: string) => Promise<void>;
      onPhaseFinished: (cb: (p: { title: string; body: string }) => void) => () => void;
      onPlaySound: (cb: (kind: string) => void) => () => void;
    };
  }
}

const PHASE_META: Record<Phase, { label: string; notice: string; status: string; className: string }> = {
  focus: {
    label: "🍅 专注中",
    notice: "专注开始",
    status: "保持专注，手机放远一点～",
    className: "focus",
  },
  shortBreak: {
    label: "🌿 短休息",
    notice: "短休息开始",
    status: "喝口水，看看窗外 🌱",
    className: "break",
  },
  longBreak: {
    label: "😴 长休息",
    notice: "长休息开始",
    status: "起来走走，伸展一下身体 🧘",
    className: "long",
  },
};

const CIRCUMFERENCE = 2 * Math.PI * 105;

type Tab = "timer" | "stats" | "settings";

function beep(kind: string, enabled: boolean, volume: number) {
  if (!enabled || volume <= 0) return;
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const notes = kind === "long" ? [660, 660, 880, 880] : [880, 660];
    notes.forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.frequency.value = frequency;
      oscillator.type = "sine";
      const normalizedVolume = Math.max(0, Math.min(100, volume)) / 100;
      gain.gain.setValueAtTime(0.12 * normalizedVolume, ctx.currentTime + index * 0.25);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + index * 0.25 + 0.22);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(ctx.currentTime + index * 0.25);
      oscillator.stop(ctx.currentTime + index * 0.25 + 0.24);
    });
    setTimeout(() => void ctx.close(), 1500);
  } catch {
    // 系统没有可用音频上下文时，计时仍应正常运行。
  }
}

function localDate(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function phaseFullMs(settings: TimerSettings, phase: Phase): number {
  const minutes =
    phase === "focus"
      ? settings.focusMinutes
      : phase === "shortBreak"
        ? settings.shortBreakMinutes
        : settings.longBreakMinutes;
  return Math.max(1, minutes) * 60_000;
}

function phaseMinutes(settings: TimerSettings, phase: Phase): number {
  return Math.round(phaseFullMs(settings, phase) / 60_000);
}

function App() {
  const [ready, setReady] = useState(false);
  const [settings, setSettingsState] = useState<TimerSettings>(DEFAULT_SETTINGS);
  const [state, setStateObj] = useState<TimerState>(createInitialState());
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [autostart, setAutostartFlag] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("timer");
  const [clearArmed, setClearArmed] = useState(false);
  const stateRef = useRef(state);
  const settingsRef = useRef(settings);
  stateRef.current = state;
  settingsRef.current = settings;

  const showToast = (message: string, allowDuringFocus = false) => {
    if (!allowDuringFocus && settingsRef.current.doNotDisturb && stateRef.current.phase === "focus") {
      return;
    }
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 3200);
  };

  useEffect(() => {
    void (async () => {
      try {
        const init = await window.api.getInit();
        const loadedSettings = { ...DEFAULT_SETTINGS, ...init.settings };
        setSettingsState(loadedSettings);
        settingsRef.current = loadedSettings;
        setHistory(init.history);
        setStateObj(init.state);
        setAutostartFlag(await window.api.getAutostart());
        document.documentElement.dataset.theme = loadedSettings.theme;
      } finally {
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const interval = window.setInterval(() => {
      const current = stateRef.current;
      if (!current.running) return;
      const result = tick(settingsRef.current, current, Date.now());
      if (result.finished.length > 0) {
        const nextPhase = result.state.phase;
        // 先更新引用，再处理主进程回调，使免打扰能识别即将进入的专注阶段。
        stateRef.current = result.state;
        setStateObj(result.state);
        void window.api.notify({
          title: PHASE_META[nextPhase].notice,
          body: `${PHASE_META[result.finished[result.finished.length - 1]].label}已结束，${PHASE_META[nextPhase].notice}`,
        });
        beep(
          nextPhase === "longBreak" ? "long" : "short",
          settingsRef.current.soundEnabled,
          settingsRef.current.volume,
        );
        void (async () => {
          let records = history;
          for (const finishedPhase of result.finished) {
            records = await window.api.recordHistory({
              phase: finishedPhase,
              minutes: phaseMinutes(settingsRef.current, finishedPhase),
              completed: true,
              source: "auto",
            });
          }
          setHistory(records);
        })();
        void window.api.setState(result.state);
      } else {
        setStateObj(result.state);
        void window.api.setTrayTitle(formatMs(result.state.remainingMs));
      }
    }, 500);
    return () => window.clearInterval(interval);
  }, [ready, history]);

  useEffect(
    () =>
      window.api.onPhaseFinished((payload) => {
        showToast(payload.body);
      }),
    [],
  );
  useEffect(
    () =>
      window.api.onPlaySound((kind) => {
        beep(kind, settingsRef.current.soundEnabled, settingsRef.current.volume);
      }),
    [],
  );

  const updateState = (next: TimerState) => {
    stateRef.current = next;
    setStateObj(next);
    void window.api.setState(next);
  };

  const applySettings = (next: TimerSettings) => {
    const currentSettings = settingsRef.current;
    setSettingsState(next);
    settingsRef.current = next;
    void window.api.setSettings(next);
    document.documentElement.dataset.theme = next.theme;
    const current = stateRef.current;
    const currentDuration = phaseFullMs(currentSettings, current.phase);
    const durationChanged = phaseFullMs(next, current.phase) !== currentDuration;
    // 只在空闲或尚未消耗当前周期时同步新时长；切换音量、主题、免打扰等设置
    // 不应重置一个已经暂停的周期。
    if (!current.running && durationChanged && current.remainingMs >= currentDuration) {
      updateState({
        ...current,
        remainingMs: phaseFullMs(next, current.phase),
        cycleId: current.cycleId + 1,
      });
    }
  };

  const recordSkippedFocus = (minutes: number) => {
    if (minutes <= 0) return;
    void window.api
      .recordHistory({ phase: "focus", minutes, completed: false, source: "manual" })
      .then(setHistory);
  };

  const clearHistory = async () => {
    if (!clearArmed) {
      setClearArmed(true);
      showToast("再点一次确认清空历史（不可恢复）", true);
      window.setTimeout(() => setClearArmed(false), 3000);
      return;
    }
    const records = await window.api.clearHistory();
    setHistory(records);
    setClearArmed(false);
    showToast("历史数据已清空，进行中的计时不受影响", true);
  };

  const stats = useMemo(() => {
    const today = localDate(Date.now());
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    weekStart.setHours(0, 0, 0, 0);
    const monthPrefix = today.slice(0, 7);
    const focusHistory = history.filter((record) => record.phase === "focus");
    const dayMinutes = focusHistory
      .filter((record) => record.date === today)
      .reduce((total, record) => total + record.minutes, 0);
    const weekMinutes = focusHistory
      .filter((record) => new Date(record.at) >= weekStart)
      .reduce((total, record) => total + record.minutes, 0);
    const monthMinutes = focusHistory
      .filter((record) => record.date.startsWith(monthPrefix))
      .reduce((total, record) => total + record.minutes, 0);
    const days: { key: string; label: string; minutes: number; today: boolean }[] = [];
    let maxMinutes = 1;
    const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date(now);
      date.setDate(now.getDate() - offset);
      const key = localDate(date.getTime());
      const minutes = focusHistory
        .filter((record) => record.date === key)
        .reduce((total, record) => total + record.minutes, 0);
      maxMinutes = Math.max(maxMinutes, minutes);
      days.push({ key, label: weekdays[date.getDay()], minutes, today: key === today });
    }
    return {
      dayMinutes,
      weekMinutes,
      monthMinutes,
      pomodoros: focusHistory.filter((record) => record.completed !== false && record.minutes > 0).length,
      days,
      maxMinutes,
    };
  }, [history]);

  if (!ready) {
    return <div className="loading-state">🍅 加载番茄钟…</div>;
  }

  const fullMs = phaseFullMs(settings, state.phase);
  const progress = Math.max(0, Math.min(1, state.remainingMs / fullMs));
  const dashOffset = CIRCUMFERENCE * (1 - progress);
  const isInitial =
    state.phase === "focus" &&
    state.completedFocus === 0 &&
    !state.running &&
    state.remainingMs === fullMs;
  const canManualEnd = state.running || !isInitial;
  const phaseMeta = PHASE_META[state.phase];
  const phaseLabel = isInitial ? "🍅 准备专注" : phaseMeta.label;
  const completedInCycle =
    state.phase === "longBreak"
      ? settings.longBreakEvery
      : state.completedFocus % settings.longBreakEvery;

  const changeTab = (nextTab: Tab) => setTab(nextTab);
  const handleMainAction = () => {
    if (state.running) {
      updateState(pause(state, Date.now()));
      return;
    }
    const next = start(settings, state, Date.now());
    updateState(next);
    if (isInitial) {
      void window.api.notify({ title: "专注开始", body: "深呼吸，开始专注吧！" });
      beep("short", settings.soundEnabled, settings.volume);
    }
  };

  return (
    <div className="window">
      <header className="titlebar">
        <div className="window-dots" aria-hidden="true">
          <span className="dot r" />
          <span className="dot y" />
          <span className="dot g" />
        </div>
        <strong>🍅 番茄钟助手</strong>
        <span className="ver">v1.0 · 正式版</span>
      </header>

      {toast && <div className="toast" role="status">{toast}</div>}

      <nav className="tabs" aria-label="番茄钟页面">
        <button className={`tab ${tab === "timer" ? "active" : ""}`} onClick={() => changeTab("timer")}>
          ⏰ 计时
        </button>
        <button className={`tab ${tab === "stats" ? "active" : ""}`} onClick={() => changeTab("stats")}>
          📊 统计
        </button>
        <button className={`tab ${tab === "settings" ? "active" : ""}`} onClick={() => changeTab("settings")}>
          ⚙️ 设置
        </button>
      </nav>

      {tab === "timer" && (
        <main className="page timer-page">
          <div className="phase-tag-wrap">
            <span className={`phase-tag ${phaseMeta.className}`}>{state.running || !isInitial ? phaseLabel : "🍅 准备专注"}</span>
          </div>
          <div className={`timer-wrap ${phaseMeta.className}`}>
            <svg className="ring" viewBox="0 0 240 240" aria-label={`${phaseLabel} ${formatMs(state.remainingMs)}`} role="img">
              <circle className="bgc" cx="120" cy="120" r="105" />
              <circle
                className="fgc"
                cx="120"
                cy="120"
                r="105"
                style={{ strokeDasharray: CIRCUMFERENCE, strokeDashoffset: dashOffset }}
              />
            </svg>
            <div className="timer-center">
              <div className={`big-time ${!state.running && !isInitial ? "paused" : ""}`}>{formatMs(state.remainingMs)}</div>
              <div className="sub-status">{isInitial ? "点「开始」进入第一个番茄" : phaseMeta.status}</div>
            </div>
          </div>
          <div className="tomato-row" aria-label={`本轮已完成 ${completedInCycle} 个番茄`}>
            {Array.from({ length: settings.longBreakEvery }, (_, index) => (
              <span
                key={index}
                className={`tomato ${index < completedInCycle ? "full" : ""} ${state.phase === "focus" && state.running && index === completedInCycle ? "doing" : ""}`}
              />
            ))}
          </div>
          <div className="cycle-hint">每 {settings.longBreakEvery} 个番茄 → {settings.longBreakMinutes} 分钟长休息</div>
          <div className="btn-row">
            <button className="primary" onClick={handleMainAction}>
              {state.running ? "⏸ 暂停" : isInitial ? "▶ 开始" : "▶ 继续"}
            </button>
            <button onClick={() => updateState(reset(settings, state, Date.now()))}>↺ 重置</button>
            <button
              className="ghost"
              disabled={!canManualEnd}
              onClick={() => {
                const result = skip(settings, state, Date.now());
                const minutes = Math.floor(result.skippedFocusMs / 60_000);
                recordSkippedFocus(minutes);
                updateState(result.state);
                showToast(minutes > 0 ? `已记录中断：专注 ${minutes} 分钟计入统计` : "已手动结束当前周期");
              }}
            >
              ✋ 手动结束
            </button>
          </div>
          <div className="timer-footnote">
            已完成番茄 <strong>{state.completedFocus}</strong> 个 · 每 {settings.longBreakEvery} 个后长休息 {settings.longBreakMinutes} 分钟
          </div>
        </main>
      )}

      {tab === "stats" && (
        <main className="page stats-page">
          <div className="stat-cards">
            <div className="stat-card"><div className="num">{history.filter((record) => record.date === localDate(Date.now()) && record.phase === "focus" && record.completed !== false && record.minutes > 0).length}</div><div className="lbl">今日完成番茄 🍅</div></div>
            <div className="stat-card"><div className="num">{stats.dayMinutes}</div><div className="lbl">今日专注（分钟）⏱</div></div>
            <div className="stat-card"><div className="num">{stats.weekMinutes}</div><div className="lbl">本周专注（分钟）📅</div></div>
            <div className="stat-card"><div className="num">{stats.monthMinutes}</div><div className="lbl">本月专注（分钟）🗓</div></div>
          </div>
          <div className="chart-title">近 7 日专注时长（分钟）</div>
          <div className="bars" role="img" aria-label="近七日专注时长柱状图">
            {stats.days.map((day) => (
              <div className="bar-col" key={day.key}>
                <div className={`bar ${day.today ? "today" : ""}`} style={{ height: `${Math.max(4, (day.minutes / stats.maxMinutes) * 62)}px` }} title={`${day.key}：${day.minutes} 分钟`} />
                <div className="bar-lbl">{day.label}</div>
              </div>
            ))}
          </div>
          <div className="chart-title history-title">历史记录</div>
          <div className="hist-list">
            {history.length === 0 && <div className="hist-empty">还没有记录，完成一个番茄试试～</div>}
            {history.slice().reverse().slice(0, 30).map((record, index) => {
              const interrupted = record.phase === "focus" && record.completed === false;
              return (
                <div className="hist-item" key={`${record.at}-${index}`}>
                  <span>{record.date} {record.phase === "focus" ? "🍅 专注" : record.phase === "shortBreak" ? "🌿 短休" : "😴 长休"}</span>
                  <span className={interrupted ? "cut-record" : record.phase === "focus" ? "" : "muted-record"}>
                    {interrupted ? `中断 · ${record.minutes} 分钟` : `${record.minutes} 分钟`}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="clear-history-wrap">
            <button className="danger-btn" onClick={() => void clearHistory()}>
              {clearArmed ? "⚠️ 再点一次确认清空" : "🗑 清空历史数据"}
            </button>
          </div>
          <div className="stats-note">数据仅保存在本机。历史记录可在设置页打开数据目录查看。</div>
        </main>
      )}

      {tab === "settings" && (
        <main className="page settings-page">
          <section className="set-group">
            <h3>⏳ 时长配置（下一周期生效）</h3>
            <div className="set-grid">
              {(
                [
                  ["focusMinutes", "专注时长", 1, 120, "分钟"],
                  ["shortBreakMinutes", "短休息", 1, 60, "分钟"],
                  ["longBreakMinutes", "长休息", 1, 60, "分钟"],
                  ["longBreakEvery", "长休息周期", 2, 8, "个番茄"],
                ] as const
              ).map(([key, label, min, max, unit]) => (
                <label className="set-item" key={key}>
                  <span>{label}</span>
                  <span className="number-control">
                    <input
                      type="number"
                      min={min}
                      max={max}
                      value={settings[key]}
                      aria-label={label}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        const nextValue = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
                        applySettings({ ...settings, [key]: nextValue });
                      }}
                    />
                    <small>{unit}</small>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="set-group">
            <h3>🔔 提醒</h3>
            <div className="set-row">
              <span><strong>提示音效</strong><small>周期切换时播放提示音</small></span>
              <button className={`switch ${settings.soundEnabled ? "on" : ""}`} role="switch" aria-checked={settings.soundEnabled} onClick={() => applySettings({ ...settings, soundEnabled: !settings.soundEnabled })} aria-label="切换提示音效"><span /></button>
            </div>
            <div className="set-row volume-row">
              <span><strong>提醒音量 <b>{settings.volume}</b></strong><small>应用内音效强度（0–100）</small></span>
              <input
                className="volume-range"
                type="range"
                min="0"
                max="100"
                step="1"
                value={settings.volume}
                aria-label="提醒音量"
                onChange={(event) => applySettings({ ...settings, volume: Number(event.target.value) })}
              />
            </div>
            <div className="set-row">
              <span><strong>桌面通知</strong><small>周期切换时发送系统通知</small></span>
              <button className={`switch ${settings.notificationEnabled ? "on" : ""}`} role="switch" aria-checked={settings.notificationEnabled} onClick={() => applySettings({ ...settings, notificationEnabled: !settings.notificationEnabled })} aria-label="切换桌面通知"><span /></button>
            </div>
            <div className="set-row">
              <span><strong>免打扰模式</strong><small>专注期间隐藏应用内提示，系统通知保留</small></span>
              <button className={`switch ${settings.doNotDisturb ? "on" : ""}`} role="switch" aria-checked={settings.doNotDisturb} onClick={() => applySettings({ ...settings, doNotDisturb: !settings.doNotDisturb })} aria-label="切换免打扰模式"><span /></button>
            </div>
          </section>

          <section className="set-group">
            <h3>🎨 外观与系统</h3>
            <div className="set-row">
              <span><strong>深色主题</strong><small>适合夜间使用</small></span>
              <button className={`switch ${settings.theme === "dark" ? "on" : ""}`} role="switch" aria-checked={settings.theme === "dark"} onClick={() => applySettings({ ...settings, theme: settings.theme === "dark" ? "light" : "dark" })} aria-label="切换深色主题"><span /></button>
            </div>
            <div className="set-row">
              <span><strong>开机自启</strong><small>登录系统后在托盘运行</small></span>
              <button className={`switch ${autostart ? "on" : ""}`} role="switch" aria-checked={autostart} onClick={async () => setAutostartFlag(await window.api.setAutostart(!autostart))} aria-label="切换开机自启"><span /></button>
            </div>
            <div className="set-row data-row">
              <span><strong>本地数据</strong><small>设置与历史记录均保存在本机</small></span>
              <button onClick={() => void window.api.openDataDir()}>打开目录</button>
            </div>
          </section>
          <div className="privacy-note">🔒 全部数据仅保存在本机，零联网 · 零广告</div>
        </main>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
