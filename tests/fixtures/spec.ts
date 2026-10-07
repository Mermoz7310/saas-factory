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
        module: "customers",
        delete_requires_admin: true,
        fields: [
          { name: "full_name", label: "Nom", type: "text", required: true },
          { name: "phone", label: "Téléphone", type: "text", required: false },
        ],
      },
      {
        name: "orders",
        label: "Commandes",
        module: "orders",
        delete_requires_admin: true,
        fields: [
          { name: "customer_id", label: "Client", type: "ref", required: true, ref: "customers" },
          { name: "description", label: "Description", type: "text", required: true },
          { name: "total", label: "Prix total (FCFA)", type: "money_xof", required: true },
          { name: "due_on", label: "Livraison prévue", type: "date", required: true },
          { name: "status", label: "Statut", type: "enum", required: true, values: ["received", "in_progress", "ready", "delivered"] },
          { name: "urgent", label: "Urgent", type: "boolean", required: false },
        ],
      },
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
  await page.goto(\`/app/\${slug}/customers\`);
  await page.getByTestId("customers-form").getByLabel("Nom").fill("Aminata Sow");
  await page.getByRole("button", { name: "Ajouter" }).click();
  await expect(page.getByTestId("customers-list")).toContainText("Aminata Sow");
});

test("S2 — Étant donné un client, quand je crée une commande, alors elle apparaît", async ({ page }) => {
  const slug = await newWorkspace(page);
  await page.goto(\`/app/\${slug}/orders\`);
  await expect(page.getByTestId("orders-empty")).toBeVisible();
});
`;
