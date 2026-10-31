/**
 * Scanner de secrets : tourne AVANT tout envoi à l'IA. Les valeurs sont remplacées par un marqueur,
 * jamais recopiées dans un rapport, un journal ou une base.
 */
export const MASK = "[SECRET MASQUÉ]";

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "clé privée", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "clé Anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "clé OpenAI", re: /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: "clé Stripe", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "jeton GitHub", re: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { name: "jeton Slack", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "clé AWS", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "clé Google", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "jeton Telegram", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { name: "jeton JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: "mot de passe dans une URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:(?![$<{%])[^\s@'"/$<{]{6,}@/gi },
  {
    name: "secret affecté en clair",
    re: /\b[A-Za-z0-9_]*(?:secret|password|passwd|pwd|api[_-]?key|token|private[_-]?key)[A-Za-z0-9_]*\s*[:=]\s*["'](?![$<{%])[^"'\s]{8,}["']/gi,
  },
];

export type SecretHit = { kind: string; line: number };

/** Masque les secrets d'un texte ; renvoie le texte nettoyé et l'emplacement (sans la valeur) de chaque secret. */
export function maskSecrets(text: string): { text: string; hits: SecretHit[] } {
  const hits: SecretHit[] = [];
  let out = text;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, (match, ...args) => {
      if (match.includes(MASK)) return match;
      const offset = args.find((a) => typeof a === "number") as number;
      hits.push({ kind: name, line: out.slice(0, offset).split("\n").length });
      // Pour une affectation, garder le nom de la variable : utile au diagnostic, sans la valeur.
      const assign = /^(.*?[:=]\s*["'])/.exec(match);
      return name === "secret affecté en clair" && assign ? `${assign[1]}${MASK}"` : name === "mot de passe dans une URL" ? match.replace(/:[^:@]+@$/, `:${MASK}@`) : MASK;
    });
  }
  return { text: out, hits };
}

/** Tests, exemples et données factices : un secret y est presque toujours un faux, signalé en priorité basse. */
export function isTestOrExample(path: string): boolean {
  return /(^|\/)(tests?|__tests__|fixtures?|spec|mocks?|examples?)\/|\.(test|spec)\.[a-z]+$|\.(example|sample|template)$/i.test(path);
}

/** Fichiers d'environnement réels (pas les modèles .example). */
export function isEnvFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return /^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist)$/.test(name);
}
