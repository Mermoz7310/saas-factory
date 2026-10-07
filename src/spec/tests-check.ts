import ts from "typescript";
import { z } from "zod";
import { contractVocabulary, type UiContract } from "./contract.ts";

export const testFilesSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().regex(/^tests\/acceptance\/[a-z0-9-]+\.spec\.ts$/, "chemin attendu : tests/acceptance/<nom>.spec.ts"),
        content: z.string().min(50).max(40_000),
      }),
    )
    .min(1)
    .max(10),
});
export type TestFiles = z.infer<typeof testFilesSchema>;

/** Fichiers déjà fournis par le gabarit : les tests générés ne doivent pas les remplacer. */
const TEMPLATE_TEST_FILES = new Set(["tests/acceptance/auth-org.spec.ts", "tests/acceptance/security.spec.ts", "tests/acceptance/helpers.ts"]);

const ALLOWED_IMPORTS = new Set(["@playwright/test", "./helpers", "node:crypto"]);

const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /\b(?:test|describe|it)\s*\.\s*(?:only|skip|fixme|todo)\b/, why: "test désactivé ou isolé (.only/.skip/.fixme/.todo)" },
  { re: /\bwaitForTimeout\s*\(/, why: "attente fixe (waitForTimeout) : source de tests instables" },
  { re: /https?:\/\/(?:localhost|127\.0\.0\.1)/, why: "URL locale codée en dur (utiliser des chemins relatifs)" },
  { re: /\bprocess\.env\b/, why: "lecture de variables d'environnement dans un test d'acceptation" },
  { re: /\b(?:require|eval)\s*\(/, why: "require/eval interdits" },
  { re: /\bpage\.evaluate\s*\(/, why: "page.evaluate interdit : tester par l'interface comme un utilisateur" },
];

/** Route d'un page.goto : les parties variables deviennent « * ». undefined = non analysable (ignorée). */
function routePattern(arg: ts.Expression): string | undefined {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return arg.head.text + arg.templateSpans.map((s) => `*${s.literal.text}`).join("");
  return undefined;
}

const FIXED_ROUTES = [/^\/$/, /^\/login(?:\?.*)?$/, /^\/signup$/, /^\/app$/, /^\/app\/onboarding$/, /^\/admin$/, /^\/app\/[^/?#]+$/];

function routeAllowed(route: string, segments: Set<string>): boolean {
  const path = route.split("?")[0]!;
  if (FIXED_ROUTES.some((re) => re.test(route) || re.test(path))) return true;
  const m = /^\/app\/[^/]+\/([a-z0-9-]+)$/.exec(path);
  return !!m && segments.has(m[1]!);
}

/**
 * Contrôles déterministes des tests d'acceptation générés :
 * syntaxe TypeScript valide, imports autorisés, aucune pratique interdite,
 * conformité au contrat d'interface (routes, data-testid, libellés),
 * et chaque story Sx couverte par au moins un test dont le titre commence par « Sx — ».
 */
export function checkTestFiles(files: TestFiles["files"], storyIds: string[], contract?: UiContract): string[] {
  const problems: string[] = [];
  const titles: string[] = [];
  const vocab = contract ? contractVocabulary(contract) : undefined;

  for (const f of files) {
    if (TEMPLATE_TEST_FILES.has(f.path)) problems.push(`${f.path} : fichier du gabarit, ne pas le remplacer`);

    const out = ts.transpileModule(f.content, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    for (const d of out.diagnostics ?? []) {
      problems.push(`${f.path} : erreur de syntaxe — ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    }

    const source = ts.createSourceFile(f.path, f.content, ts.ScriptTarget.ES2022, true);
    source.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const mod = node.moduleSpecifier.text;
        if (!ALLOWED_IMPORTS.has(mod)) problems.push(`${f.path} : import interdit « ${mod} » (autorisés : ${[...ALLOWED_IMPORTS].join(", ")})`);
      }
    });
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test") {
        const first = node.arguments[0];
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) titles.push(first.text);
      }
      if (vocab && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const arg = node.arguments[0];
        const lit = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
        if (method === "getByTestId" && lit !== undefined && !vocab.testids.has(lit)) {
          problems.push(`${f.path} : data-testid « ${lit} » absent du contrat d'interface`);
        }
        if (method === "getByLabel" && lit !== undefined && !vocab.labels.has(lit)) {
          problems.push(`${f.path} : libellé « ${lit} » absent du contrat d'interface`);
        }
        if (method === "goto" && arg) {
          const route = routePattern(arg);
          if (route !== undefined && !routeAllowed(route, vocab.segments)) problems.push(`${f.path} : route « ${route} » absente du contrat d'interface`);
        }
        if (method === "selectOption" && arg && ts.isObjectLiteralExpression(arg)) {
          for (const p of arg.properties) {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "value") {
              problems.push(`${f.path} : selectOption({ value }) interdit, utiliser selectOption({ label: "…" })`);
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(source);

    for (const { re, why } of FORBIDDEN) if (re.test(f.content)) problems.push(`${f.path} : ${why}`);
  }

  const paths = files.map((f) => f.path);
  if (new Set(paths).size !== paths.length) problems.push("Deux fichiers ont le même chemin");

  for (const id of storyIds) {
    if (!titles.some((t) => t.startsWith(`${id} — `))) problems.push(`Aucun test pour ${id} (titre attendu : « ${id} — … »)`);
  }
  for (const t of titles) {
    const m = /^(S\d{1,2}) — /.exec(t);
    if (!m) problems.push(`Titre de test sans story : « ${t.slice(0, 60)} »`);
    else if (!storyIds.includes(m[1]!)) problems.push(`Test pour une story inconnue : ${m[1]}`);
  }
  return problems;
}
