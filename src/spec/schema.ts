import { z } from "zod";

/** Tables du gabarit : un SaaS ne peut pas les redéfinir. */
export const TEMPLATE_TABLES = ["profiles", "organizations", "memberships", "invitations", "subscriptions", "audit_logs"] as const;

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

export const FIELD_TYPES = ["text", "long_text", "integer", "decimal", "money_xof", "money_eur", "boolean", "date", "datetime", "enum", "ref"] as const;

export const fieldSchema = z
  .object({
    name: ident,
    label: z.string().min(1).max(60),
    type: z.enum(FIELD_TYPES),
    required: z.boolean(),
    /** Pour enum : valeurs autorisées (snake_case). */
    values: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,29}$/)).min(2).max(12).optional(),
    /** Pour ref : table cible (entité de la spec). */
    ref: ident.optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === "enum" && !f.values) ctx.addIssue({ code: "custom", message: `${f.name} : un enum doit lister ses valeurs` });
    if (f.type === "ref" && !f.ref) ctx.addIssue({ code: "custom", message: `${f.name} : une ref doit nommer sa table cible` });
    if (f.type === "ref" && !f.name.endsWith("_id")) ctx.addIssue({ code: "custom", message: `${f.name} : une ref doit finir par _id` });
  });

export const entitySchema = z.object({
  name: ident.refine((v) => !(TEMPLATE_TABLES as readonly string[]).includes(v), "nom réservé au gabarit"),
  label: z.string().min(1).max(60),
  module: z.string().regex(/^[a-z][a-z0-9-]{1,29}$/, "module en kebab-case"),
  fields: z.array(fieldSchema).min(1).max(20),
  /** Seuls admin/owner peuvent supprimer (sinon tout membre). */
  delete_requires_admin: z.boolean(),
});

const criterion = z.object({
  given: z.string().min(5).max(300),
  when: z.string().min(5).max(300),
  then: z.string().min(5).max(300),
});

export const storySchema = z.object({
  id: z.string().regex(/^S\d{1,2}$/),
  as: z.string().min(2).max(80),
  want: z.string().min(10).max(300),
  so_that: z.string().min(5).max(300),
  entities: z.array(ident).min(1).max(5),
  acceptance: z.array(criterion).min(1).max(5),
});

export const specSchema = z.object({
  product_name: z.string().min(2).max(60),
  summary: z.string().min(30).max(800),
  golden_path: z.enum(["europe", "afrique"]),
  variants: z
    .array(z.object({ name: z.string().min(2).max(60), description: z.string().min(10).max(400), chosen: z.boolean() }))
    .length(3),
  variant_rationale: z.string().min(20).max(600),
  pricing: z.object({ amount: z.number().positive(), currency: z.enum(["XOF", "EUR"]), period: z.enum(["mois", "an"]), rationale: z.string().min(10).max(400) }),
  roles_mapping: z.string().min(10).max(400),
  entities: z.array(entitySchema).min(1).max(8),
  stories: z.array(storySchema).min(1).max(10),
  business_rules: z.array(z.string().min(10).max(300)).max(12),
  out_of_scope: z.array(z.string().min(5).max(200)).max(10),
  prospecting: z.string().min(20).max(800),
});

export type Spec = z.infer<typeof specSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type Field = z.infer<typeof fieldSchema>;

/** Contrôles de cohérence que le schéma seul ne peut pas exprimer. Renvoie la liste des problèmes (vide = OK). */
export function checkSpec(spec: Spec): string[] {
  const problems: string[] = [];
  const names = spec.entities.map((e) => e.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) problems.push(`Entités en double : ${[...new Set(dup)].join(", ")}`);

  for (const e of spec.entities) {
    const fieldNames = e.fields.map((f) => f.name);
    const dupF = fieldNames.filter((n, i) => fieldNames.indexOf(n) !== i);
    if (dupF.length) problems.push(`${e.name} : champs en double (${dupF.join(", ")})`);
    for (const f of e.fields) {
      if (f.type === "ref" && f.ref && !names.includes(f.ref)) problems.push(`${e.name}.${f.name} pointe vers une entité inconnue « ${f.ref} »`);
      if (f.type === "ref" && f.ref === e.name) problems.push(`${e.name}.${f.name} : référence vers sa propre table non prise en charge`);
    }
  }
  if (hasCycle(spec.entities)) problems.push("Références circulaires entre entités");

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
