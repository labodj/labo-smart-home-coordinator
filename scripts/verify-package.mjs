#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

const run = async (command, args, options = {}) => {
  try {
    return await execFileAsync(command, args, {
      cwd: root,
      maxBuffer: 1024 * 1024 * 16,
      ...options,
    });
  } catch (error) {
    const stderr = error.stderr ? `\n${error.stderr}` : "";
    const stdout = error.stdout ? `\n${error.stdout}` : "";
    throw new Error(`${command} ${args.join(" ")} failed.${stdout}${stderr}`, { cause: error });
  }
};

const ensureBuildExists = async () => {
  await access(join(root, "dist", "index.js"));
  await access(join(root, "dist", "cli.js"));
  await access(join(root, "dist", "mqtt.js"));
};

const pack = async (destination) => {
  const { stdout } = await run(npmBin, ["pack", "--json", "--pack-destination", destination]);
  const packResult = JSON.parse(stdout);
  const [entry] = Array.isArray(packResult) ? packResult : Object.values(packResult);
  return join(destination, entry.filename);
};

const main = async () => {
  await ensureBuildExists();
  const tempRoot = await mkdtemp(join(tmpdir(), "labo-smart-home-coordinator-package-"));
  try {
    const packagesDir = join(tempRoot, "packages");
    const consumerDir = join(tempRoot, "consumer");
    await mkdir(packagesDir);
    await mkdir(consumerDir);

    const tarball = await pack(packagesDir);
    await writeFile(join(consumerDir, "package.json"), JSON.stringify({ private: true }, null, 2));
    await run(npmBin, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
      cwd: consumerDir,
    });

    await access(
      join(consumerDir, "node_modules", "labo-smart-home-coordinator", "dist", "cli.js"),
    );
    await run(
      process.execPath,
      [
        "--eval",
        `
          const coordinator = require("labo-smart-home-coordinator");
          const mqtt = require("labo-smart-home-coordinator/mqtt");
          if (typeof coordinator.LaboSmartHomeCoordinator !== "function") throw new Error("missing coordinator export");
          if (typeof coordinator.LshLogicService !== "function") throw new Error("missing service export");
          if (typeof coordinator.LshCodec !== "function") throw new Error("missing codec export");
          if (typeof mqtt.LaboSmartHomeCoordinatorMqtt !== "function") throw new Error("missing MQTT adapter export");
        `,
      ],
      { cwd: consumerDir },
    );
    await run(
      process.execPath,
      [
        join(consumerDir, "node_modules", "labo-smart-home-coordinator", "dist", "cli.js"),
        "--help",
      ],
      { cwd: consumerDir },
    );

    console.log(`Verified local standalone package install from ${tarball}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
