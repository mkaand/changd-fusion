// Development fixture seeding only; never invoked by production entrypoints or exposed through HTTP.
import { hash } from "bcryptjs";
import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import { type Pool, transaction } from "./db.js";
import type { Config } from "./config.js";
import { Storage } from "./storage.js";
export async function seedPreview(pool: Pool, cfg: Config, password: string) {
  const store = new Storage(cfg.DATA_DIR);
  const saved: string[] = [];
  try {
    await transaction(pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(741903)");
      const owner = await c.query("SELECT user_id FROM users WHERE email=$1", [
        "preview@example.com",
      ]);
      // Resume never resets a changed password or duplicates fixtures.
      if (owner.rowCount) return;
      const user = await c.query(
        "INSERT INTO users(email,password,firstname,user_type) VALUES($1,$2,$3,2) RETURNING user_id",
        ["preview@example.com", await hash(password, 12), "Preview"],
      );
      const monitor = await c.query(
        `INSERT INTO fusion_monitors(user_id,name,url,kind,text_enabled,visual_enabled,paused,monitor_state,browser_steps)
        VALUES($1,$2,$3,'browser',true,true,true,'paused',$4) RETURNING id`,
        [
          user.rows[0].user_id,
          "Sentetik demo — Text + Visual (duraklatıldı)",
          "https://example.com",
          JSON.stringify([
            { action: "wait_visible", selector: "main", timeout_ms: 5000 },
          ]),
        ],
      );
      const id = monitor.rows[0].id;
      const before = new PNG({ width: 400, height: 250 });
      before.data.fill(255);
      const after = new PNG({ width: 400, height: 250 });
      after.data.fill(255);
      const diff = new PNG({ width: 400, height: 250 });
      diff.data.fill(255);
      // 350/100000 pixels = exactly 0.35%; purely synthetic, no website request.
      for (let i = 0; i < 350; i++) {
        after.data[i * 4] = after.data[i * 4 + 1] = after.data[i * 4 + 2] = 0;
        diff.data[i * 4 + 1] = diff.data[i * 4 + 2] = 0;
      }
      for (const png of [before, after, diff])
        saved.push(await store.save(PNG.sync.write(png)));
      const a = randomUUID(),
        b = randomUUID();
      await c.query(
        "INSERT INTO fusion_captures(id,monitor_id,text_content,screenshot) VALUES($1,$3,$4,$6),($2,$3,$5,$7)",
        [a, b, id, "Örnek fiyat: 100", "Örnek fiyat: 101", saved[0], saved[1]],
      );
      await c.query(
        "INSERT INTO fusion_events(monitor_id,status,after_id,created_at) VALUES($1,'baseline',$2,now()-interval '5 minutes')",
        [id, a],
      );
      await c.query(
        `INSERT INTO fusion_events(monitor_id,status,before_id,after_id,text_changed,visual_changed,visual_percent,diff_screenshot,text_diff)
        VALUES($1,'changed',$2,$3,true,true,0.35,$4,$5)`,
        [
          id,
          a,
          b,
          saved[2],
          JSON.stringify([
            { value: "Örnek fiyat: 100", removed: true },
            { value: "Örnek fiyat: 101", added: true },
          ]),
        ],
      );
      await c.query(
        "UPDATE fusion_monitors SET baseline_id=$2,latest_capture_id=$2,last_percent=0.35,visual_threshold=0.30,last_success_at=now(),last_run=now(),last_change_at=now() WHERE id=$1",
        [id, b],
      );
    });
  } catch (e) {
    await Promise.all(saved.map((name) => store.remove(name)));
    throw e;
  }
}
