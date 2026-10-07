import { topoOrder, type Entity, type Field, type Spec } from "./schema.ts";

/**
 * Génère la migration SQL du SaaS à partir de la spec validée. AUCUNE IA ici :
 * le modèle décrit les entités, le code écrit le SQL selon les règles du gabarit (FACTORY.md) :
 * - org_id + clé (org_id, id) sur chaque table, références composites (aucun mélange entre organisations)
 * - RLS : lecture/écriture par les membres, suppression selon delete_requires_admin
 * - privilèges colonne par colonne (org_id, created_by… jamais modifiables par l'utilisateur)
 * - migration additive uniquement (pas de DROP/ALTER destructif)
 */
export function generateMigration(spec: Spec): string {
  const lines: string[] = [
    `-- Migration générée par SaaS Factory pour « ${spec.product_name.replace(/\n/g, " ")} ».`,
    "-- Ne pas modifier : toute évolution passe par une nouvelle migration.",
    "",
  ];
  for (const entity of topoOrder(spec.entities)) lines.push(tableSql(entity), "");
  return lines.join("\n");
}

function columnSql(f: Field): string {
  const notNull = f.required ? " not null" : "";
  const n = f.name;
  switch (f.type) {
    case "text":
      return `${n} text${notNull} check (${n} is null or char_length(${n}) <= 200)`;
    case "long_text":
      return `${n} text${notNull} check (${n} is null or char_length(${n}) <= 5000)`;
    case "integer":
      return `${n} bigint${notNull}`;
    case "decimal":
      return `${n} numeric(14, 2)${notNull}`;
    case "money_xof":
      return `${n} bigint${notNull} check (${n} is null or ${n} >= 0)`;
    case "money_eur":
      return `${n} numeric(12, 2)${notNull} check (${n} is null or ${n} >= 0)`;
    case "boolean":
      return `${n} boolean not null default false`;
    case "date":
      return `${n} date${notNull}`;
    case "datetime":
      return `${n} timestamptz${notNull}`;
    case "enum": {
      const values = (f.values ?? []).map((v) => `'${v}'`).join(", ");
      return `${n} text${notNull} check (${n} is null or ${n} in (${values}))`;
    }
    case "ref":
      return `${n} uuid${notNull}`;
  }
}

function tableSql(e: Entity): string {
  const t = `public.${e.name}`;
  const cols = [
    "id uuid primary key default gen_random_uuid()",
    "org_id uuid not null references public.organizations (id) on delete cascade",
    ...e.fields.map(columnSql),
    "created_by uuid default auth.uid() references auth.users (id) on delete set null",
    "created_at timestamptz not null default now()",
    "updated_at timestamptz not null default now()",
    "unique (org_id, id)",
    ...e.fields
      .filter((f) => f.type === "ref")
      .map((f) => `foreign key (org_id, ${f.name}) references public.${f.ref} (org_id, id) on delete no action`),
  ];
  const userCols = e.fields.map((f) => f.name);
  const out = [
    `-- ${e.label}`,
    `create table ${t} (\n  ${cols.join(",\n  ")}\n);`,
    `create index ${e.name}_org_created_idx on ${t} (org_id, created_at desc);`,
    ...e.fields.filter((f) => f.type === "ref").map((f) => `create index ${e.name}_${f.name}_idx on ${t} (${f.name});`),
    `alter table ${t} enable row level security;`,
    `create policy ${e.name}_select on ${t} for select to authenticated using (public.is_org_member(org_id));`,
    `create policy ${e.name}_insert on ${t} for insert to authenticated with check (public.is_org_member(org_id));`,
    `create policy ${e.name}_update on ${t} for update to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));`,
    `create policy ${e.name}_delete on ${t} for delete to authenticated using (public.has_org_role(org_id, '${e.delete_requires_admin ? "admin" : "member"}'));`,
    `grant select, delete on ${t} to authenticated;`,
    `grant insert (org_id, ${userCols.join(", ")}) on ${t} to authenticated;`,
    `grant update (${[...userCols, "updated_at"].join(", ")}) on ${t} to authenticated;`,
    `grant all on ${t} to service_role;`,
  ];
  return out.join("\n");
}

/** Nom de fichier conforme au gabarit (AAAAMMJJHHMMSS_description.sql). */
export function migrationFileName(spec: Spec, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const name = spec.product_name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30) || "app";
  return `supabase/migrations/${ts}_${name}.sql`;
}
