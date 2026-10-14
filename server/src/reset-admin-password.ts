import "dotenv/config";
import { makePool } from "./db.js";
import { resetOnlyActiveAdministratorPassword } from "./admin-password-reset.js";

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function")
    throw new Error("An interactive TTY is required");
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      const key = chunk.toString("utf8");
      if (key === "\u0003") { cleanup(); reject(new Error("Cancelled")); return; }
      if (key === "\r" || key === "\n") { cleanup(); process.stdout.write("\n"); resolve(value); return; }
      if (key === "\u007f" || key === "\b") { value = value.slice(0, -1); return; }
      if (!key.startsWith("\u001b")) value += key;
    };
    const cleanup = () => { process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause(); };
    process.stdin.on("data", onData);
  });
}

if (process.argv.length !== 2) throw new Error("This command does not accept arguments");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const first = await readHidden("New administrator password: ");
const second = await readHidden("Confirm new password: ");
if (first !== second) throw new Error("Passwords do not match");

const pool = makePool(databaseUrl);
try {
  await resetOnlyActiveAdministratorPassword(pool, first);
  console.log("Administrator password reset completed");
} finally {
  await pool.end();
}
