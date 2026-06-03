import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.argv.slice(2));
  // Imported dynamically so a missing venue artifact (loaded by ./abi at module init) surfaces as a
  // clean message here rather than an import-time stack trace.
  const { run } = await import("./lifecycle.js");
  await run(cfg);
}

main().catch((error: unknown) => {
  console.error(`\nmarket-maker failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
