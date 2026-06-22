let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  process.stdout.write(
    JSON.stringify({
      argv: process.argv.slice(2),
      modelEnv: process.env.FAKE_MODEL ?? "",
      input
    })
  );
});
