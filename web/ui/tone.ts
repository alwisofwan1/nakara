import type { Tone } from "../../src/web/api.ts";

/** Tile and chip colours per view-model tone. */
export const TONE: Record<Tone, string> = {
  muted: "bg-surface-muted text-muted",
  accent: "bg-accent-soft text-accent",
  attention: "bg-attention-soft text-attention",
  building: "bg-building-soft text-building",
  reviewing: "bg-reviewing-soft text-reviewing",
  handoff: "bg-handoff-soft text-handoff",
  bad: "bg-bad-bg text-bad",
};
export const TONE_TEXT: Record<Tone, string> = {
  muted: "text-muted",
  accent: "text-accent",
  attention: "text-attention",
  building: "text-building",
  reviewing: "text-reviewing",
  handoff: "text-handoff",
  bad: "text-bad",
};
export const TONE_FILL: Record<Tone, string> = {
  muted: "bg-muted",
  accent: "bg-accent",
  attention: "bg-attention",
  building: "bg-building",
  reviewing: "bg-reviewing",
  handoff: "bg-handoff",
  bad: "bg-bad",
};
