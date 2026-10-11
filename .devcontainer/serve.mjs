import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../server/node_modules/playwright/index.mjs";
import {
  previewOrigin,
  previewSecrets,
  privateFile,
  privateWrite,
  enforcePrivatePort,
} from "../scripts/preview.mjs";
import { makePool } from "../server/dist/db.js";
import { readConfig } from "../server/dist/config.js";
import { migrate } from "../server/dist/migrate.js";
import { createApp } from "../server/dist/app.js";
import { seedPreview } from "../server/dist/preview-seed.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pool,
  server,
  worker,
  privacyTimer,
  stopping = false;
let stage = "private_port";
const ghEnv = { ...process.env, GH_CONFIG_DIR: path.join(root, ".preview/gh") };
const stop = async (failed = false) => {
  if (stopping) return;
  stopping = true;
  clearTimeout(privacyTimer);
  const backstop = setTimeout(() => {
    worker?.kill("SIGKILL");
    process.exit(1);
  }, 65_000);
  try {
    const closed = server
      ? new Promise((resolve) => server.close(resolve))
      : Promise.resolve();
    server?.closeAllConnections();
    if (worker && worker.exitCode === null) {
      const exited = new Promise((resolve) => worker.once("exit", resolve));
      worker.kill("SIGTERM");
      await exited;
    }
    await closed;
    await pool?.end();
  } finally {
    clearTimeout(backstop);
  }
  process.exit(failed ? 1 : 0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
try {
  const origin = previewOrigin(process.env);
  await enforcePrivatePort(ghEnv);
  stage = "chromium_sandbox";
  if (process.getuid() === 0) throw Error("Non-root user required");
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    chromiumSandbox: true,
    timeout: 20_000,
  });
  try {
    const page = await browser.newPage();
    await page.goto("chrome://sandbox", { timeout: 10_000 });
    if (
      !/Seccomp-BPF sandbox\s+Yes/.test(await page.locator("body").innerText())
    )
      throw Error("Chromium sandbox verification failed");
  } finally {
    await browser.close();
  }
  stage = "credentials";
  const secrets = await previewSecrets(root);
  const dbPassword = (
    await privateFile(path.join(root, ".preview/db-password"))
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(dbPassword))
    throw Error("Invalid database secret");
  const cfg = readConfig({
    NODE_ENV: "production",
    DATABASE_URL: `postgresql://fusion_preview:${dbPassword}@db:5432/fusion_preview`,
    JWT_SECRET: secrets.jwt,
    CHANNEL_KEY: secrets.key,
    PUBLIC_URL: origin,
    PORT: "3000",
    DATA_DIR: path.join(root, ".preview/data"),
    REGISTRATION_ENABLED: "false",
    HISTORY_DAYS: "14",
    CAPTURE_TIMEOUT_MS: "30000",
    CHROMIUM_CONCURRENCY: "1",
    MAX_CAPTURE_PIXELS: "4000000",
    PLAYWRIGHT_EXECUTABLE_PATH: "/usr/bin/chromium",
    LOG_LEVEL: "info",
  });
  pool = makePool(cfg.DATABASE_URL);
  stage = "migrations";
  await migrate(pool);
  stage = "synthetic_fixtures";
  await seedPreview(pool, cfg, secrets.password);
  await privateWrite(
    path.join(root, ".preview/login.txt"),
    `YALNIZCA BU ÖZEL CODESPACE İÇİNDİR. PAYLAŞMAYIN.\n\nÖnizleme: ${origin}\nE-posta: preview@example.com\nParola: ${secrets.password}\n\nDemo monitör duraklatılmıştır; sentetik geçmişi inceleyebilirsiniz. Gerçek izleme için kendi herkese açık HTTPS URL'nizle monitör oluşturun. Telegram bilgilerini uygulamadaki şifreli bildirim ayarlarına girin ve Test notification düğmesini kendiniz kullanın.\n`,
  );
  stage = "application";
  const app = createApp(pool, cfg, undefined, {
    frontendDir: path.join(root, "frontend/dist"),
    requireNotificationTest: true,
    allowedHosts: [new URL(origin).host, "127.0.0.1:3000", "localhost:3000"],
  });
  await new Promise((resolve, reject) => {
    server = app.listen(3000, "0.0.0.0", resolve);
    server.once("error", () => reject(Error("Preview listen failed")));
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  const workerEnv = Object.fromEntries(
    Object.entries(cfg).map(([k, v]) => [k, String(v)]),
  );
  worker = spawn(
    process.execPath,
    [path.join(root, "server/dist/worker-main.js")],
    {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: "C.UTF-8",
        ...workerEnv,
      },
    },
  );
  worker.once("error", () => {
    console.error("Worker başlatılamadı.");
    void stop(true);
  });
  worker.once("exit", () => {
    if (!stopping) {
      console.error("Worker beklenmedik şekilde durdu.");
      void stop(true);
    }
  });
  await privateWrite(
    path.join(root, ".preview/ready.json"),
    JSON.stringify({ pid: process.pid, workerPid: worker.pid }),
  );
  const checkPrivacy = () => {
    privacyTimer = setTimeout(async () => {
      try {
        await enforcePrivatePort(ghEnv);
        if (!stopping) checkPrivacy();
      } catch {
        console.error("PRIVATE port doğrulanamadı; önizleme kapatılıyor.");
        void stop(true);
      }
    }, 60_000);
  };
  server.once("error", () => {
    console.error("Önizleme sunucusu başlatılamadı.");
    void stop(true);
  });
  checkPrivacy();
  console.log(
    "API/frontend/worker hazır; PRIVATE port ve Chromium sandbox doğrulandı. Giriş bilgileri .preview/login.txt dosyasındadır.",
  );
} catch {
  console.error(
    `Güvenli başlangıç başarısız (${stage}): PRIVATE port yetkisi için Codespace terminalinde node .devcontainer/authorize.mjs çalıştırın. Diğer aşamalar için docs/private-preview.md rehberini inceleyin. Hiçbir güvenlik kontrolü devre dışı bırakılmaz.`,
  );
  await stop(true);
}
