import pg from "pg";
import { migrate } from "../src/db/migrate.ts";
import { createPool, type Db } from "../src/db/pool.ts";

/**
 * Base de test jetable : recréée à chaque fichier de test.
 * Local : TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres (défaut).
 * CI : service PostgreSQL de GitHub Actions.
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export async function freshDb(name: string): Promise<{ db: Db; url: string; drop: () => Promise<void> }> {
  const dbName = `factory_test_${name}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  await migrate(url.toString());
  const db = createPool(url.toString());
  return {
    db,
    url: url.toString(),
    drop: async () => {
      await db.end();
    },
  };
}
