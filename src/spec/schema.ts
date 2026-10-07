import { z } from "zod";

/** Tables du gabarit : un SaaS ne peut pas les redéfinir. */
export const TEMPLATE_TABLES = ["profiles", "organizations", "memberships", "invitations", "subscriptions", "audit_logs"] as const;

/** Chemins déjà utilisés par le gabarit sous /app/<slug>. */
export const RESERVED_SEGMENTS = ["members", "settings", "billing", "audit", "onboarding", "invite", "new"];

/** Mots réservés SQL ou noms de colonnes ajoutées automatiquement. */
const RESERVED = new Set([
  "all", "and", "any", "as", "asc", "between", "by", "case", "check", "column", "constraint", "create", "default", "delete",
  "desc", "distinct", "do", "else", "end", "false", "for", "foreign", "from", "grant", "group", "having", "in", "index",
  "insert", "into", "is", "join", "key", "like", "limit", "not", "null", "offset", "on", "or", "order", "primary",
  "references", "select", "table", "then", "to", "true", "union", "unique", "update", "user", "using", "values", "when",
  "where", "with", "id", "org_id", "created_at", "created_by", "updated_at",
]);

const ident = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, "identifiant snake_case de 2 à 40 caractères")
  .refine((v) => !RESERVED.has(v), "mot réservé");

const enumValue = z.string().regex(/^[a-z][a-z0-9_]{0,29}$/, "valeur d'enum en snake_case");
const segment = z.string().regex(/^[a-z][a-z0-9-]{1,29}$/, "segment d'URL en kebab-case");
const uiLabel = z.string().min(1).max(60);
const uiMessage = z.string().min(5).max(200);

export const FIELD_TYPES = ["text", "long_text", "integer", "decimal", "money_xof", "money_eur", "boolean", "date", "datetime", "enum", "ref"] as const;
const NUMERIC_TYPES = new Set(["integer", "decimal", "money_xof", "money_eur"]);

export const fieldSchema = z
  .object({
    name: ident,
    /** Libellé EXACT du champ dans l'interface (contrat partagé par les tests et le code). */
    label: uiLabel,
    type: z.enum(FIELD_TYPES),
    required: z.boolean(),
    /** Pour enum : valeur technique + libellé affiché (option du menu). */
    values: z.array(z.object({ value: enumValue, label: uiLabel })).min(2).max(12).optional(),
    /** Pour ref : table cible (entité de la spec). */
    ref: ident.optional(),
    /** Pour un nombre : valeur minimale (ex. 1 pour un montant strictement positif). */
    min: z.number().int().min(0).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === "enum" && !f.values) ctx.addIssue({ code: "custom", message: `${f.name} : un enum doit lister ses valeurs` });
    if (f.type !== "enum" && f.values) ctx.addIssue({ code: "custom", message: `${f.name} : "values" réservé aux enums` });
    if (f.type === "ref" && !f.ref) ctx.addIssue({ code: "custom", message: `${f.name} : une ref doit nommer sa table cible` });
    if (f.type === "ref" && !f.name.endsWith("_id")) ctx.addIssue({ code: "custom", message: `${f.name} : une ref doit finir par _id` });
    if (f.min !== undefined && !NUMERIC_TYPES.has(f.type)) ctx.addIssue({ code: "custom", message: `${f.name} : "min" réservé aux nombres` });
  });

/** Règles garanties PAR LA BASE (générées en SQL par le code). */
export const constraintSchema = z.discriminatedUnion("kind", [
  /** Unicité dans l'organisation, éventuellement limitée (ex. un seul contrat actif par véhicule). */
  z.object({ kind: z.literal("unique"), fields: z.array(ident).min(1).max(3), when: z.object({ field: ident, equals: enumValue }).optional(), message: uiMessage }),
  /** Champ obligatoire quand un autre champ prend certaines valeurs (ex. référence obligatoire si paiement Wave). */
  z.object({ kind: z.literal("required_when"), field: ident, when: z.object({ field: ident, in: z.array(enumValue).min(1).max(8) }), message: uiMessage }),
  /** Date de fin postérieure ou égale à la date de début. */
  z.object({ kind: z.literal("date_order"), start: ident, end: ident, message: uiMessage }),
]);
export type Constraint = z.infer<typeof constraintSchema>;

export const entitySchema = z.object({
  name: ident.refine((v) => !(TEMPLATE_TABLES as readonly string[]).includes(v), "nom réservé au gabarit"),
  label: uiLabel,
  /** Page qui contient la liste et le formulaire : /app/<slug>/<module>. Plusieurs entités peuvent partager une page. */
  module: segment,
  /** Champ texte affiché comme lien vers la fiche dans la liste. */
  title_field: ident,
  fields: z.array(fieldSchema).min(1).max(20),
  constraints: z.array(constraintSchema).max(8).default([]),
  /** Seuls admin/owner peuvent supprimer (sinon tout membre). */
  delete_requires_admin: z.boolean(),
});

/** Écran calculé (tableau de bord, impayés, rentabilité…) : route, éléments testables, libellés de filtres. */
export const viewSchema = z.object({
  name: z.string().min(2).max(60),
  /** "" = accueil de l'organisation (/app/<slug>). */
  route_segment: z.union([z.literal(""), segment]),
  description: z.string().min(10).max(2000),
  testids: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,40}$/)).min(1).max(10),
  /** Libellés exacts des champs de filtre de cet écran (ex. "Mois"). */
  labels: z.array(uiLabel).max(6).default([]),
});

const criterion = z.object({
  given: z.string().min(5).max(600),
  when: z.string().min(5).max(600),
  then: z.string().min(5).max(600),
});

export const storySchema = z.object({
  id: z.string().regex(/^S\d{1,2}$/),
  as: z.string().min(2).max(120),
  want: z.string().min(10).max(500),
  so_that: z.string().min(5).max(500),
  entities: z.array(ident).min(1).max(5),
  acceptance: z.array(criterion).min(1).max(5),
});

export const specSchema = z.object({
  product_name: z.string().min(2).max(60),
  summary: z.string().min(30).max(1500),
  golden_path: z.enum(["europe", "afrique"]),
  variants: z
    .array(z.object({ name: z.string().min(2).max(60), description: z.string().min(10).max(400), chosen: z.boolean() }))
    .length(3),
  variant_rationale: z.string().min(20).max(1200),
  pricing: z.object({ amount: z.number().positive(), currency: z.enum(["XOF", "EUR"]), period: z.enum(["mois", "an"]), rationale: z.string().min(10).max(800) }),
  roles_mapping: z.string().min(10).max(800),
  entities: z.array(entitySchema).min(1).max(8),
  views: z.array(viewSchema).max(6).default([]),
  stories: z.array(storySchema).min(1).max(10),
  business_rules: z.array(z.string().min(10).max(1000)).max(20),
  out_of_scope: z.array(z.string().min(5).max(300)).max(15),
  prospecting: z.string().min(20).max(1500),
});

export type Spec = z.infer<typeof specSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type Field = z.infer<typeof fieldSchema>;
export type View = z.infer<typeof viewSchema>;

/** Contrôles de cohérence que le schéma seul ne peut pas exprimer. Renvoie la liste des problèmes (vide = OK). */
export function checkSpec(spec: Spec): string[] {
  const problems: string[] = [];
  const names = spec.entities.map((e) => e.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) problems.push(`Entités en double : ${[...new Set(dup)].join(", ")}`);

  for (const e of spec.entities) {
    const byName = new Map(e.fields.map((f) => [f.name, f]));
    const fieldNames = e.fields.map((f) => f.name);
    const dupF = fieldNames.filter((n, i) => fieldNames.indexOf(n) !== i);
    if (dupF.length) problems.push(`${e.name} : champs en double (${dupF.join(", ")})`);
    const labels = e.fields.map((f) => f.label);
    const dupL = labels.filter((n, i) => labels.indexOf(n) !== i);
    if (dupL.length) problems.push(`${e.name} : libellés en double (${dupL.join(", ")}) — chaque champ doit avoir un libellé unique`);

    const title = byName.get(e.title_field);
    if (!title || title.type !== "text" || !title.required) problems.push(`${e.name} : title_field doit être un champ texte obligatoire de l'entité`);

    for (const f of e.fields) {
      if (f.type === "ref" && f.ref && !names.includes(f.ref)) problems.push(`${e.name}.${f.name} pointe vers une entité inconnue « ${f.ref} »`);
      if (f.type === "ref" && f.ref === e.name) problems.push(`${e.name}.${f.name} : référence vers sa propre table non prise en charge`);
      if (f.values) {
        const vals = f.values.map((v) => v.value);
        if (new Set(vals).size !== vals.length) problems.push(`${e.name}.${f.name} : valeurs d'enum en double`);
      }
    }

    const enumHas = (field: string, value: string) => byName.get(field)?.values?.some((v) => v.value === value) ?? false;
    for (const c of e.constraints) {
      const where = `${e.name} (contrainte ${c.kind})`;
      if (c.kind === "unique") {
        for (const f of c.fields) if (!byName.has(f)) problems.push(`${where} : champ inconnu « ${f} »`);
        if (c.when && !enumHas(c.when.field, c.when.equals)) problems.push(`${where} : « ${c.when.field} = ${c.when.equals} » n'est pas une valeur d'enum de l'entité`);
      } else if (c.kind === "required_when") {
        if (!byName.has(c.field)) problems.push(`${where} : champ inconnu « ${c.field} »`);
        else if (byName.get(c.field)!.required) problems.push(`${where} : « ${c.field} » est déjà toujours obligatoire`);
        for (const v of c.when.in) if (!enumHas(c.when.field, v)) problems.push(`${where} : « ${c.when.field} = ${v} » n'est pas une valeur d'enum de l'entité`);
      } else {
        const s = byName.get(c.start);
        const en = byName.get(c.end);
        if (!s || !en || !["date", "datetime"].includes(s.type) || s.type !== en.type) problems.push(`${where} : ${c.start} et ${c.end} doivent être deux dates de l'entité`);
      }
    }
  }
  if (hasCycle(spec.entities)) problems.push("Références circulaires entre entités");

  const modules = new Set(spec.entities.map((e) => e.module));
  const segments = spec.views.map((v) => v.route_segment).filter((s) => s !== "");
  for (const s of [...modules, ...segments]) if (RESERVED_SEGMENTS.includes(s)) problems.push(`Le chemin « ${s} » est réservé au gabarit`);
  for (const s of segments) if (modules.has(s)) problems.push(`L'écran « ${s} » utilise le même chemin qu'une page d'entités`);
  if (new Set(segments).size !== segments.length) problems.push("Deux écrans calculés ont le même chemin");
  const crudIds = new Set(spec.entities.flatMap((e) => ["form", "list", "row", "empty", "edit-form"].map((k) => `${e.name}-${k}`)));
  for (const v of spec.views) for (const t of v.testids) if (crudIds.has(t)) problems.push(`L'écran « ${v.name} » réutilise l'identifiant réservé « ${t} »`);

  const ids = spec.stories.map((s) => s.id);
  if (new Set(ids).size !== ids.length) problems.push("Identifiants de stories en double");
  ids.forEach((id, i) => {
    if (id !== `S${i + 1}`) problems.push(`Les stories doivent être numérotées S1, S2… dans l'ordre (trouvé ${id} en position ${i + 1})`);
  });
  for (const s of spec.stories) {
    for (const ent of s.entities) if (!names.includes(ent)) problems.push(`${s.id} utilise une entité inconnue « ${ent} »`);
  }
  const used = new Set(spec.stories.flatMap((s) => s.entities));
  for (const n of names) if (!used.has(n)) problems.push(`L'entité ${n} n'est utilisée par aucune story`);
  if (spec.variants.filter((v) => v.chosen).length !== 1) problems.push("Exactement une variante doit être choisie");
  return problems;
}

/** Ordre de création des tables (dépendances d'abord). Suppose l'absence de cycle. */
export function topoOrder(entities: Entity[]): Entity[] {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const done = new Set<string>();
  const out: Entity[] = [];
  const visit = (e: Entity) => {
    if (done.has(e.name)) return;
    done.add(e.name);
    for (const f of e.fields) if (f.type === "ref" && f.ref && byName.has(f.ref)) visit(byName.get(f.ref)!);
    out.push(e);
  };
  entities.forEach(visit);
  return out;
}

function hasCycle(entities: Entity[]): boolean {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const state = new Map<string, 1 | 2>();
  const dfs = (name: string): boolean => {
    if (state.get(name) === 1) return true;
    if (state.get(name) === 2) return false;
    state.set(name, 1);
    for (const f of byName.get(name)?.fields ?? []) {
      if (f.type === "ref" && f.ref && f.ref !== name && byName.has(f.ref) && dfs(f.ref)) return true;
    }
    state.set(name, 2);
    return false;
  };
  return entities.some((e) => dfs(e.name));
}
