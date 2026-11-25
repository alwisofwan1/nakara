import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { BlueprintTransitionDto, Stage } from "../../src/web/api.ts";
import { blueprintQuery } from "../lib/api";
import { plural } from "../lib/format";

export const Route = createFileRoute("/f/$slug/blueprint")({
  // Started, not awaited: the page shows its frame and its own loading state.
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(blueprintQuery(params.slug));
  },
  component: Blueprint,
  staticData: { title: "Blueprint" },
});

/** The drawn stages, top to bottom; cancelled is listed, not drawn. */
const PATH: { stage: Stage; label: string; who: string }[] = [
  { stage: "intake", label: "Intake", who: "Foreman" },
  { stage: "triage", label: "Triage", who: "Triage agent" },
  { stage: "planning", label: "Planning", who: "Spec agent" },
  { stage: "building", label: "Building", who: "Implement agent" },
  { stage: "reviewing", label: "Reviewing", who: "Review agent" },
  { stage: "handoff", label: "Handoff", who: "Human merge" },
  { stage: "complete", label: "Complete", who: "Done" },
];
const LABEL: Record<Stage, string> = {
  ...(Object.fromEntries(PATH.map((p) => [p.stage, p.label])) as Record<
    Stage,
    string
  >),
  cancelled: "Cancelled",
};

const WIDTH = 500;
const NODE_W = 220;
const NODE_H = 60;
const ROW = 100;
const X = (WIDTH - NODE_W) / 2;
const row = (stage: Stage) => PATH.findIndex((p) => p.stage === stage);

/**
 * A move between two drawn stages: to the next stage straight down, a skip
 * down along the left, a return up along the right; the farther, the wider.
 */
function edgePath(from: number, to: number) {
  const span = to - from;
  if (span === 1) {
    const x = WIDTH / 2;
    const y1 = from * ROW + NODE_H;
    const y2 = to * ROW;
    return {
      d: `M${x},${y1} L${x},${y2}`,
      label: { x: x + 8, y: (y1 + y2) / 2 },
    };
  }
  const left = span > 0;
  const side = left ? X : X + NODE_W;
  const bulge = (left ? -1 : 1) * (24 + Math.abs(span) * 22);
  const y1 = from * ROW + NODE_H / 2;
  const y2 = to * ROW + NODE_H / 2;
  return {
    d: `M${side},${y1} C${side + bulge},${y1} ${side + bulge},${y2} ${side},${y2}`,
    label: { x: side + bulge * 0.75, y: (y1 + y2) / 2 },
  };
}

/** A narrow screen scrolls the diagram; it opens on the stages, not the left detours. */
const centre = (el: HTMLDivElement | null) => {
  if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
};

const touches = (t: BlueprintTransitionDto, stage: Stage | null) =>
  !stage || t.from === stage || t.to === stage;

function Blueprint() {
  const { slug } = Route.useParams();
  const { data, isError } = useQuery(blueprintQuery(slug));
  const [selected, setSelected] = useState<Stage | null>(null);

  if (!data)
    return (
      <p role="status" className="text-muted">
        {isError ? "The blueprint could not be loaded." : "Loading…"}
      </p>
    );

  const stages = new Map(data.stages.map((s) => [s.stage, s]));
  const drawn = data.transitions.filter(
    (t) => t.from && row(t.from) >= 0 && row(t.to) >= 0,
  );
  const listed = data.transitions.filter((t) => touches(t, selected));

  return (
    <section>
      <h1 className="mb-md text-heading font-semibold">Blueprint</h1>
      <p className="mb-xl text-muted">
        The stages a work item moves through and the moves the foreman makes.
        Counts start when Nakara began recording stage moves.
      </p>
      <div className="automations-layout">
        <div className="blueprint-scroll" ref={centre}>
          <div
            className="blueprint-canvas"
            style={{ width: WIDTH, height: (PATH.length - 1) * ROW + NODE_H }}
          >
            <svg
              aria-hidden="true"
              width={WIDTH}
              height={(PATH.length - 1) * ROW + NODE_H}
            >
              <defs>
                <marker
                  id="blueprint-arrow"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8 Z" className="blueprint-arrow" />
                </marker>
              </defs>
              {drawn.map((t) => {
                const { d, label } = edgePath(row(t.from as Stage), row(t.to));
                const state = !touches(t, selected)
                  ? "faded"
                  : selected
                    ? "selected"
                    : t.count > 0
                      ? "used"
                      : "idle";
                return (
                  <g key={`${t.from}-${t.to}`} data-state={state}>
                    <path
                      d={d}
                      className="blueprint-edge"
                      data-designed={t.designed}
                      markerEnd="url(#blueprint-arrow)"
                    />
                    {t.count > 0 && (
                      <text
                        x={label.x}
                        y={label.y}
                        className="blueprint-count"
                        dominantBaseline="middle"
                      >
                        {t.count}×
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {PATH.map(({ stage, label, who }, i) => {
              const s = stages.get(stage);
              return (
                <button
                  key={stage}
                  type="button"
                  className="blueprint-node"
                  style={{
                    left: X,
                    top: i * ROW,
                    width: NODE_W,
                    height: NODE_H,
                  }}
                  aria-pressed={selected === stage}
                  onClick={() => setSelected(selected === stage ? null : stage)}
                >
                  <span className="flex justify-between gap-sm">
                    <span className="font-semibold">{label}</span>
                    <span className="text-muted">
                      {plural(s?.runs ?? 0, "run")}
                    </span>
                  </span>
                  <span className="flex justify-between gap-sm text-muted">
                    <span>{who}</span>
                    {(s?.open ?? 0) > 0 && <span>{s?.open} open</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <aside className="automation-pane" aria-label="Blueprint overview">
          <section>
            <h2 className="pane-heading">Stages</h2>
            <table className="blueprint-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Entered</th>
                  <th>Runs</th>
                  <th>Open</th>
                </tr>
              </thead>
              <tbody>
                {data.stages.map((s) => (
                  <tr
                    key={s.stage}
                    aria-current={selected === s.stage ? "true" : undefined}
                  >
                    <td>{LABEL[s.stage]}</td>
                    <td>{s.entered}</td>
                    <td>{s.runs}</td>
                    <td>{s.open}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h2 className="pane-heading">
              Transitions
              {selected ? ` · ${LABEL[selected]}` : ""} ({listed.length})
            </h2>
            <ul className="grid gap-xs text-small">
              {listed.map((t) => (
                <li key={`${t.from}-${t.to}`} className="flex gap-sm">
                  <span>
                    {LABEL[t.from as Stage]} → {LABEL[t.to]}
                  </span>
                  {!t.designed && (
                    <span className="text-attention">off path</span>
                  )}
                  <span className="ml-auto text-muted">{t.count}×</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </section>
  );
}
