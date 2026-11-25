// Usage: npm run seed -- <new.db> [items=5000] [runs=50000]
// Creates a database with synthetic data, e.g. to check query plans at scale.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { Store } from "../db.ts";
import { seed } from "../db/seed.ts";

const [file, items = "5000", runs = "50000"] = process.argv.slice(2);
if (!file) {
  console.log("Usage: npm run seed -- <new.db> [items=5000] [runs=50000]");
  process.exit(1);
}
const path = resolve(file);
if (existsSync(path)) {
  console.error(`seed failed: ${path} exists; seed only a new database.`);
  process.exit(1);
}
const store = new Store(path, {
  defaultBudgetUsd: 15,
  factory: () => ({
    slug: "seed",
    name: "Seed",
    description: "Synthetic data",
    avatar_color: "#6d4aff",
    foreman_handle: "seed",
    definition_dir: "factory",
    definition_mode: "repo",
  }),
});
seed(store.db, { items: Number(items), runs: Number(runs) });
store.close();
console.log(`seeded ${path} with ${items} items and ${runs} runs`);
