import crypto from "node:crypto";

export function cleanAuthorName(value: string): string {
  return value.normalize("NFKC").replace(/^\s*作者[：:]\s*/, "").trim();
}

export function normalizeReferenceIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s·・•._—–-]+/g, "")
    .replace(/[《》「」『』【】()（）\[\]]/g, "")
    .trim();
}

export function normalizeAuthors(values: string[]): string[] {
  const seen = new Set<string>();
  const authors: string[] = [];
  for (const raw of values) {
    const author = cleanAuthorName(raw);
    const key = normalizeReferenceIdentity(author);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    authors.push(author);
  }
  return authors;
}

export function buildCandidateId(author: string, title: string): string {
  return crypto
    .createHash("sha256")
    .update(`${normalizeReferenceIdentity(author)}\0${normalizeReferenceIdentity(title)}`)
    .digest("hex")
    .slice(0, 24);
}
