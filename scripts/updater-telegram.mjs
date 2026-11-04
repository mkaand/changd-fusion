const TOKEN = /^[0-9]{6,12}:[A-Za-z0-9_-]{30,80}$/;
const CHAT = /^-?[0-9]{1,20}$/;
const SAFE = /^[A-Za-z0-9_.:@/ -]{1,160}$/;

function safe(value, fallback = "unknown") {
  const text = String(value ?? "").replace(/[^A-Za-z0-9_.:@/ -]/g, "_").slice(0, 160);
  return SAFE.test(text) ? text : fallback;
}

export class TelegramUpdaterNotifier {
  constructor({ token, chatId, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
    this.enabled = Boolean(token || chatId);
    if (this.enabled && (!TOKEN.test(token ?? "") || !CHAT.test(chatId ?? ""))) throw Error("invalid_telegram_configuration");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) throw Error("invalid_telegram_timeout");
    this.token = token; this.chatId = chatId; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
  }

  message(kind, payload) {
    if (kind === "success") return [
      "Changd Fusion update succeeded",
      `Version: ${safe(payload.version)}`,
      `Source: ${safe(payload.source_sha).slice(0, 12)}`,
      `Operation: ${safe(payload.operation_id)}`,
      `Health: ${safe(payload.health, "verified")}`,
      `Time: ${safe(payload.timestamp)}`,
    ].join("\n");
    if (kind === "recovery_required") return [
      "Changd Fusion recovery required",
      `Operation: ${safe(payload.operation_id)}`,
      `State: ${safe(payload.state)}`,
      "Automatic updates remain stopped. Verify admission and recovery state manually.",
    ].join("\n");
    return [
      "Changd Fusion update failed safely",
      `Stage: ${safe(payload.stage)}`,
      `Category: ${safe(payload.category)}`,
      `Safe stop: ${safe(payload.safe_stop, "retained")}`,
    ].join("\n");
  }

  async send(kind, payload) {
    if (!this.enabled) return { delivered: false, disabled: true };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: this.message(kind, payload), link_preview_options: { is_disabled: true } }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response?.ok) throw Error(`telegram_http_${Number(response?.status) || 0}`);
      const body = await response.json();
      if (body?.ok !== true) throw Error("telegram_invalid_response");
      return { delivered: true };
    } catch (error) {
      const code = error?.name === "AbortError" ? "telegram_timeout"
        : /^telegram_(?:http_[0-9]+|invalid_response)$/.test(error?.message ?? "") ? error.message : "telegram_delivery_failed";
      return { delivered: false, error: code };
    } finally { clearTimeout(timer); }
  }
}
