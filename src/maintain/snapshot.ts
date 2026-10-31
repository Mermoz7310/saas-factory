import { gunzipSync } from "node:zlib";
import { isEnvFile, maskSecrets, type SecretHit } from "./secrets.ts";

/**
 * Instantané d'un dépôt pour l'analyse : on lit l'archive du commit, on ne l'exécute jamais.
 * Seuls des fichiers texte utiles sont gardés, dans un budget de caractères ; les secrets sont masqués.
 */

export const MAX_ARCHIVE_BYTES = 40 * 1024 * 1024;
const MAX_FILE_BYTES = 200 * 1024;

export type TarEntry = { path: string; content: Buffer };

/** Lecteur tar minimal (ustar + en-têtes pax/GNU pour les noms longs). Ne garde que les fichiers ordinaires. */
export function readTar(gz: Buffer): TarEntry[] {
  if (gz.length > MAX_ARCHIVE_BYTES) throw new Error(`Archive trop volumineuse (${Math.round(gz.length / 1048576)} Mo).`);
  const tar = gunzipSync(gz, { maxOutputLength: MAX_ARCHIVE_BYTES * 6 });
  const out: TarEntry[] = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const str = (s: number, l: number) => header.subarray(s, s + l).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 12).trim() || "0", 8);
    const type = str(156, 1) || "0";
    const prefix = str(345, 155);
    const name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /\d+ path=([^\n]+)\n/.exec(body.toString("utf8"));
      longName = m?.[1] ?? null;
      continue;
    }
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    longName = null;
    if (type === "0" || type === "\0") out.push({ path: name, content: Buffer.from(body) });
  }
  return out;
}

const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.nuxt|coverage|vendor|\.dart_tool|\.gradle|Pods|\.venv|__pycache__|\.turbo|\.vercel|android\/app\/build|ios\/Pods)\//;
const SKIP_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|pubspec\.lock|composer\.lock|Podfile\.lock|.*\.min\.(js|css)|.*\.map)$/;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tar|mp3|mp4|mov|woff2?|ttf|otf|eot|jar|keystore|jks|apk|aab|ipa|so|dylib|dll|exe|bin|db|sqlite)$/i;

/** Plus le score est petit, plus le fichier passe tôt : configuration et schéma d'abord, puis le code, puis le reste. */
function priority(path: string): number {
  const name = path.split("/").pop()!.toLowerCase();
  if (/^(package\.json|pubspec\.yaml|readme(\.md)?|claude\.md|agents\.md|tsconfig\.json|next\.config\.\w+|vercel\.json|docker-compose\.ya?ml|dockerfile|\.env\.example)$/.test(name)) return 0;
  if (/(^|\/)(supabase\/migrations|migrations|prisma)\//.test(path) || name.endsWith(".sql")) return 1;
  if (/(^|\/)(middleware|auth|api|server|actions?|route)/.test(path)) return 2;
  if (/\.(ts|tsx|js|jsx|mjs|dart|py|go|rb|php)$/.test(name) && !/(\.test|\.spec)\./.test(name)) return 3;
  if (/(\.test|\.spec)\./.test(name) || /(^|\/)tests?\//.test(path)) return 4;
  if (/\.(json|ya?ml|toml|md|css|scss|html|sh|prisma|graphql)$/.test(name)) return 5;
  return 6;
}

export type SnapshotFile = { path: string; text: string; truncated: boolean };
export type Snapshot = {
  files: SnapshotFile[];
  /** Tous les chemins du dépôt (y compris ceux non inclus), pour la vue d'ensemble. */
  allPaths: string[];
  omitted: number;
  secrets: { path: string; hits: SecretHit[] }[];
  envFiles: string[];
};

/** Retire le dossier racine « owner-repo-sha/ » ajouté par GitHub. */
function stripRoot(path: string): string {
  return path.replace(/^[^/]+\//, "");
}

export function buildSnapshot(entries: TarEntry[], maxChars: number): Snapshot {
  const candidates = entries
    .map((e) => ({ path: stripRoot(e.path), content: e.content }))
    .filter((e) => e.path && !e.path.endsWith("/"));
  const allPaths = candidates.map((c) => c.path).sort();
  const envFiles = allPaths.filter(isEnvFile);

  const readable = candidates
    .filter((c) => !SKIP_DIR.test(c.path) && !SKIP_FILE.test(c.path) && !BINARY_EXT.test(c.path) && !isEnvFile(c.path))
    .filter((c) => !c.content.subarray(0, 8000).includes(0))
    .sort((a, b) => priority(a.path) - priority(b.path) || a.path.length - b.path.length || a.path.localeCompare(b.path));

  const files: SnapshotFile[] = [];
  const secrets: Snapshot["secrets"] = [];
  let used = 0;
  let omitted = 0;
  for (const c of readable) {
    const raw = c.content.subarray(0, MAX_FILE_BYTES).toString("utf8");
    const masked = maskSecrets(raw);
    if (masked.hits.length) secrets.push({ path: c.path, hits: masked.hits });
    const room = maxChars - used;
    if (room < 400) {
      omitted++;
      continue;
    }
    const truncated = masked.text.length > room || c.content.length > MAX_FILE_BYTES;
    const text = masked.text.slice(0, room);
    files.push({ path: c.path, text, truncated });
    used += text.length + c.path.length + 40;
  }
  // Les .env réels ne sont jamais envoyés, mais leurs secrets sont signalés.
  for (const c of candidates.filter((x) => isEnvFile(x.path))) {
    const masked = maskSecrets(c.content.subarray(0, MAX_FILE_BYTES).toString("utf8"));
    secrets.push({ path: c.path, hits: masked.hits.length ? masked.hits : [{ kind: "fichier .env commité", line: 1 }] });
  }
  return { files, allPaths, omitted, secrets, envFiles };
}
