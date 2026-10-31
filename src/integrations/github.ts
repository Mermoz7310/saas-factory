import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

/**
 * Client minimal de la GitHub App de l'usine (API REST, sans dépendance).
 * Règle de sécurité : on ne demande JAMAIS qu'un jeton limité à UN dépôt et en LECTURE seule.
 * Les jetons ne sont ni stockés, ni journalisés.
 */

const API = "https://api.github.com";

/** Droits que l'usine sait utiliser en lecture. Tout autre droit est ignoré ; tout droit en écriture fait refuser l'installation. */
export const READ_PERMISSIONS = ["metadata", "contents", "actions", "checks", "statuses"] as const;

export type Permissions = Record<string, string>;
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Jeton JWT de l'App (RS256), valable 9 minutes, daté 60 s dans le passé pour absorber un décalage d'horloge. */
export function appJwt(appId: string, key: KeyObject, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(key))}`;
}

/** Droits en écriture ou administration accordés par une installation (doit être vide). */
export function writePermissions(perms: Permissions): string[] {
  return Object.entries(perms)
    .filter(([, level]) => level !== "read")
    .map(([name, level]) => `${name}:${level}`)
    .sort();
}

export type Installation = { id: number; permissions: Permissions };
export type RepoHead = { defaultBranch: string; commitSha: string; archived: boolean };

export class GitHubApp {
  private readonly key: KeyObject;

  constructor(
    private readonly appId: string,
    privateKeyPem: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    if (!/^\d+$/.test(appId)) throw new Error("GITHUB_APP_ID invalide (nombre attendu).");
    this.key = createPrivateKey(privateKeyPem);
  }

  private async request(path: string, auth: string, method = "GET", body?: unknown): Promise<{ status: number; data: unknown }> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${auth}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "saas-factory",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data };
  }

  /** Installation de l'App sur ce dépôt, ou null si l'App n'y a pas (ou plus) accès. */
  async findInstallation(repo: string): Promise<Installation | null> {
    const { status, data } = await this.request(`/repos/${repo}/installation`, appJwt(this.appId, this.key));
    if (status === 404) return null;
    if (status !== 200) throw new GitHubError(`GitHub a répondu ${status} pour l'installation de ${repo}`, status);
    const d = data as { id?: unknown; permissions?: unknown };
    if (typeof d?.id !== "number" || typeof d.permissions !== "object" || d.permissions === null) throw new GitHubError("Réponse GitHub inattendue (installation)", status);
    return { id: d.id, permissions: d.permissions as Permissions };
  }

  /** Jeton limité à CE dépôt, en lecture seule (1 h). Refuse si GitHub accorde plus que demandé. */
  async readToken(installation: Installation, repo: string): Promise<string> {
    const name = repo.split("/")[1]!;
    const permissions = Object.fromEntries(READ_PERMISSIONS.filter((p) => installation.permissions[p]).map((p) => [p, "read"]));
    if (!permissions.contents) throw new GitHubError("L'App n'a pas le droit de lire le contenu du dépôt (Contents: Read-only).", 403);
    const { status, data } = await this.request(`/app/installations/${installation.id}/access_tokens`, appJwt(this.appId, this.key), "POST", {
      repositories: [name],
      permissions,
    });
    if (status !== 201) throw new GitHubError(`GitHub a refusé le jeton de lecture (${status}).`, status);
    const d = data as { token?: unknown; permissions?: unknown; repositories?: { full_name?: string }[] };
    if (typeof d?.token !== "string") throw new GitHubError("Réponse GitHub inattendue (jeton)", status);
    const granted = writePermissions((d.permissions ?? {}) as Permissions);
    if (granted.length) throw new GitHubError(`Jeton refusé : droits en écriture accordés (${granted.join(", ")}).`, 403);
    const repos = (d.repositories ?? []).map((r) => r.full_name?.toLowerCase());
    if (repos.length !== 1 || repos[0] !== repo.toLowerCase()) throw new GitHubError("Jeton refusé : il ne se limite pas à ce dépôt.", 403);
    return d.token;
  }

  /** Branche par défaut et dernier commit, lus avec un jeton de lecture. */
  async repoHead(token: string, repo: string): Promise<RepoHead> {
    const r = await this.request(`/repos/${repo}`, token);
    if (r.status !== 200) throw new GitHubError(`Dépôt ${repo} illisible (${r.status}).`, r.status);
    const info = r.data as { default_branch?: unknown; archived?: unknown };
    if (typeof info?.default_branch !== "string") throw new GitHubError("Réponse GitHub inattendue (dépôt)", r.status);
    const c = await this.request(`/repos/${repo}/commits/${encodeURIComponent(info.default_branch)}`, token);
    if (c.status !== 200) throw new GitHubError(`Dernier commit de ${repo} illisible (${c.status}).`, c.status);
    const sha = (c.data as { sha?: unknown })?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) throw new GitHubError("Réponse GitHub inattendue (commit)", c.status);
    return { defaultBranch: info.default_branch, commitSha: sha, archived: info.archived === true };
  }
}

/** Construit le client à partir de la configuration, ou null si la GitHub App n'est pas encore configurée. */
export function githubFromConfig(appId: string | undefined, privateKeyB64: string | undefined): GitHubApp | null {
  if (!appId || !privateKeyB64) return null;
  return new GitHubApp(appId, Buffer.from(privateKeyB64, "base64").toString("utf8"));
}
