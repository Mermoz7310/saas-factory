import type { Spec } from "../../src/spec/schema.ts";

/** Spec réaliste et valide (atelier de couture) utilisée par plusieurs tests. */
export function validSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    product_name: "TailorOS",
    summary: "Gestion des clients, des mesures et des commandes pour les ateliers de couture de Dakar.",
    golden_path: "afrique",
    variants: [
      { name: "Carnet de mesures", description: "Uniquement clients et mesures.", chosen: false },
      { name: "Atelier complet", description: "Clients, mesures, commandes et acomptes.", chosen: true },
      { name: "Marketplace tailleurs", description: "Mise en relation clients et tailleurs.", chosen: false },
    ],
    variant_rationale: "Les commandes et acomptes sont la douleur principale citée dans le dossier.",
    pricing: { amount: 5000, currency: "XOF", period: "mois", rationale: "Sous le prix des concurrents." },
    roles_mapping: "Le gérant est owner, les employés sont member.",
    entities: [
      {
        name: "customers",
        label: "Clients",
        module: "clients",
        title_field: "full_name",
        delete_requires_admin: true,
        fields: [
          { name: "full_name", label: "Nom", type: "text", required: true },
          { name: "phone", label: "Téléphone", type: "text", required: false },
        ],
        constraints: [{ kind: "unique", fields: ["phone"], message: "Ce numéro est déjà enregistré." }],
      },
      {
        name: "orders",
        label: "Commandes",
        module: "commandes",
        title_field: "description",
        delete_requires_admin: true,
        fields: [
          { name: "customer_id", label: "Client", type: "ref", required: true, ref: "customers" },
          { name: "description", label: "Description", type: "text", required: true },
          { name: "total", label: "Prix total (FCFA)", type: "money_xof", required: true, min: 1 },
          { name: "ordered_on", label: "Date de commande", type: "date", required: true },
          { name: "due_on", label: "Livraison prévue", type: "date", required: true },
          {
            name: "status",
            label: "Statut",
            type: "enum",
            required: true,
            values: [
              { value: "received", label: "Reçue" },
              { value: "in_progress", label: "En cours" },
              { value: "ready", label: "Prête" },
              { value: "delivered", label: "Livrée" },
            ],
          },
          { name: "deposit_method", label: "Mode d'acompte", type: "enum", required: false, values: [{ value: "cash", label: "Espèces" }, { value: "wave", label: "Wave" }] },
          { name: "deposit_ref", label: "Référence Wave", type: "text", required: false },
          { name: "urgent", label: "Urgent", type: "boolean", required: false },
        ],
        constraints: [
          { kind: "date_order", start: "ordered_on", end: "due_on", message: "La livraison ne peut pas précéder la commande." },
          { kind: "required_when", field: "deposit_ref", when: { field: "deposit_method", in: ["wave"] }, message: "La référence Wave est obligatoire." },
          { kind: "unique", fields: ["customer_id"], when: { field: "status", equals: "in_progress" }, message: "Ce client a déjà une commande en cours." },
        ],
      },
    ],
    views: [
      { name: "À livrer", route_segment: "a-livrer", description: "Commandes non livrées dont la livraison prévue est aujourd'hui ou avant (bornes incluses), triées par date.", testids: ["due-list", "due-count"], labels: [] },
    ],
    stories: [
      {
        id: "S1",
        as: "gérant",
        want: "créer un client avec son nom et son téléphone",
        so_that: "le retrouver facilement",
        entities: ["customers"],
        acceptance: [{ given: "un atelier vide", when: "j'ajoute Aminata Sow", then: "elle apparaît dans la liste des clients" }],
      },
      {
        id: "S2",
        as: "gérant",
        want: "créer une commande pour un client avec un prix et une date",
        so_that: "suivre le travail promis",
        entities: ["customers", "orders"],
        acceptance: [{ given: "un client existant", when: "je crée une commande de 25 000 FCFA", then: "elle apparaît dans ses commandes" }],
      },
    ],
    business_rules: ["Le prix d'une commande est un nombre entier de FCFA positif ou nul."],
    out_of_scope: ["Rappels WhatsApp"],
    prospecting: "Démarcher 20 ateliers du marché HLM avec une démonstration sur téléphone.",
    ...overrides,
  };
}

export const VALID_TEST_FILE = `import { expect, test, type Page } from "@playwright/test";
import { createOrg, newEmail, signUp } from "./helpers";

async function newWorkspace(page: Page): Promise<string> {
  await signUp(page, newEmail("e2e"), "Testeur");
  await createOrg(page, "Atelier Test");
  return new URL(page.url()).pathname.split("/")[2]!;
}

test("S1 — Étant donné un atelier, quand j'ajoute un client, alors il apparaît", async ({ page }) => {
  const slug = await newWorkspace(page);
  await page.goto(\`/app/\${slug}/clients\`);
  await page.getByTestId("customers-form").getByLabel("Nom").fill("Aminata Sow");
  await page.getByRole("button", { name: "Ajouter" }).click();
  await expect(page.getByTestId("customers-list")).toContainText("Aminata Sow");
});

test("S2 — Étant donné un client, quand je crée une commande, alors elle apparaît", async ({ page }) => {
  const slug = await newWorkspace(page);
  await page.goto(\`/app/\${slug}/commandes\`);
  await expect(page.getByTestId("orders-empty")).toBeVisible();
  await page.getByTestId("orders-form").getByLabel("Statut").selectOption({ label: "Reçue" });
  await page.goto(\`/app/\${slug}/a-livrer\`);
  await expect(page.getByTestId("due-count")).toHaveText("0");
});
`;

const HEADER = `import { expect, test, type Page } from "@playwright/test";
import { createOrg, newEmail, signUp } from "./helpers";

async function newWorkspace(page: Page): Promise<string> {
  await signUp(page, newEmail("e2e"), "Testeur");
  await createOrg(page, "Atelier Test");
  return new URL(page.url()).pathname.split("/")[2]!;
}
`;

/** Fichier du module customers (S1) et du module orders (S2), tels qu'un agent QA les renverrait. */
export const CUSTOMERS_TEST = VALID_TEST_FILE.slice(0, VALID_TEST_FILE.indexOf('test("S2'));
export const ORDERS_TEST = HEADER + "\n" + VALID_TEST_FILE.slice(VALID_TEST_FILE.indexOf('test("S2'));
export const asTsBlock = (code: string) => "Voici le fichier :\n```ts\n" + code + "\n```";
