import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("deployment scripts are valid shell and publish only the reviewed commit", () => {
  for (const relativePath of ["deploy/deploy-remote-server.sh", "deploy/seamless-upgrade.sh"]) {
    const checked = spawnSync("bash", ["-n", path.join(root, relativePath)], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
  }

  const deployment = source("deploy/deploy-remote-server.sh");
  assert.match(deployment, /git archive --format=tar\.gz HEAD/);
  assert.doesNotMatch(deployment, /tar[^\n]*-czf - \./);
  assert.match(deployment, /TEXAS_HOLDEM_PREBUILT_IMAGE_FILE/);
  assert.match(deployment, /docker load/);
  assert.match(
    deployment,
    /if \[ -e \/usr\/local\/sbin\/texas-holdem-backup-export \] \|\| \[ -L \/usr\/local\/sbin\/texas-holdem-backup-export \]; then[\s\S]*ln -sfn "\$remote_root\/bin\/texas-holdem-backup-export" \/usr\/local\/sbin\/texas-holdem-backup-export/,
    "deployments must refresh an already-provisioned restricted SSH exporter path",
  );
});

test("a prebuilt release skips only the remote image build, not health checks or rollback", () => {
  const upgrade = source("deploy/seamless-upgrade.sh");
  assert.match(upgrade, /TEXAS_HOLDEM_SKIP_BUILD/);
  assert.match(upgrade, /docker image inspect "\$APP_IMAGE"/);
  assert.match(upgrade, /wait_for_healthy_release/);
  assert.match(upgrade, /rollback_tag/);
  assert.equal(
    upgrade.match(/up -d --no-build --force-recreate/g)?.length,
    2,
    "both replacement and rollback must recreate the container from the selected image",
  );
});
