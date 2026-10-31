import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.ts";
import { appJwt, GitHubApp, githubFromConfig, writePermissions, type FetchLike, type Permissions } from "../src/integrations/github.ts";
import type { Queue } from "../src/jobs.ts";
import { connectApp, setAppStatus } from "../src/maintain/apps.ts";
import { verifyApp } from "../src/maintain/github-link.ts";
import * as maintain from "../src/telegram/maintain-commands.ts";
import { freshDb } from "./setup-db.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const APP_ID = "123456";
const SHA = "a".repeat(40);
const TOKEN = "ghs_secretTokenNeverLogged0123456789";

/** Faux GitHub : vérifie la signature du JWT, n'accepte que les routes attendues et note chaque requête. */
class FakeGitHub {
  installations = new Map<string, { id: number; permissions: Permissions }>();
  /** Droits renvoyés avec le jeton (par défaut : ceux demandés). */
  tokenOverride: { permissions?: Permissions; repositories?: string[] } | null = null;
  requests: { method: string; url: string; auth: string; body: unknown }[] = [];

  private jwtOk(auth: string): boolean {
    const [h, p, sig] = auth.replace("Bearer ", "").split(".");
    if (!h || !p || !sig) return false;
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as { iss: string; exp: number; iat: number };
    return v.verify(publicKey, Buffer.from(sig, "base64url")) && payload.iss === APP_ID && payload.exp - payload.iat <= 600;
  }

  fetch: FetchLike = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const auth = init.headers.Authorization ?? "";
    this.requests.push({ method: init.method, url, auth, body });
    const json = (status: number, data: unknown) => ({ status, json: async () => data });
    const path = url.replace("https://api.github.com", "");

    let m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path);
    if (m) {
      if (!this.jwtOk(auth)) return json(401, {});
      const inst = this.installations.get(m[1]!);
      return inst ? json(200, inst) : json(404, {});
    }
    m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (m && init.method === "POST") {
      if (!this.jwtOk(auth)) return json(401, {});
      const repo = [...this.installations.entries()].find(([, i]) => i.id === Number(m![1]))?.[0];
      return json(201, {
        token: TOKEN,
        permissions: this.tokenOverride?.permissions ?? body.permissions,
        repositories: (this.tokenOverride?.repositories ?? [repo]).map((full_name) => ({ full_name })),
      });
    }
    if (auth !== `Bearer ${TOKEN}`) return json(401, {});
    m = /^\/repos\/([^/]+\/[^/]+)$/.exec(path);
    if (m) return json(200, { default_branch: "main", archived: false });
    m = /^\/repos\/([^/]+\/[^/]+)\/commits\/main$/.exec(path);
    if (m) return json(200, { sha: SHA });
    return json(404, {});
  };
}

let db: Db;
let drop: () => Promise<void>;
const noQueue: Queue = { enqueueResearch: async () => undefined, enqueueSpec: async () => undefined };

beforeAll(async () => {
  ({ db, drop } = await freshDb("github"));
});
afterAll(async () => drop());

async function lastAudit() {
  const { rows } = await db.query("select action, decision, reason, details from audit_events order by id desc limit 1");
  return rows[0];
}

describe("client GitHub App", () => {
  it("signe un JWT RS256 vérifiable, valable moins de 10 minutes", () => {
    const fake = new FakeGitHub();
    expect(fake["jwtOk"](`Bearer ${appJwt(APP_ID, new GitHubApp(APP_ID, PEM)["key"])}`)).toBe(true);
  });

  it("détecte tout droit qui n'est pas de la lecture", () => {
    expect(writePermissions({ metadata: "read", contents: "read" })).toEqual([]);
    expect(writePermissions({ metadata: "read", contents: "write", administration: "admin" })).toEqual(["administration:admin", "contents:write"]);
  });

  it("refuse une configuration invalide et reste désactivé si rien n'est configuré", () => {
    expect(() => new GitHubApp("abc", PEM)).toThrow(/GITHUB_APP_ID/);
    expect(githubFromConfig(undefined, undefined)).toBeNull();
    expect(githubFromConfig(APP_ID, Buffer.from(PEM).toString("base64"))).toBeInstanceOf(GitHubApp);
  });
});

describe("critère de sortie du Sprint 1", () => {
  it("dépôt installé en lecture seule : lisible, commit relevé, jeton limité au dépôt et en lecture, jamais journalisé", async () => {
    const fake = new FakeGitHub();
    fake.installations.set("Mermoz7310/versa-flotte", { id: 42, permissions: { metadata: "read", contents: "read", actions: "read" } });
    const gh = new GitHubApp(APP_ID, PEM, fake.fetch);
    await connectApp(db, { slug: "versa-flotte", repo: "Mermoz7310/versa-flotte" });

    const r = await verifyApp(db, gh, "versa-flotte");
    expect(r).toMatchObject({ ok: true, head: { defaultBranch: "main", commitSha: SHA } });

    const tokenReq = fake.requests.find((q) => q.url.endsWith("/access_tokens"))!;
    expect(tokenReq.body).toEqual({ repositories: ["versa-flotte"], permissions: { metadata: "read", contents: "read", actions: "read" } });

    const { rows } = await db.query("select installation_id, last_commit_sha, revoked_at from integrations");
    expect(rows).toEqual([{ installation_id: 42, last_commit_sha: SHA, revoked_at: null }]);
    expect(await lastAudit()).toMatchObject({ action: "github.verify", decision: "done" });
    const all = await db.query("select coalesce(string_agg(reason || details::text, ' '), '') as t from audit_events");
    expect(all.rows[0].t).not.toContain(TOKEN);
  });

  it("dépôt où l'App n'est pas installée : refusé et journalisé", async () => {
    const gh = new GitHubApp(APP_ID, PEM, new FakeGitHub().fetch);
    await connectApp(db, { slug: "sure-info-tv", repo: "Mermoz7310/sure-info-tv" });
    const r = await verifyApp(db, gh, "sure-info-tv");
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain("n'est pas installée");
    expect(await lastAudit()).toMatchObject({ action: "github.verify", decision: "failed" });
  });

  it("révocation : quand l'App perd l'accès, l'intégration est marquée révoquée", async () => {
    const fake = new FakeGitHub();
    fake.installations.set("Mermoz7310/versa-flotte", { id: 42, permissions: { metadata: "read", contents: "read" } });
    const gh = new GitHubApp(APP_ID, PEM, fake.fetch);
    expect((await verifyApp(db, gh, "versa-flotte")).ok).toBe(true);
    fake.installations.clear();
    const r = await verifyApp(db, gh, "versa-flotte");
    expect(!r.ok && r.reason).toContain("accès révoqué");
    const { rows } = await db.query("select revoked_at is not null as revoked from integrations");
    expect(rows).toEqual([{ revoked: true }]);
  });
});

describe("droits trop larges", () => {
  it("installation avec écriture : refusée avant toute demande de jeton", async () => {
    const fake = new FakeGitHub();
    fake.installations.set("Mermoz7310/versa-flotte", { id: 42, permissions: { metadata: "read", contents: "write" } });
    const r = await verifyApp(db, new GitHubApp(APP_ID, PEM, fake.fetch), "versa-flotte");
    expect(!r.ok && r.reason).toContain("droits trop larges");
    expect(fake.requests.some((q) => q.url.endsWith("/access_tokens"))).toBe(false);
  });

  it("jeton renvoyé avec plus de droits ou plus de dépôts que demandé : refusé", async () => {
    const fake = new FakeGitHub();
    fake.installations.set("Mermoz7310/versa-flotte", { id: 42, permissions: { metadata: "read", contents: "read" } });
    const gh = new GitHubApp(APP_ID, PEM, fake.fetch);
    fake.tokenOverride = { permissions: { contents: "write" } };
    expect((await verifyApp(db, gh, "versa-flotte")).ok).toBe(false);
    fake.tokenOverride = { repositories: ["Mermoz7310/versa-flotte", "Mermoz7310/autre"] };
    const r = await verifyApp(db, gh, "versa-flotte");
    expect(!r.ok && r.reason).toContain("ne se limite pas à ce dépôt");
  });

  it("App sans droit de lecture du contenu : refusée clairement", async () => {
    const fake = new FakeGitHub();
    fake.installations.set("Mermoz7310/versa-flotte", { id: 42, permissions: { metadata: "read" } });
    const r = await verifyApp(db, new GitHubApp(APP_ID, PEM, fake.fetch), "versa-flotte");
    expect(!r.ok && r.reason).toContain("Contents");
  });
});

describe("règles et Telegram", () => {
  it("une app en pause n'est même pas contactée", async () => {
    const fake = new FakeGitHub();
    await setAppStatus(db, "sure-info-tv", "paused");
    const r = await verifyApp(db, new GitHubApp(APP_ID, PEM, fake.fetch), "sure-info-tv");
    expect(r.ok).toBe(false);
    expect(fake.requests).toHaveLength(0);
    await setAppStatus(db, "sure-info-tv", "active");
  });

  it("/verifier et /connecter : messages clairs avec ou sans GitHub App configurée", async () => {
    expect((await maintain.cmdVerifier({ db, queue: noQueue }, "versa-flotte")).text).toContain("pas encore configurée");
    const fake = new FakeGitHub();
    fake.installations.set("Mermoz7310/versa-flotte", { id: 42, permissions: { metadata: "read", contents: "read" } });
    fake.installations.set("Mermoz7310/agroflow", { id: 43, permissions: { metadata: "read", contents: "read" } });
    const github = new GitHubApp(APP_ID, PEM, fake.fetch);
    expect((await maintain.cmdVerifier({ db, queue: noQueue, github }, "versa-flotte")).text).toContain("main @ aaaaaaa");
    const c = await maintain.cmdConnecter({ db, queue: noQueue, github }, "agroflow Mermoz7310/agroflow");
    expect(c.text).toContain("connecté");
    expect(c.text).toContain("lecture seule");
  });
});
