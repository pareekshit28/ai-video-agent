import type { ReasoningEffort } from "./reasoning";

export type Model = {
  slug: string;
  displayName: string;
  reasoningEfforts?: { effort: ReasoningEffort; description: string }[];
  defaultReasoningEffort?: ReasoningEffort;
};
