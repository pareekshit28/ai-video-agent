import { z } from "zod";

export const reasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export const defaultReasoningEffort: ReasoningEffort = "low";
export const reasoningLabels: Record<ReasoningEffort, string> = {
  none: "No thinking", minimal: "Minimal", low: "Low · faster", medium: "Medium · balanced",
  high: "High · thorough", xhigh: "Extra high", max: "Maximum", ultra: "Ultra",
};
