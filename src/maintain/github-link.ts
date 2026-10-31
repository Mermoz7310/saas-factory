import { audit } from "../audit.ts";
import type { Db } from "../db/pool.ts";
import { GitHubError, writePermissions, type GitHubApp, type RepoHead } from "../integrations/github.ts";
import { authorize } from "./policy.ts";

export type VerifyResult =
  | { ok: true; slug: string; repo: string; head: RepoHead }
  | { ok: false; slug: string; reason: string };

async function revoke(db: Db, appId: string): Promise<boolean> {
  const res = await db.query("update integrations set revoked_at = now() where app_id = $1 and provider = 'github' and revoked_at is null", [appId]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Vérifie qu'une app est lisible par la GitHub App de l'usine, en lecture seule, et relève son dernier commit.
 * - App non installée sur le dépôt → refus (et révocation si elle l'était).
 * - Installation avec le moindre droit en écriture → refus : l'usine n'accepte que la lecture en phase 1.
 * Chaque issue est inscrite au journal ; aucun jeton n'y figure.
 */
export async function verifyApp(db: Db, gh: GitHubApp, slug: string): Promise<VerifyResult> {
  const decision = await authorize(db, { app: slug, action: "repo.read", actor: "factory" });
  if (decision.effect !== "allow" || !decision.app) return { ok: false, slug, reason: decision.reason };
  const app = decision.app;
  const repo = app.repo_full_name;

  const fail = async (reason: string, details: Record<string, unknown> = {}): Promise<VerifyResult> => {
    await audit(db, { actor: "factory", action: "github.verify", appId: app.id, decision: "failed", reason, details: { repo, ...details } });
    return { ok: false, slug: app.slug, reason };
  };

  try {
    const installation = await gh.findInstallation(repo);
    if (!installation) {
      const revoked = await revoke(db, app.id);
      return fail(
        revoked
          ? `accès révoqué : la GitHub App de l'usine n'a plus accès à ${repo}`
          : `la GitHub App de l'usine n'est pas installée sur ${repo}`,
        { revoked },
      );
    }
    const tooMuch = writePermissions(installation.permissions);
    if (tooMuch.length) {
      await revoke(db, app.id);
      return fail(`droits trop larges sur ${repo} (${tooMuch.join(", ")}) : l'usine n'accepte que la lecture`, { permissions: installation.permissions });
    }

    const token = await gh.readToken(installation, repo);
    const head = await gh.repoHead(token, repo);

    await db.query(
      `insert into integrations (app_id, provider, installation_id, permissions, default_branch, last_commit_sha, verified_at, revoked_at)
       values ($1, 'github', $2, $3, $4, $5, now(), null)
       on conflict (app_id, provider) do update set installation_id = excluded.installation_id, permissions = excluded.permissions,
         default_branch = excluded.default_branch, last_commit_sha = excluded.last_commit_sha, verified_at = now(), revoked_at = null`,
      [app.id, installation.id, JSON.stringify(installation.permissions), head.defaultBranch, head.commitSha],
    );
    await audit(db, {
      actor: "factory",
      action: "github.verify",
      appId: app.id,
      decision: "done",
      reason: `${repo} lisible en lecture seule — ${head.defaultBranch} @ ${head.commitSha.slice(0, 7)}`,
      details: { repo, installationId: installation.id, branch: head.defaultBranch, commit: head.commitSha, permissions: installation.permissions },
    });
    return { ok: true, slug: app.slug, repo, head };
  } catch (error) {
    if (error instanceof GitHubError) return fail(error.message, { status: error.status });
    throw error;
  }
}
