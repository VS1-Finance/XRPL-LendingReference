// Entry point for session management. The create, list, join and run-bots commands are wired
// alongside the registry and bot scheduler; this scope establishes the CLI surface.
function main(): void {
  console.error("usage: session <create|list|join|run-bots> ...");
  process.exitCode = 1;
}

main();
