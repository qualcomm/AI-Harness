// Copyright (c) 2026 Qualcomm Innovation Center, Inc.
// SPDX-License-Identifier: MIT
import { LitElement, html } from "lit";
import { property, state } from "lit/decorators.js";

export class DownloadStatus extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ type: String }) status: "running" | "succeeded" | "failed" | "cancelled" =
    "running";

  @property({ type: Number }) startedAt = 0;

  @property({ type: String }) error = "";

  @state() private tick = 0;

  private timer: ReturnType<typeof setInterval> | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.startTicker();
  }

  override disconnectedCallback() {
    this.stopTicker();
    super.disconnectedCallback();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("status")) {
      this.startTicker();
    }
  }

  private startTicker() {
    this.stopTicker();
    if (this.status !== "running") {
      return;
    }
    this.timer = window.setInterval(() => {
      this.tick += 1;
    }, 1000);
  }

  private stopTicker() {
    if (this.timer == null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private formatElapsed() {
    const elapsedMs = Date.now() - this.startedAt;
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }

  override render() {
    if (this.status === "failed") {
      const errorText = this.error?.trim() || "Download failed.";
      return html`
        <div class="local-models__download-failed">
          <span
            class="local-models__download-dot local-models__download-dot--failed"
            title="Download failed"
            aria-label="Download failed"
          ></span>
          <span class="local-models__download-error">${errorText}</span>
        </div>
      `;
    }

    if (this.status === "cancelled") {
      return html`
        <span
          class="local-models__download-dot local-models__download-dot--paused"
          title="Paused"
          aria-label="Paused"
        ></span>
        <span class="local-models__download-elapsed">Paused</span>
      `;
    }

    const dotClass =
      this.status === "running"
        ? "local-models__download-dot--running"
        : "local-models__download-dot--succeeded";
    const title = this.status === "running" ? "Downloading" : "Downloaded";
    const label = this.status === "running" ? `Downloading… (elapsed ${this.formatElapsed()})` : "Downloaded";

    return html`
      <span
        class="local-models__download-dot ${dotClass}"
        title=${title}
        aria-label=${title}
      ></span>
      <span class="local-models__download-elapsed">${label}</span>
    `;
  }
}

if (!customElements.get("download-status")) {
  customElements.define("download-status", DownloadStatus);
}