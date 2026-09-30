import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS as S,
  createInitialState,
  formatMs,
  pause,
  reset,
  resume,
  skip,
  start,
  tick,
} from "../src/shared/timer";

const MIN = 60_000;

describe("番茄钟状态机", () => {
  it("默认配置为 25/5/15 分钟，初始为专注阶段", () => {
    expect(S.focusMinutes).toBe(25);
    expect(S.shortBreakMinutes).toBe(5);
    expect(S.longBreakMinutes).toBe(15);
    const st = createInitialState(S);
    expect(st.phase).toBe("focus");
    expect(st.remainingMs).toBe(25 * MIN);
    expect(st.running).toBe(false);
  });

  it("开始后按绝对时间戳递减", () => {
    const started = start(S, createInitialState(S), 1000);
    expect(started.running).toBe(true);
    const { state } = tick(S, started, 1000 + 30_000);
    expect(state.remainingMs).toBe(25 * MIN - 30_000);
  });

  it("暂停并继续后剩余时间保持", () => {
    const started = start(S, createInitialState(S), 0);
    const paused = pause(started, 10 * MIN);
    expect(paused.running).toBe(false);
    expect(paused.remainingMs).toBe(15 * MIN);
    const resumed = resume(S, paused, 100 * MIN);
    const { state } = tick(S, resumed, 100 * MIN + 5 * MIN);
    expect(state.remainingMs).toBe(10 * MIN);
  });

  it("暂停时不前进", () => {
    const paused = pause(start(S, createInitialState(S), 0), 5 * MIN);
    const { state } = tick(S, paused, 100 * MIN);
    expect(state.remainingMs).toBe(20 * MIN);
  });

  it("专注结束自动进入短休息并计 1 个番茄", () => {
    const started = start(S, createInitialState(S), 0);
    const { state, finished } = tick(S, started, 25 * MIN + 1000);
    expect(finished).toContain("focus");
    expect(state.phase).toBe("shortBreak");
    expect(state.completedFocus).toBe(1);
    expect(state.running).toBe(true);
    expect(state.remainingMs).toBe(5 * MIN);
  });

  it("完成 4 个专注后进入长休息（15 分钟）", () => {
    let st = createInitialState(S);
    let now = 0;
    let focusDone = 0;
    while (focusDone < 4) {
      st = start(S, st, now);
      now += st.remainingMs + 1;
      const r = tick(S, st, now);
      st = r.state;
      if (r.finished.includes("focus")) focusDone++;
    }
    expect(st.completedFocus).toBe(4);
    expect(st.phase).toBe("longBreak");
    expect(st.remainingMs).toBe(15 * MIN);
  });

  it("长休息结束后回到专注阶段", () => {
    let st = createInitialState(S);
    st = { ...st, phase: "longBreak", completedFocus: 4, remainingMs: 15 * MIN };
    st = start(S, st, 0);
    const { state } = tick(S, st, 15 * MIN + 1);
    expect(state.phase).toBe("focus");
    expect(state.completedFocus).toBe(4);
    expect(state.remainingMs).toBe(25 * MIN);
  });

  it("长休息结束后的第一个专注周期手动结束时进入短休息", () => {
    let st = createInitialState(S);
    st = { ...st, phase: "longBreak", completedFocus: 4, remainingMs: 15 * MIN };
    st = tick(S, start(S, st, 0), 15 * MIN + 1).state;

    const { state } = skip(S, st, 15 * MIN + 10);
    expect(state.phase).toBe("shortBreak");
    expect(state.completedFocus).toBe(4);
    expect(state.running).toBe(false);
  });

  it("重置回到专注阶段并保留已完成番茄数", () => {
    const st = { ...createInitialState(S), phase: "shortBreak" as const, completedFocus: 2 };
    const r = reset(S, st, 0);
    expect(r.phase).toBe("focus");
    expect(r.completedFocus).toBe(2);
    expect(r.remainingMs).toBe(25 * MIN);
  });

  it("手动结束专注周期：立即进入休息并返回已专注毫秒数", () => {
    const started = start(S, createInitialState(S), 0);
    const { state, skippedFocusMs } = skip(S, started, 10 * MIN);
    expect(skippedFocusMs).toBe(10 * MIN);
    expect(state.phase).toBe("shortBreak");
    // 手动结束不计完整番茄
    expect(state.completedFocus).toBe(0);
    expect(state.running).toBe(false);
  });

  it("手动结束休息周期回到专注", () => {
    const st = { ...createInitialState(S), phase: "shortBreak" as const, completedFocus: 1 };
    const { state, skippedFocusMs } = skip(S, st, 0);
    expect(skippedFocusMs).toBe(0);
    expect(state.phase).toBe("focus");
  });

  it("自定义时长生效", () => {
    const s = { ...S, focusMinutes: 50, shortBreakMinutes: 10 };
    const st = createInitialState(s);
    expect(st.remainingMs).toBe(50 * MIN);
    const started = start(s, st, 0);
    const { state } = tick(s, started, 50 * MIN + 1);
    expect(state.phase).toBe("shortBreak");
    expect(state.remainingMs).toBe(10 * MIN);
  });

  it("格式化显示", () => {
    expect(formatMs(25 * MIN)).toBe("25:00");
    expect(formatMs(65_500)).toBe("01:06");
    expect(formatMs(0)).toBe("00:00");
  });
});
