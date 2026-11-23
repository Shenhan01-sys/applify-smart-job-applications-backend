import { isTestRuntime, networkErrorCode, notifyTimeoutSignal } from './notifications-switch.js'

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
    if (isTestRuntime()) return { ok: false, error: 'telegram_disabled_in_test' }
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
          signal: notifyTimeoutSignal(),
        }
      )
      if (!resp.ok) {
        // Isi balasan Telegram hanya untuk log server; pemanggil (dan klien) menerima kode generik.
        console.error('[notifications] Telegram error: HTTP', resp.status)
        return { ok: false, error: `telegram_http_${resp.status}` }
      }
      return { ok: true }
    } catch (e: unknown) {
      const code = networkErrorCode('telegram', e)
      console.error('[notifications] Telegram send failed:', code)
      return { ok: false, error: code }
    }
  }
}

export const notificationsService = new NotificationsService()
