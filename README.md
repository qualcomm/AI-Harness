<h3 align="center">
AI-Harness: Hybrid Edge‑Cloud Large‑Model Invocation Framework based on OpenClaw
</h3>

<p align="center">
  <img src="assets/dragonclaw logo.png" alt="AI-Harness Logo" width="200"/>
</p>

<p align="center">
    【<a href="./readme_zh.md"><b>中文</b></a> | English】
</p>

## Overview

**AI-Harness** is a project built on top of **OpenClaw**, designed to support hybrid edge‑cloud large‑model invocation. It extends OpenClaw’s capabilities by allowing seamless integration of local (edge) models with remote (cloud) services, enabling flexible, high‑performance AI applications across diverse deployment scenarios.

## Why AI-Harness
Better adapt to the WoS platform, addressing core challenges such as local deployment, privacy protection, intelligent context compression, workload-aware model routing, purpose-built on-device agents and hybrid agentic orchestration.

## Feature List

Each feature is delivered by a dedicated OpenClaw plugin under [`extensions/`](extensions):

| Feature | Plugin | What it does |
| --- | --- | --- |
| Privacy protection | [guardclaw](extensions/guardclaw) | Detects sensitive content at multiple checkpoints (S1/S2/S3) and routes S3 operations to an isolated guard agent with a local model, so private data never leaves the machine. |
| Intelligent context compression | [context-trim](extensions/context-trim) | Replaces the system prompt with a compact `minimal` version for low-context local/edge models (under 16K context), keeping more of the budget for actual work. |
| Workload-aware model routing | [dragon-router](extensions/dragon-router) | Detects each prompt's privacy level and task complexity, then routes across model tiers — sensitive data stays local, medium-sensitive data is desensitized before the cloud round-trip. |
| Purpose-built on-device agents | [video-chapters](extensions/video-chapters) *(example)* | A pattern for building local AI tools focused on a single job — e.g. semantic video-chapter search that indexes and searches videos entirely on-device. |
| Hybrid agentic orchestration | [dragon-task-orchestrator](extensions/dragon-task-orchestrator) | Splits a composite request into subtasks, routes each to a matching agent (dynamic decomposition or a fixed pipeline), and summarizes the results into one reply. |

## Installation

Same as OpenClaw:

### 1. Clone the Repository
```bash
https://github.com/qualcomm/AI-Harness.git
cd AI-Harness
```

### 2. Install Dependencies + Build

```bash
pnpm install
pnpm build
pnpm ui:build
pnpm openclaw onboard // a wizard to config openclaw
pnpm openclaw gateway run --verbose // start gateway
```

