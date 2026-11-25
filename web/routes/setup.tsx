import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type {
  CheckGroup,
  CheckState,
  SetupCheckDto,
} from "../../src/web/api.ts";
import { setupQuery, verifyToken } from "../lib/api";
import { Icon, type IconName } from "../ui/icons";

export const Route = createFileRoute("/setup")({
  staticData: { title: "Setup" },
  // Started, not awaited: the page shows its frame and its own loading state.
  loader: ({ context }) => {
    void context.queryClient.prefetchQuery(setupQuery);
  },
  component: Setup,
});

const GROUPS: CheckGroup[] = ["Host", "Credentials", "Factories", "Operations"];
const STATE: Record<
  CheckState,
  { label: string; icon: IconName; tile: string; text: string }
> = {
  ok: {
    label: "OK",
    icon: "circle-check",
    tile: "bg-handoff-soft text-handoff",
    text: "text-handoff",
  },
  warn: {
    label: "Needs attention",
    icon: "circle-alert",
    tile: "bg-attention-soft text-attention",
    text: "text-attention",
  },
  fail: {
    label: "Broken",
    icon: "circle-x",
    tile: "bg-bad-bg text-bad",
    text: "text-bad",
  },
};

function Setup() {
  const client = useQueryClient();
  const { data, isError, isFetching } = useQuery(setupQuery);
  return (
    <section className="grid gap-lg">
      <div className="flex flex-wrap items-center justify-between gap-md">
        <h1 className="text-heading font-bold">Setup</h1>
        <button
          type="button"
          className="ghost flex items-center gap-xs"
          disabled={isFetching}
          onClick={() => void client.invalidateQueries({ queryKey: ["setup"] })}
        >
          <Icon name="refresh" className="h-md w-md" />
          {isFetching ? "Checking…" : "Check again"}
        </button>
      </div>
      {!data ? (
        <p role="status" className="text-muted">
          {isError ? "Setup checks unavailable. Retrying…" : "Checking…"}
        </p>
      ) : (
        <>
          <p role="status" className="flex flex-wrap gap-md text-small">
            <span className={STATE.fail.text}>{data.counts.fail} broken</span>
            <span className={STATE.warn.text}>
              {data.counts.warn} need attention
            </span>
            <span className={STATE.ok.text}>{data.counts.ok} ok</span>
          </p>
          {GROUPS.map((group) => {
            const checks = data.checks.filter((c) => c.group === group);
            return checks.length === 0 ? null : (
              <section key={group} className="grid gap-sm">
                <h2 className="text-small font-semibold text-muted">{group}</h2>
                <ul className="grid gap-sm">
                  {checks.map((check) => (
                    <li key={check.id}>
                      <Check check={check} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}

function Check({ check }: { check: SetupCheckDto }) {
  const look = STATE[check.state];
  const { verify } = check;
  const test = useMutation({
    mutationFn: () => verifyToken(verify ?? "agent"),
  });
  const result = test.data;
  return (
    <div className="flex items-start gap-md rounded-control bg-surface-muted p-md">
      <span
        className={`flex h-tile w-tile shrink-0 items-center justify-center rounded-control ${look.tile}`}
      >
        <Icon name={look.icon} className="h-lg w-lg" />
        <span className="sr-only">{look.label}</span>
      </span>
      <div className="grid min-w-0 flex-1 gap-xs">
        <p className="font-semibold">{check.title}</p>
        <p className="text-small text-muted">{check.detail}</p>
        {check.fix && (
          <p className="text-small">
            <span className="font-semibold">Fix: </span>
            {check.fix}
          </p>
        )}
        {verify && (
          <div className="grid gap-xs">
            <div>
              <button
                type="button"
                className="ghost flex items-center gap-xs"
                disabled={test.isPending}
                onClick={() => test.mutate()}
              >
                <Icon name="refresh" className="h-md w-md" />
                {test.isPending ? "Asking GitHub…" : "Verify with GitHub"}
              </button>
            </div>
            {test.isError && (
              <p className="form-error" role="alert">
                {test.error.message}
              </p>
            )}
            {result && (
              <div role="status" className="grid gap-xs text-small">
                <p className={`font-semibold ${STATE[result.state].text}`}>
                  {STATE[result.state].label}: {result.detail}
                </p>
                <ul className="grid gap-xs text-muted">
                  {result.repos.map((r) => (
                    <li key={r.repo}>
                      {r.repo}:{" "}
                      {r.reachable
                        ? r.canPush === null
                          ? "reachable"
                          : r.canPush
                            ? "reachable, push allowed"
                            : "reachable, read-only"
                        : "not reachable"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
