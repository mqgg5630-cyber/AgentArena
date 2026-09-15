#!/usr/bin/env node
/**
 * local-runner-validate.mjs - zero-dependency validator for the local-runner
 * protocol (docs/local-runner-protocol.md).
 *
 * It mirrors the rules of
 *   docs/schemas/local-runner-job.schema.json
 *   docs/schemas/local-runner-result.schema.json
 * closely enough to be used as the pre-push gate for jobs written by an agent
 * session and by the local executor before it accepts a job - without pulling
 * in a JSON Schema library (this repo has no runtime dependencies for tooling).
 *
 * Usage:
 *   node scripts/local-runner-validate.mjs --job local-runs/jobs/x.job.json
 *   node scripts/local-runner-validate.mjs --status local-runs/results/x/status.json
 *   node scripts/local-runner-validate.mjs --job a.json --job b.json
 *
 * Exit codes: 0 all valid, 1 validation failed, 2 usage error.
 */

import fs from "node:fs";
import path from "node:path";

export const JOB_ID_RE = /^[0-9]{8}-[0-9]{3}-[a-z0-9][a-z0-9-]{2,39}$/;
export const KINDS = ["benchmark", "probe", "command"];
export const PROBES = ["hardware", "doctor", "nvidia-smi", "conda-env-list", "agentarena-version", "capability"];
export const SHELLS = ["powershell", "cmd", "bash"];
export const STATES = ["queued", "leased", "running", "succeeded", "failed", "cancelled", "timed_out", "skipped"];
export const OUTCOMES = ["pass", "fail", "inconclusive", "error"];
export const FAILURE_CATEGORIES = [
  "task-pack", "environment", "agent", "model", "validation", "cancelled", "unknown",
];
export const ERROR_CODES = [
  "requirements-unmet", "policy-rejected", "unsupported-schema", "unsupported-kind", "dependency-unmet",
  "duplicate-job-id", "lease-expired", "timeout", "engine-error", "cancelled", "internal-error",
];
export const STATE_SCORE_STATUS = ["success", "failed", "cancelled"];
export const ARTIFACT_MODES = ["manifest-only", "summary", "full"];
export const ARTIFACT_ROLES = ["summary", "report", "decision", "csv", "trend", "log", "trace", "bundle", "other"];
export const SCORE_MODES = [
  "practical", "balanced", "issue-resolution", "efficiency-first", "rotating-tasks", "comprehensive",
];

const BENCHMARK_OPTION_KEYS = [
  "maxConcurrency", "scoreMode", "tokenBudget", "probeAuth", "updateSnapshots", "cleanupWorkspaces",
  "agentTimeoutMs", "repeat", "resume", "locale", "jsonEvents",
];
const AGENT_CONFIG_KEYS = ["model", "reasoningEffort", "providerProfileId"];
const REQUIREMENT_KEYS = ["gpu", "condaEnv", "python", "tools", "minFreeDiskGb", "minFreeRamGb"];
const GPU_REQUIREMENT_KEYS = ["required", "minVramGb", "minCudaDriver", "nameContains"];

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value) => typeof value === "string";
const isNonEmptyString = (value) => isString(value) && value.length > 0;
const isInteger = (value) => Number.isInteger(value);
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** Validate a local-runner job object. Returns { valid, errors, warnings }. */
export function validateJob(job) {
  const errors = [];
  const warnings = [];
  const fail = (msg) => errors.push(msg);

  if (!isObject(job)) {
    return { valid: false, errors: ["job must be a JSON object"], warnings };
  }

  if (job.schemaVersion !== "1.0") {
    fail(`schemaVersion must be "1.0" (got ${JSON.stringify(job.schemaVersion)})`);
  }
  if (!isString(job.jobId) || !JOB_ID_RE.test(job.jobId)) {
    fail("jobId must match <YYYYMMDD>-<NNN>-<slug>, e.g. 20260915-001-demo-smoke");
  }
  if (!isNonEmptyString(job.createdAt) || !/^\d{4}-\d{2}-\d{2}T/.test(job.createdAt)) {
    fail("createdAt must be an ISO 8601 date-time string");
  }
  if (!KINDS.includes(job.kind)) {
    fail(`kind must be one of ${KINDS.join(", ")}`);
  }
  if (!isObject(job.requestedBy) || !isNonEmptyString(job.requestedBy.branch) || !isNonEmptyString(job.requestedBy.session)) {
    fail("requestedBy must be { branch, session }");
  }
  if (!isString(job.reason) || job.reason.trim().length < 3) {
    fail("reason must be a string of at least 3 characters");
  }
  if (!isObject(job.spec)) {
    fail("spec must be an object");
  }

  if (job.timeoutSeconds !== undefined && (!isInteger(job.timeoutSeconds) || job.timeoutSeconds < 10 || job.timeoutSeconds > 7200)) {
    fail("timeoutSeconds must be an integer between 10 and 7200");
  }
  if (job.priority !== undefined && (!isInteger(job.priority) || job.priority < 0 || job.priority > 9)) {
    fail("priority must be an integer between 0 and 9");
  }
  if (job.dependsOn !== undefined) {
    if (!Array.isArray(job.dependsOn)) {
      fail("dependsOn must be an array of jobIds");
    } else {
      job.dependsOn.forEach((id, i) => {
        if (!isString(id) || !JOB_ID_RE.test(id)) fail(`dependsOn[${i}] must be a valid jobId`);
      });
    }
  }
  if (job.idempotencyKey !== undefined && !isNonEmptyString(job.idempotencyKey)) {
    fail("idempotencyKey must be a non-empty string when present");
  }
  if (job.notes !== undefined && !isString(job.notes)) {
    fail("notes must be a string");
  }
  if (job.artifacts !== undefined) {
    if (!isObject(job.artifacts)) {
      fail("artifacts must be an object");
    } else {
      if (job.artifacts.mode !== undefined && !ARTIFACT_MODES.includes(job.artifacts.mode)) {
        fail(`artifacts.mode must be one of ${ARTIFACT_MODES.join(", ")}`);
      }
      if (job.artifacts.maxFileMb !== undefined && (!isNumber(job.artifacts.maxFileMb) || job.artifacts.maxFileMb <= 0)) {
        fail("artifacts.maxFileMb must be a positive number");
      }
      if (job.artifacts.maxTotalMb !== undefined && (!isNumber(job.artifacts.maxTotalMb) || job.artifacts.maxTotalMb <= 0)) {
        fail("artifacts.maxTotalMb must be a positive number");
      }
      if (job.artifacts.include !== undefined && !Array.isArray(job.artifacts.include)) {
        fail("artifacts.include must be an array of glob strings");
      }
      for (const key of Object.keys(job.artifacts)) {
        if (!["mode", "include", "maxFileMb", "maxTotalMb"].includes(key)) {
          fail(`artifacts has unknown key "${key}"`);
        }
      }
    }
  }
  if (job.requirements !== undefined) {
    if (!isObject(job.requirements)) {
      fail("requirements must be an object");
    } else {
      for (const key of Object.keys(job.requirements)) {
        if (!REQUIREMENT_KEYS.includes(key)) fail(`requirements has unknown key "${key}"`);
      }
      if (job.requirements.gpu !== undefined) {
        if (!isObject(job.requirements.gpu)) {
          fail("requirements.gpu must be an object");
        } else {
          for (const key of Object.keys(job.requirements.gpu)) {
            if (!GPU_REQUIREMENT_KEYS.includes(key)) fail(`requirements.gpu has unknown key "${key}"`);
          }
          if (job.requirements.gpu.minVramGb !== undefined && !isNumber(job.requirements.gpu.minVramGb)) {
            fail("requirements.gpu.minVramGb must be a number");
          }
        }
      }
      if (job.requirements.tools !== undefined && !Array.isArray(job.requirements.tools)) {
        fail("requirements.tools must be an array of command names");
      }
    }
  }

  if (isObject(job.spec)) {
    const spec = job.spec;
    const specKeys = Object.keys(spec);
    if (job.kind === "benchmark") {
      for (const required of ["repo", "task", "agents"]) {
        if (spec[required] === undefined) fail(`spec.${required} is required for kind=benchmark`);
      }
      if (spec.repo !== undefined && !isNonEmptyString(spec.repo)) fail("spec.repo must be a non-empty string");
      if (spec.task !== undefined && !isNonEmptyString(spec.task)) fail("spec.task must be a non-empty string");
      if (!Array.isArray(spec.agents) || spec.agents.length === 0) {
        fail("spec.agents must contain at least one agent");
      } else {
        spec.agents.forEach((agent, i) => {
          if (!isObject(agent) || !isNonEmptyString(agent.baseAgentId)) {
            fail(`spec.agents[${i}].baseAgentId is required`);
            return;
          }
          for (const key of Object.keys(agent)) {
            if (!["baseAgentId", "displayLabel", "config"].includes(key)) {
              fail(`spec.agents[${i}] has unknown key "${key}"`);
            }
          }
          if (agent.variantId !== undefined) {
            fail(`spec.agents[${i}].variantId must not be authored - it is derived from baseAgentId + config`);
          }
          if (agent.config !== undefined) {
            if (!isObject(agent.config)) {
              fail(`spec.agents[${i}].config must be an object`);
            } else {
              for (const key of Object.keys(agent.config)) {
                if (!AGENT_CONFIG_KEYS.includes(key)) fail(`spec.agents[${i}].config has unknown key "${key}"`);
              }
            }
          }
        });
      }
      if (spec.options !== undefined) {
        if (!isObject(spec.options)) {
          fail("spec.options must be an object");
        } else {
          for (const key of Object.keys(spec.options)) {
            if (!BENCHMARK_OPTION_KEYS.includes(key)) fail(`spec.options has unknown key "${key}"`);
          }
          if (spec.options.scoreMode !== undefined && !SCORE_MODES.includes(spec.options.scoreMode)) {
            fail(`spec.options.scoreMode must be one of ${SCORE_MODES.join(", ")}`);
          }
          if (spec.options.locale !== undefined && !["en", "zh-CN"].includes(spec.options.locale)) {
            fail('spec.options.locale must be "en" or "zh-CN"');
          }
          if (spec.options.maxConcurrency !== undefined && (!isInteger(spec.options.maxConcurrency) || spec.options.maxConcurrency < 1)) {
            fail("spec.options.maxConcurrency must be a positive integer");
          }
          if (spec.options.repeat !== undefined && (!isInteger(spec.options.repeat) || spec.options.repeat < 1)) {
            fail("spec.options.repeat must be a positive integer");
          }
          if (spec.options.tokenBudget !== undefined && (!isNumber(spec.options.tokenBudget) || spec.options.tokenBudget <= 0)) {
            fail("spec.options.tokenBudget must be a positive number");
          }
          if (spec.options.agentTimeoutMs !== undefined && (!isInteger(spec.options.agentTimeoutMs) || spec.options.agentTimeoutMs < 1000)) {
            fail("spec.options.agentTimeoutMs must be an integer >= 1000");
          }
        }
      }
      for (const key of specKeys) {
        if (!["repo", "task", "agents", "options"].includes(key)) fail(`spec has unknown key "${key}" for kind=benchmark`);
      }
    } else if (job.kind === "probe") {
      if (!PROBES.includes(spec.probe)) fail(`spec.probe must be one of ${PROBES.join(", ")}`);
      for (const key of specKeys) {
        if (key !== "probe") fail(`spec has unknown key "${key}" for kind=probe`);
      }
    } else if (job.kind === "command") {
      if (!SHELLS.includes(spec.shell)) fail(`spec.shell must be one of ${SHELLS.join(", ")}`);
      if (!isNonEmptyString(spec.command)) fail("spec.command must be a non-empty string");
      if (spec.args !== undefined && !Array.isArray(spec.args)) fail("spec.args must be an array of strings");
      if (spec.allowRisky !== undefined && typeof spec.allowRisky !== "boolean") fail("spec.allowRisky must be a boolean");
      for (const key of specKeys) {
        if (!["shell", "command", "args", "cwd", "allowRisky"].includes(key)) {
          fail(`spec has unknown key "${key}" for kind=command`);
        }
      }
    }
  }

  for (const key of Object.keys(job)) {
    if (!key.startsWith("x-") && !KNOWN_JOB_KEYS.has(key)) {
      warnings.push(`unknown top-level key "${key}" (allowed, but ignored by the executor)`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

const KNOWN_JOB_KEYS = new Set([
  "schemaVersion", "jobId", "createdAt", "kind", "requestedBy", "reason", "spec", "requirements",
  "timeoutSeconds", "priority", "dependsOn", "idempotencyKey", "artifacts", "notes",
]);

/** Validate a local-runner status object (results/<jobId>/status.json). */
export function validateStatus(status) {
  const errors = [];
  const warnings = [];
  const fail = (msg) => errors.push(msg);

  if (!isObject(status)) {
    return { valid: false, errors: ["status must be a JSON object"], warnings };
  }
  if (status.schemaVersion !== "1.0") fail(`schemaVersion must be "1.0" (got ${JSON.stringify(status.schemaVersion)})`);
  if (!isString(status.jobId) || !JOB_ID_RE.test(status.jobId)) fail("jobId must match <YYYYMMDD>-<NNN>-<slug>");
  if (!STATES.includes(status.state)) fail(`state must be one of ${STATES.join(", ")}`);
  if (!isInteger(status.attempt) || status.attempt < 1) fail("attempt must be an integer >= 1");
  if (!KINDS.includes(status.kind)) fail(`kind must be one of ${KINDS.join(", ")}`);
  if (!isObject(status.requestedBy)) fail("requestedBy must be an object");
  if (!isObject(status.host) || !isNonEmptyString(status.host.name)) fail("host.name is required");
  if (!isObject(status.timing)) fail("timing must be an object");

  if (status.verdict !== undefined) {
    if (!isObject(status.verdict)) {
      fail("verdict must be an object");
    } else {
      if (!OUTCOMES.includes(status.verdict.outcome)) fail(`verdict.outcome must be one of ${OUTCOMES.join(", ")}`);
      const category = status.verdict.failureCategory;
      if (category !== null && category !== undefined && !FAILURE_CATEGORIES.includes(category)) {
        fail(`verdict.failureCategory must be null or one of ${FAILURE_CATEGORIES.join(", ")}`);
      }
      if (status.verdict.scores !== undefined) {
        if (!Array.isArray(status.verdict.scores)) {
          fail("verdict.scores must be an array");
        } else {
          status.verdict.scores.forEach((score, i) => {
            if (!isObject(score) || !isNonEmptyString(score.variantId)) fail(`verdict.scores[${i}].variantId is required`);
            else if (!STATE_SCORE_STATUS.includes(score.status)) {
              fail(`verdict.scores[${i}].status must be one of ${STATE_SCORE_STATUS.join(", ")}`);
            }
          });
        }
      }
    }
  }

  if (status.error !== undefined && status.error !== null) {
    if (!isObject(status.error) || !ERROR_CODES.includes(status.error.code) || !isNonEmptyString(status.error.message)) {
      fail(`error must be { code: <one of ${ERROR_CODES.join(", ")}>, message }`);
    }
  }

  if (status.artifacts !== undefined) {
    if (!Array.isArray(status.artifacts)) {
      fail("artifacts must be an array");
    } else {
      status.artifacts.forEach((artifact, i) => {
        if (!isObject(artifact) || !isNonEmptyString(artifact.path)) fail(`artifacts[${i}].path is required`);
        else {
          if (!isInteger(artifact.bytes) || artifact.bytes < 0) fail(`artifacts[${i}].bytes must be a non-negative integer`);
          if (typeof artifact.committed !== "boolean") fail(`artifacts[${i}].committed must be a boolean`);
          if (artifact.role !== undefined && !ARTIFACT_ROLES.includes(artifact.role)) {
            fail(`artifacts[${i}].role must be one of ${ARTIFACT_ROLES.join(", ")}`);
          }
        }
      });
    }
  }

  if (status.logTail !== undefined && !Array.isArray(status.logTail)) fail("logTail must be an array of strings");
  return { valid: errors.length === 0, errors, warnings };
}

function readJsonFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

function main(argv) {
  const jobs = [];
  const statuses = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--job" || arg === "--status") {
      const target = argv[i + 1];
      if (!target) {
        console.error(`[ERROR] ${arg} requires a file path`);
        return 2;
      }
      (arg === "--job" ? jobs : statuses).push(target);
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      console.log("usage: node scripts/local-runner-validate.mjs --job <file.job.json> [--job ...] [--status <status.json> ...]");
      return 0;
    } else {
      console.error(`[ERROR] unknown argument: ${arg}`);
      return 2;
    }
  }

  if (jobs.length === 0 && statuses.length === 0) {
    console.error("usage: node scripts/local-runner-validate.mjs --job <file.job.json> [--status <status.json>]");
    return 2;
  }

  let failed = 0;
  for (const [list, kind, validate] of [[jobs, "job", validateJob], [statuses, "status", validateStatus]]) {
    for (const rel of list) {
      const abs = path.resolve(rel);
      let result;
      try {
        result = validate(readJsonFile(abs));
      } catch (error) {
        console.log(`[FAIL] ${kind} ${rel}: ${error instanceof Error ? error.message : String(error)}`);
        failed = 1;
        continue;
      }
      if (result.valid) {
        console.log(`[OK] ${kind} ${rel}`);
      } else {
        console.log(`[FAIL] ${kind} ${rel}`);
        failed = 1;
      }
      for (const warning of result.warnings ?? []) console.log(`       warn: ${warning}`);
      for (const error of result.errors ?? []) console.log(`       ${error}`);
    }
  }
  return failed;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
