const action = process.argv[2] ?? "login";

if (action === "login") {
  process.stdout.write("Open https://login.example.test/device and finish login\n");
  process.stdout.write("logged in successfully\n");
  process.exit(0);
}

if (action === "device-login") {
  process.stdout.write("Go to https://login.example.test/device and enter code ABCD-EFGH\n");
  process.stdout.write("authenticated\n");
  process.exit(0);
}

if (action === "status") {
  process.stdout.write("signed in as fake@example.test\n");
  process.exit(0);
}

if (action === "logout") {
  process.stdout.write("logged out\n");
  process.exit(0);
}

process.stderr.write(`unknown auth action: ${action}\n`);
process.exit(2);
