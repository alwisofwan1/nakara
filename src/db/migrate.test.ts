import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { listSnapshots } from "../backup.ts";
import { type FactorySeed, Store, stubFactorySeed } from "../db.ts";
import {
  DEFAULT_MAX_REVIEWS,
  DEFAULT_MAX_REVISIONS,
  DEFAULT_MAX_RUNS,
} from "../domain/policy.ts";
import { MIGRATIONS, migrate, migrateDown, schemaVersion } from "./migrate.ts";

function tempDir(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "nakara-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const schema = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    )
    .all();

const freshSchema = () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const result = schema(store.db);
  store.close();
  return result;
};

/** The schema versioned migrations started from. */
const baselineSchema = () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, { defaultBudgetUsd: 15, migrations: MIGRATIONS.slice(0, 1) });
  const result = schema(db);
  db.close();
  return result;
};

const FIXTURE = new URL("fixtures/nakara-d059536.db", import.meta.url).pathname;

test("a database from main@d059536 migrates to the schema of a fresh one", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  copyFileSync(FIXTURE, path);
  const store = new Store(path, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 99,
  });
  assert.equal(store.schemaVersion, MIGRATIONS.length);
  assert.equal(schemaVersion(store.db), MIGRATIONS.length);
  assert.deepEqual(schema(store.db), freshSchema());
  const item = store.item(1);
  assert.equal(item?.title, "Fixture item");
  assert.equal(item?.budget_usd, 7);
  assert.deepEqual(JSON.parse(store.approvals(1)[0]?.options ?? "null"), [
    "a",
    "b",
  ]);
  assert.equal(store.runs(1).length, 1);
  assert.equal(store.getKv("cursor"), "1");
  store.close();
});

test("a database with ad hoc columns is rebuilt to the baseline without an env budget in its DDL", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  const legacy = new DatabaseSync(path);
  // Tables as created before budgets and question options existed.
  legacy.exec(`CREATE TABLE work_items (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, request TEXT NOT NULL, requester TEXT,
    source TEXT NOT NULL, source_ref TEXT UNIQUE, source_url TEXT, repo TEXT, automation TEXT,
    stage TEXT NOT NULL DEFAULT 'intake', status TEXT NOT NULL DEFAULT 'active',
    spec_state TEXT NOT NULL DEFAULT 'none', review_count INTEGER NOT NULL DEFAULT 0,
    revision_count INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
    issue_url TEXT, pr_url TEXT, pr_merged INTEGER NOT NULL DEFAULT 0, foreman_session TEXT,
    foreman_turns INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE approvals (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES work_items(id),
    kind TEXT NOT NULL, prompt TEXT NOT NULL, ref_url TEXT, status TEXT NOT NULL DEFAULT 'pending',
    answer TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
    INSERT INTO work_items (title, request, source, source_ref, cost_usd, created_at, updated_at)
    VALUES ('Old', 'Request', 'manual', 'gh:1', 3, '2026-01-01', '2026-01-01');
    INSERT INTO approvals (item_id, kind, prompt, created_at) VALUES (1, 'spec', 'Ok?', '2026-01-01');`);
  legacy.close();

  const store = new Store(path, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 22,
  });
  assert.deepEqual(schema(store.db), freshSchema());
  assert.equal(store.item(1)?.budget_usd, 22);
  assert.equal(store.itemBySourceRef("gh:1")?.cost_usd, 3);
  assert.equal(store.approvals(1)[0]?.options, null);
  assert.equal(
    store.db.prepare("PRAGMA foreign_key_list(approvals)").all().length,
    1,
  );
  assert.equal(
    (
      store.db.prepare("PRAGMA foreign_key_list(approvals)").get() as {
        table: string;
      }
    ).table,
    "work_items",
  );
  store.close();
});

test("a database at the baseline gets the hot-path indexes with its data intact", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  const backup = { dir: join(dir, "backups"), keep: 5 };
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  migrate(db, { defaultBudgetUsd: 15, migrations: MIGRATIONS.slice(0, 1) });
  assert.equal(schemaVersion(db), 1);
  const before = contents(db);
  db.close();

  const store = new Store(path, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
    backup,
  });
  assert.equal(schemaVersion(store.db), MIGRATIONS.length);
  assert.deepEqual(schema(store.db), freshSchema());
  assert.deepEqual(contents(store.db), before);
  assert.deepEqual(
    listSnapshots(backup.dir).map((s) => s.reason),
    ["pre-migration-002"],
  );
  const plan = store.db
    .prepare("EXPLAIN QUERY PLAN SELECT id FROM runs WHERE status = 'queued'")
    .all()
    .map((r) => r.detail);
  assert.deepEqual(plan, [
    "SEARCH runs USING COVERING INDEX runs_status (status=?)",
  ]);
  store.close();
});

test("migration 003 keeps every run and lets only known statuses in, interrupted included", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  migrate(db, { defaultBudgetUsd: 15, migrations: MIGRATIONS.slice(0, 2) });
  for (const status of ["queued", "running", "failed", "cancelled"])
    db.prepare(
      "INSERT INTO runs (item_id, role, agent, agent_type, harness, session_id, status, input, started_at) VALUES (1, 'agent', 'implement', 'IMPLEMENT', 'claude', 's-1', ?, 'go', 't')",
    ).run(status);
  const before = contents(db);
  db.close();

  const store = new Store(path, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });
  assert.equal(schemaVersion(store.db), MIGRATIONS.length);
  assert.deepEqual(schema(store.db), freshSchema());
  assert.deepEqual(contents(store.db), before);
  assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  const [run] = store.runs(1);
  assert.ok(run);
  store.db
    .prepare("UPDATE runs SET status = 'interrupted' WHERE id = ?")
    .run(run.id);
  assert.equal(store.runById(run.id)?.status, "interrupted");
  assert.throws(
    () =>
      store.db
        .prepare("UPDATE runs SET status = 'paused' WHERE id = ?")
        .run(run.id),
    /CHECK constraint failed/,
  );
  store.close();
});

test("migration 003 rolls back on a run status this Nakara does not know", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path);
  migrate(db, { defaultBudgetUsd: 15, migrations: MIGRATIONS.slice(0, 2) });
  db.exec("UPDATE runs SET status = 'weird'");
  const before = { schema: schema(db), data: contents(db) };
  assert.throws(
    () => migrate(db, { defaultBudgetUsd: 15 }),
    /Schema migration 3 \(interrupted-runs\) failed and was rolled back: CHECK constraint failed/,
  );
  assert.equal(schemaVersion(db), 2);
  assert.deepEqual(schema(db), before.schema);
  assert.deepEqual(contents(db), before.data);
  db.close();
});

test("a failing migration rolls back and leaves user_version unchanged", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  new Store(path, { factory: stubFactorySeed, defaultBudgetUsd: 15 }).close();
  const db = new DatabaseSync(path);
  const before = schema(db);
  assert.throws(
    () =>
      migrate(db, {
        defaultBudgetUsd: 15,
        migrations: [
          ...MIGRATIONS,
          {
            version: MIGRATIONS.length + 1,
            name: "broken",
            up(db) {
              db.exec("CREATE TABLE half_done (id INTEGER PRIMARY KEY)");
              db.exec("ALTER TABLE work_items ADD COLUMN extra TEXT");
              db.exec("SELECT * FROM no_such_table");
            },
          },
        ],
      }),
    new RegExp(
      `Schema migration ${MIGRATIONS.length + 1} \\(broken\\) failed and was rolled back: no such table`,
    ),
  );
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.deepEqual(schema(db), before);
  db.close();
});

test("an existing database is snapshotted before a pending migration runs", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  const backup = { dir: join(dir, "backups"), keep: 5 };
  copyFileSync(FIXTURE, path);

  new Store(path, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
    backup,
  }).close();
  const [taken, ...rest] = listSnapshots(backup.dir);
  assert.equal(rest.length, 0);
  assert.equal(taken?.reason, "pre-migration-001");
  // The snapshot holds the database as it was before migrating.
  const snap = new DatabaseSync(taken?.path ?? "", { readOnly: true });
  assert.equal(schemaVersion(snap), 0);
  snap.close();

  // Nothing pending, or nothing to lose: no snapshot.
  new Store(path, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
    backup,
  }).close();
  new Store(join(dir, "fresh.db"), {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
    backup,
  }).close();
  assert.equal(listSnapshots(backup.dir).length, 1);
});

test("a database from a newer Nakara is refused", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  const backup = { dir: join(dir, "backups"), keep: 5 };
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
  db.close();
  assert.throws(
    () =>
      new Store(path, {
        factory: stubFactorySeed,
        defaultBudgetUsd: 15,
        backup,
      }),
    new RegExp(
      `schema version ${MIGRATIONS.length + 1}, but this Nakara knows versions up to ${MIGRATIONS.length}: the database is from a newer Nakara`,
    ),
  );
  assert.equal(listSnapshots(backup.dir).length, 0);
});

/** A pre-versioned database with every table, where budget_usd was appended by ALTER TABLE. */
function legacyDatabase(path: string) {
  const db = new DatabaseSync(path);
  const rows = baselineSchema() as { type: string; sql: string | null }[];
  // Tables before the indexes on them.
  for (const { sql } of rows.sort((a, b) => b.type.localeCompare(a.type)))
    if (sql) db.exec(sql.replace("  budget_usd REAL NOT NULL,\n", ""));
  db.exec(`ALTER TABLE work_items ADD COLUMN budget_usd REAL NOT NULL DEFAULT 15;
    INSERT INTO work_items (title, request, source, source_ref, cost_usd, created_at, updated_at)
    VALUES ('Old', 'Request', 'manual', 'gh:1', 3, 't0', 't0');
    INSERT INTO events (item_id, kind, payload, created_at) VALUES (1, 'work_received', '{}', 't1');
    INSERT INTO runs (item_id, role, agent, agent_type, harness, status, input, started_at)
    VALUES (1, 'foreman', 'foreman', 'foreman', 'claude', 'succeeded', 'go', 't2');
    INSERT INTO messages (item_id, author, body, created_at) VALUES (1, 'factory', 'Hi', 't3');
    INSERT INTO approvals (item_id, kind, prompt, options, created_at) VALUES (1, 'question', 'Which?', '["a"]', 't4');
    INSERT INTO kv (key, value) VALUES ('cursor', '7');`);
  return db;
}

const TABLES = [
  "work_items",
  "events",
  "runs",
  "messages",
  "approvals",
  "kv",
] as const;

// Without what a Store adds on open: the instance that holds the database
// (kv), the runs' instance_id column, empty for runs before migration 004,
// their snapshots column, empty for runs before migration 006, their
// review_verdict column, empty for runs before migration 007, and their tools
// column, empty for runs before migration 008.
const contents = (db: DatabaseSync) =>
  Object.fromEntries(
    TABLES.map((t) => [
      t,
      db
        .prepare(
          `SELECT * FROM ${t} ${t === "kv" ? "WHERE key != 'instance'" : ""} ORDER BY 1`,
        )
        .all()
        // Columns that later migrations add: compare the rows without them.
        .map(
          ({
            instance_id,
            factory_id,
            snapshots,
            review_verdict,
            tools,
            max_runs,
            run_count,
            max_reviews,
            max_revisions,
            request_edited,
            ...row
          }) => {
            assert.equal(instance_id ?? null, null);
            assert.equal(tools ?? null, null);
            assert.equal(snapshots ?? null, null);
            assert.equal(review_verdict ?? null, null);
            // Migration 012 flags nothing that existed before it.
            assert.equal(request_edited ?? 0, 0);
            if (t === "work_items" && factory_id !== undefined)
              assert.equal(typeof factory_id, "number");
            // Migration 015 gives existing items the default review and revision limits.
            if (t === "work_items" && max_reviews !== undefined) {
              assert.equal(max_reviews, DEFAULT_MAX_REVIEWS);
              assert.equal(max_revisions, DEFAULT_MAX_REVISIONS);
            }
            if (t === "work_items" && max_runs !== undefined) {
              assert.equal(max_runs, DEFAULT_MAX_RUNS);
              // Migration 010 counts the runs the item already has.
              assert.equal(
                run_count,
                (
                  db
                    .prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id = ?")
                    .get(row.id as number) as { n: number }
                ).n,
              );
            }
            return row;
          },
        ),
    ]),
  );

test("a drifted pre-versioned database is rebuilt with its data and foreign keys intact", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  const legacy = legacyDatabase(path);
  const before = contents(legacy);
  legacy.close();

  const store = new Store(path, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 22,
  });
  const db = store.db;
  assert.deepEqual(schema(db), freshSchema());
  const after = contents(db);
  for (const table of TABLES) assert.deepEqual(after[table], before[table]);
  // The item keeps the budget it had; the leaked DDL default is gone.
  assert.equal(store.item(1)?.budget_usd, 15);
  for (const child of ["events", "runs", "messages", "approvals"])
    assert.deepEqual(
      db
        .prepare(`SELECT "table" FROM pragma_foreign_key_list('${child}')`)
        .all()
        .map((r) => r.table),
      ["work_items"],
      child,
    );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.ok(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'events_pending'",
      )
      .get(),
  );
  store.close();
});

test("unknown columns and indexes stop the baseline before it changes anything", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  const legacy = legacyDatabase(path);
  legacy.exec(`ALTER TABLE runs ADD COLUMN notes TEXT;
    UPDATE runs SET notes = 'keep me';
    CREATE INDEX work_items_repo ON work_items(repo);`);
  const before = { schema: schema(legacy), data: contents(legacy) };
  legacy.close();

  assert.throws(
    () => new Store(path, { factory: stubFactorySeed, defaultBudgetUsd: 15 }),
    /does not know \(work_items: index work_items_repo; runs: column notes\)/,
  );
  const db = new DatabaseSync(path);
  assert.equal(schemaVersion(db), 0);
  assert.deepEqual(schema(db), before.schema);
  assert.deepEqual(contents(db), before.data);
  db.close();
});

test("a migration error is reported even when no transaction is left to roll back", (t) => {
  const dir = tempDir(t);
  const db = new DatabaseSync(join(dir, "nakara.db"));
  assert.throws(
    () =>
      migrate(db, {
        defaultBudgetUsd: 15,
        migrations: [
          {
            version: 1,
            name: "ends-transaction",
            up(db) {
              db.exec("COMMIT");
              throw new Error("the real cause");
            },
          },
        ],
      }),
    /Schema migration 1 \(ends-transaction\) failed: the real cause/,
  );
  db.close();
});

const NAKARA_SEED: FactorySeed = {
  slug: "nakara",
  name: "Nakara",
  description: "Default SDLC factory",
  avatar_color: "#6d4aff",
  foreman_handle: "nakara",
  definition_dir: "/srv/nakara/factory",
  definition_mode: "repo",
};

/** The fixture at version 4 with two more items and an event whose item is gone. */
function atVersion4(path: string) {
  copyFileSync(FIXTURE, path);
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  migrate(db, { defaultBudgetUsd: 15, migrations: MIGRATIONS.slice(0, 4) });
  db.exec(`
    INSERT INTO work_items (id, title, request, requester, source, source_ref, stage, spec_state,
      cost_usd, budget_usd, pr_url, foreman_session, created_at, updated_at)
    VALUES
      (7, 'Fix login', 'It fails', 'alice', 'github', 'gh:acme/web#7', 'reviewing', 'approved',
        4.25, 15, 'https://github.com/acme/web/pull/8', 'session-1', '2026-01-01', '2026-01-02'),
      (9, 'Weekly check', 'Check health', NULL, 'schedule', NULL, 'complete', 'none',
        1.5, 10, NULL, NULL, '2026-02-01', '2026-02-03');
    INSERT INTO events (item_id, kind, payload, created_at) VALUES (999, 'work_received', '{}', '2026-01-01');
  `);
  const rows = db
    .prepare("SELECT * FROM work_items ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
  db.close();
  return rows;
}

test("migration 005 assigns every item to the first factory, once, and leaves orphans alone", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  const backup = { dir: join(dir, "backups"), keep: 5 };
  const before = atVersion4(path);
  assert.equal(before.length, 3);

  let seeded = 0;
  const open = () =>
    new Store(path, {
      defaultBudgetUsd: 15,
      backup,
      factory: () => {
        seeded++;
        return NAKARA_SEED;
      },
    });
  for (const restart of [1, 2, 3]) {
    const store = open();
    assert.equal(
      schemaVersion(store.db),
      MIGRATIONS.length,
      `restart ${restart}`,
    );
    const factories = store.repos.factories.factories();
    assert.equal(factories.length, 1);
    const [factory] = factories;
    assert.deepEqual(
      { ...factory, id: undefined, created_at: undefined },
      { ...NAKARA_SEED, id: undefined, created_at: undefined },
    );
    assert.deepEqual(
      store.db
        .prepare("SELECT * FROM work_items ORDER BY id")
        .all()
        // Migration 010, 012 and 015's columns are checked by contents().
        .map(
          ({
            max_runs,
            run_count,
            request_edited,
            max_reviews,
            max_revisions,
            ...row
          }) => row,
        ),
      before.map((row) => ({ ...row, factory_id: factory?.id })),
    );
    // The orphan event is still there, and the only violation.
    assert.deepEqual(
      store.db
        .prepare("PRAGMA foreign_key_check")
        .all()
        .map((v) => [v.table, v.parent]),
      [["events", "work_items"]],
    );
    assert.equal(store.runs(1).length, 1);
    store.close();
  }
  assert.equal(seeded, 1);
  assert.deepEqual(
    listSnapshots(backup.dir).map((s) => s.reason),
    ["pre-migration-005"],
  );

  // Item ids stay global, and an unknown factory is refused.
  const store = open();
  const item = store.createItem({
    title: "New",
    request: "R",
    source: "manual",
  });
  assert.equal(item.id, 10);
  assert.equal(item.factory_id, store.repos.factories.defaultFactory().id);
  assert.throws(() =>
    store.db
      .prepare("UPDATE work_items SET factory_id = 99 WHERE id = 10")
      .run(),
  );
  store.close();
});

test("migration 005 refuses to run without a seed, or when the seed fails, and changes nothing", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  const before = atVersion4(path);
  assert.throws(
    () => new Store(path, { defaultBudgetUsd: 15 }),
    /migration 5 \(factory-registry\) failed and was rolled back: The first factory needs a seed/,
  );
  assert.throws(
    () =>
      new Store(path, {
        defaultBudgetUsd: 15,
        factory: () => {
          throw new Error("definition does not load");
        },
      }),
    /definition does not load/,
  );
  const db = new DatabaseSync(path);
  assert.equal(schemaVersion(db), 4);
  assert.deepEqual(
    db
      .prepare("SELECT * FROM work_items ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    before,
  );
  db.close();
  // A fresh database on disk needs the seed too.
  assert.throws(
    () => new Store(join(dir, "fresh.db"), { defaultBudgetUsd: 15 }),
    /needs a seed/,
  );
});

const VERSION_8 = MIGRATIONS.slice(0, 8);

test("a downgrade undoes the newer migrations so an older release accepts the database", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  const store = new Store(path, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });
  store.createItem({ title: "Kept", request: "r", source: "manual" });
  store.close();
  const older = new DatabaseSync(":memory:");
  migrate(older, {
    defaultBudgetUsd: 15,
    factory: stubFactorySeed,
    migrations: VERSION_8,
  });
  const olderSchema = schema(older);
  older.close();

  const db = new DatabaseSync(path);
  const backup = { dir: join(dir, "backups"), keep: 5 };
  assert.equal(migrateDown(db, 8, { backup }), 8);
  assert.equal(schemaVersion(db), 8);
  assert.deepEqual(schema(db), olderSchema);
  assert.equal(
    (db.prepare("SELECT title FROM work_items").get() as { title: string })
      .title,
    "Kept",
  );
  assert.deepEqual(
    listSnapshots(backup.dir).map((s) => s.reason),
    ["pre-downgrade-008"],
  );
  // The older release starts; a later upgrade migrates forward again.
  assert.equal(migrate(db, { defaultBudgetUsd: 15, migrations: VERSION_8 }), 8);
  assert.equal(migrate(db, { defaultBudgetUsd: 15 }), MIGRATIONS.length);
  db.close();
});

test("a downgrade past a migration without down refuses and changes nothing", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  new Store(path, { factory: stubFactorySeed, defaultBudgetUsd: 15 }).close();
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const before = schema(db);
  assert.throws(
    () => migrateDown(db, 7),
    /migration 8 \(run-tools\) cannot be undone: restore the pre-migration-008 snapshot/,
  );
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.deepEqual(schema(db), before);
  assert.equal(migrateDown(db, MIGRATIONS.length), MIGRATIONS.length);
});

test("migration 015 adds factory settings, gives existing items the default limits, and down restores version 14", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "nakara.db");
  const VERSION_14 = MIGRATIONS.slice(0, 14);
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  migrate(db, {
    defaultBudgetUsd: 15,
    factory: stubFactorySeed,
    migrations: VERSION_14,
  });
  const version14 = schema(db);
  db.exec(`INSERT INTO work_items (title, request, source, budget_usd, factory_id, created_at, updated_at)
           VALUES ('Old', 'r', 'manual', 9, 1, 'now', 'now')`);

  migrate(db, {
    defaultBudgetUsd: 15,
    defaultMaxReviews: 3,
    defaultMaxRevisions: 4,
  });
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.deepEqual(
    {
      ...db
        .prepare(
          "SELECT budget_usd, max_runs, max_reviews, max_revisions FROM work_items",
        )
        .get(),
    },
    {
      budget_usd: 9,
      max_runs: DEFAULT_MAX_RUNS,
      max_reviews: 3,
      max_revisions: 4,
    },
  );
  db.exec(
    "INSERT INTO factory_settings (factory_id, budget_usd, updated_at) VALUES (1, 5, 'now')",
  );
  // Every limit is nullable: NULL means the environment default.
  assert.deepEqual(
    {
      ...db
        .prepare(
          "SELECT budget_usd, max_reviews, max_revisions, max_runs FROM factory_settings",
        )
        .get(),
    },
    { budget_usd: 5, max_reviews: null, max_revisions: null, max_runs: null },
  );

  assert.equal(migrateDown(db, 14), 14);
  assert.deepEqual(schema(db), version14);
  assert.equal(
    (db.prepare("SELECT title FROM work_items").get() as { title: string })
      .title,
    "Old",
  );
});
