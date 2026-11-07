// OpenClaw src/tui/tui-overlays.ts, commit 24a860c9e7d9b2ebba60e3ca2cbb0b3ce3abfb19.
// Copyright (c) 2026 OpenClaw Foundation; MIT license in LICENSE.openclaw.
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";

type OverlayHost = Pick<TUI, "showOverlay" | "hasOverlay" | "setFocus">;

/** Creates open/close handlers that restore focus when no overlay is active. */
export function createOverlayHandlers(host: OverlayHost, fallbackFocus: Component) {
  const closeOverlay = (handle: OverlayHandle) => {
    handle.hide();
    if (!host.hasOverlay()) {
      host.setFocus(fallbackFocus);
    }
  };

  return { openOverlay: host.showOverlay.bind(host), closeOverlay };
}
