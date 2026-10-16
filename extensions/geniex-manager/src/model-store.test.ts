// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
  isValidGenieXChipset,
  isValidGenieXModelName,
  mapGenieXListedModels,
  parseGenieXChipsetOutput,
  parseGenieXListOutput,
} from "./model-store.js";

/** Verbatim `geniex list --format json` output from a Snapdragon X2 Elite host. */
const REAL_LIST_OUTPUT = `[
  {
    "name": "ggml-org/bge-m3-Q8_0-GGUF",
    "size": 634553760,
    "runtime": "llama_cpp",
    "type": "llm",
    "precisions": [
      "Q8_0"
    ]
  },
  {
    "name": "qualcomm/Qwen2.5-VL-7B-Instruct",
    "size": 6815229014,
    "runtime": "qairt",
    "type": "vlm",
    "precisions": [
      "W4A16"
    ]
  },
  {
    "name": "unsloth/gpt-oss-20b-GGUF",
    "size": 13792639168,
    "runtime": "llama_cpp",
    "type": "llm",
    "precisions": [
      "F16"
    ]
  }
]`;

describe("parseGenieXListOutput", () => {
  it("parses real CLI output", () => {
    expect(parseGenieXListOutput(REAL_LIST_OUTPUT)).toHaveLength(3);
  });

  it("ignores banner text printed before the JSON array", () => {
    expect(parseGenieXListOutput(`Some notice line\n${REAL_LIST_OUTPUT}`)).toHaveLength(3);
  });

  it("returns an empty list for no output", () => {
    // A fresh install with nothing downloaded is a normal state, not an error.
    expect(parseGenieXListOutput("")).toEqual([]);
    expect(parseGenieXListOutput("   ")).toEqual([]);
  });

  it("returns an empty list when there is no JSON array", () => {
    expect(parseGenieXListOutput("no models found")).toEqual([]);
  });

  it("returns an empty list for malformed JSON instead of throwing", () => {
    expect(parseGenieXListOutput("[{broken")).toEqual([]);
  });
});

describe("mapGenieXListedModels", () => {
  const models = mapGenieXListedModels(parseGenieXListOutput(REAL_LIST_OUTPUT));

  it("marks llama_cpp models as compute-selectable", () => {
    expect(models.find((model) => model.name === "unsloth/gpt-oss-20b-GGUF")?.computeSelectable).toBe(
      true,
    );
  });

  it("locks qairt models out of compute selection", () => {
    // qairt is NPU-only: GenieX coerces any other unit back and warns.
    expect(
      models.find((model) => model.name === "qualcomm/Qwen2.5-VL-7B-Instruct")?.computeSelectable,
    ).toBe(false);
  });

  it("carries runtime, type, size, and precisions through", () => {
    const vlm = models.find((model) => model.name === "qualcomm/Qwen2.5-VL-7B-Instruct");
    expect(vlm).toMatchObject({
      runtime: "qairt",
      modelType: "vlm",
      size: 6815229014,
      precisions: ["W4A16"],
    });
  });

  it("reports an unrecognized type as unknown rather than guessing", () => {
    const [model] = mapGenieXListedModels([{ name: "a/b", type: "diffusion" }]);
    expect(model?.modelType).toBe("unknown");
  });

  it("treats an unknown runtime as compute-selectable", () => {
    // Matches computeUnitsForRuntime: a future runtime is more likely
    // device-flexible than NPU-pinned, and both paths must agree.
    const [model] = mapGenieXListedModels([{ name: "a/b", runtime: "future_runtime" }]);
    expect(model?.computeSelectable).toBe(true);
  });

  it("skips rows with no name", () => {
    expect(mapGenieXListedModels([{ size: 1 }, { name: "  " }])).toEqual([]);
  });
});

describe("isValidGenieXModelName", () => {
  it("accepts the forms GenieX pulls", () => {
    for (const name of [
      "qualcomm/Qwen3-4B",
      "qualcomm/Qwen3-4B-Instruct-2507",
      "unsloth/gpt-oss-20b-GGUF:F16",
      "ggml-org/bge-m3-Q8_0-GGUF:Q8_0",
      "qualcomm/qwen3_vl_8b_instruct",
      // Bare names are rewritten to qualcomm/<name> by GenieX.
      "llama_v3_2_3b_instruct",
    ]) {
      expect(isValidGenieXModelName(name), name).toBe(true);
    }
  });

  it("rejects shell metacharacters and separators", () => {
    // Commands are spawned as argv without a shell, so this is defence in depth —
    // but a name like this should never reach GenieX either.
    for (const name of [
      "a/b; rm -rf /",
      "a/b && whoami",
      "a/b | cat",
      "a/b`id`",
      "a/b$(id)",
      "a/b'",
      'a/b"',
      "a b/c",
      "a/b\nc",
    ]) {
      expect(isValidGenieXModelName(name), name).toBe(false);
    }
  });

  it("rejects path traversal", () => {
    expect(isValidGenieXModelName("../etc/passwd")).toBe(false);
    expect(isValidGenieXModelName("a/../../b")).toBe(false);
  });

  it("rejects absolute and multi-segment paths", () => {
    expect(isValidGenieXModelName("/etc/passwd")).toBe(false);
    expect(isValidGenieXModelName("a/b/c")).toBe(false);
  });

  it("rejects blank and over-long names", () => {
    expect(isValidGenieXModelName("")).toBe(false);
    expect(isValidGenieXModelName("   ")).toBe(false);
    expect(isValidGenieXModelName(`a/${"x".repeat(300)}`)).toBe(false);
  });
});

describe("parseGenieXChipsetOutput", () => {
  it("reads the configured chipset", () => {
    expect(parseGenieXChipsetOutput("qualcomm-snapdragon-x2-elite\n")).toBe(
      "qualcomm-snapdragon-x2-elite",
    );
  });

  it("treats \"unknown\" as unresolved", () => {
    // GenieX prints this when neither config nor host probe yields a chipset;
    // the caller must then ask the user, or `geniex pull` would hang on a picker.
    expect(parseGenieXChipsetOutput("unknown")).toBeUndefined();
    expect(parseGenieXChipsetOutput("UNKNOWN\n")).toBeUndefined();
  });

  it("takes the last line, ignoring preceding notices", () => {
    expect(parseGenieXChipsetOutput("note\nqualcomm-snapdragon-x-elite")).toBe(
      "qualcomm-snapdragon-x-elite",
    );
  });

  it("returns undefined for empty output", () => {
    expect(parseGenieXChipsetOutput("")).toBeUndefined();
  });
});

describe("isValidGenieXChipset", () => {
  it("accepts canonical platform.json ids", () => {
    expect(isValidGenieXChipset("qualcomm-snapdragon-x2-elite")).toBe(true);
    expect(isValidGenieXChipset("qualcomm-qcs9075")).toBe(true);
  });

  it("rejects anything with separators or metacharacters", () => {
    expect(isValidGenieXChipset("a; rm -rf /")).toBe(false);
    expect(isValidGenieXChipset("a/b")).toBe(false);
    expect(isValidGenieXChipset("")).toBe(false);
  });
});
