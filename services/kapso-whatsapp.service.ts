import crypto from 'crypto'
import { networkErrorCode, notificationsEnabled, notifyTimeoutSignal } from './notifications-switch.js'

/**
 * Integrasi WhatsApp resmi via Kapso (`https://docs.kapso.ai/docs/introduction`).
 *
 * Referensi dokumentasi resmi Kapso (diakses 2026-11-24):
 *   - Kirim pesan Cloud API v24.0: `https://docs.kapso.ai/api-reference/messages/send-a-message`
 *     Endpoint: `POST https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}/messages` (`X-API-Key`)
 *   - Template `AUTHENTICATION` OTP: `https://docs.kapso.ai/api-reference/templates/create-or-update-message-template`
 *     Di luar jendela 24 jam Meta, OTP memakai template `KAPSO_OTP_TEMPLATE_NAME` kategori `AUTHENTICATION`
 *     (parameter `body` dan opsional tombol `button` `sub_type: "url"`, `index: "0"`).
 *   - Webhook Security: `https://docs.kapso.ai/webhook-security`
 *     Kapso native webhook (`kind: 'kapso'`) menandatangani raw body bytes lewat header `X-Webhook-Signature`
 *     (HMAC-SHA256 hex langsung tanpa prefix).
 *   - Webhooks Overview: `https://docs.kapso.ai/webhooks-overview`
 *     Header `X-Webhook-Event` (`whatsapp.message.received`), payload unbuffered maupun `batch: true`
 *     (`data[].message` & `conversation`), serta mode Meta-forwarded (`kind: 'meta'`) dengan `X-Hub-Signature-256`.
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
  otpTemplateName: string
  otpTemplateLang: string
  otpTemplateIncludeButton: boolean
  sandboxMode: boolean
}

export function kapsoConfigFromEnv(env: Record<string, string | undefined> = process.env): KapsoConfig {
  const templateLang = (env.KAPSO_TEMPLATE_LANG ?? 'id').trim() || 'id'
  return {
    apiKey: (env.KAPSO_API_KEY ?? '').trim(),
    phoneNumberId: (env.KAPSO_PHONE_NUMBER_ID ?? '').trim(),
    baseUrl: ((env.KAPSO_API_BASE_URL ?? '').trim() || DEFAULT_KAPSO_BASE_URL).replace(/\/+$/, ''),
    webhookSecret: (env.KAPSO_WEBHOOK_SECRET ?? '').trim(),
    templateName: (env.KAPSO_TEMPLATE_NAME ?? '').trim(),
    templateLang,
    otpTemplateName: (env.KAPSO_OTP_TEMPLATE_NAME ?? '').trim(),
    otpTemplateLang: (env.KAPSO_OTP_TEMPLATE_LANG ?? '').trim() || templateLang,
    otpTemplateIncludeButton: (env.KAPSO_OTP_TEMPLATE_INCLUDE_BUTTON ?? 'true').trim().toLowerCase() !== 'false',
    sandboxMode: (env.KAPSO_SANDBOX_MODE ?? '').trim().toLowerCase() === 'true',
  }
}

export function isKapsoConfigured(cfg: KapsoConfig = kapsoConfigFromEnv()): boolean {
  return Boolean(cfg.apiKey && cfg.phoneNumberId)
}

export interface NormalizePhoneOptions {
  /**
   * Untuk nomor yang diketik pengguna: tolak digit polos tanpa penanda negara (`+`, `00`, `0`, atau `62`).
   * `81234567890` bisa nomor Indonesia yang kehilangan angka 0, bisa pula nomor Jepang (+81); menebaknya
   * mengirim OTP ke orang lain (BS-05). Tanpa opsi ini digit polos dibaca sebagai E.164 tanpa `+`, sesuai
   * format `from` pada webhook WhatsApp.
   */
  requireCountryPrefix?: boolean
}

/**
 * Normalisasi nomor WhatsApp Indonesia / internasional ke format E.164 (`+628...`) maupun digit polos (`628...`).
 * Mengembalikan null bila tidak valid (bukan 8-15 digit). Angka 0 awal setelah kode negara Indonesia
 * (`+62 0812...`) dibuang karena tidak ada nomor Indonesia yang berawalan `620`.
 */
export function normalizeWhatsAppPhone(raw: unknown, opts: NormalizePhoneOptions = {}): { e164: string; waDigits: string } | null {
  if (typeof raw !== 'string') return null
  let digits = raw.replace(/[^\d+]/g, '').trim()
  if (digits.startsWith('00')) digits = '+' + digits.slice(2)
  if (digits.startsWith('0')) digits = '+62' + digits.slice(1)
  if (!digits.startsWith('+')) {
    if (digits.startsWith('62')) digits = '+' + digits
    else if (opts.requireCountryPrefix) return null
  }
  if (digits.startsWith('+620')) digits = '+62' + digits.slice(4)
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

function verifyHmacSha256RawHex(rawBody: string | Buffer, hexDigest: string, secret: string): boolean {
  if (!secret || !/^[a-f0-9]{64}$/i.test(hexDigest)) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(hexDigest.toLowerCase(), 'utf8')
  const b = Buffer.from(expected.toLowerCase(), 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Verifikasi satu nilai header signature webhook Kapso (`X-Webhook-Signature: <hex>` atau
 * `X-Hub-Signature-256: sha256=<hex>`) secara timing-safe (cek panjang buffer lebih dulu).
 */
export function verifyKapsoWebhookSignature(rawBody: string | Buffer, signatureHeader: unknown, secret: string): boolean {
  if (!secret || typeof signatureHeader !== 'string') return false
  const clean = signatureHeader.trim()
  const hex = clean.startsWith('sha256=') ? clean.slice('sha256='.length) : clean
  return verifyHmacSha256RawHex(rawBody, hex, secret)
}

function headerLookup(headers: Record<string, unknown>, targetLower: string): unknown {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === targetLower) return v
  }
  return undefined
}

/**
 * Verifikasi header signature request webhook Kapso/Meta terhadap raw body bytes (`Buffer`):
 *   - `X-Webhook-Signature`: HMAC-SHA256 hex murni tanpa prefix (mode native `kind: 'kapso'`)
 *   - `X-Hub-Signature-256`: `sha256=<hex>` (mode Meta-forwarded `kind: 'meta'`)
 * Sedikitnya satu header wajib hadir; setiap header yang hadir wajib cocok persis format & signature-nya.
 */
export function verifyKapsoWebhookRequest(
  rawBody: Buffer,
  headers: Record<string, unknown>,
  secret: string
): boolean {
  if (!Buffer.isBuffer(rawBody) || !secret) return false
  const kapsoHeader = headerLookup(headers, 'x-webhook-signature')
  const metaHeader = headerLookup(headers, 'x-hub-signature-256')

  const hasKapso = kapsoHeader !== undefined
  const hasMeta = metaHeader !== undefined
  if (!hasKapso && !hasMeta) return false

  if (hasKapso) {
    if (typeof kapsoHeader !== 'string') return false
    const sig = kapsoHeader.trim()
    if (!verifyHmacSha256RawHex(rawBody, sig, secret)) return false
  }
  if (hasMeta) {
    if (typeof metaHeader !== 'string') return false
    const sig = metaHeader.trim()
    if (!sig.startsWith('sha256=')) return false
    const hex = sig.slice('sha256='.length)
    if (!verifyHmacSha256RawHex(rawBody, hex, secret)) return false
  }
  return true
}

/**
 * Ekstrak daftar nomor pengirim pesan inbound (`whatsapp.message.received` Kapso native batch/unbuffered
 * maupun webhook Meta Cloud API `entry[].changes[].value.messages[]`). Event outbound/status dilewati.
 */
export function extractInboundWebhookPhones(payload: unknown, eventHeader?: unknown): string[] {
  if (typeof eventHeader === 'string' && eventHeader.trim()) {
    if (eventHeader.trim().toLowerCase() !== 'whatsapp.message.received') return []
  }
  if (!payload || typeof payload !== 'object') return []

  const root = payload as Record<string, any>
  if (typeof root.type === 'string' && root.type.trim() && root.type.trim().toLowerCase() !== 'whatsapp.message.received') {
    return []
  }

  const phones = new Set<string>()
  const collectKapsoItem = (item: any) => {
    if (!item || typeof item !== 'object') return
    const msg = item.message
    const conv = item.conversation
    const direction = typeof msg?.kapso?.direction === 'string' ? msg.kapso.direction.toLowerCase() : null
    if (direction === 'outbound') return
    if (typeof msg?.from === 'string') phones.add(msg.from)
    if (typeof msg?.kapso?.phone_number === 'string') phones.add(msg.kapso.phone_number)
    if (direction !== 'outbound' && typeof conv?.phone_number === 'string') phones.add(conv.phone_number)
  }

  // 1. Format Kapso buffered batch (`data[]`) & unbuffered single event (`message` / `conversation`)
  if (Array.isArray(root.data)) {
    for (const item of root.data) collectKapsoItem(item)
  }
  if (root.message || root.conversation) {
    collectKapsoItem(root)
  }

  // 2. Format Meta-forwarded (`entry[].changes[].value.messages[]`; `statuses[]` sengaja diabaikan)
  const collectMetaNode = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.from === 'string') phones.add(node.from)
    if (Array.isArray(node.messages)) {
      for (const m of node.messages) if (typeof m?.from === 'string') phones.add(m.from)
    }
    if (Array.isArray(node.entry)) {
      for (const e of node.entry) {
        for (const ch of Array.isArray(e?.changes) ? e.changes : []) collectMetaNode(ch?.value)
      }
    }
  }
  collectMetaNode(root)

  return [...phones]
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

  private async postWhatsAppPayload(
    cfg: KapsoConfig,
    mode: 'text' | 'template',
    payload: Record<string, unknown>
  ): Promise<KapsoSendResult> {
    try {
      const resp = await this.fetchImpl(`${cfg.baseUrl}/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': cfg.apiKey,
        },
        body: JSON.stringify(payload),
        signal: notifyTimeoutSignal(),
      })
      const text = await resp.text()
      let data: any = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = {}
      }
      if (!resp.ok) {
        const providerCode =
          typeof data?.error?.code === 'number' || typeof data?.error?.code === 'string'
            ? String(data.error.code).slice(0, 32)
            : ''
        console.warn(`[kapso] kirim gagal: HTTP ${resp.status}${providerCode ? ` kode ${providerCode}` : ''}`)
        return { ok: false, error: `kapso_http_${resp.status}` }
      }
      const messageId = Array.isArray(data?.messages) ? data.messages[0]?.id : data?.id
      return { ok: true, mode, ...(typeof messageId === 'string' ? { messageId } : {}) }
    } catch (err: unknown) {
      const code = networkErrorCode('kapso', err)
      console.warn(`[kapso] kirim gagal: ${code}`)
      return { ok: false, error: code }
    }
  }

  async sendMessage(args: {
    to: string
    body: string
    lastInboundAt?: string | null
    forceText?: boolean
    now?: Date
  }): Promise<KapsoSendResult> {
    if (!notificationsEnabled(this.env)) {
      return { ok: false, error: 'notifications_disabled' }
    }
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

    if (canSendText) {
      return this.postWhatsAppPayload(cfg, 'text', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: norm.waDigits,
        type: 'text',
        text: { body: cleanBody },
      })
    }
    if (cfg.templateName) {
      return this.postWhatsAppPayload(cfg, 'template', {
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
      })
    }
    return { ok: false, error: 'outside_24h_window_no_template' }
  }

  /**
   * Kirim kode OTP verifikasi WhatsApp:
   *   - Di dalam jendela 24 jam (atau `KAPSO_SANDBOX_MODE=true`): pesan teks langsung.
   *   - Di luar jendela 24 jam: wajib memakai template kategori `AUTHENTICATION` (`KAPSO_OTP_TEMPLATE_NAME`)
   *     dengan parameter `body` dan tombol `sub_type: "url"` (`index: "0"`), bukan template notifikasi umum.
   */
  async sendOtp(args: {
    to: string
    code: string
    lastInboundAt?: string | null
    now?: Date
  }): Promise<KapsoSendResult> {
    if (!notificationsEnabled(this.env)) {
      return { ok: false, error: 'notifications_disabled' }
    }
    const cfg = this.config()
    if (!isKapsoConfigured(cfg)) {
      return { ok: false, error: 'kapso_not_configured' }
    }
    const norm = normalizeWhatsAppPhone(args.to)
    if (!norm) return { ok: false, error: 'invalid_whatsapp_phone' }
    const cleanCode = String(args.code ?? '').trim()
    if (!/^\d{4,10}$/.test(cleanCode)) return { ok: false, error: 'invalid_otp_code' }

    const withinWindow = isWithinWhatsApp24hWindow(args.lastInboundAt, args.now ?? new Date())
    if (cfg.sandboxMode || withinWindow) {
      return this.postWhatsAppPayload(cfg, 'text', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: norm.waDigits,
        type: 'text',
        text: { body: `Kode verifikasi Applify Anda: ${cleanCode} (berlaku 10 menit). Jangan bagikan kode ini kepada siapa pun.` },
      })
    }
    if (!cfg.otpTemplateName) {
      return { ok: false, error: 'outside_24h_window_no_otp_template' }
    }

    const components: Array<Record<string, unknown>> = [
      {
        type: 'body',
        parameters: [{ type: 'text', text: cleanCode }],
      },
    ]
    if (cfg.otpTemplateIncludeButton) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: cleanCode }],
      })
    }

    return this.postWhatsAppPayload(cfg, 'template', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: norm.waDigits,
      type: 'template',
      template: {
        name: cfg.otpTemplateName,
        language: { code: cfg.otpTemplateLang },
        components,
      },
    })
  }
}

export const kapsoWhatsAppService = new KapsoWhatsAppService()
