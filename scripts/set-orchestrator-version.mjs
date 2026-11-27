import { readFileSync, writeFileSync } from "node:fs";

const nextVersion = process.argv[2]?.trim();

if (!nextVersion || !/^\d+\.\d+\.\d+$/.test(nextVersion)) {
  console.error("Usage: node ./scripts/set-orchestrator-version.mjs <x.y.z>");
  process.exit(1);
}

const orchestratorPackagePath = new URL(
  "../orchestrator/package.json",
  import.meta.url,
);

const orchestratorPackage = JSON.parse(
  readFileSync(orchestratorPackagePath, "utf8"),
);

if (orchestratorPackage.version === nextVersion) {
  console.log(`orchestrator/package.json already at ${nextVersion}`);
} else {
  orchestratorPackage.version = nextVersion;
  writeFileSync(
    orchestratorPackagePath,
    `${JSON.stringify(orchestratorPackage, null, 2)}\n`,
  );
  console.log(`Updated orchestrator/package.json to ${nextVersion}`);
}
