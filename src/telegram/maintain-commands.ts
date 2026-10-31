import { recentAudit, type AuditRow } from "../audit.ts";
import { connectApp, getApp, LEVEL_LABEL, listApps, MAX_AVAILABLE_LEVEL, setAutonomy } from "../maintain/apps.ts";
import { verifyApp } from "../maintain/github-link.ts";
import { authorize } from "../maintain/policy.ts";
import type { CommandDeps, Reply } from "./commands.ts";

export const MAINTAIN_HELP = [
  "",
  "🔧 Mode Entretenir (tes SaaS existants)",
  "/apps — SaaS connectés et leur niveau d'autonomie",
  "/connecter <nom> <proprietaire/depot> — connecter un SaaS (niveau 0, lecture seule)",
  `/autonomie <nom> <0-${MAX_AVAILABLE_LEVEL}> — changer le niveau d'autonomie`,
  "/verifier <nom> — vérifier l'accès GitHub en lecture seule et relever le dernier commit",
  "/analyser <nom> — demander une analyse (contrôlée par les règles)",
  "/journal [nom] — dernières décisions du journal d'audit",
].join("\n");

/** Coût maximal réservé pour une analyse de dépôt (Sonnet, ~300 000 jetons lus) : sert au contrôle du plafond par mission. */
export const ANALYSIS_ESTIMATE_USD = 1;

const errorText = (e: unknown) => `⚠️ ${e instanceof Error ? e.message : String(e)}`;

export async function cmdApps(deps: CommandDeps): Promise<Reply> {
  const apps = await listApps(deps.db);
  if (apps.length === 0) return { text: "Aucun SaaS connecté.\nEx. : /connecter versa-flotte Mermoz7310/versa-flotte" };
  return {
    text: apps
      .map((a) => `• ${a.slug}${a.status === "paused" ? " ⏸️" : ""}\n   ${a.repo_full_name}\n   Niveau ${LEVEL_LABEL[a.autonomy_level]}`)
      .join("\n"),
  };
}

export async function cmdConnecter(deps: CommandDeps, args: string): Promise<Reply> {
  const m = /^\s*(\S+)\s+(\S+)\s*$/.exec(args);
  if (!m) return { text: "Usage : /connecter <nom> <proprietaire/depot>\nEx. : /connecter versa-flotte Mermoz7310/versa-flotte" };
  try {
    const app = await connectApp(deps.db, { slug: m[1]!, repo: m[2]! });
    const base = `✅ ${app.slug} connecté (${app.repo_full_name}).\nNiveau ${LEVEL_LABEL[0]} : l'usine peut seulement lire.`;
    if (!deps.github) return { text: `${base}\nGitHub App pas encore configurée : l'accès au dépôt sera vérifié ensuite (/verifier ${app.slug}).` };
    return { text: `${base}\n${verifyText(await verifyApp(deps.db, deps.github, app.slug))}` };
  } catch (error) {
    return { text: errorText(error) };
  }
}

function verifyText(r: Awaited<ReturnType<typeof verifyApp>>): string {
  if (r.ok) return `🔎 Dépôt lisible en lecture seule : ${r.head.defaultBranch} @ ${r.head.commitSha.slice(0, 7)}${r.head.archived ? " (archivé)" : ""}.`;
  return `⛔ Accès GitHub refusé : ${r.reason}.`;
}

export async function cmdVerifier(deps: CommandDeps, slug: string): Promise<Reply> {
  const name = slug.trim();
  if (!name) return { text: "Usage : /verifier <nom>\nTape /apps pour voir les noms." };
  if (!deps.github) return { text: "GitHub App pas encore configurée sur le serveur (voir deploy/INSTALL.md, section GitHub App)." };
  try {
    return { text: verifyText(await verifyApp(deps.db, deps.github, name)) };
  } catch (error) {
    return { text: errorText(error) };
  }
}

export async function cmdAutonomie(deps: CommandDeps, args: string): Promise<Reply> {
  const m = /^\s*(\S+)\s+(\d)\s*$/.exec(args);
  if (!m) return { text: `Usage : /autonomie <nom> <0-${MAX_AVAILABLE_LEVEL}>\nEx. : /autonomie versa-flotte 1` };
  try {
    const app = await setAutonomy(deps.db, m[1]!, Number(m[2]));
    return { text: `✅ ${app.slug} : niveau ${LEVEL_LABEL[app.autonomy_level]}.` };
  } catch (error) {
    return { text: errorText(error) };
  }
}

export async function cmdAnalyser(deps: CommandDeps, slug: string): Promise<Reply> {
  const name = slug.trim();
  if (!name) return { text: "Usage : /analyser <nom>\nTape /apps pour voir les noms." };
  const decision = await authorize(deps.db, { app: name, action: "analysis.run", actor: "owner", estimatedCostUsd: ANALYSIS_ESTIMATE_USD });
  if (decision.effect === "deny") return { text: `⛔ Refusé : ${decision.reason}.\n(Inscrit au journal : /journal)` };
  if (decision.effect === "approve") return { text: `✋ ${decision.reason}.` };
  return { text: `✅ Autorisé pour ${decision.app?.slug}.\nL'analyse elle-même arrive au Sprint 2 : rien n'a été lancé ni facturé.` };
}

const DECISION_ICON: Record<NonNullable<AuditRow["decision"]>, string> = {
  allowed: "✅",
  approval_required: "✋",
  denied: "⛔",
  done: "📝",
  failed: "❌",
};

function fmtDate(d: Date): string {
  return d.toLocaleString("fr-BE", { timeZone: "Europe/Brussels", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export async function cmdJournal(deps: CommandDeps, slug: string): Promise<Reply> {
  let appId: string | undefined;
  if (slug.trim()) {
    const app = await getApp(deps.db, slug);
    if (!app) return { text: "App introuvable. Tape /apps pour voir les noms." };
    appId = app.id;
  }
  const rows = await recentAudit(deps.db, 15, appId);
  if (rows.length === 0) return { text: "Journal vide." };
  return {
    text: [
      "🧾 Journal d'audit (plus récent en premier)",
      ...rows.map((r) => `${r.decision ? DECISION_ICON[r.decision] : "•"} ${fmtDate(r.created_at)} ${r.action}${r.app_slug ? ` [${r.app_slug}]` : ""}${r.reason ? `\n   ${r.reason.slice(0, 160)}` : ""}`),
    ].join("\n"),
  };
}
