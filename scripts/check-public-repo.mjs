#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const POLICY_FILES = new Set([
  "scripts/check-public-repo.mjs",
  "tests/public-repo-hygiene.test.js",
]);

const decodePolicyTerms = (values) => values.map((value) => Buffer.from(value, "base64").toString("utf8"));
const PLACE_TERMS = [
  "\u5e7f\u5dde", "\u6df1\u5733", "\u5317\u4eac", "\u4e0a\u6d77", "\u676d\u5dde", "\u6210\u90fd", "\u9999\u6e2f", "\u65b0\u52a0\u5761", "\u4e1c\u4eac", "\u9996\u5c14",
  ...decodePolicyTerms([
    "Z3Vhbmd6aG91", "c2hlbnpoZW4=", "YmVpamluZw==", "c2hhbmdoYWk=", "aGFuZ3pob3U=", "Y2hlbmdkdQ==",
    "aG9uZy1rb25n", "aG9uZyBrb25n", "c2luZ2Fwb3Jl", "dG9reW8=", "c2VvdWw=", "ZnJhbmtmdXJ0",
    "dmlyZ2luaWE=", "c2lsaWNvbi12YWxsZXk=", "c2lsaWNvbiB2YWxsZXk=",
  ]),
];

const INFRASTRUCTURE_FINGERPRINTS = decodePolicyTerms([
  "dGFpbHNjYWxl", "dGFpbG5ldA==", "YWxpeXVu", "YWxpY2xvdWQ=", "dGVuY2VudCBjbG91ZA==",
  "dGVuY2VudC1jbG91ZA==", "YWxpYmFiYSBjbG91ZA==", "YW1hem9uIHdlYiBzZXJ2aWNlcw==",
  "bWljcm9zb2Z0IGF6dXJl", "Z29vZ2xlIGNsb3VkIHBsYXRmb3Jt", "Y2xvdWRmbGFyZQ==",
]);
const INFRASTRUCTURE_ACRONYM = new RegExp(`\\b(?:${decodePolicyTerms(["YXdz", "YXp1cmU=", "Z2Nw", "ZWNz"]).join("|")})\\b`, "gi");

const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519)(?:\.|$)/i,
  /\.(?:pem|p12|pfx|jks|keystore)$/i,
];

const RUNTIME_PATH_PATTERNS = [
  /(^|\/)(?:data|backups?|snapshots?|\.logs?|\.run)(?:\/|$)/i,
  /(^|\/)(?:texashold|runtime-rooms|history-events|replication-state)\.json$/i,
  /\.(?:db|db-wal|db-shm|sqlite|sqlite3|rdb|dump|bak|sql\.gz)$/i,
  /\.jsonl(?:\.|$)/i,
];

const SAFE_USER_SEGMENTS = new Set(["<user>", "<username>", "example", "private-name", "username", "user"]);
const SAFE_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SAFE_DATABASE_SUFFIXES = [".example", ".example.com", ".invalid", ".test"];
const SAFE_PUBLIC_HOSTS = new Set([
  "localhost", "0.0.0.0", "127.0.0.1", "::", "::1",
  "registry.npmjs.org", "github.com", "fonts.googleapis.com", "design-tokens.github.io",
  "opencollective.com", "tidelift.com", "www.w3.org",
]);

function runGit(root, args, { allowFailure = false, encoding = "utf8" } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr || "").trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function splitNul(value) {
  return String(value || "").split("\0").filter(Boolean);
}

function isExampleEnv(relativePath) {
  const base = path.posix.basename(relativePath);
  return base === ".env.example" || base.endsWith(".env.example");
}

function allowedSqlPath(relativePath) {
  return /^(?:database\/(?:schema|fixtures)|tests\/fixtures)\/.+\.sql$/i.test(relativePath);
}

function pathIssues(relativePath) {
  const issues = [];
  const normalized = relativePath.replaceAll(path.sep, "/");

  for (const pattern of SECRET_PATH_PATTERNS) {
    if (pattern.test(normalized) && !isExampleEnv(normalized)) {
      issues.push({ code: "tracked-secret-path", file: normalized, message: "environment or credential file must not be public" });
      break;
    }
  }
  const runtimeComparablePath = normalized.startsWith("deploy/backup/")
    ? normalized.replace(/^deploy\/backup\//, "deploy/backup-source/")
    : normalized;
  for (const pattern of RUNTIME_PATH_PATTERNS) {
    if (pattern.test(runtimeComparablePath)) {
      issues.push({ code: "tracked-runtime-data", file: normalized, message: "runtime data, database, backup, or log artifact must not be public" });
      break;
    }
  }
  if (/\.sql$/i.test(normalized) && !allowedSqlPath(normalized)) {
    issues.push({ code: "sql-outside-allowlist", file: normalized, message: "SQL is allowed only under database/schema, database/fixtures, or tests/fixtures" });
  }

  const lower = normalized.toLowerCase();
  for (const term of PLACE_TERMS) {
    if (lower.includes(term.toLowerCase())) {
      issues.push({ code: "location-in-path", file: normalized, message: "deployment geography must not appear in a public path" });
      break;
    }
  }
  return issues;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (text.charCodeAt(position) === 10) line += 1;
  }
  return line;
}

function isSafeIp(value) {
  if (net.isIPv4(value)) return value === "0.0.0.0" || value.startsWith("127.");
  if (net.isIPv6(value)) return value === "::" || value === "::1" || value.toLowerCase().startsWith("::ffff:127.");
  return true;
}

function isSafeDatabaseUrl(rawUrl, relativePath) {
  if (!isExampleEnv(relativePath)) return false;
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const safeHost = SAFE_DATABASE_HOSTS.has(hostname) || SAFE_DATABASE_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
    const placeholderCredential = (value) => !value || /^(?:example|change-me|placeholder|user|username|password|<[^>]+>)$/i.test(decodeURIComponent(value));
    return safeHost && placeholderCredential(parsed.username) && placeholderCredential(parsed.password);
  } catch {
    return false;
  }
}

function isSafePublicHost(hostname) {
  const lower = hostname.toLowerCase();
  return SAFE_PUBLIC_HOSTS.has(lower)
    || lower.startsWith("127.")
    || SAFE_DATABASE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function contentIssues(relativePath, text) {
  if (POLICY_FILES.has(relativePath)) return [];
  const issues = [];
  const lower = text.toLowerCase();

  for (const term of PLACE_TERMS) {
    let index = lower.indexOf(term.toLowerCase());
    while (index >= 0) {
      issues.push({
        code: "deployment-location",
        file: relativePath,
        line: lineNumberAt(text, index),
        message: "deployment geography must not appear in public content",
      });
      index = lower.indexOf(term.toLowerCase(), index + term.length);
    }
  }

  for (const term of INFRASTRUCTURE_FINGERPRINTS) {
    let index = lower.indexOf(term);
    while (index >= 0) {
      issues.push({
        code: "infrastructure-fingerprint",
        file: relativePath,
        line: lineNumberAt(text, index),
        message: "private network or cloud-provider fingerprints must not be public",
      });
      index = lower.indexOf(term, index + term.length);
    }
  }
  for (const match of text.matchAll(INFRASTRUCTURE_ACRONYM)) {
    issues.push({
      code: "infrastructure-fingerprint",
      file: relativePath,
      line: lineNumberAt(text, match.index),
      message: "private network or cloud-provider fingerprints must not be public",
    });
  }

  const ipv4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
  for (const match of text.matchAll(ipv4)) {
    if (net.isIPv4(match[0]) && !isSafeIp(match[0])) {
      issues.push({
        code: "network-address",
        file: relativePath,
        line: lineNumberAt(text, match.index),
        message: "only loopback or wildcard IPv4 addresses may be public",
      });
    }
  }

  const bracketedIpv6 = /\[([0-9a-f:]+)\]/gi;
  for (const match of text.matchAll(bracketedIpv6)) {
    if (net.isIPv6(match[1]) && !isSafeIp(match[1])) {
      issues.push({
        code: "network-address",
        file: relativePath,
        line: lineNumberAt(text, match.index),
        message: "only loopback or wildcard IPv6 addresses may be public",
      });
    }
  }

  const unixHome = /\/(?:Users|home)\/([^/\s"'`)]+)/g;
  for (const match of text.matchAll(unixHome)) {
    if (!SAFE_USER_SEGMENTS.has(match[1].toLowerCase())) {
      issues.push({
        code: "personal-absolute-path",
        file: relativePath,
        line: lineNumberAt(text, match.index),
        message: "personal home-directory paths must not be public",
      });
    }
  }
  const windowsHome = /[A-Za-z]:\\Users\\([^\\\s"'`)]+)/g;
  for (const match of text.matchAll(windowsHome)) {
    if (!SAFE_USER_SEGMENTS.has(match[1].toLowerCase())) {
      issues.push({
        code: "personal-absolute-path",
        file: relativePath,
        line: lineNumberAt(text, match.index),
        message: "personal home-directory paths must not be public",
      });
    }
  }

  const currentHome = os.homedir();
  if (currentHome && text.includes(currentHome)) {
    issues.push({
      code: "current-home-path",
      file: relativePath,
      line: lineNumberAt(text, text.indexOf(currentHome)),
      message: "the current user's absolute home path must not be public",
    });
  }

  const emailAddress = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
  for (const match of text.matchAll(emailAddress)) {
    const domain = match[1].toLowerCase();
    const safe = domain === "example.com"
      || domain === "users.noreply.github.com"
      || domain.endsWith(".example")
      || domain.endsWith(".invalid")
      || domain.endsWith(".test");
    if (!safe) {
      issues.push({
        code: "personal-email",
        file: relativePath,
        line: lineNumberAt(text, match.index),
        message: "personal or deployment email addresses must not be public",
      });
    }
  }

  const databaseUrl = /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|mssql|oracle):\/\/[^\s"'`]+/gi;
  for (const match of text.matchAll(databaseUrl)) {
    if (!isSafeDatabaseUrl(match[0], relativePath)) {
      issues.push({
        code: "database-url",
        file: relativePath,
        line: lineNumberAt(text, match.index),
        message: "real database connection URLs must not be public",
      });
    }
  }

  const publicUrl = /(?:https?|wss?|ssh):\/\/[^\s"'`<>)]+/gi;
  for (const match of text.matchAll(publicUrl)) {
    if (match[0].includes("$(") || match[0].includes("${")) continue;
    try {
      const parsed = new URL(match[0]);
      if (!isSafePublicHost(parsed.hostname)) {
        issues.push({
          code: "deployment-url",
          file: relativePath,
          line: lineNumberAt(text, match.index),
          message: "non-example deployment URL or hostname must not be public",
        });
      }
    } catch {
      // Environment substitutions are validated by the assignment rule below.
    }
  }

  const deploymentAssignment = /^[ \t]*(?:APP_ORIGINS?|CORS_ORIGINS?|HEALTH_URL|PUBLIC_URL|[A-Z0-9_]+_(?:HOST|HOSTNAME|URL|REMOTE))[ \t]*[:=][ \t]*([^\r\n]*)$/gm;
  for (const match of text.matchAll(deploymentAssignment)) {
    const value = match[1].trim().replace(/[;,][ \t]*$/, "").replace(/^['"]|['"]$/g, "");
    if (!value || value.includes("${") || /^(?:<[^>]+>|example|change-me)$/i.test(value)) continue;
    if (/^[A-Za-z_$][\w.$()[\]]*$/.test(value)) continue;
    const entries = value.split(",").map((entry) => entry.trim());
    const unsafe = entries.some((entry) => {
      const remoteHost = entry.includes("@") && !entry.includes("://") ? entry.slice(entry.lastIndexOf("@") + 1) : entry;
      try {
        const parsed = new URL(remoteHost.includes("://") ? remoteHost : `ssh://${remoteHost}`);
        return !isSafePublicHost(parsed.hostname);
      } catch {
        return true;
      }
    });
    if (unsafe) {
      issues.push({
        code: "deployment-host",
        file: relativePath,
        line: lineNumberAt(text, match.index),
        message: "deployment host settings must use loopback, an example domain, or an ignored environment file",
      });
    }
  }

  const databaseAssignment = /^[ \t]*(?:DATABASE_URL|DB_(?:HOST|PORT|NAME|USER|USERNAME|PASSWORD)|POSTGRES_(?:DB|USER|PASSWORD)|MYSQL_(?:DATABASE|USER|PASSWORD|ROOT_PASSWORD))[ \t]*[:=][ \t]*([^\r\n]*)$/gim;
  for (const match of text.matchAll(databaseAssignment)) {
    const value = match[1].trim().replace(/^['"]|['"]$/g, "");
    const placeholder = value === "" || /^(?:change-me|example|localhost|<[^>]+>|\$\{[^}]+\})$/i.test(value);
    if (!isExampleEnv(relativePath) || !placeholder) {
      issues.push({
        code: "database-setting",
        file: relativePath,
        line: lineNumberAt(text, match.index),
        message: "database connection settings belong only in ignored environment files",
      });
    }
  }

  const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
  for (const match of text.matchAll(privateKey)) {
    issues.push({
      code: "private-key",
      file: relativePath,
      line: lineNumberAt(text, match.index),
      message: "private key material must not be public",
    });
  }

  const tokenPatterns = [
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  ];
  for (const pattern of tokenPatterns) {
    for (const match of text.matchAll(pattern)) {
      issues.push({
        code: "credential-token",
        file: relativePath,
        line: lineNumberAt(text, match.index),
        message: "credential-like token must not be public",
      });
    }
  }

  return issues;
}

function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function scanFileContent(relativePath, buffer) {
  if (isProbablyBinary(buffer)) return [];
  return contentIssues(relativePath, buffer.toString("utf8"));
}

function worktreeFiles(root) {
  const result = runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return [...new Set(splitNul(result.stdout))].sort();
}

function scanWorktree(root) {
  const issues = [];
  for (const relativePath of worktreeFiles(root)) {
    const absolutePath = path.join(root, relativePath);
    let stat;
    try {
      stat = fs.statSync(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    issues.push(...pathIssues(relativePath));
    issues.push(...scanFileContent(relativePath, fs.readFileSync(absolutePath)));
  }
  return issues;
}

function resolveHistoryRange(root, explicitRange) {
  if (explicitRange) return explicitRange;
  const upstream = runGit(root, ["rev-parse", "--verify", "origin/main"], { allowFailure: true });
  return upstream.status === 0 ? "origin/main..HEAD" : null;
}

function scanHistory(root, explicitRange) {
  const range = resolveHistoryRange(root, explicitRange);
  if (!range) return [];
  const commits = String(runGit(root, ["rev-list", "--reverse", range]).stdout).trim().split("\n").filter(Boolean);
  const issues = [];
  for (const commit of commits) {
    const metadata = splitNul(runGit(root, [
      "show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00", commit,
    ]).stdout);
    const [authorName = "", authorEmail = "", committerName = "", committerEmail = ""] = metadata;
    const localIdentities = new Set([
      os.userInfo().username.toLowerCase(),
      os.hostname().toLowerCase(),
      os.hostname().split(".")[0].toLowerCase(),
    ].filter(Boolean));
    for (const [role, name, email] of [
      ["author", authorName, authorEmail],
      ["committer", committerName, committerEmail],
    ]) {
      const normalizedName = name.trim().toLowerCase();
      const [localPart = "", domain = ""] = email.trim().toLowerCase().split("@");
      const localHostname = !domain.includes(".")
        || domain.endsWith(".local")
        || domain.endsWith(".lan")
        || domain.endsWith(".internal")
        || localIdentities.has(domain)
        || localIdentities.has(domain.split(".")[0]);
      const localUser = localIdentities.has(normalizedName)
        || (localIdentities.has(localPart) && domain !== "users.noreply.github.com");
      if (localHostname || localUser) {
        issues.push({
          code: "local-git-identity",
          file: "<commit-metadata>",
          commit: commit.slice(0, 12),
          message: `${role} identity appears to contain a local username or hostname`,
        });
      }
      for (const issue of contentIssues("<commit-metadata>", `${name}\n${email}\n`)) {
        issues.push({ ...issue, commit: commit.slice(0, 12) });
      }
    }
    const message = String(runGit(root, ["show", "-s", "--format=%B", commit]).stdout);
    for (const issue of contentIssues("<commit-message>", message)) {
      issues.push({ ...issue, commit: commit.slice(0, 12) });
    }
    const files = splitNul(runGit(root, ["ls-tree", "-r", "--name-only", "-z", commit]).stdout);
    for (const relativePath of files) {
      for (const issue of pathIssues(relativePath)) issues.push({ ...issue, commit: commit.slice(0, 12) });
      const blob = runGit(root, ["show", `${commit}:${relativePath}`], { allowFailure: true, encoding: null });
      if (blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) continue;
      for (const issue of scanFileContent(relativePath, blob.stdout)) issues.push({ ...issue, commit: commit.slice(0, 12) });
    }
  }
  return issues;
}

export function scanPublicRepository({ root = DEFAULT_ROOT, includeHistory = false, historyRange } = {}) {
  const normalizedRoot = path.resolve(root);
  const issues = scanWorktree(normalizedRoot);
  if (includeHistory) issues.push(...scanHistory(normalizedRoot, historyRange));
  return issues;
}

export function formatIssues(issues) {
  return issues.map((issue) => {
    const location = `${issue.file}${issue.line ? `:${issue.line}` : ""}`;
    const commit = issue.commit ? ` (${issue.commit})` : "";
    return `${location}${commit} [${issue.code}] ${issue.message}`;
  }).join("\n");
}

function parseCli(argv) {
  let root = DEFAULT_ROOT;
  let includeHistory = false;
  let historyRange;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--include-history") includeHistory = true;
    else if (argument === "--root") root = argv[++index];
    else if (argument === "--history-range") {
      includeHistory = true;
      historyRange = argv[++index];
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!root) throw new Error("--root requires a path");
  if (includeHistory && historyRange === "") throw new Error("--history-range requires a revision range");
  return { root, includeHistory, historyRange };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const options = parseCli(process.argv.slice(2));
    const issues = scanPublicRepository(options);
    if (issues.length > 0) {
      console.error(`Public repository privacy check failed with ${issues.length} issue(s):`);
      console.error(formatIssues(issues));
      process.exitCode = 1;
    } else {
      console.log(options.includeHistory
        ? "Public repository privacy check passed (worktree and outgoing history)."
        : "Public repository privacy check passed.");
    }
  } catch (error) {
    console.error(`Public repository privacy check could not run: ${error.message}`);
    process.exitCode = 2;
  }
}
