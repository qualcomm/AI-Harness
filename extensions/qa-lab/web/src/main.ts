// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import "./styles.css";
import { createQaLabApp } from "./app.js";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error("QA Lab app root missing");
}

void createQaLabApp(root);
