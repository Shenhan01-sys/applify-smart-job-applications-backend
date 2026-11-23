import crypto from 'crypto'

/**
 * Integrasi WhatsApp resmi via Kapso (`https://docs.kapso.ai/docs/introduction`).
 *
 * Referensi protokol Kapso:
 *   - Endpoint kirim pesan: `POST https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}/messages`
 *   - Autentikasi header: `X-API-Key: <KAPSO_API_KEY>`
 *   - Verifikasi webhook masuk: HMAC-SHA256 `x-hub-signature-256: sha256=<hex>`
 *   - Aturan 24 jam Meta Cloud API: dalam 24 jam sejak pesan inbound pengguna terakhir (`whatsapp_last_inbound_at`),
 *     pesan teks/interaktif bebas dikirim; di luar 24 jam harus memakai template (`KAPSO_TEMPLATE_NAME`)
 *     atau mode sandbox (`KAPSO_SANDBOX_MODE=true`).
 */

export const DEFAULT_KAPSO_BASE_URL = 'https://api.kapso.ai/meta/whatsapp/v24.0'
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000

export interface KapsoConfig {
  apiKey: string
  phoneNumberId: string
  baseUrl: string
  webhookSecret: string
  templateName: string
  templateLang: string
  sandboxMode: boolean
}

export function kapsoConfigFromEnv(env: Record<string, string | undefined> = process.env): KapsoConfig {
  return {
    apiKey: (env.KAPSO_API_KEY ?? '').trim(),
    phoneNumberId: (env.KAPSO_PHONE_NUMBER_ID ?? '').trim(),
    baseUrl: ((env.KAPSO_API_BASE_URL ?? '').trim() || DEFAULT_KAPSO_BASE_URL).replace(/\/+$/, ''),
    webhookSecret: (env.KAPSO_WEBHOOK_SECRET ?? '').trim(),
    templateName: (env.KAPSO_TEMPLATE_NAME ?? '').trim(),
    templateLang: (env.KAPSO_TEMPLATE_LANG ?? 'id').trim() || 'id',
    sandboxMode: (env.KAPSO_SANDBOX_MODE ?? '').trim().toLowerCase() === 'true',
  }
}

export function isKapsoConfigured(cfg: KapsoConfig = kapsoConfigFromEnv()): boolean {
  return Boolean(cfg.apiKey && cfg.phoneNumberId)
}

/**
 * Normalisasi nomor WhatsApp Indonesia / internasional ke format E.164 (`+628...`) maupun digit polos (`628...`).
 * Mengembalikan null bila tidak valid (bukan 8-15 digit).
 */
export function normalizeWhatsAppPhone(raw: unknown): { e164: string; waDigits: string } | null {
  if (typeof raw !== 'string') return null
  let digits = raw.replace(/[^\d+]/g, '').trim()
  if (digits.startsWith('00')) digits = '+' + digits.slice(2)
  if (digits.startsWith('0')) digits = '+62' + digits.slice(1)
  if (!digits.startsWith('+')) {
    digits = digits.startsWith('62') ? '+' + digits : digits
  }
  const onlyDigits = digits.replace(/^\+/, '')
  if (!/^\d{8,15}$/.test(onlyDigits)) return null
  return { e164: `+${onlyDigits}`, waDigits: onlyDigits }
}

/** True bila pengguna sudah mengirim chat masuk ke bot WA dalam 24 jam terakhir (jendela Meta bebas teks). */
export function isWithinWhatsApp24hWindow(lastInboundAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!lastInboundAt || typeof lastInboundAt !== 'string') return false
  const ts = Date.parse(lastInboundAt)
  return Number.isFinite(ts) && now.getTime() - ts >= 0 && now.getTime() - ts < WHATSAPP_WINDOW_MS
}

/** Verifikasi signature webhook Kapso (`x-hub-signature-256: sha256=<hex>`) secara timing-safe. */
export function verifyKapsoWebhookSignature(rawBody: string | Buffer, signatureHeader: unknown, secret: string): boolean {
  if (!secret || typeof signatureHeader !== 'string') return false
  const clean = signatureHeader.trim()
  const hex = clean.startsWith('sha256=') ? clean.slice('sha256='.length) : clean
  if (!/^[a-f0-9]{64}$/i.test(hex)) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(hex.toLowerCase(), 'utf8')
  const b = Buffer.from(expected.toLowerCase(), 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export interface KapsoSendResult {
  ok: boolean
  mode?: 'text' | 'template'
  messageId?: string
  error?: string
}

export class KapsoWhatsAppService {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly env: Record<string, string | undefined> = process.env
  ) {}

  config(): KapsoConfig {
    return kapsoConfigFromEnv(this.env)
  }

  isConfigured(): boolean {
    return isKapsoConfigured(this.config())
  }

  async sendMessage(args: {
    to: string
    body: string
    lastInboundAt?: string | null
    forceText?: boolean
    now?: Date
  }): Promise<KapsoSendResult> {
    const cfg = this.config()
    if (!isKapsoConfigured(cfg)) {
      return { ok: false, error: 'kapso_not_configured' }
    }
    const norm = normalizeWhatsAppPhone(args.to)
    if (!norm) return { ok: false, error: 'invalid_whatsapp_phone' }

    const cleanBody = String(args.body ?? '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 1024)
    if (!cleanBody) return { ok: false, error: 'empty_message' }

    const withinWindow = isWithinWhatsApp24hWindow(args.lastInboundAt, args.now ?? new Date())
    const canSendText = Boolean(args.forceText || cfg.sandboxMode || withinWindow)

    let mode: 'text' | 'template' = 'text'
    let payload: Record<string, unknown>

    if (canSendText) {
      payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: norm.waDigits,
        type: 'text',
        text: { body: cleanBody },
      }
    } else if (cfg.templateName) {
      mode = 'template'
      payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: norm.waDigits,
        type: 'template',
        template: {
          name: cfg.templateName,
          language: { code: cfg.templateLang },
          components: [
            {
              type: 'body',
              parameters: [{ type: 'text', text: cleanBody.slice(0, 300) }],
            },
          ],
        },
      }
    } else {
      return {
        ok: false,
        error: 'outside_24h_window_no_template',
      }
    }

    try {
      const resp = await this.fetchImpl(`${cfg.baseUrl}/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': cfg.apiKey,
        },
        body: JSON.stringify(payload),
      })
      const text = await resp.text()
      let data: any = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = {}
      }
      if (!resp.ok) {
        return { ok: false, error: `kapso_${resp.status}: ${String(data?.error?.message ?? text).slice(0, 160)}` }
      }
      const messageId = Array.isArray(data?.messages) ? data.messages[0]?.id : data?.id
      return { ok: true, mode, ...(typeof messageId === 'string' ? { messageId } : {}) }
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  }
}

export const kapsoWhatsAppService = new KapsoWhatsAppService()
