import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { modelsQuery } from "../../lib/api";
import { Icon } from "../../ui/icons";

/** What agent.md stores: null means agentDefaults decides. */
export interface ModelChoice {
  harness: string | null;
  model: string | null;
  effort: string | null;
}

const PROVIDERS = [
  { harness: "claude", label: "Claude" },
  { harness: "codex", label: "Codex" },
  { harness: "qwen", label: "Qwen" },
] as const;
type Provider = (typeof PROVIDERS)[number]["harness"];

const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};
const effortLabel = (e: string) =>
  EFFORT_LABEL[e] ?? e.charAt(0).toUpperCase() + e.slice(1);

// Warp's `claude-code` runs on Claude Code; Warp-only harnesses show under Claude.
const providerOf = (harness: string | null, fallback: string): Provider =>
  harness === "codex" || harness === "qwen"
    ? harness
    : harness === null && (fallback === "codex" || fallback === "qwen")
      ? fallback
      : "claude";

/** One button with a panel like bb's: provider tabs, search, models, then reasoning. */
export function ModelPicker({
  value,
  defaultLabel,
  defaultHarness,
  onChange,
}: {
  value: ModelChoice;
  /** What an unset harness and model fall back to, e.g. "claude · opus". */
  defaultLabel: string;
  defaultHarness: string;
  onChange: (next: ModelChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = providerOf(value.harness, defaultHarness);
  const [tab, setTab] = useState<Provider>(current);
  const [search, setSearch] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const searchId = useId();
  const listed = tab === "qwen" ? null : tab;
  const models = useQuery({
    ...modelsQuery(listed ?? "claude"),
    enabled: open && listed !== null,
  });
  // The trigger names the saved model even before the panel ever opened.
  const savedList = useQuery({
    ...modelsQuery(current === "qwen" ? "claude" : current),
    enabled: current !== "qwen" && value.model !== null,
  });

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        button.current?.focus();
      } else if (
        panel.current?.contains(event.target as Node) ||
        button.current?.contains(event.target as Node)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const inherited = value.harness === null && value.model === null;
  const savedModel = savedList.data?.find((m) => m.id === value.model);
  const triggerLabel = inherited
    ? `Default (${defaultLabel})`
    : current === "qwen"
      ? "Qwen (gateway model)"
      : (savedModel?.label ??
        value.model ??
        `${PROVIDERS.find((p) => p.harness === current)?.label} default`);

  const query = search.trim().toLowerCase();
  const shown = (models.data ?? []).filter(
    (m) =>
      !query ||
      m.label.toLowerCase().includes(query) ||
      m.id.toLowerCase().includes(query),
  );
  const exact = (models.data ?? []).some((m) => m.id === search.trim());
  const selected =
    tab === current
      ? (models.data ?? []).find((m) => m.id === value.model)
      : undefined;

  const choose = (harness: Provider, model: string | null) => {
    const efforts =
      models.data?.find((m) => m.id === model)?.efforts ?? ([] as string[]);
    // Keep the chosen effort when the new model supports it.
    const effort =
      value.effort && efforts.includes(value.effort) ? value.effort : null;
    onChange({ harness, model, effort });
  };

  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        className="filter-button"
        aria-label="Model"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setTab(current);
          setSearch("");
          setOpen(!open);
        }}
      >
        <span>{triggerLabel}</span>
        {value.effort && (
          <span className="text-muted">{effortLabel(value.effort)}</span>
        )}
        <Icon name="chevron-down" className="h-md w-md text-muted" />
      </button>
      {open && (
        <div
          ref={panel}
          className="model-picker"
          role="dialog"
          aria-label="Choose a model"
        >
          <div className="flex gap-xs border-b border-line p-xs" role="tablist">
            {PROVIDERS.map((p) => (
              <button
                key={p.harness}
                type="button"
                role="tab"
                className="tab"
                aria-selected={tab === p.harness}
                data-state={tab === p.harness ? "active" : undefined}
                onClick={() => {
                  setTab(p.harness);
                  setSearch("");
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          {listed !== null && (
            <label
              htmlFor={searchId}
              className="flex items-center gap-sm border-b border-line px-md py-sm"
            >
              <Icon name="search" className="h-md w-md text-muted" />
              <input
                id={searchId}
                className="w-full bg-bg outline-none"
                placeholder="Search models, or type a model id"
                value={search}
                // biome-ignore lint/a11y/noAutofocus: the panel opens to search, like bb's picker.
                autoFocus
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          )}
          <div className="model-picker-list">
            <button
              type="button"
              className="model-option"
              aria-pressed={inherited}
              onClick={() =>
                onChange({ harness: null, model: null, effort: null })
              }
            >
              <span>Default ({defaultLabel})</span>
              {inherited && <Icon name="check" className="h-md w-md" />}
            </button>
            {listed === null ? (
              <button
                type="button"
                className="model-option"
                aria-pressed={current === "qwen" && !inherited}
                onClick={() =>
                  onChange({ harness: "qwen", model: null, effort: null })
                }
              >
                <span className="grid">
                  <span>Qwen (gateway model)</span>
                  <span className="text-tiny text-muted">
                    The gateway serves one model; its other names are aliases of
                    it.
                  </span>
                </span>
                {current === "qwen" && !inherited && (
                  <Icon name="check" className="h-md w-md" />
                )}
              </button>
            ) : models.isPending ? (
              <p className="px-md py-sm text-muted">
                Asking {tab} for its models…
              </p>
            ) : (
              <>
                {models.error && (
                  <p className="px-md py-sm text-attention" role="alert">
                    {models.error.message}{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => models.refetch()}
                    >
                      Retry
                    </button>
                  </p>
                )}
                {shown.map((m) => {
                  const active = tab === current && m.id === value.model;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className="model-option"
                      aria-pressed={active}
                      title={m.description}
                      onClick={() => choose(tab, m.id)}
                    >
                      <span className="grid">
                        <span>{m.label}</span>
                        <span className="text-tiny text-muted">{m.id}</span>
                      </span>
                      {active && <Icon name="check" className="h-md w-md" />}
                    </button>
                  );
                })}
                {search.trim() && !exact && (
                  <button
                    type="button"
                    className="model-option"
                    onClick={() => choose(tab, search.trim())}
                  >
                    Use “{search.trim()}”
                  </button>
                )}
              </>
            )}
          </div>
          {selected && selected.efforts.length > 0 && (
            <fieldset className="grid gap-xs border-t border-line px-md py-sm">
              <legend className="text-muted">Reasoning</legend>
              <div className="flex flex-wrap gap-xs">
                {[null, ...selected.efforts].map((e) => (
                  <button
                    key={e ?? "default"}
                    type="button"
                    className="effort-option"
                    aria-pressed={value.effort === e}
                    onClick={() => onChange({ ...value, effort: e })}
                  >
                    {e
                      ? effortLabel(e)
                      : `Default${selected.defaultEffort ? ` (${effortLabel(selected.defaultEffort)})` : ""}`}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}
