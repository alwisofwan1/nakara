import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useToast } from "../app/toast";
import {
  instanceSettingsQuery,
  loadPage,
  saveConcurrency,
  statusQuery,
} from "../lib/api";

export const Route = createFileRoute("/settings")({
  loader: ({ context }) => loadPage(context.queryClient, instanceSettingsQuery),
  component: InstanceSettings,
  staticData: { title: "Settings" },
});

/** The range the server accepts; see src/db/instance-settings.ts. */
const MIN = 1;
const MAX = 10;

function InstanceSettings() {
  return (
    <section className="grid gap-xl">
      <div className="grid gap-xs">
        <h1 className="text-heading font-semibold">Settings</h1>
        <p className="text-small text-muted">
          Settings of this Nakara, shared by every factory. Each factory has its
          own Settings page under its name in the sidebar.
        </p>
      </div>
      <Runs />
    </section>
  );
}

/** How many agent runs start at once, across every factory. */
function Runs() {
  const { data } = useSuspenseQuery(instanceSettingsQuery);
  const status = useQuery(statusQuery).data;
  const { concurrency } = data;
  const client = useQueryClient();
  const toast = useToast();
  const saved = concurrency.saved === null ? "" : String(concurrency.saved);
  const [value, setValue] = useState(saved);
  const [invalid, setInvalid] = useState<string | null>(null);
  // The text last saved or sent: Enter then blur saves once.
  const committed = useRef(saved);
  // Another tab's edit arrives through /api/events.
  useEffect(() => {
    committed.current = saved;
    setValue(saved);
  }, [saved]);
  const save = useMutation({
    mutationFn: saveConcurrency,
    onSuccess: (result, next) => {
      client.setQueryData(instanceSettingsQuery.queryKey, result);
      void client.invalidateQueries({ queryKey: ["status"] });
      toast({
        title: "Settings saved",
        description: `Concurrent agent runs: ${next === null ? `default (${concurrency.default})` : next}.`,
        tone: "ok",
      });
    },
  });
  const commit = (input: HTMLInputElement) => {
    const text = input.value.trim();
    if (!input.checkValidity()) {
      setInvalid(input.validationMessage);
      return;
    }
    if (text === committed.current) return;
    committed.current = text;
    save.mutate(text === "" ? null : Number(text), {
      onError: () => {
        committed.current = saved;
      },
    });
  };
  const busy = status?.slots.busy;
  return (
    <section className="box" aria-labelledby="settings-runs">
      <h2 id="settings-runs" className="box-row font-semibold">
        Runs
      </h2>
      {/* One text run: a box row is a flex row, which would split the code apart. */}
      <div className="box-row">
        <p className="text-muted">
          Leave the field empty to use the default,{" "}
          <code>NAKARA_CONCURRENCY</code>. A change applies without a restart.
        </p>
      </div>
      <div className="box-row grid gap-xs">
        <div className="limit-row">
          <label htmlFor="settings-concurrency" className="field-label">
            Concurrent agent runs
            <span className="field-hint">across all factories</span>
          </label>
          <span className="limit-input">
            <input
              id="settings-concurrency"
              className="input input-narrow"
              type="number"
              inputMode="numeric"
              min={MIN}
              max={MAX}
              step={1}
              placeholder={`Default: ${concurrency.default}`}
              value={value}
              aria-invalid={invalid ? true : undefined}
              aria-describedby="settings-concurrency-help"
              onChange={(event) => {
                setValue(event.target.value);
                setInvalid(null);
                save.reset();
              }}
              onBlur={(event) => commit(event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit(event.currentTarget);
              }}
            />
          </span>
        </div>
        <p id="settings-concurrency-help" className="text-muted">
          {MIN} to {MAX}. Lowering it stops no run: Nakara starts nothing new
          until fewer runs than the limit are running.
        </p>
        {(invalid ?? save.error) && (
          <p className="form-error" role="alert">
            {invalid ?? save.error?.message}
          </p>
        )}
      </div>
      <dl className="box-row grid gap-xs">
        <div className="flex flex-wrap justify-between gap-md">
          <dt className="text-muted">In use now</dt>
          <dd>
            {busy === undefined
              ? "…"
              : `${busy} of ${concurrency.concurrency} slots`}
          </dd>
        </div>
        <div className="flex flex-wrap justify-between gap-md">
          <dt className="text-muted">Default</dt>
          <dd>
            {concurrency.default}
            {concurrency.saved === null && " (in use)"}
          </dd>
        </div>
      </dl>
    </section>
  );
}
