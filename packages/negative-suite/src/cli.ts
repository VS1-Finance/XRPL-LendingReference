// Entry point for the negative-test suite. The run command is wired alongside the case registry and
// runner; this scope establishes the CLI surface.
function main(): void {
  console.error("usage: negatives run --provisioned <file> --seed <seed>");
  process.exitCode = 1;
}

main();
