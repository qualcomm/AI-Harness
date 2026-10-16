// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { resolveCanonicalChipsetId, selectAiHubChipsets, selectAiHubModels } from "./aihub.js";

/**
 * Entry shapes taken from the live AI Hub `manifest.json`, including a
 * computer-vision model and a GGUF-only entry that must both be filtered out.
 */
const MANIFEST = {
  models: [
    {
      id: "cavaface",
      display_name: "CavaFace",
      domain: "MODEL_DOMAIN_COMPUTER_VISION",
      supported_runtimes: ["RUNTIME_TFLITE", "RUNTIME_QNN_DLC", "RUNTIME_ONNX"],
      supported_chipsets: ["qualcomm-snapdragon-x2-elite"],
      tags: ["MODEL_TAG_REAL_TIME"],
    },
    {
      id: "qwen3_4b",
      display_name: "Qwen3-4B",
      domain: "MODEL_DOMAIN_GENERATIVE_AI",
      supported_runtimes: ["RUNTIME_GENIEX_QAIRT"],
      supported_chipsets: ["qualcomm-snapdragon-x2-elite", "qualcomm-snapdragon-x-elite"],
      tags: [],
    },
    {
      id: "qwen2_5_vl_7b_instruct",
      display_name: "Qwen2.5-VL-7B-Instruct",
      domain: "MODEL_DOMAIN_GENERATIVE_AI",
      supported_runtimes: ["RUNTIME_GENIEX_QAIRT"],
      supported_chipsets: ["qualcomm-snapdragon-x2-elite"],
      tags: ["MODEL_TAG_VLM"],
    },
    {
      id: "phi_3_5_mini_instruct",
      display_name: "Phi-3.5-Mini-Instruct",
      domain: "MODEL_DOMAIN_GENERATIVE_AI",
      // Only the legacy runtime id — must still match.
      supported_runtimes: ["RUNTIME_GENIE"],
      supported_chipsets: ["qualcomm-snapdragon-x2-elite"],
      tags: [],
    },
    {
      id: "llama_v3_2_1b_instruct",
      display_name: "Llama-v3.2-1B-Instruct",
      domain: "MODEL_DOMAIN_GENERATIVE_AI",
      supported_runtimes: ["RUNTIME_GENIEX_QAIRT"],
      // Different chipset: excluded when filtering for X2 Elite.
      supported_chipsets: ["qualcomm-snapdragon-8-elite"],
      tags: [],
    },
  ],
};

const X2_ELITE = "qualcomm-snapdragon-x2-elite";

describe("selectAiHubModels", () => {
  it("keeps only models with a QAIRT build", () => {
    // ONNX / TFLite / QNN_DLC / llama.cpp GGUF assets cannot be installed through
    // the AI Hub source, so they must never be offered.
    const models = selectAiHubModels({ manifest: MANIFEST, chipset: X2_ELITE });
    expect(models.map((model) => model.id)).not.toContain("cavaface");
  });

  it("accepts the legacy RUNTIME_GENIE id", () => {
    // AI Hub is mid-migration; some models publish only the legacy name.
    const models = selectAiHubModels({ manifest: MANIFEST, chipset: X2_ELITE });
    expect(models.map((model) => model.id)).toContain("phi_3_5_mini_instruct");
  });

  it("filters to the requested chipset", () => {
    const models = selectAiHubModels({ manifest: MANIFEST, chipset: X2_ELITE });
    expect(models.map((model) => model.id)).not.toContain("llama_v3_2_1b_instruct");
  });

  it("lists every QAIRT model when no chipset is given", () => {
    const models = selectAiHubModels({ manifest: MANIFEST });
    expect(models.map((model) => model.id)).toContain("llama_v3_2_1b_instruct");
  });

  it("builds pull-ready names under the qualcomm org", () => {
    const models = selectAiHubModels({ manifest: MANIFEST, chipset: X2_ELITE });
    expect(models.find((model) => model.id === "qwen3_4b")?.name).toBe("qualcomm/Qwen3-4B");
  });

  it("marks VLMs from MODEL_TAG_VLM", () => {
    // `domain` alone cannot distinguish them: both report GENERATIVE_AI.
    const models = selectAiHubModels({ manifest: MANIFEST, chipset: X2_ELITE });
    expect(models.find((model) => model.id === "qwen2_5_vl_7b_instruct")?.modelType).toBe("vlm");
    expect(models.find((model) => model.id === "qwen3_4b")?.modelType).toBe("llm");
  });

  it("sorts case-insensitively by display name, matching the CLI order", () => {
    const models = selectAiHubModels({ manifest: MANIFEST, chipset: X2_ELITE });
    expect(models.map((model) => model.displayName)).toEqual([
      "Phi-3.5-Mini-Instruct",
      "Qwen2.5-VL-7B-Instruct",
      "Qwen3-4B",
    ]);
  });

  it("skips entries missing an id or display name", () => {
    const models = selectAiHubModels({
      manifest: {
        models: [
          { id: "x", supported_runtimes: ["RUNTIME_GENIE"] },
          { display_name: "Y", supported_runtimes: ["RUNTIME_GENIE"] },
        ],
      },
    });
    expect(models).toEqual([]);
  });

  it("tolerates a manifest with no models", () => {
    expect(selectAiHubModels({ manifest: {} })).toEqual([]);
  });
});

describe("selectAiHubChipsets", () => {
  const PLATFORM = {
    chipsets: [
      {
        name: "qualcomm-snapdragon-x2-elite",
        aliases: ["qualcomm-snapdragon-x2-elite", "snapdragon-x2-elite"],
        marketing_name: "Snapdragon® X2 Elite",
        reference_device: "Snapdragon X2 Elite CRD",
      },
      {
        name: "qualcomm-qcm6690",
        aliases: ["qcm6690"],
        marketing_name: "Qualcomm® Dragonwing™ Q-6690",
        reference_device: "Dragonwing Q-6690 MTP",
      },
    ],
  };

  it("prefers reference_device, which is what GenieX displays", () => {
    const chipsets = selectAiHubChipsets(PLATFORM);
    expect(chipsets.find((chipset) => chipset.name === "qualcomm-snapdragon-x2-elite")?.displayName).toBe(
      "Snapdragon X2 Elite CRD",
    );
  });

  it("falls back to the marketing name when no reference device exists", () => {
    const chipsets = selectAiHubChipsets({
      chipsets: [{ name: "qualcomm-test", marketing_name: "Test Chip" }],
    });
    expect(chipsets[0]?.displayName).toBe("Test Chip");
  });

  it("falls back to the canonical id when nothing else is available", () => {
    const chipsets = selectAiHubChipsets({ chipsets: [{ name: "qualcomm-test" }] });
    expect(chipsets[0]?.displayName).toBe("qualcomm-test");
  });

  it("sorts by display name", () => {
    expect(selectAiHubChipsets(PLATFORM).map((chipset) => chipset.displayName)).toEqual([
      "Dragonwing Q-6690 MTP",
      "Snapdragon X2 Elite CRD",
    ]);
  });
});

describe("resolveCanonicalChipsetId", () => {
  const PLATFORM = {
    chipsets: [
      {
        name: "qualcomm-snapdragon-x2-elite",
        aliases: ["qualcomm-snapdragon-x2-elite", "snapdragon-x2-elite"],
        marketing_name: "Snapdragon® X2 Elite",
        reference_device: "Snapdragon X2 Elite CRD",
      },
    ],
  };

  it("resolves the reference-device display name GenieX's online chipset detection returns", () => {
    // The exact real-world failure: `geniex config get chipset` (unconfigured,
    // online detection) returns this string, not the canonical id, and
    // `supported_chipsets` in manifest.json never contains it — filtering
    // directly against it always produces zero models with no error.
    expect(resolveCanonicalChipsetId(PLATFORM, "Snapdragon X2 Elite CRD")).toBe(
      "qualcomm-snapdragon-x2-elite",
    );
  });

  it("resolves case-insensitively and trims whitespace", () => {
    expect(resolveCanonicalChipsetId(PLATFORM, "  snapdragon x2 elite crd  ")).toBe(
      "qualcomm-snapdragon-x2-elite",
    );
  });

  it("passes an already-canonical id straight through", () => {
    expect(resolveCanonicalChipsetId(PLATFORM, "qualcomm-snapdragon-x2-elite")).toBe(
      "qualcomm-snapdragon-x2-elite",
    );
  });

  it("resolves an alias", () => {
    expect(resolveCanonicalChipsetId(PLATFORM, "snapdragon-x2-elite")).toBe(
      "qualcomm-snapdragon-x2-elite",
    );
  });

  it("resolves the marketing name", () => {
    expect(resolveCanonicalChipsetId(PLATFORM, "Snapdragon® X2 Elite")).toBe(
      "qualcomm-snapdragon-x2-elite",
    );
  });

  it("returns undefined when nothing in the catalogue matches", () => {
    expect(resolveCanonicalChipsetId(PLATFORM, "some unknown chip")).toBeUndefined();
  });

  it("returns undefined for blank input", () => {
    expect(resolveCanonicalChipsetId(PLATFORM, "   ")).toBeUndefined();
  });
});
