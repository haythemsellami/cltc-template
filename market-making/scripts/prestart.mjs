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
if (result.error) {
  // forge isn't runnable at all (not installed / not on PATH / contracts dir missing).
  if (existsSync(artifact)) {
    console.warn(
      "warning: Foundry (`forge`) is not available — starting with the EXISTING venue artifact. " +
        "Contract edits since your last successful build will NOT be picked up.",
    );
    process.exit(0);
  }
  console.error(
    "Foundry (`forge`) is not available and no venue artifact exists yet.\n" +
      "Install it (https://docs.monad.xyz/tooling-and-infra/toolkits/monad-foundry#installation), then:\n" +
      "  cd ../contracts && forge build",
  );
  process.exit(1);
}
// forge ran and the build FAILED — the contract doesn't compile. Never start on the old bytecode:
// the player is mid-edit and would silently deploy/reuse a venue WITHOUT their change.
console.error("\n`forge build` failed (see the compiler errors above) — fix the contract, then `npm start` again.");
process.exit(1);
