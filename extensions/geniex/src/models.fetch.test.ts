// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverGenieXModels, probeGenieXServer } from "./models.fetch.js";

const BASE_URL = "http://127.0.0.1:18181/v1";

/**
 * Real shapes from a Snapdragon X2 Elite host. The list endpoint returns bare
 * OpenAI model objects — note the absence of `model_type`, which is exactly why
 * discovery needs the per-model detail lookup.
 */
const LIST_RESPONSE = {
  object: "list",
  data: [
    { id: "ggml-org/bge-m3-Q8_0-GGUF:Q8_0", owned_by: "ggml-org" },
    { id: "qualcomm/Qwen2.5-VL-7B-Instruct:W4A16", owned_by: "qualcomm" },
    { id: "qualcomm/Qwen3-4B-Instruct-2507:W4A16", owned_by: "qualcomm" },
    { id: "unsloth/gpt-oss-20b-GGUF:F16", owned_by: "unsloth" },
  ],
};

const MODEL_TYPES: Record<string, string> = {
  "qualcomm/Qwen2.5-VL-7B-Instruct:W4A16": "vlm",
  "qualcomm/Qwen3-4B-Instruct-2507:W4A16": "llm",
  "unsloth/gpt-oss-20b-GGUF:F16": "llm",
  "ggml-org/bge-m3-Q8_0-GGUF:Q8_0": "llm",
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Stubs fetch for the probe, list, and per-model detail endpoints. */
function stubGenieX(options?: { detailStatus?: number; listStatus?: number }) {
  const detailRequests: string[] = [];
  // The module under test always passes a template-string URL, so the mock only
  // needs to handle `string` — avoids stringifying a Request, which has no
  // meaningful toString().
  const fetchMock = vi.fn(async (url: string) => {
    if (url === `${BASE_URL}/`) {
      return jsonResponse("GenieX-CLI is running");
    }
    if (url === `${BASE_URL}/models`) {
      return jsonResponse(LIST_RESPONSE, options?.listStatus ?? 200);
    }
    const detailPrefix = `${BASE_URL}/models/`;
    if (url.startsWith(detailPrefix)) {
      const modelId = url.slice(detailPrefix.length);
      detailRequests.push(modelId);
      if (options?.detailStatus && options.detailStatus >= 400) {
        return jsonResponse(null, options.detailStatus);
      }
      return jsonResponse({ id: modelId, model_type: MODEL_TYPES[modelId] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { detailRequests, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeGenieXServer", () => {
  it("accepts the 200 that GET /v1/ returns while serve is up", async () => {
    stubGenieX();
    await expect(probeGenieXServer({ baseUrl: BASE_URL })).resolves.toBe(true);
  });

  it("reports unreachable when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(probeGenieXServer({ baseUrl: BASE_URL })).resolves.toBe(false);
  });
});

describe("discoverGenieXModels", () => {
  it("backfills model_type from the detail endpoint so VLMs accept images", async () => {
    stubGenieX();
    const models = await discoverGenieXModels({ baseUrl: BASE_URL });
    const vlm = models.find((model) => model.id === "qualcomm/Qwen2.5-VL-7B-Instruct:W4A16");
    expect(vlm?.input).toEqual(["text", "image"]);
  });

  it("keeps LLM entries text-only", async () => {
    stubGenieX();
    const models = await discoverGenieXModels({ baseUrl: BASE_URL });
    const llm = models.find((model) => model.id === "unsloth/gpt-oss-20b-GGUF:F16");
    expect(llm?.input).toEqual(["text"]);
  });

  it("excludes the embedding model from the chat catalog", async () => {
    stubGenieX();
    const models = await discoverGenieXModels({ baseUrl: BASE_URL });
    expect(models.map((model) => model.id)).toEqual([
      "qualcomm/Qwen2.5-VL-7B-Instruct:W4A16",
      "qualcomm/Qwen3-4B-Instruct-2507:W4A16",
      "unsloth/gpt-oss-20b-GGUF:F16",
    ]);
  });

  it("does not spend a detail request on the excluded embedding model", async () => {
    const { detailRequests } = stubGenieX();
    await discoverGenieXModels({ baseUrl: BASE_URL });
    expect(detailRequests).not.toContain("ggml-org/bge-m3-Q8_0-GGUF:Q8_0");
    expect(detailRequests).toHaveLength(3);
  });

  it("falls back to text-only when the detail lookup fails", async () => {
    stubGenieX({ detailStatus: 404 });
    const models = await discoverGenieXModels({ baseUrl: BASE_URL });
    const vlm = models.find((model) => model.id === "qualcomm/Qwen2.5-VL-7B-Instruct:W4A16");
    expect(vlm?.input).toEqual(["text"]);
  });

  it("returns nothing when the list endpoint fails", async () => {
    stubGenieX({ listStatus: 500 });
    await expect(discoverGenieXModels({ baseUrl: BASE_URL })).resolves.toEqual([]);
  });
});
