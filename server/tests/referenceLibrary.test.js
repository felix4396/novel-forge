const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildCandidateId,
  cleanAuthorName,
  normalizeAuthors,
  normalizeReferenceIdentity,
} = require("../dist/services/referenceLibrary/referenceLibraryNormalization.js");

test("normalizes and deduplicates author batches without fuzzy matching", () => {
  assert.deepEqual(normalizeAuthors([" 唐家三少 ", "唐家三少", "作者：烽火戏诸侯", ""]), [
    "唐家三少",
    "烽火戏诸侯",
  ]);
  assert.equal(cleanAuthorName("作者: 唐家三少"), "唐家三少");
  assert.notEqual(normalizeReferenceIdentity("唐家三少"), normalizeReferenceIdentity("唐家四哥"));
});

test("candidate ids are stable for equivalent typography", () => {
  assert.equal(buildCandidateId("唐家三少", "《光之子》"), buildCandidateId(" 唐家三少 ", "光之子"));
  assert.notEqual(buildCandidateId("唐家三少", "光之子"), buildCandidateId("唐家三少", "冰火魔厨"));
});
