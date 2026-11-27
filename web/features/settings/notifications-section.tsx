import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useToast } from "../../app/toast";
import {
  factorySettingsQuery,
  type NotificationsEdit,
  saveNotifications,
} from "../../lib/api";

type NotifyEvent = "approvals" | "handoff" | "paused";

const NOTIFY_SWITCHES: { event: NotifyEvent; label: string }[] = [
  { event: "approvals", label: "A Spec or Question waits" },
  { event: "handoff", label: "A Pull Request is ready to merge" },
  { event: "paused", label: "A Work Item pauses at its Budget" },
];

export interface Notifications {
  /** A Slack channel ID, or the name as given when Slack did not resolve it. */
  slackChannel: string | null;
  notify: Record<NotifyEvent, boolean>;
  /** Whether the Slack bridge runs. */
  slackConnected: boolean;
}

/** Where "something needs you" goes in Slack, and which events send it. */
export function NotificationsSection({
  slug,
  notifications,
}: {
  slug: string;
  notifications: Notifications;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (edit: NotificationsEdit) => saveNotifications(slug, edit),
    onSuccess: (saved, edit) => {
      // The saved channel and switches show at once, not after the refetch.
      client.setQueryData(
        factorySettingsQuery(slug).queryKey,
        (current) =>
          current && {
            ...current,
            notifications: { ...current.notifications, ...saved },
          },
      );
      void client.invalidateQueries({ queryKey: ["factories", slug] });
      toast({
        title: "Notifications saved",
        description:
          edit.slackChannel !== undefined
            ? saved.slackChannel
              ? `Slack messages go to ${saved.slackChannel}.`
              : "No Slack channel: nothing is sent."
            : NOTIFY_SWITCHES.filter((s) => edit[s.event] !== undefined)
                .map(
                  (s) => `${s.label}: ${saved.notify[s.event] ? "on" : "off"}.`,
                )
                .join(" "),
        tone: "ok",
      });
    },
  });
  return (
    <section className="box" aria-labelledby="settings-notifications">
      <h2 id="settings-notifications" className="box-row font-semibold">
        Notifications
      </h2>
      <p className="box-row text-muted">
        When a Work Item needs you, Nakara posts one message to the factory's
        Slack channel: the Work Item, what is needed, and a link to it.
      </p>
      <SlackChannelRow
        saved={notifications.slackChannel ?? ""}
        connected={notifications.slackConnected}
        save={save}
      />
      <div className="box-row grid gap-sm">
        <span id="notify-label" className="field-label">
          Notify me when
        </span>
        <fieldset
          className="grid gap-sm"
          aria-labelledby="notify-label"
          disabled={save.isPending}
        >
          {NOTIFY_SWITCHES.map((s) => {
            // A switch follows the click until the saved switches arrive.
            const on =
              save.isPending && save.variables[s.event] !== undefined
                ? Boolean(save.variables[s.event])
                : notifications.notify[s.event];
            return (
              <label key={s.event} className="switch-field">
                <span>{s.label}</span>
                <input
                  type="checkbox"
                  role="switch"
                  className="automation-switch"
                  aria-checked={on}
                  checked={on}
                  onChange={(e) => save.mutate({ [s.event]: e.target.checked })}
                />
              </label>
            );
          })}
        </fieldset>
        <p className="text-muted">
          The Budget switch covers the run limit too.
        </p>
      </div>
      {save.error && (
        <p className="box-row form-error" role="alert">
          {save.error.message}
        </p>
      )}
    </section>
  );
}

function SlackChannelRow({
  saved,
  connected,
  save,
}: {
  saved: string;
  connected: boolean;
  save: Pick<
    UseMutationResult<unknown, Error, NotificationsEdit>,
    "mutate" | "reset"
  >;
}) {
  const [value, setValue] = useState(saved);
  // The text last saved or sent: Enter then blur saves once.
  const committed = useRef(saved);
  // Another tab's edit, or the channel ID a "#name" resolved to.
  useEffect(() => {
    committed.current = saved;
    setValue(saved);
  }, [saved]);
  const commit = (input: HTMLInputElement) => {
    const text = input.value.trim();
    if (text === committed.current) return;
    committed.current = text;
    save.mutate(
      { slackChannel: text === "" ? null : text },
      {
        onError: () => {
          committed.current = saved;
        },
      },
    );
  };
  return (
    <div className="box-row grid gap-xs">
      <div className="limit-row">
        <label htmlFor="slack-channel" className="field-label">
          Slack channel
        </label>
        <input
          id="slack-channel"
          className="input input-narrow"
          type="text"
          placeholder="#channel"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            save.reset();
          }}
          onBlur={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(event.currentTarget);
          }}
        />
      </div>
      {connected ? (
        <p className="text-muted">
          A #name is saved as its channel ID. Invite the Nakara app to the
          channel so it can post there. Leave empty to send nothing.
        </p>
      ) : (
        <p role="note" className="banner attention">
          {/* One grid cell: the banner is a grid. */}
          <span>
            Slack is not connected yet. See <Link to="/setup">Setup</Link>.
          </span>
        </p>
      )}
    </div>
  );
}
