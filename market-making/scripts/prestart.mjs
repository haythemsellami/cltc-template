// Runs before `npm start`: keep the venue artifact fresh so the bot always deploys the contract
// you actually edited. Two footguns this closes:
//   - no artifact at all -> the bot used to fail at startup asking for a manual forge build;
//   - a STALE artifact   -> the sneaky one: you edit contracts/src and forget to rebuild, and the
//     bot silently deploys/reuses the OLD bytecode (no error — your change just isn't live).
// `forge build` is incremental (near-instant when nothing changed), so always running it is cheap.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.env.VENUE_ARTIFACT) {
  // Explicit artifact override — the player manages their own build.
  process.exit(0);
}

const contractsDir = fileURLToPath(new URL("../../contracts", import.meta.url));
const artifact = fileURLToPath(
  new URL("../../contracts/out/CompetitionPropAMM.sol/CompetitionPropAMM.json", import.meta.url),
);

const result = spawnSync("forge", ["build"], { cwd: contractsDir, stdio: "inherit" });
if (result.status === 0 && !result.error) {
  process.exit(0);
}
if (existsSync(artifact)) {
  console.warn(
    "warning: `forge build` failed or Foundry is not installed — starting with the EXISTING venue " +
      "artifact. Contract edits since your last successful build will NOT be picked up.",
  );
  process.exit(0);
}
console.error(
  "`forge build` failed and no venue artifact exists yet.\n" +
    "Install Foundry (https://book.getfoundry.sh/getting-started/installation), then:\n" +
    "  cd ../contracts && forge build",
);
process.exit(1);
