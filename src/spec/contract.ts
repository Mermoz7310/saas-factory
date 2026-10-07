import { constraintName } from "./sql.ts";
import { RESERVED_SEGMENTS, type Entity, type Field, type Spec } from "./schema.ts";

/**
 * Contrat d'interface : la SEULE source des routes, identifiants de test et libellés.
 * Calculé par le code (aucune IA), il est donné à chaque appel qui écrit des tests,
 * puis à l'agent qui code l'application. Tests et code parlent donc exactement la même langue.
 */

/** Éléments fournis par le gabarit, utilisables dans les tests. */
export const TEMPLATE_TESTIDS = ["org-name", "invite-form", "members-list", "pending-invitations", "user-email", "billing-disabled"];
export const TEMPLATE_LABELS = ["Nom complet", "E-mail", "Mot de passe", "Nom de l'organisation", "Rôle"];
export const TEMPLATE_SEGMENTS = ["members", "settings", "billing", "audit"];
export { RESERVED_SEGMENTS };

export const BUTTONS = { add: "Ajouter", edit: "Modifier", save: "Enregistrer", remove: "Supprimer" } as const;

export type ContractField = {
  name: string;
  label: string;
  input: "texte" | "zone de texte" | "nombre entier" | "nombre décimal" | "montant FCFA (entier)" | "montant EUR" | "case à cocher" | "date" | "date et heure" | "liste" | "liste (référence)";
  required: boolean;
  options?: { value: string; label: string }[];
  ref?: { table: string; shows: string };
  min?: number;
};

export type ContractEntity = {
  table: string;
  label: string;
  route: string;
  testids: { form: string; list: string; row: string; empty: string; edit_form: string };
  title_field: string;
  delete: "admin" | "membre";
  fields: ContractField[];
  errors: { constraint: string; message: string }[];
};

export type ContractView = { name: string; route: string; description: string; testids: string[]; labels: string[] };

export type UiContract = {
  conventions: string[];
  entities: ContractEntity[];
  views: ContractView[];
};

const INPUT: Record<Field["type"], ContractField["input"]> = {
  text: "texte",
  long_text: "zone de texte",
  integer: "nombre entier",
  decimal: "nombre décimal",
  money_xof: "montant FCFA (entier)",
  money_eur: "montant EUR",
  boolean: "case à cocher",
  date: "date",
  datetime: "date et heure",
  enum: "liste",
  ref: "liste (référence)",
};

export const CONVENTIONS = [
  "Toutes les pages métier sont sous /app/<slug> (slug de l'organisation). Écrire les routes des tests avec le slug en variable : page.goto(`/app/${slug}/vehicules`).",
  `Chaque entité a, sur sa page, un formulaire data-testid="<table>-form" : un champ par ligne de « fields », dans cet ordre, avec un <label> au texte EXACT du libellé (getByLabel). Bouton d'envoi : « ${BUTTONS.add} ».`,
  "Liste (« liste ») : <select>. Chaque option affiche le libellé et a pour valeur la valeur technique. Dans les tests : selectOption({ label: \"<libellé de l'option>\" }).",
  "Référence (« liste (référence) ») : <select> dont chaque option affiche le champ « shows » de la ligne cible. Dans les tests : selectOption({ label: \"<texte de la ligne cible>\" }).",
  "Date : <input type=\"date\">, remplie au format AAAA-MM-JJ. Montants et nombres : <input type=\"number\">, remplis avec des chiffres seuls (\"15000\"). Case à cocher : check().",
  "Après « Ajouter », la nouvelle ligne apparaît dans data-testid=\"<table>-list\" ; chaque ligne est un élément data-testid=\"<table>-row\" qui contient le texte du champ titre (title_field) et les valeurs affichées.",
  "Liste vide : un élément data-testid=\"<table>-empty\" remplace la liste.",
  `Chaque ligne a un bouton « ${BUTTONS.edit} » qui affiche dans la ligne un formulaire data-testid="<table>-edit-form" (mêmes libellés, pré-rempli) avec le bouton « ${BUTTONS.save} », et un bouton « ${BUTTONS.remove} » visible seulement pour les rôles autorisés (« delete »). La suppression est immédiate (pas de boîte de confirmation).`,
  "Affichage des valeurs dans les listes et écrans : montant FCFA = chiffres groupés par 3 avec une ESPACE ORDINAIRE + \" FCFA\" (ex. « 15 000 FCFA ») ; montant EUR = « 12,50 € » ; date = JJ/MM/AAAA ; liste = libellé de l'option (jamais la valeur technique) ; case à cocher = « Oui »/« Non ».",
  "Erreur métier (contrainte de la base refusée) : la page affiche le « message » correspondant dans un élément role=\"alert\" et n'ajoute aucune ligne. Dans les tests : expect(page.getByRole(\"alert\")).toContainText(\"<message>\").",
  "Champ obligatoire vide : le navigateur bloque l'envoi (attribut required) ; ne pas tester le texte du message du navigateur.",
  "Écrans calculés (« views ») : route et identifiants de test donnés ci-dessous ; leurs champs de filtre ont les libellés « labels ».",
  "Les tests n'utilisent QUE les routes, data-testid et libellés de ce contrat, plus ceux du gabarit (helpers.ts : signUp, logIn, createOrg, newEmail, DEMO).",
];

function contractField(f: Field, byName: Map<string, Entity>): ContractField {
  const out: ContractField = { name: f.name, label: f.label, input: INPUT[f.type], required: f.required };
  if (f.values) out.options = f.values.map((v) => ({ value: v.value, label: v.label }));
  if (f.type === "ref" && f.ref) {
    const target = byName.get(f.ref);
    out.ref = { table: f.ref, shows: target ? `${target.title_field} (« ${target.fields.find((x) => x.name === target.title_field)?.label ?? target.title_field} »)` : "?" };
  }
  if (f.min !== undefined) out.min = f.min;
  return out;
}

export function buildUiContract(spec: Spec): UiContract {
  const byName = new Map(spec.entities.map((e) => [e.name, e]));
  return {
    conventions: CONVENTIONS,
    entities: spec.entities.map((e) => ({
      table: e.name,
      label: e.label,
      route: `/app/<slug>/${e.module}`,
      testids: { form: `${e.name}-form`, list: `${e.name}-list`, row: `${e.name}-row`, empty: `${e.name}-empty`, edit_form: `${e.name}-edit-form` },
      title_field: e.title_field,
      delete: e.delete_requires_admin ? "admin" : "membre",
      fields: e.fields.map((f) => contractField(f, byName)),
      errors: e.constraints.map((c, i) => ({ constraint: constraintName(e, c, i), message: c.message })),
    })),
    views: spec.views.map((v) => ({
      name: v.name,
      route: v.route_segment ? `/app/<slug>/${v.route_segment}` : "/app/<slug>",
      description: v.description,
      testids: v.testids,
      labels: v.labels,
    })),
  };
}

/** Ensembles autorisés pour la vérification statique des tests. */
export function contractVocabulary(c: UiContract) {
  const testids = new Set(TEMPLATE_TESTIDS);
  const labels = new Set(TEMPLATE_LABELS);
  const optionLabels = new Set<string>();
  const segments = new Set(TEMPLATE_SEGMENTS);
  for (const e of c.entities) {
    Object.values(e.testids).forEach((t) => testids.add(t));
    e.fields.forEach((f) => {
      labels.add(f.label);
      f.options?.forEach((o) => optionLabels.add(o.label));
    });
    segments.add(e.route.split("/").pop()!);
  }
  for (const v of c.views) {
    v.testids.forEach((t) => testids.add(t));
    v.labels.forEach((l) => labels.add(l));
    if (v.route !== "/app/<slug>") segments.add(v.route.split("/").pop()!);
  }
  return { testids, labels, optionLabels, segments };
}

/** Rendu Markdown lisible du contrat (envoyé au propriétaire et aux agents). */
export function renderContract(c: UiContract): string {
  const out: string[] = ["## Contrat d'interface", "", ...c.conventions.map((x) => `- ${x}`), ""];
  for (const e of c.entities) {
    out.push(`### ${e.label} — ${e.route}`, `testids : ${Object.values(e.testids).join(", ")} · titre : ${e.title_field} · suppression : ${e.delete}`, "");
    for (const f of e.fields) {
      const extra = [
        f.required ? "obligatoire" : "facultatif",
        f.options ? `options : ${f.options.map((o) => `${o.label} (${o.value})`).join(", ")}` : "",
        f.ref ? `→ ${f.ref.table}, affiche ${f.ref.shows}` : "",
        f.min !== undefined ? `minimum ${f.min}` : "",
      ].filter(Boolean);
      out.push(`- « ${f.label} » (${f.name}) : ${f.input} — ${extra.join(" · ")}`);
    }
    for (const err of e.errors) out.push(`- Erreur ${err.constraint} → « ${err.message} »`);
    out.push("");
  }
  for (const v of c.views) {
    out.push(`### Écran « ${v.name} » — ${v.route}`, v.description, `testids : ${v.testids.join(", ")}${v.labels.length ? ` · filtres : ${v.labels.join(", ")}` : ""}`, "");
  }
  return out.join("\n");
}
