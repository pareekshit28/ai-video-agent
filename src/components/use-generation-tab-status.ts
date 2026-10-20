"use client";

import { useEffect } from "react";
import { defaultTabTitle, generationTabTitle, type GenerationTabStatus } from "@/lib/generation-tab-status";

export function useReportTabStatus(status: GenerationTabStatus | null, report?: (status: GenerationTabStatus | null) => void) {
  const label = status?.label, state = status?.state;
  useEffect(() => { report?.(label && state ? { label, state } : null); }, [label, state, report]);
  useEffect(() => () => report?.(null), [report]);
}

export function useGenerationTabTicker(status: GenerationTabStatus | null) {
  const label = status?.label, state = status?.state;
  useEffect(() => {
    let tick = 0;
    const current = label && state ? { label, state } : null;
    const update = () => { document.title = generationTabTitle(current, tick++); };
    update();
    const timer = state === "working" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? window.setInterval(update, 1200) : undefined;
    // Refresh the title immediately when returning from another browser tab.
    document.addEventListener("visibilitychange", update);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", update); document.title = defaultTabTitle; };
  }, [label, state]);
}
