import { loadProvisioned } from "./environment.js";

// Entry point for the lifecycle runner. The run command is wired alongside the runner; this scope
// loads and validates a provisioned environment so the file contract can be exercised on its own.
function main(): void {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--provisioned");
  if (idx === -1 || !args[idx + 1]) {
    console.error("usage: lifecycle --provisioned <provisioned.json>");
    process.exitCode = 1;
    return;
  }
  const env = loadProvisioned(args[idx + 1]!);
  console.log(`loaded environment ${env.setupId} on ${env.network}`);
  console.log(`  vault  ${env.objects.vaultId}`);
  console.log(`  broker ${env.objects.brokerId}`);
}

main();
