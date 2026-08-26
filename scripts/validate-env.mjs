import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error("Usage: node scripts/validate-env.mjs [--env-file PATH] [--mode local|production]");
}

function parseArguments(argv) {
  const result = { envFile: ".env", mode: "local" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--env-file" && argv[index + 1]) result.envFile = argv[++index];
    else if (argument === "--mode" && argv[index + 1]) result.mode = argv[++index];
    else {
      usage();
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  if (!["local", "production"].includes(result.mode)) {
    usage();
    throw new Error(`Unsupported mode: ${result.mode}`);
  }
  return result;
}

function parseEnvironmentFile(filePath) {
  const values = {};
  const source = fs.readFileSync(filePath, "utf8");
  source.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`${filePath}:${index + 1} is not a KEY=VALUE assignment`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[match[1]] = value;
  });
  return values;
}

function validBoolean(value) {
  return ["true", "false", "1", "0"].includes(String(value).toLowerCase());
}

function positiveInteger(value) {
  return /^\d+$/.test(String(value)) && Number(value) > 0;
}

function validateOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
      && url.origin === value;
  } catch {
    return false;
  }
}

function nodeVersionSupported() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(64);
}

const errors = [];
const warnings = [];
const resolvedEnvFile = path.resolve(options.envFile);
let fileValues = {};
if (fs.existsSync(resolvedEnvFile)) {
  try {
    fileValues = parseEnvironmentFile(resolvedEnvFile);
  } catch (error) {
    errors.push(error.message);
  }
} else if (options.mode === "production") {
  errors.push(`production environment file is missing: ${options.envFile}`);
} else {
  warnings.push(`${options.envFile} is absent; built-in development defaults will be used`);
}

const values = { ...fileValues, ...process.env };
const nodeEnvironment = values.NODE_ENV || "development";
const port = values.PORT || "7790";
const dataDirectory = values.DATA_DIR || (options.mode === "local" ? "./data/local" : "");
const origins = String(values.APP_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
const secureCookies = values.COOKIE_SECURE ?? (options.mode === "production" ? "true" : "false");
const allowNoOrigin = values.ALLOW_NO_ORIGIN ?? "false";

if (!nodeVersionSupported()) errors.push(`Node ${process.versions.node} is unsupported; use Node >=22.12`);
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
  errors.push("PORT must be an integer from 1 to 65535");
}
if (!dataDirectory) errors.push("DATA_DIR is required");
if (!validBoolean(secureCookies)) errors.push("COOKIE_SECURE must be true or false");
if (!validBoolean(allowNoOrigin)) errors.push("ALLOW_NO_ORIGIN must be true or false");
if (origins.some((origin) => !validateOrigin(origin))) {
  errors.push("APP_ORIGINS must contain comma-separated exact http(s) origins without paths or trailing slashes");
}
for (const key of ["ARCHIVE_RING_MAX_BYTES", "STORAGE_MIN_FREE_BYTES"]) {
  if (values[key] != null && !positiveInteger(values[key])) errors.push(`${key} must be a positive integer`);
}
for (const key of ["LOG_ENABLED", "LOG_STDOUT"]) {
  if (values[key] != null && !validBoolean(values[key])) errors.push(`${key} must be true or false`);
}
if (values.LOG_LEVEL != null && !["trace", "debug", "info", "warn", "error", "fatal"].includes(values.LOG_LEVEL)) {
  errors.push("LOG_LEVEL must be trace, debug, info, warn, error, or fatal");
}
for (const key of [
  "LOG_FILE_MAX_BYTES",
  "LOG_ROTATE_INTERVAL_MS",
  "LOG_ARCHIVE_MAX_BYTES",
  "LOG_ARCHIVE_MAX_FILES",
  "LOG_QUEUE_MAX_ENTRIES",
  "LOG_FLUSH_INTERVAL_MS",
  "LOG_ARCHIVE_SYNC_INTERVAL_MS",
  "LOG_ARCHIVE_STALE_AFTER_MS",
]) {
  if (values[key] != null && !positiveInteger(values[key])) errors.push(`${key} must be a positive integer`);
}
const archiveLogMode = values.LOG_ARCHIVE_MODE || "disabled";
if (!["disabled", "pull", "push"].includes(archiveLogMode)) {
  errors.push("LOG_ARCHIVE_MODE must be disabled, pull, or push");
}
if (archiveLogMode === "push") {
  if (!values.LOG_ARCHIVE_DIR) {
    errors.push("LOG_ARCHIVE_DIR is required when LOG_ARCHIVE_MODE=push");
  } else if (!path.isAbsolute(values.LOG_ARCHIVE_DIR)) {
    errors.push("LOG_ARCHIVE_DIR must be an absolute path");
  } else if (!fs.existsSync(values.LOG_ARCHIVE_DIR)) {
    errors.push("LOG_ARCHIVE_DIR must already exist; the application will not create a remote mount path");
  }
  if (!values.LOG_ARCHIVE_READY_FILE) {
    warnings.push("LOG_ARCHIVE_READY_FILE should point to a sentinel file inside the mounted archive path");
  } else if (!path.isAbsolute(values.LOG_ARCHIVE_READY_FILE) || !fs.existsSync(values.LOG_ARCHIVE_READY_FILE)) {
    errors.push("LOG_ARCHIVE_READY_FILE must be an existing absolute sentinel file");
  }
}

if (options.mode === "production") {
  if (nodeEnvironment !== "production") errors.push("NODE_ENV must be production");
  if (!path.isAbsolute(dataDirectory)) errors.push("DATA_DIR must be an absolute production path");
  if (values.LOG_DIR && !path.isAbsolute(values.LOG_DIR)) errors.push("LOG_DIR must be an absolute production path");
  if (!origins.length) errors.push("APP_ORIGINS is required in production");
  if (String(allowNoOrigin).toLowerCase() !== "false" && allowNoOrigin !== "0") {
    errors.push("ALLOW_NO_ORIGIN must be false in production");
  }
  if (String(secureCookies).toLowerCase() === "true" || secureCookies === "1") {
    if (origins.some((origin) => !origin.startsWith("https://"))) {
      errors.push("COOKIE_SECURE=true requires HTTPS APP_ORIGINS");
    }
  } else {
    warnings.push("COOKIE_SECURE is disabled; public traffic will not have transport-level cookie protection");
  }
}

warnings.forEach((warning) => console.warn(`warning: ${warning}`));
if (errors.length) {
  errors.forEach((error) => console.error(`error: ${error}`));
  process.exit(78);
}
console.log(`Environment is valid (${options.mode}, ${fs.existsSync(resolvedEnvFile) ? options.envFile : "defaults"}).`);
