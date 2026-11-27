import { Link } from "@tanstack/react-router";
import {
  AutomationSwitch,
  useAutomationToggle,
} from "../automations/automation-switch";

interface Intake {
  automation: string | null;
  displayName: string;
  provider: string;
  event: string;
  enabled: boolean;
  detail: string | null;
  revision: string | null;
}

const SOURCE: Record<string, string> = {
  nakara: "Manual",
  github: "GitHub label",
  telegram: "Telegram",
  slack: "Slack",
};

/**
 * Where work comes from: manual intake, then each GitHub, Telegram or Slack
 * Automation with the Automations page's own switch, so the two never disagree.
 */
export function WhereWorkComesFrom({
  slug,
  intake,
}: {
  slug: string;
  intake: Intake[];
}) {
  const toggle = useAutomationToggle(slug);
  const github = intake.some(
    (entry) => entry.provider === "github" && entry.event === "issue_labeled",
  );
  return (
    <section className="box" aria-labelledby="settings-intake">
      <h2 id="settings-intake" className="box-row font-semibold">
        Where work comes from
      </h2>
      <p className="box-row text-muted">
        Manual intake from this channel is always on. Each switch is the
        Automation's own switch.
      </p>
      <ul aria-label="Intake">
        {intake.map((entry) => (
          <li
            key={`${entry.automation ?? "manual"}:${entry.provider}:${entry.event}`}
            className="box-row flex flex-wrap items-center gap-md"
          >
            <div className="grid flex-1 gap-xs">
              <span className="font-semibold">
                {SOURCE[entry.provider] ?? entry.provider}
                {entry.automation && (
                  <span className="font-normal text-muted">
                    {" "}
                    · {entry.displayName}
                  </span>
                )}
              </span>
              <span className="text-small text-muted">
                {entry.automation
                  ? entry.detail
                  : "New work from this channel's composer or the API."}
              </span>
            </div>
            {entry.automation ? (
              <AutomationSwitch
                automation={{
                  name: entry.automation,
                  displayName: entry.displayName,
                  enabled: entry.enabled,
                  revision: entry.revision,
                }}
                toggle={toggle}
              />
            ) : (
              <span className="text-small text-muted">Always on</span>
            )}
          </li>
        ))}
      </ul>
      {!github && (
        <div className="box-row">
          <p className="text-muted">
            No GitHub intake.{" "}
            <Link
              to="/f/$slug/automations"
              params={{ slug }}
              className="text-accent hover:underline"
            >
              Add an Automation with a GitHub label trigger.
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}
