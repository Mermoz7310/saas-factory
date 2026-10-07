import { z } from "zod";
import type { Db } from "../db/pool.ts";
import { requestApproval } from "../domain/approvals.ts";
import { getProject, latestArtifact, saveArtifact, transition, type Project } from "../domain/projects.ts";
import { extractJson, type Llm } from "../llm/client.ts";
import type { Notifier } from "../notify.ts";
import { buildUiContract, renderContract, type UiContract } from "../spec/contract.ts";
import { checkSpec, specSchema, topoOrder, type Spec } from "../spec/schema.ts";
import { generateMigration, migrationFileName } from "../spec/sql.ts";
import { checkTestFiles, type TestFiles } from "../spec/tests-check.ts";
import { shorten } from "./dossier.ts";

export const SPEC_PROMPT_VERSION = "spec-v3";

const SPEC_SYSTEM = `Tu es le Product Manager d'une usine à SaaS. Tu travailles en français.
Tu transformes un dossier d'opportunité validé en spécification de MVP, construite sur un gabarit existant qui fournit DÉJÀ :
comptes, organisations, rôles owner/admin/member, invitations, journal d'audit (toute suppression y est tracée automatiquement), abonnement (Stripe en Europe ; mobile money en Afrique).
Ne respécifie jamais ces fonctions : spécifie uniquement le métier.

Règles :
- 10 user stories AU MAXIMUM, numérotées S1, S2… dans l'ordre. Chaque story : 1 à 5 critères d'acceptation « Étant donné / Quand / Alors », concrets et vérifiables dans un navigateur, avec des valeurs chiffrées.
- 8 entités au maximum. Noms de tables en snake_case au pluriel anglais (ex. "customers"). Pas de colonnes id, org_id, created_at, created_by, updated_at : elles sont ajoutées automatiquement.
- "module" = segment d'URL en français kebab-case de la page qui contient liste + formulaire (ex. "clients"). Plusieurs entités peuvent partager une page. Interdits : members, settings, billing, audit, onboarding, invite, new.
- "label" de chaque champ = libellé EXACT affiché dans l'interface, unique dans l'entité. "title_field" = champ texte obligatoire qui identifie une ligne (affiché dans les listes et les menus de référence).
- Types : text (≤200 car.), long_text, integer, decimal, money_xof (FCFA entiers), money_eur, boolean, date, datetime, enum ("values" = [{ "value": "snake_case", "label": "Libellé affiché" }]), ref ("ref" = table cible, nom finissant par _id). "min" (facultatif, nombres) : ex. 1 pour un montant strictement positif.
- Toute règle qui peut être garantie par la base DOIT être dans "constraints" de l'entité (sinon elle ne sera pas garantie) :
  · {"kind":"unique","fields":[...],"when":{"field":"status","equals":"active"},"message":"..."} — unicité dans l'organisation, "when" facultatif (ex. un seul contrat actif par véhicule) ;
  · {"kind":"required_when","field":"reference","when":{"field":"method","in":["wave"]},"message":"..."} — champ facultatif devenu obligatoire ;
  · {"kind":"date_order","start":"start_date","end":"end_date","message":"..."}.
  "message" = texte EXACT affiché à l'utilisateur quand la règle est violée.
- "views" : écrans calculés (impayés, tableau de bord, rentabilité…) : route_segment (kebab-case, "" = accueil de l'organisation), description PRÉCISE du calcul, data-testid des éléments à vérifier, libellés des filtres.
- Toute règle de calcul est sans ambiguïté : bornes incluses ou exclues, jour de référence (aujourd'hui inclus ?), arrondis, ordre de tri, que faire des cas limites (jour de repos, contrat terminé, montant partiel). Donne un exemple chiffré.
- Chaque entité est utilisée par au moins une story ; chaque story liste les entités qu'elle touche.
- 3 variantes du produit, exactement une "chosen": true, et la justification du choix.
- Le MVP doit être construisible en quelques jours : en cas de doute, retire plutôt que d'ajouter.

LIMITES STRICTES (au-delà, la réponse est refusée) : 8 entités, 20 champs par entité, 8 contraintes par entité, 10 stories, 5 critères par story,
6 écrans calculés, 20 règles métier (≤ 500 caractères chacune ; ne répète pas les contraintes déjà déclarées), 15 éléments hors périmètre,
libellés ≤ 60 caractères, messages d'erreur ≤ 160 caractères, résumé ≤ 800 caractères.
Réponds uniquement par un objet JSON dans un bloc \`\`\`json.`;

const SPEC_SHAPE = `{
  "product_name": "...", "summary": "...", "golden_path": "europe | afrique",
  "variants": [{ "name": "...", "description": "...", "chosen": true }, {...}, {...}],
  "variant_rationale": "...",
  "pricing": { "amount": 5000, "currency": "XOF | EUR", "period": "mois | an", "rationale": "..." },
  "roles_mapping": "comment les rôles métier correspondent à owner/admin/member",
  "entities": [{ "name": "customers", "label": "Clients", "module": "clients", "title_field": "full_name", "delete_requires_admin": true,
    "fields": [{ "name": "full_name", "label": "Nom", "type": "text", "required": true },
               { "name": "phone", "label": "Téléphone", "type": "text", "required": true },
               { "name": "status", "label": "Statut", "type": "enum", "required": true, "values": [{ "value": "active", "label": "Actif" }, { "value": "archived", "label": "Archivé" }] }],
    "constraints": [{ "kind": "unique", "fields": ["phone"], "message": "Ce numéro de téléphone est déjà enregistré." }] },
   { "name": "orders", "label": "Commandes", "module": "commandes", "title_field": "title", "delete_requires_admin": false,
    "fields": [{ "name": "title", "label": "Intitulé", "type": "text", "required": true },
               { "name": "customer_id", "label": "Client", "type": "ref", "required": true, "ref": "customers" },
               { "name": "amount_xof", "label": "Montant (FCFA)", "type": "money_xof", "required": true, "min": 1 }],
    "constraints": [] }],
  "views": [{ "name": "Impayés", "route_segment": "impayes", "description": "calcul exact…", "testids": ["unpaid-total", "unpaid-list"], "labels": ["Mois"] }],
  "stories": [{ "id": "S1", "as": "gérant", "want": "...", "so_that": "...", "entities": ["customers"],
    "acceptance": [{ "given": "...", "when": "...", "then": "..." }] }],
  "business_rules": ["..."], "out_of_scope": ["..."], "prospecting": "où et comment trouver les 10 premiers clients"
}`;

const TEST_SYSTEM = `Tu es l'agent QA d'une usine à SaaS. Tu écris les tests d'acceptation Playwright AVANT que le code existe.
Ces tests sont le contrat : un autre agent devra écrire l'interface pour les faire passer, sans pouvoir les modifier.

Le CONTRAT D'INTERFACE fourni est la seule source des routes, data-testid, libellés de champs, options de listes et messages d'erreur.
N'invente AUCUN autre élément : un contrôle automatique refuse tout data-testid, libellé ou route absent du contrat.
- Chaque test part d'un compte neuf : const slug = await newWorkspace(page) (fonction à définir dans le fichier, voir l'exemple).
- Si une story a besoin de données préalables (ex. un véhicule avant un contrat), crée-les par l'interface, sur leur page, dans le test (fonction d'aide locale au fichier).
- Listes : selectOption({ label: "<libellé de l'option>" }) — jamais la valeur technique.
- Vérifie les valeurs affichées selon les conventions d'affichage du contrat (ex. « 15 000 FCFA » avec une espace ordinaire, dates JJ/MM/AAAA).
- Dates : calcule-les par rapport à aujourd'hui dans le test (new Date()), jamais de date fixe qui deviendrait fausse avec le temps.
- Erreurs métier : expect(page.getByRole("alert")).toContainText("<message exact du contrat>").
- Titre de chaque test : « Sx — Étant donné …, quand …, alors … ». Au moins un test par story. Tests courts et indépendants.

Interdits : test.only/skip/fixme, waitForTimeout, page.evaluate, URL absolues, process.env, imports autres que "@playwright/test", "./helpers", "node:crypto".
Helpers disponibles dans "./helpers" : signUp(page, email, name?, password?), createOrg(page, name), newEmail(label), logIn(page, email, password).

Exemple de style :
\`\`\`ts
import { expect, test, type Page } from "@playwright/test";
import { createOrg, newEmail, signUp } from "./helpers";

async function newWorkspace(page: Page): Promise<string> {
  await signUp(page, newEmail("e2e"), "Testeur");
  await createOrg(page, "Atelier Test");
  return new URL(page.url()).pathname.split("/")[2]!;
}

async function addCustomer(page: Page, slug: string, name: string) {
  await page.goto(\`/app/\${slug}/clients\`);
  const form = page.getByTestId("customers-form");
  await form.getByLabel("Nom").fill(name);
  await form.getByLabel("Téléphone").fill("771234567");
  await form.getByLabel("Statut").selectOption({ label: "Actif" });
  await form.getByRole("button", { name: "Ajouter" }).click();
  await expect(page.getByTestId("customers-list")).toContainText(name);
}

test("S2 — Étant donné un client, quand j'ajoute une commande de 15000 FCFA, alors elle apparaît avec son montant", async ({ page }) => {
  const slug = await newWorkspace(page);
  await addCustomer(page, slug, "Aminata Sow");
  await page.goto(\`/app/\${slug}/commandes\`);
  const form = page.getByTestId("orders-form");
  await form.getByLabel("Intitulé").fill("Boubou brodé");
  await form.getByLabel("Client").selectOption({ label: "Aminata Sow" });
  await form.getByLabel("Montant (FCFA)").fill("15000");
  await form.getByRole("button", { name: "Ajouter" }).click();
  const row = page.getByTestId("orders-row").filter({ hasText: "Boubou brodé" });
  await expect(row).toContainText("15 000 FCFA");
});
\`\`\`
Tu écris UN seul fichier, pour les stories qu'on te donne. Réponds uniquement par UN bloc \`\`\`ts contenant le fichier complet, sans autre texte.`;

export type SpecDeps = { db: Db; llm: Llm; notifier: Notifier };

export type TaskPlanItem = { id: string; title: string; story: string | null; depends_on: string[]; allowed_paths: string[] };

/** Plan de construction déterministe : migration d'abord, puis une tâche par story. */
export function planTasks(spec: Spec, migrationPath: string): TaskPlanItem[] {
  const modulesOf = (entities: string[]) =>
    [...new Set(entities.map((n) => spec.entities.find((e) => e.name === n)?.module).filter((m): m is string => Boolean(m)))];
  return [
    { id: "T0", title: "Appliquer la migration générée", story: null, depends_on: [], allowed_paths: [migrationPath] },
    ...spec.stories.map((s, i) => ({
      id: `T${i + 1}`,
      title: `${s.id} — ${s.want}`,
      story: s.id,
      depends_on: ["T0"],
      allowed_paths: [
        ...modulesOf(s.entities).flatMap((m) => [`src/app/app/[slug]/${m}/**`, `src/app/app/${m}-actions.ts`, `src/lib/${m}.ts`, `tests/unit/${m}.test.ts`]),
        ...spec.views.flatMap((v) => (v.route_segment ? [`src/app/app/[slug]/${v.route_segment}/**`] : ["src/app/app/[slug]/page.tsx"])),
        "src/app/app/[slug]/layout.tsx",
        "src/lib/format.ts",
      ],
    })),
  ];
}

async function structured<T>(
  deps: SpecDeps,
  schema: z.ZodType<T>,
  check: (value: T) => string[],
  params: { agent: string; projectId: string; tier: "standard" | "strong"; system: string; prompt: string; maxTokens: number },
): Promise<T> {
  let prompt = params.prompt;
  let problems: string[] = [];
  const history: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await deps.llm.call({ ...params, prompt, promptVersion: SPEC_PROMPT_VERSION, acceptTruncated: true });
    if (res.truncated) {
      problems = ["Réponse trop longue, coupée : sois plus concis."];
    } else {
      try {
        const value = schema.parse(extractJson(res.text));
        problems = check(value);
        if (problems.length === 0) return value;
      } catch (error) {
        problems = [error instanceof z.ZodError ? z.prettifyError(error) : String(error)];
      }
    }
    history.push(`essai ${attempt} : ${problems.slice(0, 2).join(" ; ").slice(0, 200)}`);
    prompt = `${params.prompt}\n\n⚠️ ESSAI ${attempt + 1}/3 — ta réponse précédente a été REFUSÉE par les contrôles automatiques pour ces raisons :\n- ${problems.join("\n- ").slice(0, 2500)}\nRenvoie le JSON complet en corrigeant CHACUN de ces points (respecte les LIMITES STRICTES : regroupe ou retire plutôt que de dépasser).`;
  }
  throw new Error(`${params.agent} : réponse refusée après 3 essais — ${history.join(" | ")}`);
}

/** Extrait le premier bloc de code TypeScript d'une réponse. */
export function extractCode(text: string): string | null {
  const m = /```(?:ts|typescript)?[ \t]*\r?\n([\s\S]*?)```/.exec(text);
  return m?.[1]?.trim() ? `${m[1].trim()}\n` : null;
}

/**
 * Story → module du fichier de tests : celui de son entité la plus « dépendante »
 * (une story « créer une commande pour un client » touche customers et orders : elle relève d'orders).
 */
export function groupStoriesByModule(spec: Spec): Map<string, Spec["stories"]> {
  const order = topoOrder(spec.entities).map((e) => e.name);
  const groups = new Map<string, Spec["stories"]>();
  for (const story of spec.stories) {
    const main = [...story.entities].sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
    const module = spec.entities.find((e) => e.name === main)?.module ?? "app";
    groups.set(module, [...(groups.get(module) ?? []), story]);
  }
  return groups;
}

/** Un fichier de tests par module, un appel par fichier : réponses courtes, code brut (pas de JSON), 3 essais chacun. */
async function writeAcceptanceTests(deps: SpecDeps, projectId: string, spec: Spec, contract: UiContract): Promise<TestFiles> {
  const files: TestFiles["files"] = [];
  for (const [module, stories] of groupStoriesByModule(spec)) {
    const path = `tests/acceptance/${module}.spec.ts`;
    const ids = stories.map((s) => s.id);
    const base = [
      `Fichier à écrire : ${path}`,
      `Stories à couvrir (au moins un test chacune, titre « Sx — … ») :\n${JSON.stringify(stories, null, 2)}`,
      `CONTRAT D'INTERFACE (toute l'application) :\n${JSON.stringify(contract, null, 1)}`,
      `Règles métier :\n${spec.business_rules.map((r) => `- ${r}`).join("\n")}`,
    ].join("\n\n");
    let prompt = base;
    let problems: string[] = [];
    let content: string | null = null;
    for (let attempt = 1; attempt <= 3 && content === null; attempt++) {
      const res = await deps.llm.call({ agent: "acceptance_tests", projectId, tier: "standard", system: TEST_SYSTEM, prompt, maxTokens: 10000, promptVersion: SPEC_PROMPT_VERSION, acceptTruncated: true });
      const code = res.truncated ? null : extractCode(res.text);
      problems = res.truncated ? ["Fichier trop long, coupé : écris des tests plus courts (un test par story suffit)."] : code === null ? ["Aucun bloc ```ts trouvé dans la réponse."] : checkTestFiles([{ path, content: code }], ids, contract);
      if (problems.length === 0) content = code;
      else prompt = `${base}\n\nTa réponse précédente a été refusée par les contrôles automatiques :\n- ${problems.join("\n- ").slice(0, 2500)}\nRenvoie le fichier complet corrigé.`;
    }
    if (content === null) throw new Error(`acceptance_tests (${module}) : réponse refusée après 3 essais — ${problems.slice(0, 3).join(" ; ").slice(0, 400)}`);
    files.push({ path, content });
  }
  const global = checkTestFiles(files, spec.stories.map((s) => s.id), contract);
  if (global.length) throw new Error(`Tests d'acceptation incohérents : ${global.slice(0, 3).join(" ; ")}`);
  return { files };
}

export function renderSpec(spec: Spec, tests: TestFiles, migrationPath: string, tasks: TaskPlanItem[], contract: UiContract): string {
  const L: string[] = [];
  L.push(`# ${spec.product_name} — Spécification MVP`, "", spec.summary, "");
  L.push(`**Voie :** ${spec.golden_path === "afrique" ? "Afrique (PWA + mobile money)" : "Europe (web + Stripe)"}  `);
  L.push(`**Prix :** ${spec.pricing.amount} ${spec.pricing.currency === "XOF" ? "FCFA" : "€"} / ${spec.pricing.period} — ${spec.pricing.rationale}`, "");
  L.push("## Variantes étudiées", ...spec.variants.map((v) => `- ${v.chosen ? "✅" : "▫️"} **${v.name}** : ${v.description}`), "", spec.variant_rationale, "");
  L.push("## Rôles", spec.roles_mapping, "");
  L.push("## User stories");
  for (const s of spec.stories) {
    L.push(`### ${s.id} — En tant que ${s.as}, je veux ${s.want}, afin de ${s.so_that}`);
    for (const c of s.acceptance) L.push(`- Étant donné ${c.given}, quand ${c.when}, alors ${c.then}`);
    L.push("");
  }
  L.push("## Données", "| Table | Champs |", "| --- | --- |");
  for (const e of spec.entities) {
    L.push(`| ${e.name} (${e.label}) | ${e.fields.map((f) => `${f.name}${f.required ? "*" : ""} : ${f.type === "ref" ? `→ ${f.ref}` : f.type === "enum" ? (f.values ?? []).map((v) => v.label).join("/") : f.type}${f.min !== undefined ? ` ≥ ${f.min}` : ""}`).join(", ")} |`);
  }
  const guaranteed = spec.entities.flatMap((e) => e.constraints.map((c) => `- ${e.label} : ${c.message} (${c.kind})`));
  L.push("", "## Règles garanties par la base", ...(guaranteed.length ? guaranteed : ["- (aucune)"]), "");
  L.push("## Écrans calculés", ...(spec.views.length ? spec.views.map((v) => `- **${v.name}** (/${v.route_segment}) : ${v.description}`) : ["- (aucun)"]), "");
  L.push("## Règles métier", ...spec.business_rules.map((r) => `- ${r}`), "");
  L.push("## Hors MVP", ...spec.out_of_scope.map((r) => `- ${r}`), "");
  L.push("## Trouver les premiers clients", spec.prospecting, "");
  L.push("## Fichiers produits", `- Migration (générée par le code, RLS incluse) : \`${migrationPath}\``, ...tests.files.map((f) => `- Tests d'acceptation : \`${f.path}\``), "");
  L.push("## Plan de construction", ...tasks.map((t) => `- ${t.id} : ${t.title}`), "");
  L.push(renderContract(contract));
  return L.join("\n");
}

/**
 * Étape 2 : spec (Product Manager) → contrôles de cohérence (code) → migration SQL (code) →
 * tests d'acceptation (agent QA distinct) → contrôles des tests (code) → plan de tâches (code) → porte P2.
 */
export async function runSpec(deps: SpecDeps, projectId: string, instruction?: string): Promise<"AWAITING_P2"> {
  const { db, notifier } = deps;
  const project = (await getProject(db, projectId)) as Project | null;
  if (!project) throw new Error(`Projet ${projectId} introuvable`);
  if (project.state !== "SPECIFYING") throw new Error(`Projet dans l'état ${project.state}, spec impossible`);

  const dossier = await latestArtifact(db, projectId, "dossier");
  if (!dossier) throw new Error("Aucun dossier d'opportunité : la spec part toujours du dossier validé.");
  const previous = await latestArtifact(db, projectId, "spec");
  await notifier.send(`📝 Rédaction de la spec pour « ${project.title} »${instruction ? " avec ta consigne" : ""} (10 à 15 min).`);

  // Brouillon déjà validé et payé (relance après un échec des tests, sans nouvelle consigne) : on le réutilise.
  // Chaque exécution réussie enregistre exactement un brouillon et une spec : un brouillon plus récent = exécution interrompue.
  const draft = instruction ? null : await latestArtifact(db, projectId, "spec_draft");
  const parsedDraft = draft && (!previous || draft.version > previous.version) ? specSchema.safeParse((draft.content as { spec?: unknown }).spec) : null;
  const reused = parsedDraft?.success && checkSpec(parsedDraft.data).length === 0 ? parsedDraft.data : null;

  const spec: Spec =
    reused ??
    (await structured(deps, specSchema, checkSpec, {
      agent: "spec",
      projectId,
      tier: "strong",
      system: SPEC_SYSTEM,
      prompt: [
        `Demande initiale :\n"""${project.request}"""`,
        `Dossier d'opportunité validé (P1) :\n"""${dossier.markdown.slice(0, 30_000)}"""`,
        previous && instruction ? `Spec précédente (à retravailler) :\n"""${previous.markdown.slice(0, 20_000)}"""` : "",
        instruction ? `CONSIGNE DU PROPRIÉTAIRE (prioritaire) :\n"""${instruction}"""` : "",
        `Forme attendue :\n${SPEC_SHAPE}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      maxTokens: 16000,
    }));
  if (!reused) await saveArtifact(db, projectId, "spec_draft", { spec }, spec.product_name);

  const migrationPath = migrationFileName(spec);
  const migration = generateMigration(spec);

  const contract = buildUiContract(spec);
  const tests = await writeAcceptanceTests(deps, projectId, spec, contract);

  const tasks = planTasks(spec, migrationPath);
  const markdown = renderSpec(spec, tests, migrationPath, tasks, contract);
  const version = await saveArtifact(db, projectId, "spec", { spec, contract, migration: { path: migrationPath, sql: migration }, tasks, instruction: instruction ?? null }, markdown);
  await saveArtifact(db, projectId, "test_plan", tests, tests.files.map((f) => `// ${f.path}\n${f.content}`).join("\n\n"));
  await transition(db, projectId, "SPECIFYING", "AWAITING_P2", "system", `spec v${version} prête`);

  await notifier.sendFile(`SPEC-${project.slug}-v${version}.md`, markdown);
  await notifier.sendFile(migrationPath.split("/").pop()!, migration);
  await notifier.sendFile(`tests-acceptance-${project.slug}-v${version}.ts.txt`, tests.files.map((f) => `// ===== ${f.path} =====\n${f.content}`).join("\n\n"));

  const fresh = (await getProject(db, projectId)) as Project;
  const chosen = spec.variants.find((v) => v.chosen)!;
  await requestApproval(
    db,
    notifier,
    fresh,
    "P2",
    [
      `📐 Porte P2 — ${spec.product_name} (spec v${version})`,
      "",
      shorten(spec.summary, 400),
      "",
      `Variante retenue : ${chosen.name}`,
      `${spec.stories.length} user stories · ${spec.entities.length} tables · ${tests.files.length} fichier(s) de tests d'acceptation`,
      `Prix : ${spec.pricing.amount} ${spec.pricing.currency === "XOF" ? "FCFA" : "€"} / ${spec.pricing.period}`,
      "",
      "Lis les 3 fichiers ci-dessus. Après validation, la spec est gelée.",
      `Pour corriger : /retravailler ${project.slug} <ta consigne>`,
    ].join("\n"),
  );
  return "AWAITING_P2";
}
