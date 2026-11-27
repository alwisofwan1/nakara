import { Repository } from "./repository.ts";

/** Reads and writes the kv table: small named settings and cursors. */
export class KvRepository extends Repository {
  getKv(key: string): string | undefined {
    return this.get<{ value: string }>(
      "SELECT value FROM kv WHERE key = ?",
      key,
    )?.value;
  }

  /** The values of the keys that start with `prefix`. */
  kvValues(prefix: string): string[] {
    return this.all<{ value: string }>(
      "SELECT value FROM kv WHERE substr(key, 1, ?) = ?",
      prefix.length,
      prefix,
    ).map((row) => row.value);
  }

  /** The keys that start with `prefix`. */
  kvKeys(prefix: string): string[] {
    return this.all<{ key: string }>(
      "SELECT key FROM kv WHERE substr(key, 1, ?) = ?",
      prefix.length,
      prefix,
    ).map((row) => row.key);
  }

  deleteKv(key: string): void {
    this.run("DELETE FROM kv WHERE key = ?", key);
  }

  setKv(key: string, value: string): void {
    this.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
    this.notifier.notify({ type: "status", id: "global" });
  }
}
