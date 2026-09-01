/**
 * Tests for the per-session orchestration mode.
 *
 * The default (`off`) is the load-bearing property: it is what keeps an ordinary
 * question from paying for a decomposer call, a classifier call per subtask, or a fixed
 * pipeline that runs for minutes. A regression here is silent — the plugin would simply
 * start orchestrating requests nobody opted in for.
 */

import { beforeEach, describe, expect, test } from "vitest";
import {
  clearSessionsUsingPipeline,
  getSessionMode,
  missionModeSessionCount,
  resetMissionModeStore,
  setSessionMode,
} from "../src/mission-mode.js";

beforeEach(() => {
  resetMissionModeStore();
});

describe("defaults", () => {
  test("an unknown session is off", () => {
    expect(getSessionMode("agent:main:default")).toEqual({ kind: "off" });
  });

  test("nothing is remembered until a non-default mode is set", () => {
    expect(missionModeSessionCount()).toBe(0);
  });
});

describe("setSessionMode", () => {
  test("dynamic round-trips", () => {
    setSessionMode("agent:main:default", { kind: "dynamic" });
    expect(getSessionMode("agent:main:default")).toEqual({ kind: "dynamic" });
  });

  test("pipeline round-trips with its id", () => {
    setSessionMode("agent:main:default", { kind: "pipeline", pipelineId: "pl_abc" });
    expect(getSessionMode("agent:main:default")).toEqual({
      kind: "pipeline",
      pipelineId: "pl_abc",
    });
  });

  test("setting off forgets the session rather than storing an explicit off", () => {
    setSessionMode("agent:main:default", { kind: "dynamic" });
    setSessionMode("agent:main:default", { kind: "off" });
    expect(getSessionMode("agent:main:default")).toEqual({ kind: "off" });
    // `off` is the default, so there is nothing to record.
    expect(missionModeSessionCount()).toBe(0);
  });

  test("switching between modes replaces rather than accumulates", () => {
    setSessionMode("agent:main:default", { kind: "dynamic" });
    setSessionMode("agent:main:default", { kind: "pipeline", pipelineId: "pl_x" });
    expect(getSessionMode("agent:main:default")).toEqual({
      kind: "pipeline",
      pipelineId: "pl_x",
    });
    expect(missionModeSessionCount()).toBe(1);
  });

  test("sessions are independent", () => {
    setSessionMode("agent:main:a", { kind: "dynamic" });
    setSessionMode("agent:main:b", { kind: "pipeline", pipelineId: "pl_x" });
    expect(getSessionMode("agent:main:a")).toEqual({ kind: "dynamic" });
    expect(getSessionMode("agent:main:b")).toEqual({ kind: "pipeline", pipelineId: "pl_x" });
    expect(getSessionMode("agent:main:c")).toEqual({ kind: "off" });
  });

  test("a blank session key is ignored rather than stored", () => {
    setSessionMode("", { kind: "dynamic" });
    setSessionMode("   ", { kind: "dynamic" });
    expect(missionModeSessionCount()).toBe(0);
  });

  // A pipeline mode with no id could not be executed and would be indistinguishable
  // from `off` downstream, so it must not be stored as a broken state.
  test("a pipeline mode without an id is rejected", () => {
    setSessionMode("agent:main:default", { kind: "pipeline", pipelineId: "" });
    expect(getSessionMode("agent:main:default")).toEqual({ kind: "off" });
    expect(missionModeSessionCount()).toBe(0);
  });
});

describe("clearSessionsUsingPipeline", () => {
  // Called when a pipeline is deleted: a session left pointing at it would show the
  // operator a pipeline that no longer exists.
  test("forgets only the sessions using that pipeline", () => {
    setSessionMode("agent:main:a", { kind: "pipeline", pipelineId: "pl_gone" });
    setSessionMode("agent:main:b", { kind: "pipeline", pipelineId: "pl_kept" });
    setSessionMode("agent:main:c", { kind: "dynamic" });

    expect(clearSessionsUsingPipeline("pl_gone")).toBe(1);
    expect(getSessionMode("agent:main:a")).toEqual({ kind: "off" });
    expect(getSessionMode("agent:main:b")).toEqual({ kind: "pipeline", pipelineId: "pl_kept" });
    expect(getSessionMode("agent:main:c")).toEqual({ kind: "dynamic" });
  });

  test("reports zero when nothing referenced it", () => {
    setSessionMode("agent:main:a", { kind: "dynamic" });
    expect(clearSessionsUsingPipeline("pl_never")).toBe(0);
    expect(missionModeSessionCount()).toBe(1);
  });
});

describe("bounded growth", () => {
  // A long-lived gateway must not accumulate session keys forever. Eviction drops a
  // session back to `off`, which is the fail-safe direction.
  test("the store stops growing past its cap", () => {
    for (let i = 0; i < 600; i++) {
      setSessionMode(`agent:main:s${i}`, { kind: "dynamic" });
    }
    expect(missionModeSessionCount()).toBeLessThanOrEqual(500);
  });

  test("eviction removes the oldest and keeps the newest", () => {
    for (let i = 0; i < 600; i++) {
      setSessionMode(`agent:main:s${i}`, { kind: "dynamic" });
    }
    expect(getSessionMode("agent:main:s599")).toEqual({ kind: "dynamic" });
    expect(getSessionMode("agent:main:s0")).toEqual({ kind: "off" });
  });

  test("re-setting refreshes a session's position, protecting it from eviction", () => {
    setSessionMode("agent:main:keep", { kind: "dynamic" });
    for (let i = 0; i < 499; i++) {
      setSessionMode(`agent:main:s${i}`, { kind: "dynamic" });
    }
    setSessionMode("agent:main:keep", { kind: "dynamic" });
    for (let i = 499; i < 600; i++) {
      setSessionMode(`agent:main:s${i}`, { kind: "dynamic" });
    }
    expect(getSessionMode("agent:main:keep")).toEqual({ kind: "dynamic" });
  });
});
