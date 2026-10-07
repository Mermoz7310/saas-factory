import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.ts";
import { decide as decideApproval } from "../src/domain/approvals.ts";
import { createProject, getProject, latestArtifact, saveArtifact, transition } from "../src/domain/projects.ts";
import type { Llm, LlmRequest, LlmResult } from "../src/llm/client.ts";
import { NullNotifier } from "../src/notify.ts";
import { extractCode, groupStoriesByModule, planTasks, runSpec } from "../src/pipeline/spec.ts";
import { buildUiContract, renderContract } from "../src/spec/contract.ts";
import { checkSpec, specSchema } from "../src/spec/schema.ts";
import { generateMigration, migrationFileName } from "../src/spec/sql.ts";
import { checkTestFiles } from "../src/spec/tests-check.ts";
import * as cmd from "../src/telegram/commands.ts";
import type { Queue } from "../src/jobs.ts";
import { CUSTOMERS_TEST, ORDERS_TEST, VALID_TEST_FILE, asTsBlock, validSpec } from "./fixtures/spec.ts";
import { freshDb } from "./setup-db.ts";

let db: Db;
let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await freshDb("spec")));
afterAll(async () => drop());

describe("contrôles de cohérence de la spec", () => {
  it("une spec réaliste passe le schéma et les contrôles", () => {
    expect(specSchema.safeParse(validSpec()).success).toBe(true);
    expect(checkSpec(validSpec())).toEqual([]);
  });

  it("refuse une référence vers une table inconnue, une entité inutilisée et une mauvaise numérotation", () => {
    const s = validSpec();
    s.entities[1]!.fields[0]!.ref = "clients";
    s.entities.push({ name: "suppliers", label: "Fournisseurs", module: "fournisseurs", title_field: "label", delete_requires_admin: false, constraints: [], fields: [{ name: "label", label: "Nom", type: "text", required: true }] });
    s.stories[1]!.id = "S3";
    const problems = checkSpec(s).join("\n");
    expect(problems).toContain("entité inconnue « clients »");
    expect(problems).toContain("suppliers n'est utilisée par aucune story");
    expect(problems).toContain("S1, S2");
  });

  it("refuse les références circulaires et un nombre de variantes choisies différent de 1", () => {
    const s = validSpec();
    s.entities[0]!.fields.push({ name: "last_order_id", label: "Dernière commande", type: "ref", required: false, ref: "orders" });
    s.variants.forEach((v) => (v.chosen = true));
    const problems = checkSpec(s).join("\n");
    expect(problems).toContain("circulaires");
    expect(problems).toContain("Exactement une variante");
  });

  it("le schéma refuse les noms dangereux ou réservés", () => {
    for (const name of ["organizations", "order", "Clients", "x", "drop table;--"]) {
      const s = validSpec();
      s.entities[0]!.name = name;
      expect(specSchema.safeParse(s).success, name).toBe(false);
    }
    const s = validSpec();
    s.entities[0]!.fields[0]!.name = "org_id";
    expect(specSchema.safeParse(s).success).toBe(false);
  });
});

describe("migration générée par le code", () => {
  const sql = generateMigration(validSpec());

  it("est additive : aucune instruction destructive", () => {
    expect(sql).not.toMatch(/\b(drop|truncate|delete\s+from|disable\s+row\s+level)\b/i);
    expect(migrationFileName(validSpec(), new Date("2026-10-07T12:30:45Z"))).toBe("supabase/migrations/20261007123045_tailoros.sql");
  });

  it("crée les tables dans l'ordre des dépendances", () => {
    expect(sql.indexOf("create table public.customers")).toBeLessThan(sql.indexOf("create table public.orders"));
  });

  describe("appliquée sur une base identique au gabarit", () => {
    let client: pg.Client;
    const A = "aaaaaaaa-0000-4000-8000-00000000000a";
    const B = "bbbbbbbb-0000-4000-8000-00000000000b";
    const M = "cccccccc-0000-4000-8000-00000000000c";
    let orgA = "";
    let orgB = "";

    const asUser = async (user: string, fn: () => Promise<unknown>) => {
      await client.query("begin");
      try {
        await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, email: `${user}@t.t` })]);
        await client.query("set local role authenticated");
        return await fn();
      } finally {
        await client.query("rollback");
      }
    };

    beforeAll(async () => {
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres" });
      await admin.connect();
      await admin.query("drop database if exists factory_test_generated with (force)");
      await admin.query("create database factory_test_generated");
      await admin.end();
      const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
      url.pathname = "/factory_test_generated";
      client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      const dir = join(import.meta.dirname, "fixtures", "template");
      await client.query(readFileSync(join(dir, "supabase-shim.sql"), "utf8"));
      await client.query(readFileSync(join(dir, "20261003000001_core.sql"), "utf8"));
      await client.query(sql);
      await client.query("insert into auth.users (id, email) values ($1, 'a@t.t'), ($2, 'b@t.t'), ($3, 'm@t.t')", [A, B, M]);
      orgA = (await client.query("insert into public.organizations (name, slug, created_by) values ('Org A', 'org-aaa', $1) returning id", [A])).rows[0].id;
      orgB = (await client.query("insert into public.organizations (name, slug, created_by) values ('Org B', 'org-bbb', $1) returning id", [B])).rows[0].id;
      await client.query("insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner'), ($1, $5, 'member')", [orgA, A, orgB, B, M]);
    });
    afterAll(async () => client.end());

    it("toutes les tables ont la RLS activée", async () => {
      const { rows } = await client.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and relkind = 'r' and not relrowsecurity");
      expect(rows).toEqual([]);
    });

    it("un membre crée et lit ses données ; une autre organisation ne voit rien", async () => {
      const seen = await asUser(A, async () => {
        await client.query("insert into public.customers (org_id, full_name) values ($1, 'Aminata')", [orgA]);
        return (await client.query("select full_name, created_by from public.customers")).rows;
      });
      expect(seen).toEqual([{ full_name: "Aminata", created_by: A }]);

      await client.query("insert into public.customers (org_id, full_name) values ($1, 'Secret A')", [orgA]);
      const other = await asUser(B, async () => (await client.query("select 1 from public.customers")).rowCount);
      expect(other).toBe(0);
    });

    it("impossible d'écrire dans une autre organisation ou de falsifier l'auteur", async () => {
      await expect(asUser(B, () => client.query("insert into public.customers (org_id, full_name) values ($1, 'Pirate')", [orgA]))).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(A, () => client.query("insert into public.customers (org_id, full_name, created_by) values ($1, 'X', $2)", [orgA, B]))).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(A, () => client.query("update public.customers set org_id = $1", [orgB]))).rejects.toMatchObject({ code: "42501" });
    });

    it("une commande ne peut pas pointer vers le client d'une autre organisation", async () => {
      const cB = (await client.query("insert into public.customers (org_id, full_name) values ($1, 'Client B') returning id", [orgB])).rows[0].id;
      await expect(
        asUser(A, () => client.query("insert into public.orders (org_id, customer_id, description, total, ordered_on, due_on, status) values ($1, $2, 'x', 100, current_date, current_date, 'received')", [orgA, cB])),
      ).rejects.toMatchObject({ code: "23503" });
    });

    it("contraintes métier : enum, montant négatif, champ obligatoire", async () => {
      const cA = (await client.query("insert into public.customers (org_id, full_name) values ($1, 'Client A') returning id", [orgA])).rows[0].id;
      const ins = (status: string, total: number) =>
        asUser(A, () => client.query("insert into public.orders (org_id, customer_id, description, total, ordered_on, due_on, status) values ($1, $2, 'x', $3, current_date, current_date, $4)", [orgA, cA, total, status]));
      await expect(ins("inventé", 100)).rejects.toMatchObject({ code: "23514" });
      await expect(ins("received", -1)).rejects.toMatchObject({ code: "23514" });
      await expect(ins("received", 0)).rejects.toMatchObject({ code: "23514" });
      await expect(asUser(A, () => client.query("insert into public.customers (org_id) values ($1)", [orgA]))).rejects.toMatchObject({ code: "23502" });
      await expect(ins("received", 25000)).resolves.toBeDefined();
    });

    it("règles métier de la spec garanties par la base (unicité conditionnelle, champ obligatoire conditionnel, ordre des dates)", async () => {
      const cA = (await client.query("insert into public.customers (org_id, full_name, phone) values ($1, 'Règles', '770000001') returning id", [orgA])).rows[0].id;
      const ins = (cols: Record<string, unknown>) => {
        const row = { org_id: orgA, customer_id: cA, description: "x", total: 100, ordered_on: "2026-10-01", due_on: "2026-10-05", status: "received", ...cols };
        const keys = Object.keys(row);
        return asUser(A, () => client.query(`insert into public.orders (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row)));
      };
      await expect(ins({ due_on: "2026-09-30" })).rejects.toMatchObject({ code: "23514", constraint: "orders_date_order_1" });
      await expect(ins({ due_on: "2026-10-01" })).resolves.toBeDefined();
      await expect(ins({ deposit_method: "wave" })).rejects.toMatchObject({ code: "23514", constraint: "orders_required_when_2" });
      await expect(ins({ deposit_method: "wave", deposit_ref: "W-123" })).resolves.toBeDefined();
      await expect(ins({ deposit_method: "cash" })).resolves.toBeDefined();
      await client.query("insert into public.orders (org_id, customer_id, description, total, ordered_on, due_on, status) values ($1, $2, 'en cours', 100, current_date, current_date, 'in_progress')", [orgA, cA]);
      await expect(ins({ status: "in_progress" })).rejects.toMatchObject({ code: "23505", constraint: "orders_unique_3" });
      await expect(asUser(A, () => client.query("insert into public.customers (org_id, full_name, phone) values ($1, 'Doublon', '770000001')", [orgA]))).rejects.toMatchObject({ code: "23505", constraint: "customers_unique_1" });
      // l'unicité est par organisation
      await expect(asUser(B, () => client.query("insert into public.customers (org_id, full_name, phone) values ($1, 'Autre org', '770000001')", [orgB]))).resolves.toBeDefined();
    });

    it("chaque suppression est tracée dans le journal d'audit ; supprimer l'organisation reste possible", async () => {
      const id = (await client.query("insert into public.customers (org_id, full_name) values ($1, 'À supprimer') returning id", [orgA])).rows[0].id;
      const rows = await asUser(A, async () => {
        expect((await client.query("delete from public.customers where id = $1", [id])).rowCount).toBe(1);
        await client.query("reset role");
        return (await client.query("select org_id, actor_id, action, target, metadata->>'full_name' as name from public.audit_logs where action = 'customers.deleted' and target = $1", [id])).rows;
      });
      expect(rows).toEqual([{ org_id: orgA, actor_id: A, action: "customers.deleted", target: id, name: "À supprimer" }]);
      await expect(asUser(A, () => client.query("select public.app_audit_delete()"))).rejects.toMatchObject({ code: "42501" });

      const orgC = (await client.query("insert into public.organizations (name, slug, created_by) values ('Org C', 'org-ccc', $1) returning id", [A])).rows[0].id;
      const cC = (await client.query("insert into public.customers (org_id, full_name) values ($1, 'C') returning id", [orgC])).rows[0].id;
      await client.query("insert into public.orders (org_id, customer_id, description, total, ordered_on, due_on, status) values ($1, $2, 'x', 100, current_date, current_date, 'received')", [orgC, cC]);
      await client.query("delete from public.organizations where id = $1", [orgC]);
      expect((await client.query("select 1 from public.customers where org_id = $1", [orgC])).rowCount).toBe(0);
    });

    it("un simple membre ne peut pas supprimer quand delete_requires_admin est vrai", async () => {
      await client.query("insert into public.customers (org_id, full_name) values ($1, 'À garder')", [orgA]);
      const deleted = await asUser(M, async () => (await client.query("delete from public.customers where full_name = 'À garder'")).rowCount);
      expect(deleted).toBe(0);
    });

    it("le visiteur anonyme n'a accès à rien", async () => {
      await client.query("begin");
      await client.query("set local role anon");
      await expect(client.query("select 1 from public.orders")).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback");
    });
  });
});

describe("contrat d'interface", () => {
  const contract = buildUiContract(validSpec());

  it("est déduit de la spec par le code : routes, data-testid, libellés, options, messages d'erreur", () => {
    const orders = contract.entities.find((e) => e.table === "orders")!;
    expect(orders.route).toBe("/app/<slug>/commandes");
    expect(orders.testids).toEqual({ form: "orders-form", list: "orders-list", row: "orders-row", empty: "orders-empty", edit_form: "orders-edit-form" });
    expect(orders.fields.find((f) => f.name === "status")?.options?.[0]).toEqual({ value: "received", label: "Reçue" });
    expect(orders.fields.find((f) => f.name === "customer_id")?.ref).toEqual({ table: "customers", shows: "full_name (« Nom »)" });
    expect(orders.errors).toContainEqual({ constraint: "orders_required_when_2", message: "La référence Wave est obligatoire." });
    expect(contract.views[0]!.route).toBe("/app/<slug>/a-livrer");
    expect(renderContract(contract)).toContain("« Prix total (FCFA) » (total) : montant FCFA (entier) — obligatoire · minimum 1");
  });

  it("la spec refuse les chemins du gabarit, les libellés en double et les contraintes incohérentes", () => {
    const s = validSpec();
    s.entities[0]!.module = "members";
    s.entities[1]!.fields[1]!.label = "Client";
    s.entities[1]!.constraints.push({ kind: "required_when", field: "deposit_ref", when: { field: "deposit_method", in: ["orange"] }, message: "x" });
    s.entities[1]!.constraints.push({ kind: "date_order", start: "ordered_on", end: "description", message: "x" });
    s.views[0]!.testids.push("orders-row");
    const problems = checkSpec(s).join("\n");
    expect(problems).toContain("« members » est réservé");
    expect(problems).toContain("libellés en double (Client)");
    expect(problems).toContain("« deposit_method = orange » n'est pas une valeur");
    expect(problems).toContain("doivent être deux dates");
    expect(problems).toContain("réutilise l'identifiant réservé « orders-row »");
  });
});

describe("contrôles des tests d'acceptation générés", () => {
  const ok = [{ path: "tests/acceptance/clients.spec.ts", content: VALID_TEST_FILE }];
  const contract = buildUiContract(validSpec());

  it("un fichier propre couvrant toutes les stories passe", () => {
    expect(checkTestFiles(ok, ["S1", "S2"])).toEqual([]);
    expect(checkTestFiles(ok, ["S1", "S2"], contract)).toEqual([]);
  });

  it("refuse toute route, data-testid ou libellé absent du contrat, et selectOption par valeur technique", () => {
    const bad = VALID_TEST_FILE.replace("/clients`", "/fleet`")
      .replace('getByTestId("customers-list")', 'getByTestId("clients-list")')
      .replace('getByLabel("Nom")', 'getByLabel("Nom complet du client")')
      .replace('selectOption({ label: "Reçue" })', 'selectOption({ value: "received" })');
    const problems = checkTestFiles([{ path: "tests/acceptance/clients.spec.ts", content: bad }], ["S1", "S2"], contract).join("\n");
    expect(problems).toContain("route « /app/*/fleet »");
    expect(problems).toContain("data-testid « clients-list »");
    expect(problems).toContain("libellé « Nom complet du client »");
    expect(problems).toContain("selectOption({ value })");
    const tpl = VALID_TEST_FILE.replace("/clients`", "/members`").replace('getByLabel("Nom")', 'getByLabel("E-mail")');
    expect(checkTestFiles([{ path: "tests/acceptance/clients.spec.ts", content: tpl }], ["S1", "S2"], contract)).toEqual([]);
  });

  it("détecte une story non couverte, une erreur de syntaxe, un import interdit et les pratiques instables", () => {
    const bad = VALID_TEST_FILE.replace('import { createOrg, newEmail, signUp } from "./helpers";', 'import fs from "node:fs";\nimport { createOrg, newEmail, signUp } from "./helpers";')
      .replace("await expect(page.getByTestId(\"orders-empty\")).toBeVisible();", "await page.waitForTimeout(2000);\n  test.skip();")
      .concat("\nconst x = ;\n");
    const problems = checkTestFiles([{ path: "tests/acceptance/customers.spec.ts", content: bad }], ["S1", "S2", "S3"]).join("\n");
    expect(problems).toContain("Aucun test pour S3");
    expect(problems).toContain("erreur de syntaxe");
    expect(problems).toContain("import interdit « node:fs »");
    expect(problems).toContain("waitForTimeout");
    expect(problems).toContain(".only/.skip");
  });

  it("refuse de remplacer un test du gabarit", () => {
    expect(checkTestFiles([{ path: "tests/acceptance/security.spec.ts", content: VALID_TEST_FILE }], ["S1", "S2"]).join()).toContain("fichier du gabarit");
  });
});

describe("découpage des tests", () => {
  it("regroupe les stories par module de leur première entité et extrait le code brut", () => {
    expect([...groupStoriesByModule(validSpec()).entries()].map(([m, st]) => [m, st.map((x) => x.id)])).toEqual([["clients", ["S1"]], ["commandes", ["S2"]]]);
    expect(extractCode(asTsBlock("const a = 1;"))).toBe("const a = 1;\n");
    expect(extractCode("aucun bloc")).toBeNull();
  });
});

describe("plan de construction", () => {
  it("migration d'abord, puis une tâche par story limitée aux fichiers de ses modules", () => {
    const tasks = planTasks(validSpec(), "supabase/migrations/x.sql");
    expect(tasks.map((t) => t.id)).toEqual(["T0", "T1", "T2"]);
    expect(tasks[2]!.depends_on).toEqual(["T0"]);
    expect(tasks[1]!.allowed_paths).toContain("src/app/app/[slug]/clients/**");
    expect(tasks[1]!.allowed_paths).not.toContain("src/app/app/[slug]/commandes/**");
    expect(tasks[2]!.allowed_paths).toContain("src/app/app/[slug]/commandes/**");
    expect(tasks[2]!.allowed_paths).toContain("src/app/app/[slug]/a-livrer/**");
  });
});

class ScriptedLlm implements Llm {
  calls: LlmRequest[] = [];
  constructor(private readonly script: Record<string, Array<Partial<LlmResult>>>) {}
  async call(req: LlmRequest): Promise<LlmResult> {
    this.calls.push(req);
    const queue = this.script[req.agent];
    const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (!next) throw new Error(`pas de réponse scriptée pour ${req.agent}`);
    return { text: "", fetched: [], costUsd: 0.01, ...next };
  }
}
const json = (o: unknown) => "```json\n" + JSON.stringify(o) + "\n```";
const testsOk = [{ text: asTsBlock(CUSTOMERS_TEST) }, { text: asTsBlock(ORDERS_TEST) }];

async function projectInSpecifying(title: string) {
  const p = await createProject(db, title);
  await saveArtifact(db, p.id, "dossier", {}, "# Dossier\nScore : 70/100");
  await transition(db, p.id, "IDEA", "RESEARCHING", "system");
  await transition(db, p.id, "RESEARCHING", "AWAITING_P1", "system");
  await transition(db, p.id, "AWAITING_P1", "SPECIFYING", "user");
  return p;
}

class FakeQueue implements Queue {
  specs: { id: string; instruction?: string }[] = [];
  async enqueueResearch() {}
  async enqueueSpec(id: string, instruction?: string) {
    this.specs.push(instruction ? { id, instruction } : { id });
  }
}

describe("étape 2 de bout en bout (modèles simulés)", () => {
  it("produit spec, migration et tests, les envoie en fichiers et demande la validation P2", async () => {
    const p = await projectInSpecifying("Gestion des ateliers de couture à Dakar");
    const notifier = new NullNotifier();
    const llm = new ScriptedLlm({ spec: [{ text: json(validSpec()) }], acceptance_tests: [...testsOk] });

    expect(await runSpec({ db, llm, notifier }, p.id)).toBe("AWAITING_P2");
    expect((await getProject(db, p.id))?.state).toBe("AWAITING_P2");
    expect(llm.calls.find((c) => c.agent === "spec")?.tier).toBe("strong");
    expect(llm.calls.find((c) => c.agent === "acceptance_tests")?.tier).toBe("standard");

    expect(notifier.files.map((f) => f.name)).toEqual([
      expect.stringMatching(/^SPEC-.*-v1\.md$/),
      expect.stringMatching(/^\d{14}_tailoros\.sql$/),
      expect.stringMatching(/^tests-acceptance-.*-v1\.ts\.txt$/),
    ]);
    expect(notifier.files[0]!.content).toContain("### S2 — En tant que gérant");
    expect(notifier.files[1]!.content).toContain("create table public.orders");
    const last = notifier.sent.at(-1)!;
    expect(last.text).toContain("Porte P2");
    expect(last.buttons?.flat().map((b) => b.label)).toEqual(["✅ Approuver et geler la spec", "❌ Archiver"]);

    const spec = await latestArtifact(db, p.id, "spec");
    expect((spec?.content as { tasks: unknown[] }).tasks).toHaveLength(3);
    expect((spec?.content as { contract: { entities: unknown[] } }).contract.entities).toHaveLength(2);
    expect(notifier.files[0]!.content).toContain("## Contrat d'interface");
    expect(notifier.files[0]!.content).toContain("## Règles garanties par la base");
    expect(notifier.files[1]!.content).toContain("create unique index orders_unique_3");
  });

  it("une spec incohérente est renvoyée au modèle avec la liste précise des problèmes", async () => {
    const p = await projectInSpecifying("Projet à la spec incohérente au départ");
    const broken = validSpec();
    broken.stories[1]!.entities = ["invoices"];
    const llm = new ScriptedLlm({ spec: [{ text: json(broken) }, { text: json(validSpec()) }], acceptance_tests: [...testsOk] });
    await runSpec({ db, llm, notifier: new NullNotifier() }, p.id);
    const specCalls = llm.calls.filter((c) => c.agent === "spec");
    expect(specCalls).toHaveLength(2);
    expect(specCalls[1]!.prompt).toContain("S2 utilise une entité inconnue « invoices »");
  });

  it("des tests qui ne couvrent pas leurs stories sont refusés jusqu'à correction, fichier par fichier", async () => {
    const p = await projectInSpecifying("Projet aux tests incomplets au départ");
    const withoutS1 = CUSTOMERS_TEST.replace('test("S1 —', 'test("Sans story —');
    const llm = new ScriptedLlm({
      spec: [{ text: json(validSpec()) }],
      acceptance_tests: [{ text: asTsBlock(withoutS1) }, { text: asTsBlock(CUSTOMERS_TEST) }, { text: asTsBlock(ORDERS_TEST) }],
    });
    await runSpec({ db, llm, notifier: new NullNotifier() }, p.id);
    const calls = llm.calls.filter((c) => c.agent === "acceptance_tests");
    expect(calls).toHaveLength(3);
    expect(calls[0]!.prompt).toContain("tests/acceptance/clients.spec.ts");
    expect(calls[0]!.prompt).toContain("CONTRAT D'INTERFACE");
    expect(calls[1]!.prompt).toContain("Aucun test pour S1");
    expect(calls[2]!.prompt).toContain("tests/acceptance/commandes.spec.ts");
    const tests = await latestArtifact(db, p.id, "test_plan");
    expect((tests?.content as { files: { path: string }[] }).files.map((f) => f.path)).toEqual(["tests/acceptance/clients.spec.ts", "tests/acceptance/commandes.spec.ts"]);
  });

  it("un fichier de tests coupé par la longueur est redemandé plus court", async () => {
    const p = await projectInSpecifying("Projet aux tests trop longs au départ");
    const llm = new ScriptedLlm({
      spec: [{ text: json(validSpec()) }],
      acceptance_tests: [{ text: "```ts\nimport", truncated: true }, ...testsOk],
    });
    expect(await runSpec({ db, llm, notifier: new NullNotifier() }, p.id)).toBe("AWAITING_P2");
    expect(llm.calls.filter((c) => c.agent === "acceptance_tests")[1]!.prompt).toContain("trop long");
  });

  it("une relance après un échec des tests réutilise la spec déjà validée au lieu de la repayer", async () => {
    const p = await projectInSpecifying("Projet dont les tests ont échoué une fois");
    const first = new ScriptedLlm({ spec: [{ text: json(validSpec()) }], acceptance_tests: [{ text: "pas de code" }] });
    await expect(runSpec({ db, llm: first, notifier: new NullNotifier() }, p.id)).rejects.toThrow(/acceptance_tests \(clients\)/);

    const second = new ScriptedLlm({ acceptance_tests: [...testsOk] });
    expect(await runSpec({ db, llm: second, notifier: new NullNotifier() }, p.id)).toBe("AWAITING_P2");
    expect(second.calls.map((c) => c.agent)).not.toContain("spec");
  });

  it("après 3 refus, l'étape échoue sans changer d'état (le traitement le passera en échec)", async () => {
    const p = await projectInSpecifying("Projet à la spec impossible");
    const llm = new ScriptedLlm({ spec: [{ text: "pas de json" }] });
    await expect(runSpec({ db, llm, notifier: new NullNotifier() }, p.id)).rejects.toThrow(/3 essais/);
    expect((await getProject(db, p.id))?.state).toBe("SPECIFYING");
  });

  it("refuse de rédiger une spec sans dossier d'opportunité validé", async () => {
    const p = await createProject(db, "Projet sans dossier");
    await transition(db, p.id, "IDEA", "RESEARCHING", "system");
    await transition(db, p.id, "RESEARCHING", "AWAITING_P1", "system");
    await transition(db, p.id, "AWAITING_P1", "SPECIFYING", "user");
    await expect(runSpec({ db, llm: new ScriptedLlm({}), notifier: new NullNotifier() }, p.id)).rejects.toThrow(/dossier/);
  });
});

describe("porte P2 et commandes", () => {
  async function awaitingP2() {
    const p = await projectInSpecifying("Projet en attente de P2");
    const notifier = new NullNotifier();
    await runSpec({ db, llm: new ScriptedLlm({ spec: [{ text: json(validSpec()) }], acceptance_tests: [...testsOk] }), notifier }, p.id);
    const { rows } = await db.query<{ id: string }>("select id from approvals where project_id = $1 and gate = 'P2'", [p.id]);
    return { p: (await getProject(db, p.id))!, approvalId: rows[0]!.id };
  }

  it("valider P1 met la rédaction de la spec en file", async () => {
    const p = await createProject(db, "Projet validé en P1");
    await transition(db, p.id, "IDEA", "RESEARCHING", "system");
    await transition(db, p.id, "RESEARCHING", "AWAITING_P1", "system");
    const { rows } = await db.query<{ id: string }>("insert into approvals (project_id, gate, summary) values ($1, 'P1', 'x') returning id", [p.id]);
    const queue = new FakeQueue();
    const res = await cmd.onApprovalButton({ db, queue }, `ap:${rows[0]!.id}:approve`);
    expect(res.append).toContain("Rédaction de la spec");
    expect(queue.specs).toEqual([{ id: p.id }]);
  });

  it("/retravailler annule P2, repasse en rédaction et transmet la consigne", async () => {
    const { p, approvalId } = await awaitingP2();
    const queue = new FakeQueue();
    expect((await cmd.cmdRetravailler({ db, queue }, `${p.slug} court`)).text).toContain("Usage");
    const r = await cmd.cmdRetravailler({ db, queue }, `${p.slug} Retire les commandes, garde seulement les clients et les mesures.`);
    expect(r.text).toContain("reprise");
    expect((await getProject(db, p.id))?.state).toBe("SPECIFYING");
    expect(queue.specs).toEqual([{ id: p.id, instruction: "Retire les commandes, garde seulement les clients et les mesures." }]);
    expect(await decideApproval(db, approvalId, "approve")).toEqual({ ok: false, reason: "Cette demande a déjà été traitée." });
  });

  it("la nouvelle spec tient compte de la consigne et devient la version 2", async () => {
    const { p } = await awaitingP2();
    await cmd.cmdRetravailler({ db, queue: new FakeQueue() }, `${p.slug} Ajoute une story pour exporter les clients.`);
    const llm = new ScriptedLlm({ spec: [{ text: json(validSpec()) }], acceptance_tests: [...testsOk] });
    await runSpec({ db, llm, notifier: new NullNotifier() }, p.id, "Ajoute une story pour exporter les clients.");
    const prompt = llm.calls.find((c) => c.agent === "spec")!.prompt;
    expect(prompt).toContain("CONSIGNE DU PROPRIÉTAIRE");
    expect(prompt).toContain("Spec précédente");
    expect((await latestArtifact(db, p.id, "spec"))?.version).toBe(2);
  });

  it("approuver P2 gèle la spec et passe en construction ; /spec renvoie les 3 fichiers", async () => {
    const { p, approvalId } = await awaitingP2();
    const res = await cmd.onApprovalButton({ db, queue: new FakeQueue() }, `ap:${approvalId}:approve`);
    expect(res.append).toContain("Spec gelée");
    expect((await getProject(db, p.id))?.state).toBe("BUILDING");
    const r = await cmd.cmdSpec({ db, queue: new FakeQueue() }, p.slug);
    expect(r.files?.map((f) => f.name)).toHaveLength(3);
  });

  it("/retravailler reprend aussi une spec en échec, avec la consigne", async () => {
    const p = await projectInSpecifying("Projet dont la spec a échoué puis est retravaillée");
    await transition(db, p.id, "SPECIFYING", "FAILED", "system", "erreur");
    const queue = new FakeQueue();
    expect((await cmd.cmdRetravailler({ db, queue }, `${p.slug} Précise le calcul des sommes dues.`)).text).toContain("reprise");
    expect((await getProject(db, p.id))?.state).toBe("SPECIFYING");
    expect(queue.specs).toEqual([{ id: p.id, instruction: "Précise le calcul des sommes dues." }]);
  });

  it("/relancer reprend une spec en échec", async () => {
    const p = await projectInSpecifying("Projet dont la spec a échoué");
    await transition(db, p.id, "SPECIFYING", "FAILED", "system", "erreur");
    const queue = new FakeQueue();
    expect((await cmd.cmdRelancer({ db, queue }, p.slug)).text).toContain("spec relancée");
    expect(queue.specs).toEqual([{ id: p.id }]);
  });
});
