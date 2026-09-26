// 三阶段番茄钟状态机（纯函数，可独立测试）
export type Phase = "focus" | "shortBreak" | "longBreak";

export interface TimerSettings {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  longBreakEvery: number; // 完成多少个专注后长休息
  soundEnabled: boolean;
  /** 提示音音量（0-100），只影响应用内音效增益。 */
  volume: number;
  notificationEnabled: boolean;
  /** 专注期间屏蔽应用内非必要 toast，系统通知仍由主进程发出。 */
  doNotDisturb: boolean;
  theme: "light" | "dark";
}

export const DEFAULT_SETTINGS: TimerSettings = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4,
  soundEnabled: true,
  volume: 60,
  notificationEnabled: true,
  doNotDisturb: false,
  theme: "light",
};

export interface TimerState {
  phase: Phase;
  /** 剩余毫秒 */
  remainingMs: number;
  /** 本轮累计完整完成专注番茄数 */
  completedFocus: number;
  /** 是否正在计时 */
  running: boolean;
  /** 周期结束时间戳（绝对时间，规避 WebView 后台节流）；暂停时为 null */
  endAt: number | null;
  /** 每阶段唯一标识，用于前端检测切换 */
  cycleId: number;
}

export interface TickResult {
  state: TimerState;
  /** 本次 tick 跨过的阶段列表 */
  finished: Phase[];
}

function phaseDurationMs(s: TimerSettings, p: Phase): number {
  const m =
    p === "focus"
      ? s.focusMinutes
      : p === "shortBreak"
        ? s.shortBreakMinutes
        : s.longBreakMinutes;
  return Math.max(1, m) * 60_000;
}

export function createInitialState(s: TimerSettings = DEFAULT_SETTINGS): TimerState {
  return {
    phase: "focus",
    remainingMs: phaseDurationMs(s, "focus"),
    completedFocus: 0,
    running: false,
    endAt: null,
    cycleId: 0,
  };
}

function nextPhaseOf(s: TimerSettings, state: TimerState): TimerState {
  const now = state.endAt ?? 0;
  if (state.phase === "focus") {
    const completed = state.completedFocus + 1;
    const phase: Phase =
      completed % s.longBreakEvery === 0 ? "longBreak" : "shortBreak";
    const dur = phaseDurationMs(s, phase);
    return {
      phase,
      completedFocus: completed,
      remainingMs: dur,
      running: true,
      endAt: now + dur,
      cycleId: state.cycleId + 1,
    };
  }
  const dur = phaseDurationMs(s, "focus");
  return {
    phase: "focus",
    completedFocus: state.completedFocus,
    remainingMs: dur,
    running: true,
    endAt: now + dur,
    cycleId: state.cycleId + 1,
  };
}

/** 推进时间：返回新状态与跨过的阶段（用于触发提醒） */
export function tick(s: TimerSettings, state: TimerState, now: number): TickResult {
  if (!state.running || state.endAt === null) return { state, finished: [] };
  const finished: Phase[] = [];
  let cur = state;
  let guard = 0;
  while (cur.endAt !== null && now >= cur.endAt && guard++ < 1000) {
    finished.push(cur.phase);
    const next = nextPhaseOf(s, { ...cur, endAt: cur.endAt });
    // 新周期以当前时刻为起点，保证节律连续且避免连环跳期
    cur = { ...next, endAt: now + next.remainingMs };
  }
  cur = { ...cur, remainingMs: Math.max(0, (cur.endAt ?? now) - now) };
  return { state: cur, finished };
}

export function start(s: TimerSettings, state: TimerState, now: number): TimerState {
  void s;
  if (state.running) return state;
  return { ...state, running: true, endAt: now + state.remainingMs };
}

export function pause(state: TimerState, now: number): TimerState {
  if (!state.running || state.endAt === null) return { ...state, running: false, endAt: null };
  return {
    ...state,
    running: false,
    remainingMs: Math.max(0, state.endAt - now),
    endAt: null,
  };
}

export function resume(s: TimerSettings, state: TimerState, now: number): TimerState {
  return start(s, state, now);
}

export function reset(s: TimerSettings, state: TimerState, now: number): TimerState {
  void now;
  const st = createInitialState(s);
  return { ...st, completedFocus: state.completedFocus, cycleId: state.cycleId + 1 };
}

/**
 * 手动结束当前周期：立即进入下一阶段（暂停态）。
 * 若结束的是专注周期，已专注时间通过 skippedFocusMs 返回（计入统计，但不计为完整番茄）。
 */
export function skip(
  s: TimerSettings,
  state: TimerState,
  now: number,
): { state: TimerState; skippedFocusMs: number } {
  const elapsedMs =
    state.phase === "focus"
      ? Math.max(
          0,
          phaseDurationMs(s, "focus") -
            (state.running && state.endAt !== null
              ? Math.max(0, state.endAt - now)
              : state.remainingMs),
        )
      : 0;
  const nextPhase: Phase =
    state.phase === "focus"
      ? state.completedFocus > 0 && state.completedFocus % s.longBreakEvery === 0
        ? "longBreak"
        : "shortBreak"
      : "focus";
  const dur = phaseDurationMs(s, nextPhase);
  return {
    state: {
      phase: nextPhase,
      completedFocus: state.completedFocus,
      remainingMs: dur,
      running: false,
      endAt: null,
      cycleId: state.cycleId + 1,
    },
    skippedFocusMs: elapsedMs,
  };
}

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
