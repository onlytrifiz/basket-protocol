/**
 * Telegram announcements. Fire-and-forget on purpose: a bad token, a rate limit or a Telegram outage
 * must never touch the payout loop. Nothing here throws.
 */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const EXPLORER = process.env.EXPLORER_URL ?? "https://robinhoodchain.blockscout.com";

export const NOTIFY_ON = BOT_TOKEN !== "" && CHAT_ID !== "" && process.env.TELEGRAM_ENABLED !== "0";

export async function announce(text: string, txHash?: string) {
  if (!NOTIFY_ON) return;
  const body = txHash ? `${text}\n${EXPLORER}/tx/${txHash}` : text;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: body, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    /* decoration, not product */
  }
}
