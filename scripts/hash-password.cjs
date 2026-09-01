const { randomBytes, scrypt } = require("node:crypto");

function readPassword() {
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { value += chunk; });
      process.stdin.on("end", () => resolve(value.replace(/[\r\n]+$/, "")));
      process.stdin.on("error", reject);
    });
  }

  return new Promise((resolve) => {
    let value = "";
    process.stdout.write("Password: ");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (key) => {
      if (key === "\u0003") process.exit(130);
      if (key === "\r" || key === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off("data", onData);
        process.stdout.write("\n");
        resolve(value);
        return;
      }
      if (key === "\u007f" || key === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += key;
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const password = await readPassword();
  if (password.length < 12) {
    throw new Error("Password must contain at least 12 characters.");
  }
  const salt = randomBytes(16).toString("base64url");
  const hash = await new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, result) => error ? reject(error) : resolve(result));
  });
  process.stdout.write(`scrypt$${salt}$${hash.toString("base64url")}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
