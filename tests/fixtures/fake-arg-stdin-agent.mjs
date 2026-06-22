let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(`arg-agent-ok: ${process.argv[2] ?? ""}; stdin=${input.length}`);
});
