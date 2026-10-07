import pg from "pg";

// bigint et numeric renvoyés comme nombres JS (montants et compteurs restent bien sous 2^53).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 5 });
  // Une connexion inactive coupée (redémarrage de la base) ne doit pas faire tomber l'usine : le pool se reconnecte.
  pool.on("error", (err) => process.stderr.write(`[db] connexion inactive perdue : ${err.message}\n`));
  pool.on("connect", (client) => client.on("error", (err) => process.stderr.write(`[db] connexion perdue : ${err.message}\n`)));
  return pool;
}
