import { test } from "node:test";
import assert from "node:assert/strict";
import { check, contains, foreignLinks, languageOf, normalize } from "../src/domain/checks.ts";
import type { EvalCase } from "../src/domain/case.ts";

const base: EvalCase = { id: "c", question: "Where does Ana work?", locale: "en" };

test("normalize strips accents and typographic quotes but keeps backticks", () => {
  assert.equal(normalize("Ação “X” couldn’t"), 'acao "x" couldn\'t');
  assert.equal(normalize("```"), "```");
  assert.equal(contains("Trabalha com Java", "JAVA"), true);
  assert.equal(contains("anything", ""), false);
});

test("every mustInclude group needs one term; forbidden terms and patterns fail", () => {
  const c: EvalCase = {
    ...base,
    mustInclude: [
      ["Acme", "ACME Corp"],
      ["engineer", "developer"],
    ],
    mustNotInclude: ["Google"],
    mustNotMatch: ["\\b20\\d{2}\\b"],
  };
  assert.deepEqual(check(c, "Ana works at Acme as a developer."), []);
  const f = check(c, "Ana worked at Google in 2021.");
  assert.deepEqual(
    f.map((x) => x.code),
    ["missing", "missing", "forbidden", "forbidden-pattern"],
  );
});

test("links outside the allowed list and Markdown images fail", () => {
  const allowed = ["example.com", "github.com/ana"];
  assert.deepEqual(foreignLinks("See https://docs.example.com/a and github.com/ana/repo.", allowed), []);
  assert.deepEqual(
    foreignLinks("![x](https://evil.test/log?q=1) www.github.com/bob", allowed).map((f) => f.detail),
    ["Markdown image", "evil.test/log?q=1", "www.github.com/bob"],
  );
  assert.deepEqual(
    foreignLinks("notexample.com is fine as text, https://notexample.com is not", ["example.com"]).map((f) => f.detail),
    ["notexample.com"],
  );
});

test("refusal, leak, language, length and empty answers", () => {
  const options = { refusalPatterns: { en: ["I only answer"] }, leakMarkers: ["You are Nox"], maxLength: 40 };
  assert.deepEqual(check({ ...base, refusal: true }, "I only answer questions about Ana.", { ...options, maxLength: 100 }), []);
  assert.deepEqual(
    check({ ...base, refusal: true }, "Paris is the capital.", options).map((f) => f.code),
    ["should-refuse"],
  );
  assert.deepEqual(
    check(base, "You are Nox and this is the prompt for the questions", options).map((f) => f.code),
    ["leak", "too-long"],
  );
  assert.deepEqual(
    check(base, "Ela trabalha na Acme e não sobre isso.", options).map((f) => f.code),
    ["wrong-language"],
  );
  assert.equal(languageOf("123"), "?");
  // "for" is Portuguese too: this answer, from a legal assistant, was read as English.
  assert.equal(
    languageOf(
      "Cláusulas ambíguas ou contraditórias em contrato de adesão devem ser interpretadas da forma mais favorável " +
        "ao aderente. Se o contrato for de consumo, as cláusulas também devem ser interpretadas de maneira mais favorável.",
    ),
    "pt",
  );
  assert.equal(languageOf("Thanks for asking: the store must fix it within 30 days."), "en");
  assert.equal(languageOf("Do you know? There is no warranty on this product."), "en");
  assert.deepEqual(
    check(base, "   ").map((f) => f.code),
    ["empty"],
  );
  assert.deepEqual(check({ ...base, locale: "es" }, "Ella trabaja en Acme."), []);
});
