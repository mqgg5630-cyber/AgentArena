#!/usr/bin/env node
/**
 * local-runner.mjs - the local side of the local-runner protocol (S2).
 *
 * Drains the queue in local-runs/jobs/ on the USER'S machine: pre-checks
 * requirements, runs `agentarena run` (or a read-only probe), harvests the
 * artifacts, and writes the machine-readable verdict to
 * local-runs/results/<jobId>/status.json. Protocol: docs/local-runner-protocol.md
 *
 * Why Node and not PowerShell: this file must be testable off-Windows (the
 * agent sandbox has no pwsh), and it needs real JSON handling (PowerShell 5.1
 * ConvertTo-Json collapses single-element arrays). code/local-runner.ps1 is a
 * thin ASCII wrapper so the documented entry point still exists.
 *
 * Usage:
 *   node code/local-runner.mjs [--drain-once] [--max-jobs N] [--job <jobId>]
 *                              [--force] [--dry-run] [--self-test] [--help]
 *
 * Exit codes: 0 nothing to do / all selected jobs ended cleanly (succeeded or
 *             policy-skipped), 1 at least one job failed/timed_out, 2 usage,
 *             3 internal error.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateJob, JOB_ID_RE, PROBES } from "../scripts/local-runner-validate.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUEUE_DIR = "local-runs/jobs";
const ARCHIVE_DIR = "local-runs/jobs/archive";
const RESULTS_DIR = "local-runs/results";
const WORK_DIR = "local-runs/.work";
const STATE_DIR = "local-runs/state";
const LEASE_FILE = "local-runs/state/lease.json";
const SETTINGS_FILE = "local-runs/state/settings.json";
const LEDGER_FILE = "local-runs/ledger.jsonl";

const SCHEMA_VERSION = "1.0";
const LEASE_TTL_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

const DEFAULT_SETTINGS = {
  maxJobsPerDrain: 1,
  maxParallelAgents: 2,
  allowedKinds: ["benchmark", "probe"],
  allowRiskyCommands: false,
  allowedProbes: [...PROBES],
  arenaCli: null,
  arenaCliArgs: [],
  artifactPolicy: { defaultMode: "summary", maxFileMb: 5, maxTotalMb: 20 },
  defaultTimeoutSeconds: { benchmark: 3600, probe: 120, command: 600 },
  consoleTailLines: 2000,
  maxLogMb: 5,
};

const HARD_MAX_FILE_MB = 25;
const HARD_MAX_TOTAL_MB = 100;

const ARTIFACT_PRESETS = {
  "manifest-only": [],
  summary: [
    "summary.json", "report.html", "decision-report.md", "results.csv", "trend.md",
    "badge.svg", "pr-comment.md",
  ],
  full: [
    "summary.json", "report.html", "decision-report.md", "results.csv", "trend.md",
    "badge.svg", "pr-comment.md", "agents/*/result.json",
  ],
};

// ---------------------------------------------------------------- utilities

const nowIso = () => new Date().toISOString();
const log = (message) => process.stdout.write(`[local-runner] ${message}\n`);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonSafe(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sizeOf(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function tailLines(filePath, maxLines, maxBytes = 8 * 1024 * 1024) {
  if (!fs.existsSync(filePath)) return { lines: [], total: 0 };
  const size = sizeOf(filePath);
  const start = size > maxBytes ? size - maxBytes : 0;
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift();
    const total = lines.length;
    return { lines: lines.slice(-maxLines), total };
  } finally {
    fs.closeSync(fd);
  }
}

function which(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  const first = String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  return first ?? null;
}

function winQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

/** Run a command, streaming stdout/stderr to files. Never throws. */
function runCapture({ command, args = [], cwd, timeoutMs, stdoutPath, stderrPath }) {
  return new Promise((resolve) => {
    let child;
    const openStdio = () => [fs.openSync(stdoutPath, "w"), fs.openSync(stderrPath, "w")];
    const [outFd, errFd] = (() => {
      fs.mkdirSync(path.dirname(stdoutPath), { recursive: true });
      return openStdio();
    })();

    const resolved = which(command) ?? command;
    const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);

    try {
      if (needsShell) {
        const cmdline = [winQuote(resolved), ...args.map(winQuote)].join(" ");
        child = spawn(cmdline, { cwd, stdio: ["ignore", outFd, errFd], shell: true, windowsHide: true });
      } else {
        child = spawn(resolved, args, {
          cwd,
          stdio: ["ignore", outFd, errFd],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
      }
    } catch (error) {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      resolve({ exitCode: null, signal: null, timedOut: false, spawnError: error.message });
      return;
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, Math.max(1000, timeoutMs));

    const finish = (exitCode, signal, spawnError) => {
      clearTimeout(timer);
      try { fs.closeSync(outFd); } catch { /* already closed */ }
      try { fs.closeSync(errFd); } catch { /* already closed */ }
      resolve({ exitCode, signal, timedOut, spawnError });
    };

    child.on("close", (code, signal) => finish(code, signal, null));
    child.on("error", (error) => finish(null, null, error.message));
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

// ------------------------------------------------------------------ settings

function loadSettings() {
  const configured = readJsonSafe(path.join(REPO_ROOT, SETTINGS_FILE)) ?? {};
  const settings = {
    ...DEFAULT_SETTINGS,
    ...configured,
    artifactPolicy: { ...DEFAULT_SETTINGS.artifactPolicy, ...(configured.artifactPolicy ?? {}) },
    defaultTimeoutSeconds: { ...DEFAULT_SETTINGS.defaultTimeoutSeconds, ...(configured.defaultTimeoutSeconds ?? {}) },
  };
  if (process.env.AGENTARENA_CLI) {
    settings.arenaCli = process.env.AGENTARENA_CLI;
    settings.arenaCliArgs = (process.env.AGENTARENA_CLI_ARGS ?? "").split(/\s+/).filter(Boolean);
  }
  return settings;
}

function dirsFor(jobId) {
  return {
    resultsDir: path.join(REPO_ROOT, RESULTS_DIR, jobId),
    workDir: path.join(REPO_ROOT, WORK_DIR, jobId),
    statusPath: path.join(REPO_ROOT, RESULTS_DIR, jobId, "status.json"),
  };
}

function readStatus(jobId) {
  return readJsonSafe(dirsFor(jobId).statusPath);
}

function isTerminal(status) {
  return Boolean(status) && ["succeeded", "failed", "cancelled", "timed_out", "skipped"].includes(status.state);
}

// --------------------------------------------------------------------- lease

function readLease() {
  const lease = readJsonSafe(path.join(REPO_ROOT, LEASE_FILE));
  return lease && typeof lease === "object" ? lease : null;
}

function leaseActive(lease) {
  if (!lease?.expiresAt) return false;
  return Date.parse(lease.expiresAt) > Date.now();
}

function writeLease(jobId) {
  writeJsonAtomic(path.join(REPO_ROOT, LEASE_FILE), {
    jobId,
    host: os.hostname(),
    pid: process.pid,
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
  });
}

function heartbeatLease(jobId) {
  const lease = readLease();
  if (!lease || lease.jobId !== jobId) return;
  writeJsonAtomic(path.join(REPO_ROOT, LEASE_FILE), {
    ...lease,
    heartbeatAt: nowIso(),
    expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
  });
}

function releaseLease(jobId) {
  const lease = readLease();
  if (lease && lease.jobId !== jobId) return;
  try { fs.unlinkSync(path.join(REPO_ROOT, LEASE_FILE)); } catch { /* already gone */ }
}

// -------------------------------------------------------------------- ledger

function ledgerEvents() {
  const file = path.join(REPO_ROOT, LEDGER_FILE);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  return text.split(/\r?\n/).filter(Boolean).slice(-1000).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function ledgerAppend(entry) {
  appendJsonl(path.join(REPO_ROOT, LEDGER_FILE), { ts: nowIso(), ...entry });
}

// -------------------------------------------------------------- facts / env

function queryNvidiaSmi() {
  const result = spawnSync("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return { available: false, error: result.error?.message ?? `exit ${result.status}` };
  const gpus = String(result.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, memoryMb, driver] = line.split(",").map((part) => part.trim());
    const mb = Number.parseInt(memoryMb ?? "", 10);
    return { name, vramGb: Number.isFinite(mb) ? Math.round((mb / 1024) * 10) / 10 : null, driver };
  });
  const full = spawnSync("nvidia-smi", [], { encoding: "utf8", windowsHide: true });
  const cudaDriver = /CUDA Version:\s*([\d.]+)/.exec(String(full.stdout ?? ""))?.[1] ?? null;
  return { available: true, gpus: gpus.map((gpu) => ({ ...gpu, cudaDriver })) };
}

function queryCondaEnvs() {
  const conda = which("conda");
  if (!conda) return { available: false, envs: [] };
  const json = spawnSync(conda, ["env", "list", "--json"], { encoding: "utf8", windowsHide: true });
  if (json.status === 0) {
    try {
      const parsed = JSON.parse(json.stdout);
      const envs = (parsed.envs ?? []).slice(0, 60).map((envPath) => ({
        name: path.basename(envPath),
        path: envPath,
      }));
      return { available: true, conda, envs };
    } catch { /* fall through to plain text */ }
  }
  const plain = spawnSync(conda, ["env", "list"], { encoding: "utf8", windowsHide: true });
  const envs = String(plain.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, 60)
    .map((line) => {
      const [name, envPath] = line.split(/\s+/).filter(Boolean);
      return { name, path: envPath ?? name };
    });
  return { available: true, conda, envs };
}

function diskFacts() {
  const targets = [...new Set([path.parse(REPO_ROOT).root, path.parse(os.tmpdir()).root, REPO_ROOT])];
  return targets.map((target) => {
    try {
      const stats = fs.statfsSync(target);
      const totalGb = (stats.blocks * stats.bsize) / 1024 ** 3;
      const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
      return { path: target, totalGb: Math.round(totalGb * 10) / 10, freeGb: Math.round(freeGb * 10) / 10 };
    } catch {
      return { path: target, totalGb: null, freeGb: null };
    }
  });
}

function resolveCliCandidates(settings) {
  const candidates = [];
  if (settings.arenaCli) {
    candidates.push({ command: settings.arenaCli, argsPrefix: settings.arenaCliArgs ?? [], source: "settings.arenaCli" });
  }
  candidates.push({ command: "agentarena", argsPrefix: [], source: "PATH" });
  const distEntry = path.join(REPO_ROOT, "packages", "cli", "dist", "index.js");
  if (fs.existsSync(distEntry)) {
    candidates.push({ command: process.execPath, argsPrefix: [distEntry], source: "packages/cli/dist/index.js" });
  }
  return candidates.map((candidate) => {
    const resolved = which(candidate.command);
    return { ...candidate, resolvedPath: resolved, available: Boolean(resolved) };
  });
}

function pickCli(settings) {
  const candidates = resolveCliCandidates(settings);
  return candidates.find((candidate) => candidate.available) ?? null;
}

function normalizeHardwareReport(report) {
  if (!report) return null;
  const gpus = (report.gpus ?? []).map((gpu) => ({
    name: gpu.name ?? null,
    vramGb: gpu.vramGb ?? gpu.vram_gb ?? null,
    driver: gpu.driver ?? null,
    cudaDriver: gpu.cudaDriver ?? gpu.cuda_driver ?? null,
  }));
  return {
    generated: report.generated ?? null,
    host: report.host ?? null,
    gpus,
    conda: report.python?.conda ?? null,
    envs: (report.python?.envs ?? []).map((env) => ({ name: env.name, path: env.path })),
    ram: report.ram ?? null,
    disks: report.disks ?? null,
  };
}

function gatherFacts(settings) {
  const hardwarePath = path.join(REPO_ROOT, "results", "hardware", "latest.json");
  const hardwareRaw = readJsonSafe(hardwarePath);
  const hardware = normalizeHardwareReport(hardwareRaw);
  const nvidia = queryNvidiaSmi();
  const conda = queryCondaEnvs();
  return {
    host: { name: os.hostname(), os: `${os.type()} ${os.release()}`, platform: process.platform, pid: process.pid },
    node: { version: process.version, execPath: process.execPath },
    git: {
      branch: runTool(["git", "rev-parse", "--abbrev-ref", "HEAD"]),
      commit: runTool(["git", "rev-parse", "HEAD"]),
    },
    tools: {
      git: which("git"), node: which("node"), pnpm: which("pnpm"), npm: which("npm"),
      agentarena: which("agentarena"), nvidiaSmi: which("nvidia-smi"), conda: conda.conda ?? null,
    },
    cli: { candidates: resolveCliCandidates(settings), selected: pickCli(settings) },
    gpu: nvidia.available ? nvidia.gpus : (hardware?.gpus ?? []),
    nvidiaSmi: { available: nvidia.available, error: nvidia.error ?? null },
    conda: {
      available: conda.available,
      envs: conda.available ? conda.envs : (hardware?.envs ?? []),
      source: conda.available ? "conda-cli" : hardware ? "hardware-report" : null,
    },
    ram: {
      totalGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      freeGb: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    },
    disk: diskFacts(),
    hardware: hardware
      ? { report: "results/hardware/latest.json", generated: hardware.generated, host: hardware.host, gpuCount: hardware.gpus.length }
      : { report: null, generated: null, host: null, gpuCount: 0 },
    hardwareRaw: hardware,
  };
}

function runTool(argv) {
  const [command, ...args] = argv;
  const result = spawnSync(command, args, { encoding: "utf8", cwd: REPO_ROOT, windowsHide: true });
  if (result.status !== 0) return null;
  return String(result.stdout ?? "").trim() || null;
}

// ----------------------------------------------------------- requirements

function compareVersion(actual, wanted) {
  const match = /^\s*(>=|<=|>|<|=|==)?\s*(\d+(?:\.\d+)*)\s*$/.exec(wanted ?? "");
  if (!match || !actual) return null;
  const operator = match[1] ?? ">=";
  const wantedParts = match[2].split(".").map(Number);
  const actualParts = String(actual).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(wantedParts.length, actualParts.length);
  for (let i = 0; i < length; i += 1) {
    const a = actualParts[i] ?? 0;
    const b = wantedParts[i] ?? 0;
    if (a === b) continue;
    const greater = a > b;
    return operator.startsWith(">") ? greater : operator.startsWith("<") ? !greater : false;
  }
  return operator.startsWith(">") || operator.startsWith("<") ? false : true;
}

function checkRequirements(declaredRequirements, facts) {
  const requirements = declaredRequirements ?? {};
  const unmet = [];
  const actual = {
    tools: {},
    gpu: facts.gpu,
    condaEnv: requirements.condaEnv ?? null,
    condaEnvs: facts.conda.envs.map((env) => env.name).slice(0, 40),
    disk: facts.disk,
    ram: facts.ram,
    hardwareGenerated: facts.hardware.generated,
    hardwareReport: facts.hardware.report,
  };
  if (Object.keys(requirements).length === 0) {
    return { satisfied: true, unmet, actual, declared: {} };
  }

  for (const tool of requirements.tools ?? []) {
    const resolved = which(tool);
    actual.tools[tool] = resolved;
    if (!resolved) unmet.push(`tools: "${tool}" not found on PATH`);
  }

  if (requirements.gpu) {
    const gpuRequired = requirements.gpu.required === true;
    const gpus = facts.gpu ?? [];
    if (gpuRequired && gpus.length === 0) {
      unmet.push(`gpu: required but none detected (${facts.nvidiaSmi.error ?? "nvidia-smi unavailable"})`);
    }
    if (gpus.length > 0) {
      if (requirements.gpu.minVramGb !== undefined) {
        const best = Math.max(...gpus.map((gpu) => gpu.vramGb ?? 0));
        if (!(best >= requirements.gpu.minVramGb)) {
          unmet.push(`gpu.minVramGb: need >= ${requirements.gpu.minVramGb} GB, found ${best} GB (${gpus.map((g) => g.name).join(", ")})`);
        }
      }
      if (requirements.gpu.minCudaDriver) {
        const driver = gpus.map((gpu) => gpu.cudaDriver).filter(Boolean).sort().pop() ?? null;
        const ok = driver ? compareVersion(driver, `>=${requirements.gpu.minCudaDriver}`) === true : false;
        if (!ok) unmet.push(`gpu.minCudaDriver: need >= ${requirements.gpu.minCudaDriver}, found ${driver ?? "unknown"}`);
      }
      if (requirements.gpu.nameContains) {
        const needle = requirements.gpu.nameContains.toLowerCase();
        if (!gpus.some((gpu) => String(gpu.name ?? "").toLowerCase().includes(needle))) {
          unmet.push(`gpu.nameContains: no GPU matching "${requirements.gpu.nameContains}" (${gpus.map((g) => g.name).join(", ")})`);
        }
      }
    }
  }

  if (requirements.condaEnv) {
    const names = facts.conda.envs.map((env) => env.name);
    const found = names.some((name) => name === requirements.condaEnv || path.basename(name) === requirements.condaEnv);
    if (!facts.conda.available) {
      unmet.push(`condaEnv: conda not available, cannot verify "${requirements.condaEnv}"`);
    } else if (!found) {
      unmet.push(`condaEnv: "${requirements.condaEnv}" not found (known: ${names.slice(0, 12).join(", ") || "none"})`);
    }
  }

  if (requirements.python) {
    const result = spawnSync("python", ["--version"], { encoding: "utf8", windowsHide: true });
    const version = /(\d+\.\d+(?:\.\d+)?)/.exec(String(result.stdout ?? result.stderr ?? ""))?.[1] ?? null;
    actual.python = version;
    if (!version) unmet.push(`python: not found on PATH (wanted ${requirements.python})`);
    else if (compareVersion(version, requirements.python) !== true) {
      unmet.push(`python: need ${requirements.python}, found ${version}`);
    }
  }

  if (requirements.minFreeDiskGb !== undefined) {
    const free = Math.max(...facts.disk.map((disk) => disk.freeGb ?? 0));
    if (!(free >= requirements.minFreeDiskGb)) {
      unmet.push(`minFreeDiskGb: need >= ${requirements.minFreeDiskGb} GB, found ${free} GB`);
    }
  }
  if (requirements.minFreeRamGb !== undefined) {
    if (!(facts.ram.freeGb >= requirements.minFreeRamGb)) {
      unmet.push(`minFreeRamGb: need >= ${requirements.minFreeRamGb} GB, found ${facts.ram.freeGb} GB`);
    }
  }

  return { satisfied: unmet.length === 0, unmet, actual, declared: requirements };
}

// ---------------------------------------------------------------- artifacts

function expandPreset(runRoot, patterns) {
  const files = [];
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      const candidate = path.join(runRoot, pattern);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) files.push(candidate);
      continue;
    }
    const [dirPart, filePart] = pattern.split("*/");
    const baseDir = path.join(runRoot, dirPart);
    if (!fs.existsSync(baseDir)) continue;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(baseDir, entry.name, filePart);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) files.push(candidate);
    }
  }
  return files;
}

function collectArtifacts({ job, settings, resultsDir, workDir, runRoot, extraSources }) {
  const policy = {
    mode: job.artifacts?.mode ?? settings.artifactPolicy.defaultMode ?? "summary",
    maxFileMb: job.artifacts?.maxFileMb ?? settings.artifactPolicy.maxFileMb ?? 5,
    maxTotalMb: job.artifacts?.maxTotalMb ?? settings.artifactPolicy.maxTotalMb ?? 20,
  };
  const patterns = [...(ARTIFACT_PRESETS[policy.mode] ?? []), ...(job.artifacts?.include ?? [])];
  const candidates = runRoot ? expandPreset(runRoot, patterns) : [];
  for (const source of extraSources ?? []) {
    if (source && fs.existsSync(source) && fs.statSync(source).isFile()) candidates.push(source);
  }

  const artifacts = [];
  const skipped = [];
  let totalBytes = 0;

  for (const source of candidates) {
    const bytes = sizeOf(source);
    const relative = isInside(runRoot ?? resultsDir, source)
      ? path.relative(runRoot ?? resultsDir, source).split(path.sep).join("/")
      : path.basename(source);
    const oversized = bytes > policy.maxFileMb * 1024 * 1024;
    const overBudget = totalBytes + bytes > policy.maxTotalMb * 1024 * 1024;
    const overHardCap = bytes > HARD_MAX_FILE_MB * 1024 * 1024 || totalBytes + bytes > HARD_MAX_TOTAL_MB * 1024 * 1024;

    if (oversized || overBudget || overHardCap) {
      const reason = overHardCap
        ? `exceeds hard cap (${HARD_MAX_FILE_MB} MB/file, ${HARD_MAX_TOTAL_MB} MB/job)`
        : oversized ? `exceeds maxFileMb (${policy.maxFileMb})` : `exceeds maxTotalMb (${policy.maxTotalMb})`;
      skipped.push({ path: relative, bytes, reason });
      artifacts.push({
        path: relative,
        role: roleFor(relative),
        bytes,
        sha256: null,
        committed: false,
        localPath: source,
        reason,
      });
      log(`artifact skipped (${reason}): ${relative} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }

    const target = path.join(resultsDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    totalBytes += bytes;
    artifacts.push({
      path: relative,
      role: roleFor(relative),
      bytes,
      sha256: sha256File(target),
      committed: true,
    });
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    jobId: job.jobId,
    mode: policy.mode,
    policy: {
      maxFileMb: policy.maxFileMb,
      maxTotalMb: policy.maxTotalMb,
      hardMaxFileMb: HARD_MAX_FILE_MB,
      hardMaxTotalMb: HARD_MAX_TOTAL_MB,
    },
    artifacts,
    skipped,
  };
  writeJsonAtomic(path.join(resultsDir, "artifacts.json"), manifest);
  return manifest;
}

function roleFor(relative) {
  const base = path.basename(relative);
  if (base === "summary.json") return "summary";
  if (base === "report.html") return "report";
  if (base === "decision-report.md") return "decision";
  if (base === "results.csv") return "csv";
  if (base === "trend.md") return "trend";
  if (base === "console.log" || base === "console.ndjson") return "log";
  if (base.endsWith("trace.jsonl") || base.endsWith("trace.json")) return "trace";
  if (base.endsWith(".zip") || base.endsWith(".7z") || base.endsWith(".tar.gz")) return "bundle";
  return "other";
}

function writeConsoleLog({ job, resultsDir, stdoutPath, stderrPath, execution, settings }) {
  const tailLines = settings.consoleTailLines ?? 2000;
  const out = tailLines0(stdoutPath, tailLines);
  const err = tailLines0(stderrPath, tailLines);
  const lines = [
    `== local-runner console ==`,
    `jobId      : ${job.jobId}`,
    `kind       : ${job.kind}`,
    `host       : ${os.hostname()}`,
    `command    : ${execution.command ?? "(n/a)"}`,
    `cwd        : ${execution.cwd ?? REPO_ROOT}`,
    `exitCode   : ${execution.exitCode ?? "(none)"}${execution.timedOut ? " (timed out)" : ""}`,
    `durationMs : ${execution.durationMs ?? 0}`,
    ``,
    `== stdout (last ${out.lines.length} of ${out.total} lines) ==`,
    ...out.lines,
    ``,
    `== stderr (last ${err.lines.length} of ${err.total} lines) ==`,
    ...err.lines,
    ``,
  ];
  const target = path.join(resultsDir, "console.log");
  fs.writeFileSync(target, lines.join("\n"), "utf8");
  return target;
}

function tailLines0(filePath, maxLines) {
  return tailLines(filePath, maxLines);
}

// ------------------------------------------------------------------ verdicts

function buildVerdict(summary, exitCode, timedOut) {
  const results = Array.isArray(summary?.results) ? summary.results : [];
  const scores = results.map((result) => ({
    variantId: result.variantId,
    status: result.status,
    compositeScore: typeof result.compositeScore === "number" ? result.compositeScore : null,
    judges: {
      passed: (result.judgeResults ?? []).filter((judge) => judge.success).length,
      total: (result.judgeResults ?? []).length,
    },
    durationMs: result.durationMs ?? 0,
  }));
  const failedJudges = [];
  for (const result of results) {
    for (const judge of result.judgeResults ?? []) {
      if (judge.success) continue;
      failedJudges.push({
        variantId: result.variantId,
        judgeId: judge.judgeId,
        label: judge.label,
        critical: judge.critical === true,
        exitCode: judge.exitCode ?? null,
        note: String(judge.stderr ?? judge.stdout ?? "").split(/\r?\n/).filter(Boolean)[0]?.slice(0, 200) ?? "",
      });
    }
  }
  const categories = [...new Set(results.map((result) => result.failureCategory).filter(Boolean))];
  const totals = {
    agentCount: results.length,
    successCount: results.filter((result) => result.status === "success").length,
    tokens: results.reduce((sum, result) => sum + (result.tokenUsage ?? 0), 0),
    costUsd: Number(results.filter((r) => r.costKnown).reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0).toFixed(4)),
  };
  const notes = [];
  if (categories.length > 1) notes.push(`mixed failure categories: ${categories.join(", ")}`);
  let outcome;
  if (timedOut) outcome = "inconclusive";
  else if (results.length === 0) outcome = "error";
  else if (results.every((result) => result.status === "success")) outcome = "pass";
  else outcome = "fail";
  let failureCategory = categories.length === 1 ? categories[0] : categories.length > 1 ? "unknown" : null;
  if (exitCode !== null && exitCode !== 0 && exitCode !== 1 && results.length === 0) {
    outcome = "error";
    failureCategory = "validation";
  }
  return { outcome, failureCategory, totals, scores, failedJudges, notes };
}

function summarizeOneRunSummary(summary) {
  return {
    runId: summary?.runId ?? null,
    createdAt: summary?.createdAt ?? null,
    outputPath: summary?.outputPath ?? null,
    scoreMode: summary?.scoreMode ?? null,
    taskId: summary?.task?.id ?? null,
    taskTitle: summary?.task?.title ?? null,
  };
}

function findRunRoot(workRoot) {
  const runs = fs.existsSync(workRoot)
    ? fs.readdirSync(workRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  const withSummary = runs
    .map((entry) => path.join(workRoot, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "summary.json")))
    .sort((a, b) => fs.statSync(path.join(b, "summary.json")).mtimeMs - fs.statSync(path.join(a, "summary.json")).mtimeMs);
  return withSummary[0] ?? (runs.length === 1 ? path.join(workRoot, runs[0].name) : null);
}

// ---------------------------------------------------------------- execution

function buildBenchmarkArgs(job, settings, outputRoot) {
  const spec = job.spec;
  const args = [
    "run",
    "--repo", path.resolve(REPO_ROOT, spec.repo),
    "--task", path.resolve(REPO_ROOT, spec.task),
    "--agents", spec.agents.map((agent) => agent.baseAgentId).join(","),
    "--output", outputRoot,
  ];
  const options = spec.options ?? {};
  if (options.maxConcurrency !== undefined) args.push("--max-concurrency", String(options.maxConcurrency));
  else if (settings.maxParallelAgents) args.push("--max-concurrency", String(settings.maxParallelAgents));
  if (options.scoreMode) args.push("--score-mode", options.scoreMode);
  if (options.tokenBudget !== undefined) args.push("--token-budget", String(options.tokenBudget));
  if (options.probeAuth) args.push("--probe-auth");
  if (options.updateSnapshots) args.push("--update-snapshots");
  if (options.cleanupWorkspaces) args.push("--cleanup-workspaces");
  if (options.agentTimeoutMs !== undefined) args.push("--agent-timeout", String(options.agentTimeoutMs));
  if (options.repeat !== undefined) args.push("--repeat", String(options.repeat));
  if (options.resume) args.push("--resume", path.resolve(REPO_ROOT, options.resume));
  if (options.locale) args.push("--locale", options.locale);

  // --json and --json-events are mutually exclusive; the last stdout line is a
  // parseable summary either way (verified in packages/cli/src/commands/run.ts).
  if (options.jsonEvents) args.push("--json-events");
  else args.push("--json");

  const perAdapterModelFlags = {
    codex: "--codex-model", claude: "--claude-model", gemini: "--gemini-model", aider: "--aider-model",
    kilo: "--kilo-model", opencode: "--opencode-model", qwen: "--qwen-model", copilot: "--copilot-model",
  };
  for (const agent of spec.agents) {
    const adapterKey = String(agent.baseAgentId).split("-")[0];
    const flag = perAdapterModelFlags[adapterKey];
    if (flag && agent.config?.model) args.push(flag, agent.config.model);
    if (agent.config?.reasoningEffort && adapterKey === "codex") args.push("--codex-reasoning", agent.config.reasoningEffort);
    if (agent.config?.providerProfileId && adapterKey === "claude") args.push("--claude-profile", agent.config.providerProfileId);
  }
  return args;
}

function buildCommandArgs(job) {
  const spec = job.spec;
  if (spec.shell === "powershell") return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", [spec.command, ...(spec.args ?? [])].join(" ")];
  if (spec.shell === "cmd") return ["/d", "/s", "/c", [spec.command, ...(spec.args ?? [])].join(" ")];
  return ["-lc", [spec.command, ...(spec.args ?? [])].join(" ")];
}

function shellCommandFor(shell) {
  if (shell === "powershell") return process.platform === "win32" ? "powershell" : "pwsh";
  if (shell === "cmd") return "cmd";
  return "bash";
}

function probeToJson(facts, probe, extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    probe,
    generatedAt: nowIso(),
    host: facts.host,
    node: facts.node,
    git: facts.git,
    tools: facts.tools,
    cli: {
      selected: facts.cli.selected
        ? { command: facts.cli.selected.command, argsPrefix: facts.cli.selected.argsPrefix, source: facts.cli.selected.source, resolvedPath: facts.cli.selected.resolvedPath }
        : null,
      candidates: facts.cli.candidates.map((candidate) => ({
        command: candidate.command, source: candidate.source, available: candidate.available, resolvedPath: candidate.resolvedPath,
      })),
    },
    gpu: facts.gpu,
    nvidiaSmi: facts.nvidiaSmi,
    conda: { available: facts.conda.available, envs: facts.conda.envs, envCount: facts.conda.envs.length },
    ram: facts.ram,
    disk: facts.disk,
    hardware: facts.hardware,
    ...extra,
  };
}

// ------------------------------------------------------------------- status

function baseStatus(job, state, attempt) {
  const { resultsDir } = dirsFor(job.jobId);
  fs.mkdirSync(resultsDir, { recursive: true });
  return {
    schemaVersion: SCHEMA_VERSION,
    jobId: job.jobId,
    state,
    attempt,
    idempotencyKey: job.idempotencyKey ?? null,
    kind: job.kind,
    requestedBy: job.requestedBy,
    host: { name: os.hostname(), os: `${os.type()} ${os.release()}`, node: process.version, pid: process.pid },
    timing: { queuedAt: null, startedAt: null, finishedAt: null, durationMs: 0, timeoutSeconds: timeoutFor(job) },
  };
}

function timeoutFor(job, settings = DEFAULT_SETTINGS) {
  const defaults = settings.defaultTimeoutSeconds ?? DEFAULT_SETTINGS.defaultTimeoutSeconds;
  return job.timeoutSeconds ?? defaults[job.kind] ?? 600;
}

function saveStatus(jobId, status) {
  writeJsonAtomic(dirsFor(jobId).statusPath, status);
  return status;
}

function archiveJob(jobId) {
  const source = path.join(REPO_ROOT, QUEUE_DIR, `${jobId}.job.json`);
  const target = path.join(REPO_ROOT, ARCHIVE_DIR, `${jobId}.job.json`);
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(source, target);
  } catch {
    fs.copyFileSync(source, target);
    fs.unlinkSync(source);
  }
}

// --------------------------------------------------------------- run a job

async function runJob(jobFile, job, settings, options) {
  const { resultsDir, workDir, statusPath } = dirsFor(job.jobId);
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  const previousStatus = readJsonSafe(statusPath);
  const attempt = options.force || !previousStatus ? (options.force ? (previousStatus?.attempt ?? 0) + 1 : 1) : previousStatus.attempt;
  const timeoutSeconds = timeoutFor(job, settings);

  let status = baseStatus(job, "leased", attempt);
  status.timing.queuedAt = job.createdAt ?? nowIso();
  saveStatus(job.jobId, status);
  writeLease(job.jobId);
  ledgerAppend({ jobId: job.jobId, event: "leased", host: os.hostname(), attempt });

  const heartbeat = setInterval(() => heartbeatLease(job.jobId), HEARTBEAT_MS);
  const startedAt = Date.now();
  status.state = "running";
  status.timing.startedAt = nowIso();
  saveStatus(job.jobId, status);
  ledgerAppend({ jobId: job.jobId, event: "started", host: os.hostname(), attempt });

  const stdoutPath = path.join(workDir, "stdout.log");
  const stderrPath = path.join(workDir, "stderr.log");
  const execution = {
    command: null, cwd: REPO_ROOT, exitCode: null, runId: null,
    durationMs: 0, timedOut: false, stdoutLastLine: null,
  };
  let error = null;
  let verdict = null;
  let runRoot = null;
  let probeResult = null;

  try {
    const facts = gatherFacts(settings);
    const requirements = checkRequirements(job.requirements, facts);
    status.requirements = requirements;
    status.envActual = {
      gpu: facts.gpu,
      conda: { available: facts.conda.available, activeEnv: facts.conda.envs[0]?.name ?? null },
      node: facts.node.version,
      ram: facts.ram,
      disk: facts.disk,
      hardwareReport: facts.hardware.report,
      hardwareGenerated: facts.hardware.generated,
      git: facts.git,
    };
    saveStatus(job.jobId, status);

    if (!requirements.satisfied) {
      error = { code: "requirements-unmet", message: requirements.unmet.join("; ") };
      verdict = { outcome: "inconclusive", failureCategory: "environment", totals: {}, scores: [], failedJudges: [], notes: requirements.unmet };
      log(`requirements unmet for ${job.jobId}: ${error.message}`);
    } else if (job.kind === "benchmark") {
      const results = await runBenchmarkJob({ job, settings, workDir, stdoutPath, stderrPath, execution, timeoutSeconds, facts });
      runRoot = results.runRoot;
      verdict = results.verdict;
      error = results.error;
    } else if (job.kind === "probe") {
      const results = await runProbeJob({ job, settings, workDir, stdoutPath, stderrPath, execution, timeoutSeconds, facts });
      probeResult = results.probeResult;
      verdict = results.verdict;
      error = results.error;
    } else if (job.kind === "command") {
      const results = await runCommandJob({ job, settings, workDir, stdoutPath, stderrPath, execution, timeoutSeconds });
      verdict = results.verdict;
      error = results.error;
    }
  } catch (thrown) {
    error = { code: "internal-error", message: thrown instanceof Error ? thrown.message : String(thrown) };
    verdict = { outcome: "error", failureCategory: "unknown", totals: {}, scores: [], failedJudges: [], notes: [] };
  } finally {
    clearInterval(heartbeat);
  }

  execution.durationMs = Date.now() - startedAt;
  execution.timedOut = Boolean(execution.timedOut);

  // ---- artifacts
  const consolePath = writeConsoleLog({ job, resultsDir, stdoutPath, stderrPath, execution, settings });
  const extras = [consolePath];
  if (probeResult) {
    const probePath = path.join(resultsDir, "probe.json");
    writeJsonAtomic(probePath, probeResult);
    extras.push(probePath);
  }
  const ndjsonPath = path.join(workDir, "events.ndjson");
  if (fs.existsSync(ndjsonPath) && sizeOf(ndjsonPath) <= (settings.maxLogMb ?? 5) * 1024 * 1024) {
    fs.copyFileSync(ndjsonPath, path.join(resultsDir, "console.ndjson"));
  }
  const manifest = collectArtifacts({ job, settings, resultsDir, workDir, runRoot, extraSources: extras });

  // ---- final state
  const state = decideState({ execution, verdict, error });
  status.state = state;
  status.timing.finishedAt = nowIso();
  status.timing.durationMs = execution.durationMs;
  status.execution = {
    command: execution.command,
    cwd: execution.cwd,
    exitCode: execution.exitCode,
    runId: execution.runId,
    timedOut: execution.timedOut,
    stdoutLastLine: execution.stdoutLastLine,
  };
  status.artifacts = manifest.artifacts;
  status.verdict = verdict ?? { outcome: "inconclusive", failureCategory: null, totals: {}, scores: [], failedJudges: [], notes: [] };
  status.error = error;
  const logTail = tailLines0(path.join(resultsDir, "console.log"), 50);
  status.logTail = logTail.lines;
  if (previousStatus?.attempts) status.attempts = previousStatus.attempts;
  status.attempts = [...(status.attempts ?? []), {
    attempt, state, startedAt: status.timing.startedAt, finishedAt: status.timing.finishedAt,
    exitCode: execution.exitCode, error,
  }];
  status.links = {
    report: manifest.artifacts.some((a) => a.role === "report") ? `${RESULTS_DIR}/${job.jobId}/report.html` : null,
    runSummary: manifest.artifacts.some((a) => a.role === "summary") ? `${RESULTS_DIR}/${job.jobId}/summary.json` : null,
    workdir: `${WORK_DIR}/${job.jobId}`,
    console: `${RESULTS_DIR}/${job.jobId}/console.log`,
  };
  const finalStatus = saveStatus(job.jobId, status);
  ledgerAppend({ jobId: job.jobId, event: "finished", state, outcome: status.verdict.outcome, durationMs: execution.durationMs });
  archiveJob(job.jobId);
  releaseLease(job.jobId);

  log(`${job.jobId}: ${state} (outcome=${status.verdict.outcome}${error ? `, error=${error.code}` : ""}) in ${(execution.durationMs / 1000).toFixed(1)}s -> ${path.relative(REPO_ROOT, statusPath)}`);
  return finalStatus;
}

function decideState({ execution, verdict, error }) {
  if (execution.timedOut) return "timed_out";
  if (error?.code === "policy-rejected" || error?.code === "unsupported-kind" || error?.code === "unsupported-schema") return "skipped";
  if (execution.spawnError) return "failed";
  if (execution.exitCode === 0) return "succeeded";
  if (execution.exitCode === null) return "failed";
  return "failed";
}

async function runBenchmarkJob({ job, settings, workDir, stdoutPath, stderrPath, execution, timeoutSeconds, facts }) {
  const cli = facts.cli.selected ?? pickCli(settings);
  if (!cli) {
    return {
      runRoot: null,
      verdict: { outcome: "error", failureCategory: "environment", totals: {}, scores: [], failedJudges: [], notes: ["agentarena CLI not found"] },
      error: { code: "engine-error", message: "agentarena CLI not found: install it globally or build packages/cli (pnpm build), or set settings.arenaCli" },
    };
  }
  const args = buildBenchmarkArgs(job, settings, workDir);
  execution.command = [cli.command, ...cli.argsPrefix, ...args].join(" ");
  execution.cwd = REPO_ROOT;
  const result = await runCapture({
    command: cli.command,
    args: [...cli.argsPrefix, ...args],
    cwd: REPO_ROOT,
    timeoutMs: timeoutSeconds * 1000,
    stdoutPath,
    stderrPath,
  });
  execution.exitCode = result.exitCode;
  execution.timedOut = result.timedOut;

  const runRoot = findRunRoot(workDir);
  let summary = null;
  if (runRoot && fs.existsSync(path.join(runRoot, "summary.json"))) {
    summary = readJsonSafe(path.join(runRoot, "summary.json"));
  }
  const stdoutTail = tailLines0(stdoutPath, 1).lines;
  execution.stdoutLastLine = stdoutTail[stdoutTail.length - 1]?.slice(0, 500) ?? null;
  const verdict = buildVerdict(summary ?? parseStdoutSummary(stdoutPath), result.exitCode, result.timedOut);
  if (summary) {
    execution.runId = summary.runId ?? null;
    const meta = summarizeOneRunSummary(summary);
    verdict.notes = [...(verdict.notes ?? []), ...(meta.taskId ? [`task: ${meta.taskId}`] : [])];
  }
  let error = null;
  if (result.spawnError) error = { code: "engine-error", message: result.spawnError };
  else if (result.timedOut) error = { code: "timeout", message: `killed after ${timeoutSeconds}s` };
  else if (result.exitCode === 1) error = { code: "engine-error", message: "agentarena run reported at least one failed agent" };
  else if (result.exitCode !== 0 && result.exitCode !== null) error = { code: "engine-error", message: `agentarena run exited with code ${result.exitCode}` };
  if (!summary && result.exitCode === 0) {
    verdict.notes = [...(verdict.notes ?? []), "no summary.json found under the output root"];
  }
  return { runRoot, verdict, error };
}

function parseStdoutSummary(stdoutPath) {
  const { lines } = tailLines0(stdoutPath, 200);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "summary" && Array.isArray(parsed.runs)) {
        return parsed.runs.length === 1 ? parsed.runs[0] : { results: parsed.runs.flatMap((run) => run.results ?? []) };
      }
      return parsed;
    } catch { /* keep scanning */ }
  }
  return null;
}

async function runProbeJob({ job, settings, workDir, stdoutPath, stderrPath, execution, timeoutSeconds, facts }) {
  const probe = job.spec.probe;
  const base = { outcome: "pass", failureCategory: null, totals: {}, scores: [], failedJudges: [], notes: [] };

  if (probe === "capability" || probe === "hardware") {
    const probeJson = probeToJson(facts, probe, {
      checks: [
        { name: "agentarena-cli", ok: Boolean(facts.cli.selected), detail: facts.cli.selected ? `${facts.cli.selected.command} (${facts.cli.selected.source})` : "not found" },
        { name: "nvidia-smi", ok: facts.nvidiaSmi.available, detail: facts.nvidiaSmi.error ?? `${facts.gpu.length} GPU(s)` },
        { name: "conda", ok: facts.conda.available, detail: `${facts.conda.envs.length} env(s)` },
        { name: "hardware-report", ok: Boolean(facts.hardware.report), detail: facts.hardware.generated ?? "no report yet (run .\\hardware.ps1 -Deep)" },
      ],
    });
    if (!facts.hardware.report) base.notes.push("no results/hardware/latest.json yet - ask the user to run .\\hardware.ps1 -Deep");
    if (!facts.cli.selected) base.notes.push("agentarena CLI not resolvable - benchmark jobs will fail until it is installed or built");
    execution.command = `(probe:${probe})`;
    execution.cwd = REPO_ROOT;
    execution.exitCode = 0;
    return { probeResult: probeJson, verdict: base, error: null };
  }

  if (probe === "nvidia-smi" || probe === "conda-env-list" || probe === "doctor" || probe === "agentarena-version") {
    let command;
    let args;
    if (probe === "nvidia-smi") {
      command = "nvidia-smi";
      args = [];
    } else if (probe === "conda-env-list") {
      command = "conda";
      args = ["env", "list"];
    } else {
      const cli = facts.cli.selected ?? pickCli(settings);
      if (!cli) {
        return {
          probeResult: null,
          verdict: { ...base, outcome: "error", failureCategory: "environment", notes: ["agentarena CLI not found"] },
          error: { code: "engine-error", message: "agentarena CLI not found" },
        };
      }
      command = cli.command;
      args = probe === "agentarena-version" ? [...cli.argsPrefix, "--version"] : [...cli.argsPrefix, "doctor"];
    }
    execution.command = [command, ...args].join(" ");
    execution.cwd = REPO_ROOT;
    const result = await runCapture({ command, args: args, cwd: REPO_ROOT, timeoutMs: timeoutSeconds * 1000, stdoutPath, stderrPath });
    execution.exitCode = result.exitCode;
    execution.timedOut = result.timedOut;
    const verdict = { ...base };
    let error = null;
    if (result.timedOut) error = { code: "timeout", message: `killed after ${timeoutSeconds}s` };
    else if (result.exitCode !== 0) {
      error = { code: "engine-error", message: `${command} exited with code ${result.exitCode}` };
      verdict.outcome = "error";
      verdict.failureCategory = "environment";
    }
    const probeJson = probeToJson(facts, probe, {
      argv: [command, ...args],
      exitCode: result.exitCode,
      stdoutTail: tailLines0(stdoutPath, 40).lines,
    });
    return { probeResult: probeJson, verdict, error };
  }

  return {
    probeResult: null,
    verdict: { ...base, outcome: "inconclusive", notes: [`unsupported probe: ${probe}`] },
    error: { code: "unsupported-kind", message: `probe "${probe}" is not supported by this executor` },
  };
}

async function runCommandJob({ job, settings, workDir, stdoutPath, stderrPath, execution, timeoutSeconds }) {
  const base = { outcome: "pass", failureCategory: null, totals: {}, scores: [], failedJudges: [], notes: [] };
  if (!settings.allowRiskyCommands || job.spec.allowRisky !== true) {
    return {
      verdict: { ...base, outcome: "inconclusive", notes: ["kind=command requires spec.allowRisky=true AND settings.allowRiskyCommands=true"] },
      error: { code: "policy-rejected", message: "command jobs are disabled (set local-runs/state/settings.json allowRiskyCommands=true to enable)" },
    };
  }
  const command = shellCommandFor(job.spec.shell);
  const args = buildCommandArgs(job);
  const cwd = job.spec.cwd ? path.resolve(REPO_ROOT, job.spec.cwd) : REPO_ROOT;
  if (!isInside(REPO_ROOT, cwd)) {
    return {
      verdict: { ...base, outcome: "error", notes: ["cwd escapes the repository root"] },
      error: { code: "policy-rejected", message: `cwd "${job.spec.cwd}" escapes the repository root` },
    };
  }
  execution.command = [command, ...args].join(" ");
  execution.cwd = cwd;
  const result = await runCapture({ command, args, cwd, timeoutMs: timeoutSeconds * 1000, stdoutPath, stderrPath });
  execution.exitCode = result.exitCode;
  execution.timedOut = result.timedOut;
  let error = null;
  if (result.timedOut) error = { code: "timeout", message: `killed after ${timeoutSeconds}s` };
  else if (result.exitCode !== 0) error = { code: "engine-error", message: `command exited with code ${result.exitCode}` };
  return { verdict: { ...base, outcome: result.exitCode === 0 ? "pass" : "error" }, error };
}

// --------------------------------------------------------------- queue scan

function scanQueue(settings, options) {
  const queueDir = path.join(REPO_ROOT, QUEUE_DIR);
  if (!fs.existsSync(queueDir)) return { ready: [], blocked: [] };
  const ready = [];
  const blocked = [];
  const entries = fs.readdirSync(queueDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".job.json"));

  for (const entry of entries) {
    const file = path.join(queueDir, entry.name);
    const jobIdFromName = entry.name.replace(/\.job\.json$/, "");
    if (!JOB_ID_RE.test(jobIdFromName)) {
      blocked.push({ file, jobId: jobIdFromName, reason: "file name must be <jobId>.job.json", terminal: true });
      continue;
    }
    const job = readJsonSafe(file);
    if (!job) {
      blocked.push({ file, jobId: jobIdFromName, reason: "job file is not valid JSON", terminal: true });
      continue;
    }
    const validation = validateJob(job);
    if (!validation.valid) {
      blocked.push({ file, job, jobId: job.jobId ?? jobIdFromName, reason: `job failed validation: ${validation.errors[0]}`, terminal: true });
      continue;
    }
    if (options.jobId && job.jobId !== options.jobId) continue;
    if (!settings.allowedKinds.includes(job.kind)) {
      blocked.push({ file, job, jobId: job.jobId, reason: `kind "${job.kind}" is not allowed by local policy`, terminal: true });
      continue;
    }
    if (job.kind === "probe" && !settings.allowedProbes.includes(job.spec.probe)) {
      blocked.push({ file, job, jobId: job.jobId, reason: `probe "${job.spec.probe}" is not allowed by local policy`, terminal: true });
      continue;
    }
    const existing = readStatus(job.jobId);
    if (!options.force && isTerminal(existing)) {
      if (job.idempotencyKey && existing.idempotencyKey && job.idempotencyKey === existing.idempotencyKey) {
        blocked.push({ file, job, jobId: job.jobId, reason: `already finished (idempotencyKey ${job.idempotencyKey} reused)`, terminal: false, reuse: true });
        continue;
      }
      if (!job.idempotencyKey) {
        blocked.push({ file, job, jobId: job.jobId, reason: "already has a terminal result (use --force to rerun)", terminal: false, reuse: true });
        continue;
      }
    }
    const unmetDeps = (job.dependsOn ?? []).filter((dep) => !isTerminal(readStatus(dep)) || readStatus(dep)?.state === "failed");
    if (unmetDeps.length > 0) {
      blocked.push({ file, job, jobId: job.jobId, reason: `dependency not satisfied: ${unmetDeps.join(", ")}`, terminal: false });
      continue;
    }
    ready.push({ file, job });
  }

  ready.sort((a, b) => {
    const priority = (a.job.priority ?? 5) - (b.job.priority ?? 5);
    if (priority !== 0) return priority;
    const created = String(a.job.createdAt ?? "").localeCompare(String(b.job.createdAt ?? ""));
    if (created !== 0) return created;
    return a.job.jobId.localeCompare(b.job.jobId);
  });
  return { ready, blocked };
}

function rejectJob(candidate, settings) {
  const job = candidate.job ?? {
    schemaVersion: SCHEMA_VERSION,
    jobId: candidate.jobId,
    kind: "benchmark",
    requestedBy: { branch: "unknown", session: "unknown" },
  };
  const status = baseStatus(job, "skipped", 1);
  status.timing.queuedAt = job.createdAt ?? nowIso();
  status.timing.startedAt = nowIso();
  status.timing.finishedAt = nowIso();
  status.verdict = { outcome: "inconclusive", failureCategory: null, totals: {}, scores: [], failedJudges: [], notes: [candidate.reason] };
  const reason = candidate.reason;
  status.error = {
    code: reason.startsWith("kind ") || reason.startsWith("probe ") ? "policy-rejected"
      : /validation|not valid JSON|file name/.test(reason) ? "unsupported-schema"
        : "internal-error",
    message: reason,
  };
  saveStatus(job.jobId, status);
  ledgerAppend({ jobId: job.jobId, event: "rejected", reason: candidate.reason });
  archiveJob(job.jobId);
  log(`${job.jobId}: skipped (${candidate.reason})`);
}

// -------------------------------------------------------------------- entry

/**
 * Refuse to drain inside the agent sandbox: jobs are meant for the USER's real
 * machine (GPU / conda / CLI agents live there). Running a drain here would
 * consume a queued job and write a meaningless verdict (sandbox host, no GPU)
 * into the branch - which is exactly what happened once during S2 testing.
 * Override with --allow-sandbox (e2e tests) or LOCAL_RUNNER_ALLOW_SANDBOX=1.
 */
function isSandboxEnvironment() {
  if (process.env.LOCAL_RUNNER_ALLOW_SANDBOX === "1") return false;
  const host = os.hostname().toLowerCase();
  return host === "e2b.local" || host.endsWith(".e2b.local") || REPO_ROOT.startsWith("/home/user/");
}

function parseArgs(argv) {
  const options = { drainOnce: true, maxJobs: null, jobId: null, force: false, dryRun: false, selfTest: false, allowSandbox: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--drain-once") options.drainOnce = true;
    else if (arg === "--max-jobs") options.maxJobs = Number.parseInt(argv[++i] ?? "", 10);
    else if (arg === "--job") options.jobId = argv[++i] ?? null;
    else if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--allow-sandbox") options.allowSandbox = true;
    else if (arg === "-h" || arg === "--help") {
      console.log("usage: node code/local-runner.mjs [--drain-once] [--max-jobs N] [--job <jobId>] [--force] [--dry-run] [--self-test]");
      return { help: true };
    } else {
      console.error(`[ERROR] unknown argument: ${arg}`);
      return { usageError: true };
    }
  }
  if (options.maxJobs !== null && (!Number.isInteger(options.maxJobs) || options.maxJobs < 1)) {
    console.error("[ERROR] --max-jobs must be a positive integer");
    return { usageError: true };
  }
  return options;
}

/**
 * Structured evidence for the sandbox: written on EVERY drain attempt (even
 * "nothing to do"). The watcher's own output capture has proven unreliable on
 * some machines, so this tracked file is how the agent verifies that the runner
 * actually ran and what it saw. See docs/local-runner-protocol.md section 10.
 */
function writeDrainReport(report) {
  try {
    writeJsonAtomic(path.join(REPO_ROOT, "local-runs", "drain-last.json"), {
      schemaVersion: SCHEMA_VERSION,
      ts: nowIso(),
      host: os.hostname(),
      repoRoot: REPO_ROOT,
      cwd: process.cwd(),
      node: process.version,
      exitCode: report.exitCode,
      ran: report.ran,
      reason: report.reason,
      jobsSeen: report.jobsSeen ?? [],
      results: report.results ?? [],
    });
  } catch (error) {
    log(`warn: could not write local-runs/drain-last.json (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return 0;
  if (options.usageError) return 2;
  if (options.selfTest) return runSelfTest();

  if (isSandboxEnvironment() && !options.allowSandbox) {
    log("refused: this looks like the agent sandbox, not the user's machine - jobs belong to the real machine");
    log("         (use --allow-sandbox or LOCAL_RUNNER_ALLOW_SANDBOX=1 only for e2e tests)");
    writeDrainReport({ exitCode: 0, ran: false, reason: "sandbox-environment (refused)", jobsSeen: [], results: [] });
    return 0;
  }

  const settings = loadSettings();
  const lease = readLease();
  if (lease && leaseActive(lease) && !options.force && lease.jobId !== options.jobId) {
    log(`busy: ${lease.jobId} holds the lease until ${lease.expiresAt}`);
    writeDrainReport({ exitCode: 0, ran: false, reason: `busy: lease held by ${lease.jobId}`, jobsSeen: [], results: [] });
    return 0;
  }

  const { ready, blocked } = scanQueue(settings, options);
  for (const candidate of blocked) {
    if (candidate.reuse) {
      log(`${candidate.jobId}: ${candidate.reason}`);
      if (!options.dryRun) archiveJob(candidate.jobId);
    } else if (candidate.terminal) {
      if (options.dryRun) log(`${candidate.jobId}: would reject (${candidate.reason})`);
      else rejectJob(candidate, settings);
    } else {
      log(`${candidate.jobId}: waiting (${candidate.reason})`);
    }
  }

  if (ready.length === 0) {
    log("no queued jobs");
    writeDrainReport({
      exitCode: 0,
      ran: false,
      reason: blocked.length > 0 ? `no ready jobs (${blocked.length} blocked/waiting)` : "no queued jobs",
      jobsSeen: blocked.map((candidate) => ({ jobId: candidate.jobId, reason: candidate.reason })),
      results: [],
    });
    return 0;
  }

  const limit = options.maxJobs ?? settings.maxJobsPerDrain ?? 1;
  const selected = ready.slice(0, limit);
  log(`${ready.length} job(s) ready, running ${selected.length}`);

  if (options.dryRun) {
    for (const candidate of selected) log(`would run: ${candidate.job.jobId} (${candidate.job.kind})`);
    writeDrainReport({
      exitCode: 0, ran: false, reason: "dry-run",
      jobsSeen: ready.map((candidate) => ({ jobId: candidate.job.jobId, kind: candidate.job.kind })),
      results: [],
    });
    return 0;
  }

  let failed = 0;
  const results = [];
  for (const candidate of selected) {
    if (leaseActive(readLease())) {
      log(`stopping: lease taken by ${readLease().jobId}`);
      break;
    }
    ledgerAppend({ jobId: candidate.job.jobId, event: "queued", by: candidate.job.requestedBy?.session ?? "unknown" });
    const status = await runJob(candidate.file, candidate.job, settings, options);
    results.push({ jobId: status.jobId, state: status.state, outcome: status.verdict?.outcome ?? null, error: status.error?.code ?? null });
    if (["failed", "timed_out"].includes(status.state)) failed = 1;
  }
  writeDrainReport({
    exitCode: failed, ran: true, reason: null,
    jobsSeen: ready.map((candidate) => ({ jobId: candidate.job.jobId, kind: candidate.job.kind })),
    results,
  });
  return failed;
}

// ---------------------------------------------------------------- self test

function runSelfTest() {
  const checks = [];
  const assert = (name, condition, detail = "") => {
    checks.push({ name, ok: Boolean(condition), detail });
    if (!condition) console.log(`[FAIL] ${name} ${detail}`);
  };

  const goodJob = {
    schemaVersion: "1.0",
    jobId: "20260915-001-demo-smoke",
    createdAt: "2026-09-15T07:40:00Z",
    kind: "benchmark",
    requestedBy: { branch: "arena/x", session: "arena-x" },
    reason: "self test",
    spec: { repo: ".", task: "examples/taskpacks/demo-repo-health.json", agents: [{ baseAgentId: "demo-fast" }], options: { scoreMode: "balanced", locale: "zh-CN" } },
  };
  assert("validateJob accepts a good job", validateJob(goodJob).valid);
  assert("validateJob rejects a bad jobId", !validateJob({ ...goodJob, jobId: "nope" }).valid);
  assert("validateJob rejects an authored variantId", !validateJob({ ...goodJob, spec: { ...goodJob.spec, agents: [{ baseAgentId: "x", variantId: "x" }] } }).valid);
  assert("validateJob rejects kind/spec mismatch", !validateJob({ ...goodJob, kind: "probe" }).valid);

  const args = buildBenchmarkArgs(goodJob, DEFAULT_SETTINGS, "/tmp/work");
  assert("benchmark args include --json", args.includes("--json") && !args.includes("--json-events"), args.join(" "));
  assert("benchmark args include --agents", args.join(" ").includes("--agents demo-fast"));
  const eventJob = { ...goodJob, spec: { ...goodJob.spec, options: { jsonEvents: true } } };
  const eventArgs = buildBenchmarkArgs(eventJob, DEFAULT_SETTINGS, "/tmp/work");
  assert("jsonEvents switches to --json-events (never both)", eventArgs.includes("--json-events") && !eventArgs.includes("--json"), eventArgs.join(" "));
  const configuredJob = { ...goodJob, spec: { ...goodJob.spec, agents: [{ baseAgentId: "codex", config: { model: "gpt-5.4", reasoningEffort: "high" } }] } };
  const configuredArgs = buildBenchmarkArgs(configuredJob, DEFAULT_SETTINGS, "/tmp/work");
  assert("per-adapter flags are mapped", configuredArgs.join(" ").includes("--codex-model gpt-5.4") && configuredArgs.join(" ").includes("--codex-reasoning high"), configuredArgs.join(" "));

  assert("compareVersion >= works", compareVersion("3.11.9", ">=3.10") === true && compareVersion("3.9.1", ">=3.10") === false);

  const verdict = buildVerdict({
    results: [
      { variantId: "a", status: "success", compositeScore: 0.8, judgeResults: [{ judgeId: "j1", success: true }], tokenUsage: 10, costKnown: true, estimatedCostUsd: 0.01, durationMs: 5 },
      { variantId: "b", status: "failed", failureCategory: "environment", compositeScore: null, judgeResults: [{ judgeId: "j2", success: false, label: "tests", critical: true, exitCode: 1, stderr: "boom" }], tokenUsage: 0, costKnown: false, estimatedCostUsd: 0, durationMs: 7 },
    ],
  }, 1, false);
  assert("verdict outcome=fail with one failed agent", verdict.outcome === "fail");
  assert("verdict collects failed judges", verdict.failedJudges.length === 1 && verdict.failedJudges[0].judgeId === "j2");
  assert("verdict totals count tokens/cost", verdict.totals.tokens === 10 && verdict.totals.costUsd === 0.01);
  assert("verdict single failure category is propagated", verdict.failureCategory === "environment");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "local-runner-selftest-"));
  try {
    const resultsDir = path.join(tmp, "results");
    const runRoot = path.join(tmp, "run");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(path.join(runRoot, "summary.json"), JSON.stringify({ runId: "r1", results: [] }), "utf8");
    fs.writeFileSync(path.join(runRoot, "report.html"), "<html></html>", "utf8");
    fs.writeFileSync(path.join(runRoot, "huge.bin"), Buffer.alloc(6 * 1024 * 1024));
    const manifest = collectArtifacts({
      job: { jobId: "20260915-001-self", artifacts: { mode: "full", include: ["huge.bin"] } },
      settings: DEFAULT_SETTINGS,
      resultsDir,
      workDir: tmp,
      runRoot,
      extraSources: [],
    });
    const summaryEntry = manifest.artifacts.find((a) => a.path === "summary.json");
    const hugeEntry = manifest.artifacts.find((a) => a.path === "huge.bin");
    assert("artifact in policy is committed with sha256", summaryEntry?.committed === true && /^[0-9a-f]{64}$/.test(summaryEntry.sha256));
    assert("oversized artifact is manifest-only", hugeEntry?.committed === false && hugeEntry.localPath && /maxFileMb/.test(hugeEntry.reason));
    assert("artifacts.json is written", fs.existsSync(path.join(resultsDir, "artifacts.json")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const failed = checks.filter((check) => !check.ok).length;
  console.log(`[local-runner] self-test: ${checks.length - failed}/${checks.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`[local-runner] fatal: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 3;
  });
