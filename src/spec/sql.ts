import { topoOrder, type Constraint, type Entity, type Field, type Spec } from "./schema.ts";

/**
 * Génère la migration SQL du SaaS à partir de la spec validée. AUCUNE IA ici :
 * le modèle décrit les entités, le code écrit le SQL selon les règles du gabarit (FACTORY.md) :
 * - org_id + clé (org_id, id) sur chaque table, références composites (aucun mélange entre organisations)
 * - RLS : lecture/écriture par les membres, suppression selon delete_requires_admin
 * - privilèges colonne par colonne (org_id, created_by… jamais modifiables par l'utilisateur)
 * - règles métier de la spec (unicité, champ obligatoire conditionnel, ordre des dates, minimum) en contraintes SQL
 * - chaque suppression est tracée dans audit_logs (déclencheur)
 * - migration additive uniquement (pas de DROP/ALTER destructif)
 */
export function generateMigration(spec: Spec): string {
  const lines: string[] = [
    `-- Migration générée par SaaS Factory pour « ${spec.product_name.replace(/\n/g, " ")} ».`,
    "-- Ne pas modifier : toute évolution passe par une nouvelle migration.",
    "",
    AUDIT_FUNCTION,
    "",
  ];
  for (const entity of topoOrder(spec.entities)) lines.push(tableSql(entity), "");
  return lines.join("\n");
}

/** Trace chaque suppression (sauf celles provoquées par la suppression de l'organisation entière). */
const AUDIT_FUNCTION = `create function public.app_audit_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.organizations o where o.id = old.org_id) then
    perform public._audit(old.org_id, tg_table_name || '.deleted', old.id::text, to_jsonb(old));
  end if;
  return old;
end;
$$;
revoke all on function public.app_audit_delete() from public, anon, authenticated;`;

function minCheck(f: Field): string {
  const min = f.min ?? 0;
  return ` check (${f.name} is null or ${f.name} >= ${min})`;
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
      return `${n} bigint${notNull}${f.min !== undefined ? minCheck(f) : ""}`;
    case "decimal":
      return `${n} numeric(14, 2)${notNull}${f.min !== undefined ? minCheck(f) : ""}`;
    case "money_xof":
      return `${n} bigint${notNull}${minCheck(f)}`;
    case "money_eur":
      return `${n} numeric(12, 2)${notNull}${minCheck(f)}`;
    case "boolean":
      return `${n} boolean not null default false`;
    case "date":
      return `${n} date${notNull}`;
    case "datetime":
      return `${n} timestamptz${notNull}`;
    case "enum": {
      const values = (f.values ?? []).map((v) => `'${v.value}'`).join(", ");
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
    ...e.constraints.flatMap((c, i) => checkConstraint(e, c, i)),
  ];
  const userCols = e.fields.map((f) => f.name);
  const out = [
    `-- ${e.label}`,
    `create table ${t} (\n  ${cols.join(",\n  ")}\n);`,
    `create index ${e.name}_org_created_idx on ${t} (org_id, created_at desc);`,
    ...e.fields.filter((f) => f.type === "ref").map((f) => `create index ${e.name}_${f.name}_idx on ${t} (${f.name});`),
    ...e.constraints.flatMap((c, i) => uniqueIndex(e, c, i)),
    `create trigger ${e.name}_audit_delete after delete on ${t} for each row execute function public.app_audit_delete();`,
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

/** Nom de contrainte stable : le code de l'application l'utilise pour afficher le bon message. */
export function constraintName(e: Entity, c: Constraint, i: number): string {
  return `${e.name}_${c.kind}_${i + 1}`.slice(0, 60);
}

function checkConstraint(e: Entity, c: Constraint, i: number): string[] {
  const name = constraintName(e, c, i);
  if (c.kind === "required_when") {
    const values = c.when.in.map((v) => `'${v}'`).join(", ");
    return [`constraint ${name} check (${c.when.field} is null or ${c.when.field} not in (${values}) or ${c.field} is not null)`];
  }
  if (c.kind === "date_order") return [`constraint ${name} check (${c.end} is null or ${c.start} is null or ${c.end} >= ${c.start})`];
  return [];
}

function uniqueIndex(e: Entity, c: Constraint, i: number): string[] {
  if (c.kind !== "unique") return [];
  const conds = c.fields.map((f) => `${f} is not null`);
  if (c.when) conds.push(`${c.when.field} = '${c.when.equals}'`);
  return [`create unique index ${constraintName(e, c, i)} on public.${e.name} (org_id, ${c.fields.join(", ")}) where ${conds.join(" and ")};`];
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
