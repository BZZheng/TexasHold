import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, test } from "node:test";

import { scanPublicRepository } from "../scripts/check-public-repo.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "texas-holdem-public-policy-"));
  temporaryRoots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Policy Test");
  git(root, "config", "user.email", "policy@example.com");
  return root;
}

function write(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function decoded(value) {
  return Buffer.from(value, "base64").toString("utf8");
}

test("public repository policy allows local examples and explicit schema/test fixtures", () => {
  const root = createRepository();
  write(root, ".env.example", [
    "APP_ORIGINS=http://127.0.0.1:5173,http://localhost:5173",
    "DATABASE_URL=",
    "DB_PASSWORD=change-me",
    "PUBLIC_URL=https://play.example.com",
    "",
  ].join("\n"));
  write(root, "database/schema/001-init.sql", "CREATE TABLE sample (id INTEGER PRIMARY KEY);\n");
  write(root, "database/fixtures/sample.sql", "INSERT INTO sample (id) VALUES (1);\n");
  write(root, "README.md", "Run locally at http://127.0.0.1:7790.\n");

  assert.deepEqual(scanPublicRepository({ root }), []);
});

test("public repository policy rejects infrastructure, database, credential, and runtime leaks", () => {
  const root = createRepository();
  write(root, "notes.txt", [
    `deployment city: ${decoded("R3Vhbmd6aG91")}`,
    `server address: ${[203, 0, 113, 42].join(".")}`,
    `developer checkout: ${["", "Users", "alice", "private-project"].join("/")}`,
    `database: ${["postgresql", "://", "real-user", ":", "real-password", "@", "db.internal", "/prod"].join("")}`,
    `private overlay: ${decoded("VGFpbHNjYWxl")}`,
    `cloud vendor: ${decoded("QVdT")}`,
    `APP_ORIGINS=${["https", "://", "poker.production.invalid-company.net"].join("")}`,
    `owner: ${["alice", "@", "corp.invalid-company.net"].join("")}`,
    `credential: ${["-----BEGIN OPEN", "SSH PRIVATE KEY-----"].join("")}`,
    "",
  ].join("\n"));
  write(root, "data/runtime-rooms.json", "{}\n");
  write(root, "database/production.sql", "SELECT 1;\n");

  const codes = new Set(scanPublicRepository({ root }).map((issue) => issue.code));
  assert.ok(codes.has("deployment-location"));
  assert.ok(codes.has("network-address"));
  assert.ok(codes.has("personal-absolute-path"));
  assert.ok(codes.has("database-url"));
  assert.ok(codes.has("infrastructure-fingerprint"));
  assert.ok(codes.has("deployment-url"));
  assert.ok(codes.has("deployment-host"));
  assert.ok(codes.has("personal-email"));
  assert.ok(codes.has("private-key"));
  assert.ok(codes.has("tracked-runtime-data"));
  assert.ok(codes.has("sql-outside-allowlist"));
});

test("history mode catches a leak removed by a later outgoing commit", () => {
  const root = createRepository();
  write(root, "README.md", "safe local setup\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");

  write(root, "leak.txt", `temporary host ${[203, 0, 113, 42].join(".")}\n`);
  git(root, "add", ".");
  git(root, "commit", "-m", "add leaked address");
  fs.rmSync(path.join(root, "leak.txt"));
  git(root, "add", "-u");
  git(root, "commit", "-m", "remove leaked address");

  assert.deepEqual(scanPublicRepository({ root }), []);
  const issues = scanPublicRepository({ root, includeHistory: true, historyRange: `${base}..HEAD` });
  assert.ok(issues.some((issue) => issue.code === "network-address" && issue.commit));
});
