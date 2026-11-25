import { serve } from "@hono/node-server";

import { Backups } from "./backup.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { DatabaseLocked } from "./db/instance.ts";
import { lazyFactorySeed } from "./definition/seed.ts";
import { GithubPoller } from "./intake/github.ts";
import { Scheduler } from "./intake/schedule.ts";
import { slackBridge } from "./intake/slack.ts";
import { EvidencePublisher } from "./orchestrator/evidence-publisher.ts";
import { TelegramBridge, telegramApi } from "./intake/telegram.ts";
import { FactoryRegistry } from "./orchestrator/registry.ts";
import { readSecrets } from "./secrets.ts";
import { Logger } from "./telemetry/log.ts";
import { Metrics } from "./telemetry/metrics.ts";
import { createApp, loadToken } from "./web/server.ts";

const REPO_CHECK_MS = 10 * 60_000;

const config = loadConfig();
// Redacts the secret-looking environment variables (GH_TOKEN,
// CLAUDE_CODE_OAUTH_TOKEN, NAKARA_TELEGRAM_BOT_TOKEN, …) and the web token.
const log = new Logger({ level: config.logLevel });
const factorySeed = await lazyFactorySeed(config);
const store = (() => {
  try {
    return new Store(config.dbPath, {
      defaultBudgetUsd: config.limits.budgetUsd,
      defaultMaxRuns: config.limits.maxRuns,
      backup: config.backup,
      factory: factorySeed,
    });
  } catch (error) {
    if (!(error instanceof DatabaseLocked)) throw error;
    log.error("startup.database_locked", { error });
    process.exit(1);
  }
})();
// A secrets file others can read is refused before anything starts.
let secrets: Record<string, string> = {};
try {
  secrets = await readSecrets(config.secretsPath);
} catch (error) {
  log.error("startup.secrets_refused", { error });
  process.exit(1);
}
const token = loadToken(config.tokenPath);
log.addSecret(token);
const backups = new Backups(store.db, config.backup, log);
backups.start();
const registry = new FactoryRegistry(store, config, {
  log,
  metrics: new Metrics(),
});
// Each factory loads its own definition; a broken one logs its errors and the
// other factories run.
await registry.start();

for (const factory of registry.factories) {
  const { errors, warnings } = factory.definitionProblems;
  for (const w of warnings)
    factory.telemetry.log.warn("definition.warning", {
      path: w.path,
      message: w.message,
    });
  for (const e of errors)
    factory.telemetry.log.error("definition.error", {
      path: e.path,
      message: e.message,
    });
}

void registry.checkRepositories();
const repoTimer = setInterval(
  () => void registry.checkRepositories(),
  REPO_CHECK_MS,
);

// GitHub intake polls the repositories of every factory, each for its own
// factory:<alias> label, and creates the work in that factory. Telegram intake
// creates work in the factory a leading @handle names, else the first one.
// Both pass operator actions on items to the item's own factory.
const poller = new GithubPoller(registry.factories);
poller.start(config.pollSeconds);
const schedulers = registry.factories.map((factory) => new Scheduler(factory));
for (const scheduler of schedulers) scheduler.start();
// A factory the New factory wizard creates joins the intake right away.
registry.onAdded((factory) => {
  poller.add(factory);
  const scheduler = new Scheduler(factory);
  scheduler.start();
  schedulers.push(scheduler);
  void factory.checkRepositories();
});
// A factory deleted from its Settings page leaves the intake.
registry.onRemoved((factory) => {
  poller.remove(factory);
  for (const scheduler of schedulers.filter((s) => s.factory === factory)) {
    scheduler.stop();
    schedulers.splice(schedulers.indexOf(scheduler), 1);
  }
});
const telegram = config.telegram.token
  ? new TelegramBridge(
      registry,
      telegramApi(config.telegram.token),
      config.telegram.chatId,
    )
  : null;
telegram?.start();
const slack = slackBridge(config, secrets, registry);
slack?.start();
// Implement runs' screenshots go on their PR once it exists.
const evidence = new EvidencePublisher(store, log);
evidence.start();

const app = createApp(registry, poller, config, token);
const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  (info) => {
    log.info("startup.listening", {
      url: `http://${info.address}:${info.port}${config.basePath || ""}`,
      factories: registry.factories.map((f) => f.config.definitionDir),
      data_dir: config.dataDir,
    });
  },
);

// The first signal drains: no new work starts, and runs in flight get
// NAKARA_DRAIN_SECONDS to finish. A second signal interrupts them at once.
// Interrupted runs resume after the restart. The web UI stays up meanwhile.
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) {
    log.info("shutdown.interrupt", { in_flight: registry.inFlightCount });
    registry.interrupt();
    return;
  }
  shuttingDown = true;
  poller.stop();
  backups.stop();
  clearInterval(repoTimer);
  for (const scheduler of schedulers) scheduler.stop();
  telegram?.stop();
  slack?.stop();
  evidence.stop();
  if (registry.inFlightCount)
    log.info("shutdown.drain", {
      in_flight: registry.inFlightCount,
      drain_s: config.drainSeconds,
    });
  await registry.drain(config.drainSeconds * 1000);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
