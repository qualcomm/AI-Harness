// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenieXStatus } from "../controllers/local-models.ts";
import { renderLocalModels, type LocalModelsProps } from "./local-models.ts";

function baseProps(overrides?: Partial<LocalModelsProps>): LocalModelsProps {
  return {
    status: null,
    statusLoading: false,
    statusError: null,
    cached: [],
    cachedLoading: false,
    cachedError: null,
    available: [],
    availableLoading: false,
    availableError: null,
    chipset: "Snapdragon X2 Elite CRD",
    chipsets: [],
    jobs: [],
    actionPending: false,
    actionMessage: null,
    selectedAvailable: "",
    manualInput: "",
    computeByModel: () => "",
    onRefresh: vi.fn(),
    onSelectedAvailableChange: vi.fn(),
    onManualInputChange: vi.fn(),
    onPull: vi.fn(),
    onPausePull: vi.fn(),
    onResumePull: vi.fn(),
    onForgetJob: vi.fn(),
    onRemove: vi.fn(),
    onComputeChange: vi.fn(),
    onChipsetChange: vi.fn(),
    onServeStart: vi.fn(),
    onServeStop: vi.fn(),
    onServeRestart: vi.fn(),
    ...overrides,
  };
}

const READY_STATUS: GenieXStatus = {
  state: "ready",
  platform: "win32-arm64",
  cliPath: "C:/geniex/geniex.exe",
  version: "0.3.1",
  baseUrl: "http://127.0.0.1:18181/v1",
  serve: { status: "running", pid: 1234 },
};

let host: HTMLElement;

function renderInto(props: LocalModelsProps): string {
  render(renderLocalModels(props), host);
  return host.textContent ?? "";
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.replaceChildren(host);
});

describe("renderLocalModels", () => {
  it("explains how to enable the plugin when geniex.status does not exist yet", () => {
    // This state is client-synthesized from an "unknown method" RPC error
    // (see the controller), never read from config — auto-enable never
    // persists to disk, so a config-based check would lie here.
    const text = renderInto(baseProps({ status: { state: "plugin-inactive" } }));
    expect(text).toContain("not active");
    expect(text).toContain("openclaw plugins enable geniex-manager");
  });

  it("states the reason on an unsupported platform", () => {
    const text = renderInto(
      baseProps({
        status: {
          state: "unsupported-platform",
          platform: "win32-x64",
          reason: "GenieX requires an ARM64 host; this is x64.",
        },
      }),
    );
    expect(text).toContain("Not available on this device");
    expect(text).toContain("ARM64");
  });

  it("shows install guidance, including the PATH restart caveat", () => {
    const text = renderInto(
      baseProps({
        status: {
          state: "cli-missing",
          platform: "win32-arm64",
          install: {
            url: "https://github.com/qualcomm/GenieX/releases",
            note: "After installing, restart the gateway so it picks up the updated PATH.",
          },
        },
      }),
    );
    expect(text).toContain("needs GenieX");
    expect(text).toContain("github.com/qualcomm/GenieX/releases");
    // Without this, users install and then retry the probe forever.
    expect(text).toContain("restart the gateway");
  });

  it("renders the empty state when no models are downloaded", () => {
    // A fresh install legitimately has zero models, so this is a first-run
    // screen rather than an error.
    const text = renderInto(baseProps({ status: READY_STATUS }));
    expect(text).toContain("No local models yet");
    expect(text).toContain("no restart");
  });

  it("locks the compute cell for NPU-only runtimes", () => {
    renderInto(
      baseProps({
        status: READY_STATUS,
        cached: [
          {
            name: "qualcomm/Qwen3-4B-Instruct-2507",
            size: 3194859352,
            runtime: "qairt",
            modelType: "llm",
            precisions: ["W4A16"],
            computeSelectable: false,
          },
        ],
      }),
    );
    // Static text rather than a disabled dropdown: most models on a Snapdragon
    // host are qairt, and a column of dead controls reads as broken.
    expect(host.textContent).toContain("fixed");
    expect(host.querySelector(".local-models__compute-select")).toBeNull();
  });

  it("offers a compute dropdown for llama_cpp models", () => {
    renderInto(
      baseProps({
        status: READY_STATUS,
        cached: [
          {
            name: "unsloth/gpt-oss-20b-GGUF",
            size: 13792639168,
            runtime: "llama_cpp",
            modelType: "llm",
            precisions: ["F16"],
            computeSelectable: true,
          },
        ],
      }),
    );
    const select = host.querySelector<HTMLSelectElement>(".local-models__compute-select");
    expect(select).not.toBeNull();
    expect([...(select?.options ?? [])].map((option) => option.value)).toEqual([
      "",
      "npu",
      "gpu",
      "cpu",
    ]);
  });

  it("preselects the configured compute unit", () => {
    renderInto(
      baseProps({
        status: READY_STATUS,
        computeByModel: () => "cpu",
        cached: [
          {
            name: "unsloth/gpt-oss-20b-GGUF",
            size: 1,
            runtime: "llama_cpp",
            modelType: "llm",
            precisions: ["F16"],
            computeSelectable: true,
          },
        ],
      }),
    );
    expect(host.querySelector<HTMLSelectElement>(".local-models__compute-select")?.value).toBe(
      "cpu",
    );
  });

  it("reports the chosen compute unit with the model name, and Default as empty", () => {
    const onComputeChange = vi.fn();
    renderInto(
      baseProps({
        status: READY_STATUS,
        onComputeChange,
        cached: [
          {
            name: "unsloth/gpt-oss-20b-GGUF",
            size: 1,
            runtime: "llama_cpp",
            modelType: "llm",
            precisions: ["F16"],
            computeSelectable: true,
          },
        ],
      }),
    );
    const select = host.querySelector<HTMLSelectElement>(".local-models__compute-select")!;
    select.value = "gpu";
    select.dispatchEvent(new Event("change"));
    select.value = "";
    select.dispatchEvent(new Event("change"));
    expect(onComputeChange.mock.calls).toEqual([
      ["unsloth/gpt-oss-20b-GGUF", "gpu"],
      ["unsloth/gpt-oss-20b-GGUF", ""],
    ]);
  });

  it("warns when a name:precision entry overrides the dropdown", () => {
    renderInto(
      baseProps({
        status: READY_STATUS,
        cached: [
          {
            name: "unsloth/gpt-oss-20b-GGUF",
            size: 1,
            runtime: "llama_cpp",
            modelType: "llm",
            precisions: ["F16"],
            computeSelectable: true,
            computeOverridden: true,
          },
        ],
      }),
    );
    expect(host.textContent).toContain("overrides this");
  });

  it("disables already-downloaded models in the AI Hub picker", () => {
    renderInto(
      baseProps({
        status: READY_STATUS,
        cached: [
          {
            name: "qualcomm/Qwen3-4B",
            size: 1,
            runtime: "qairt",
            modelType: "llm",
            precisions: ["W4A16"],
            computeSelectable: false,
          },
        ],
        available: [
          {
            name: "qualcomm/Qwen3-4B",
            displayName: "Qwen3-4B",
            id: "qwen3_4b",
            modelType: "llm",
            supportedChipsets: [],
          },
          {
            name: "qualcomm/Qwen3-8B",
            displayName: "Qwen3-8B",
            id: "qwen3_8b",
            modelType: "llm",
            supportedChipsets: [],
          },
        ],
      }),
    );
    const options = [...host.querySelectorAll<HTMLOptionElement>("option")];
    const downloaded = options.find((option) => option.value === "qualcomm/Qwen3-4B");
    const fresh = options.find((option) => option.value === "qualcomm/Qwen3-8B");
    expect(downloaded?.disabled).toBe(true);
    expect(fresh?.disabled).toBe(false);
  });

  it("asks for a chipset when none is resolved", () => {
    // AI Hub assets are per-chipset, and an unresolved chipset would make
    // `geniex pull` fall back to a picker it cannot answer.
    const text = renderInto(
      baseProps({
        status: READY_STATUS,
        chipset: null,
        chipsets: [
          {
            name: "qualcomm-snapdragon-x2-elite",
            displayName: "Snapdragon X2 Elite CRD",
            aliases: [],
          },
        ],
      }),
    );
    expect(text).toContain("Select your chipset");
  });

  it("does not ask for a chipset when one is known", () => {
    const text = renderInto(baseProps({ status: READY_STATUS }));
    expect(text).not.toContain("Select your chipset");
  });

  it("keeps a paused download visible with a Resume button", async () => {
    const onResumePull = vi.fn();
    renderInto(
      baseProps({
        status: READY_STATUS,
        onResumePull,
        jobs: [
          {
            id: "job-9",
            model: "qualcomm/Qwen3-8B",
            status: "cancelled",
            startedAt: Date.now(),
            endedAt: Date.now(),
          },
        ],
      }),
    );
    // <download-status> is a Lit element and renders asynchronously, so wait for
    // it before reading its label.
    await Promise.all(
      [...host.querySelectorAll<HTMLElement & { updateComplete?: Promise<unknown> }>("download-status")]
        .map((element) => element.updateComplete),
    );
    // A paused job has no running process, but its partial file is kept: if the
    // row disappeared the user would have no way to continue.
    expect(host.textContent).toContain("qualcomm/Qwen3-8B");
    expect(host.textContent).toContain("Paused");
    // No Pause button once it is paused; "Paused" is the status label instead.
    const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(buttons.some((label) => label === "Pause")).toBe(false);
    const resume = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Resume"),
    );
    expect(resume).toBeDefined();
    resume!.click();
    expect(onResumePull).toHaveBeenCalledWith("job-9");
  });

  it("offers Pause, not Resume, while a download is running", () => {
    renderInto(
      baseProps({
        status: READY_STATUS,
        jobs: [
          {
            id: "job-1",
            model: "qualcomm/Qwen3-8B",
            status: "running",
            startedAt: Date.now(),
          },
        ],
      }),
    );
    const labels = [...host.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(labels.some((label) => label?.includes("Pause"))).toBe(true);
    expect(labels.some((label) => label?.includes("Resume"))).toBe(false);
  });

  it("describes cancellation as a pause that keeps progress", () => {
    const text = renderInto(
      baseProps({
        status: READY_STATUS,
        jobs: [
          {
            id: "job-1",
            model: "qualcomm/Qwen3-8B",
            status: "running",
            startedAt: Date.now(),
            downloadedBytes: 2_100_000_000,
          },
        ],
      }),
    );
    expect(text).toContain("Pause");
    // GenieX resumes from the partial file, so calling this "cancel" would
    // misrepresent what happens.
    expect(text).toContain("resumes");
  });

  it("shows an external server as a distinct state", () => {
    const text = renderInto(
      baseProps({
        status: { ...READY_STATUS, serve: { status: "external" } },
      }),
    );
    expect(text).toContain("externally managed");
  });

  it("offers Start when the server is not running", () => {
    const text = renderInto(
      baseProps({
        status: {
          ...READY_STATUS,
          serve: { status: "inactive", reason: "geniex CLI not found on PATH" },
        },
      }),
    );
    expect(text).toContain("not running");
    expect(text).toContain("Start");
  });

  it("surfaces a status error with a retry", () => {
    const text = renderInto(baseProps({ statusError: "connection refused" }));
    expect(text).toContain("connection refused");
    expect(text).toContain("Retry");
  });
});
