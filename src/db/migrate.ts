import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const DIR = join(import.meta.dirname, "migrations");
const LOCK_ID = 7_310_221;

/** Applique les migrations SQL manquantes, dans l'ordre, chacune dans sa transaction. Idempotent et sûr en parallèle. */
export async function migrate(connectionString: string, log: (msg: string) => void = () => undefined): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_ID]);
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(DIR, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(`Migration ${file} échouée : ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      applied.push(file);
      log(`migration appliquée : ${file}`);
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL manquante");
  const applied = await migrate(url, (m) => process.stdout.write(`${m}\n`));
  process.stdout.write(`OK : ${applied.length} migration(s) appliquée(s)\n`);
}
