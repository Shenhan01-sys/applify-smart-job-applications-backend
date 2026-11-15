const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || ''

export interface NotificationChannelStatus {
  telegram: boolean
}

class NotificationsService {
  isTelegramConfigured(): boolean {
    return Boolean(BOT_TOKEN && CHAT_ID)
  }

  status(): NotificationChannelStatus {
    return { telegram: this.isTelegramConfigured() }
  }

  /** Send a plain-text message to the configured Telegram chat. Config-driven: skips silently if unset. */
  async sendTelegram(message: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isTelegramConfigured()) {
      console.warn('[notifications] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — skipping Telegram send')
      return { ok: false, error: 'telegram not configured' }
    }
    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: message.slice(0, 4096),
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        }
      )
      if (!resp.ok) {
        const text = await resp.text()
        console.error('[notifications] Telegram error:', resp.status, text)
        return { ok: false, error: `telegram ${resp.status}: ${text}` }
      }
      return { ok: true }
    } catch (e: any) {
      console.error('[notifications] Telegram send failed:', e?.message)
      return { ok: false, error: String(e?.message ?? e) }
    }
  }
}

export const notificationsService = new NotificationsService()
