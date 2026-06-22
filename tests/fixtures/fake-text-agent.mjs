let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const currentTask = input.split("User task:\n").pop() ?? input;
  if (/TRIGGER_QUOTA/.test(currentTask)) {
    process.stderr.write("quota exceeded: simulated provider limit\n");
    process.exit(2);
  }
  if (/TRIGGER_CONTEXT/.test(currentTask)) {
    process.stderr.write("context window exceeded: simulated token limit\n");
    process.exit(2);
  }
  process.stdout.write(`fake-agent-ok: ${input.slice(-120)}`);
});
