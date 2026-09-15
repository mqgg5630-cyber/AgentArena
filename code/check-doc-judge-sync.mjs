#!/usr/bin/env node
/**
 * check-doc-judge-sync.mjs - keep the judge-type catalog in the docs in sync
 * with the judge registry in the code.
 *
 * WHY THIS EXISTS
 *   Judge docs drifted silently once: `.skills/add-judge` and
 *   `.skills/taskpack-authoring` kept saying "12 types available" while the
 *   registry had 15. `tests/judge-registry-sync.test.mjs` guards
 *   code <-> registry <-> normalizers, but NOTHING guarded the docs.
 *   This check is that missing guard.
 *
 * WHAT IT DOES
 *   1. Source of truth: `judgeTypeRegistry.register({ type: "<x>" ... })` lines
 *      in packages/judges/src/index.ts (no build required, works in a fresh
 *      clone). Cross-checked against
 *        - the `TaskJudge` union in packages/core/src/types/judge.ts (member
 *          count), and
 *        - the built runtime registry in packages/core/dist + judges/dist,
 *          when a build is present (this catches a broken parser above: if the
 *          registration syntax changes, this self-check fails loudly instead
 *          of silently reporting "no types").
 *   2. Scans the doc set (`.skills/**.md`, `docs/**.md`, plus root README.md,
 *      README.zh-CN.md, STABILITY.md, CLAUDE.md, AGENTS.md) for *catalogs* -
 *      files that actually ENUMERATE judge types, detected by list context
 *      (comma-separated inline runs, `- \`type\`` bullets, `| \`type\` |`
 *      table rows), never by a plain mention.
 *   3. For every catalog:
 *        - completeness: every registered type must be listed (missing -> fail)
 *        - count claims: "N types", "15 种 judge 类型" ... must equal the
 *          registry size AND the number of types listed (drift -> fail)
 *        - suspicious tokens: a list run that is overwhelmingly known types
 *          but contains an unknown one (typo / renamed type) -> fail
 *
 * WHAT IT DELIBERATELY IGNORES
 *   Narrative docs that merely mention a few types (DEVLOG entries, the
 *   architecture review, troubleshooting pages) are not catalogs and never
 *   fail here. Historical records are exempt by path (see EXEMPT_PREFIXES),
 *   and any single file can opt out with an inline marker:
 *       <!-- judge-types: ignore -->
 *
 * Usage:
 *     node code/check-doc-judge-sync.mjs            # check, exit 0/1
 *     node code/check-doc-judge-sync.mjs --list     # print the registry types
 *     node code/check-doc-judge-sync.mjs --verbose  # print every catalog found
 *
 * Exit codes: 0 = in sync, 1 = drift found (or the registry could not be read).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_SRC = "packages/judges/src/index.ts";
const UNION_SRC = "packages/core/src/types/judge.ts";

const SCAN_ROOTS = [".skills", "docs"];
const EXTRA_FILES = [
  "README.md",
  "README.zh-CN.md",
  "STABILITY.md",
  "CLAUDE.md",
  "AGENTS.md",
];
// Dated historical records: they describe a past state on purpose, so they are
// not held to today's registry. (CHANGELOG.md is historical by nature and is
// not scanned at all.)
const EXEMPT_PREFIXES = ["docs/plans/", "docs/superpowers/"];
const IGNORE_MARKER = "judge-types: ignore";

// A file must ENUMERATE at least this many registered types before it is
// treated as a catalog. Real catalogs list all 15; mention-heavy narrative
// files land far below this line.
const CATALOG_MIN = 8;

const TYPE_TOKEN = "`[a-z][a-z0-9-]*`";
const INLINE_RUN = new RegExp(`${TYPE_TOKEN}(?:\\s*[,、]\\s*${TYPE_TOKEN})+`, "g");
const BULLET_LINE = /^\s*[-*+]\s+`([a-z][a-z0-9-]*)`\s*$/;
const TABLE_LINE = /^\s*\|\s*`([a-z][a-z0-9-]*)`\s*\|/;
const COUNT_CLAIMS = [
  // "15 types", "15 judge types", "15 current types", "12 types available"
  /(\d+)\s+(?:[A-Za-z-]+\s+){0,2}types?\b/gi,
  // "15 种 judge 类型", "15 种类型", "15 类 judge"
  /(\d+)\s*[种类]\s*(?:judge\s*)?类型?/gi,
];

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
}

function rel(abs) {
  return path.relative(REPO, abs).split(path.sep).join("/");
}

function readIfExists(relPath) {
  const abs = path.join(REPO, relPath);
  return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
}

/** Registry types, parsed from the registration calls (no build needed). */
function parseRegistryTypes(source) {
  const types = new Set();
  const re = /judgeTypeRegistry\.register\(\{\s*type:\s*"([a-z][a-z0-9-]*)"/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    types.add(match[1]);
  }
  return types;
}

/** Member count of the `TaskJudge` union (the type-level list). */
function parseUnionCount(source) {
  const start = source.indexOf("export type TaskJudge =");
  if (start === -1) return undefined;
  const end = source.indexOf(";", start);
  const body = source.slice(start, end === -1 ? undefined : end);
  const members = body.match(/\|\s*\w+/g);
  return members ? members.length : 0;
}

/** Runtime registry from the build output, when a build exists. */
async function parseRuntimeTypes() {
  const core = path.join(REPO, "packages/core/dist/index.js");
  const judges = path.join(REPO, "packages/judges/dist/index.js");
  if (!existsSync(core) || !existsSync(judges)) return undefined;
  try {
    const { judgeTypeRegistry } = await import(pathToFileURL(core).href);
    await import(pathToFileURL(judges).href);
    const all = judgeTypeRegistry.getAllTypes();
    return new Set(all);
  } catch {
    return undefined; // a broken/partial build is not this check's business
  }
}

function listMarkdownFiles() {
  const files = [];
  const walk = (absDir) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".md")) files.push(rel(abs));
    }
  };
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO, root);
    if (existsSync(abs) && statSync(abs).isDirectory()) walk(abs);
  }
  files.push(...EXTRA_FILES.filter((f) => existsSync(path.join(REPO, f))));
  return [...new Set(files)]
    .filter((f) => !EXEMPT_PREFIXES.some((prefix) => f.startsWith(prefix)))
    .sort();
}

/**
 * Judge types this file ENUMERATES (list context only) plus the individual
 * list runs, so a run that is mostly known types can be flagged for unknown
 * tokens.
 */
function collectListedTypes(text, registryTypes) {
  const listed = new Set();
  const runs = [];
  const lineOf = (index) => text.slice(0, index).split("\n").length;

  for (const match of text.matchAll(INLINE_RUN)) {
    const tokens = match[0].match(/[a-z][a-z0-9-]*/g) ?? [];
    const known = tokens.filter((token) => registryTypes.has(token));
    for (const token of known) listed.add(token);
    if (tokens.length >= 2) {
      runs.push({ line: lineOf(match.index ?? 0), tokens });
    }
  }

  text.split("\n").forEach((line, index) => {
    for (const re of [BULLET_LINE, TABLE_LINE]) {
      const match = line.match(re);
      if (match && registryTypes.has(match[1])) listed.add(match[1]);
    }
  });

  return { listed, runs };
}

function findCountClaims(text) {
  const claims = [];
  for (const re of COUNT_CLAIMS) {
    for (const match of text.matchAll(re)) {
      claims.push({
        number: Number(match[1]),
        line: text.slice(0, match.index ?? 0).split("\n").length,
        snippet: match[0],
      });
    }
  }
  return claims;
}

async function main() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes("--verbose");

  const registrySource = readIfExists(REGISTRY_SRC);
  if (!registrySource) {
    fail(`cannot read the registry source: ${REGISTRY_SRC}`);
    return;
  }
  const registryTypes = parseRegistryTypes(registrySource);
  if (registryTypes.size === 0) {
    fail(
      `no judgeTypeRegistry.register({ type: ... }) entries found in ${REGISTRY_SRC} - ` +
        `the registration syntax probably changed; update this script`
    );
    return;
  }

  if (argv.includes("--list")) {
    console.log(
      `${registryTypes.size} judge types: ${[...registryTypes].sort().join(", ")}`
    );
    return;
  }

  console.log(
    `OK: ${registryTypes.size} judge types registered (${REGISTRY_SRC})`
  );

  // Cross-check 1: the TaskJudge union must have one member per type.
  const unionSource = readIfExists(UNION_SRC);
  if (unionSource) {
    const unionCount = parseUnionCount(unionSource);
    if (unionCount === undefined) {
      fail(`cannot locate "export type TaskJudge =" in ${UNION_SRC}`);
    } else if (unionCount !== registryTypes.size) {
      fail(
        `TaskJudge union has ${unionCount} members but ${registryTypes.size} types are registered - ` +
          `add the missing interface/union member or registration`
      );
    } else {
      console.log(`OK: TaskJudge union matches the registry (${unionCount} members)`);
    }
  }

  // Cross-check 2: the built runtime registry must agree with the parsed source
  // (self-check for this script's parser).
  const runtimeTypes = await parseRuntimeTypes();
  if (runtimeTypes) {
    const missing = [...registryTypes].filter((t) => !runtimeTypes.has(t));
    const extra = [...runtimeTypes].filter((t) => !registryTypes.has(t));
    if (missing.length || extra.length) {
      fail(
        `built registry disagrees with ${REGISTRY_SRC} (missing: ${missing.join(", ") || "none"}; ` +
          `extra: ${extra.join(", ") || "none"}) - rebuild or fix the parser in this script`
      );
    } else {
      console.log(`OK: built registry agrees with the source (${runtimeTypes.size} types)`);
    }
  } else if (verbose) {
    console.log("-- no build found (packages/*/dist) - skipped the runtime cross-check");
  }

  // Docs.
  const catalogs = [];
  for (const file of listMarkdownFiles()) {
    const text = readFileSync(path.join(REPO, file), "utf8");
    if (text.includes(IGNORE_MARKER)) continue;
    const { listed, runs } = collectListedTypes(text, registryTypes);
    if (listed.size >= CATALOG_MIN) {
      catalogs.push({ file, listed, runs, claims: findCountClaims(text) });
    }
  }

  if (catalogs.length === 0) {
    console.log("OK: no judge-type catalog found in the scanned docs");
    return;
  }

  for (const catalog of catalogs) {
    const missing = [...registryTypes].filter((t) => !catalog.listed.has(t)).sort();
    if (missing.length > 0) {
      fail(
        `${catalog.file}: catalog lists ${catalog.listed.size} types but is missing ` +
          `${missing.length}: ${missing.join(", ")}`
      );
    }

    for (const claim of catalog.claims) {
      if (claim.number !== registryTypes.size) {
        fail(
          `${catalog.file}:${claim.line}: says "${claim.snippet}" but the registry has ` +
            `${registryTypes.size} types`
        );
      } else if (claim.number !== catalog.listed.size) {
        fail(
          `${catalog.file}:${claim.line}: says "${claim.snippet}" but the same file lists ` +
            `${catalog.listed.size} types`
        );
      }
    }

    for (const run of catalog.runs) {
      const known = run.tokens.filter((t) => registryTypes.has(t)).length;
      const unknown = run.tokens.filter((t) => !registryTypes.has(t));
      if (unknown.length > 0 && known >= 3 && known / run.tokens.length >= 0.6) {
        fail(
          `${catalog.file}:${run.line}: list contains unknown judge type(s): ` +
            `${unknown.join(", ")} - typo, or a type that was renamed/removed?`
        );
      }
    }
  }

  if (process.exitCode === 1) {
    console.log(
      `\n${catalogs.length} catalog(s) scanned - drift found. Fix the docs (or the registry) and re-run.`
    );
  } else {
    console.log(
      `OK: ${catalogs.length} judge-type catalog(s) match the registry: ` +
        catalogs.map((c) => c.file).join(", ")
    );
  }
  if (verbose) {
    for (const catalog of catalogs) {
      console.log(
        `-- ${catalog.file}: ${catalog.listed.size} types listed, ` +
          `${catalog.claims.length} count claim(s)`
      );
    }
  }
}

await main();
