/**
 * Proteksi DNS rebinding untuk URL lowongan publik (47.3 P1-06 & 48.4 BS-P3-09).
 *
 * `isPublicHttpUrl` hanya memeriksa teks URL (host bukan IP literal dan bukan akhiran `.local`/`.internal`).
 * Modul ini melengkapi dengan resolusi DNS (semua catatan A & AAAA): bila SATU SAJA alamat IP hasil
 * resolusi termasuk rentang privat, loopback, link-local (termasuk metadata cloud 169.254.169.254),
 * CGNAT, ULA IPv6, atau IPv4-mapped privat (`::ffff:127.0.0.1`), URL ditolak.
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isPublicHttpUrl } from './apply-channel.js'

export interface DnsAddressRecord {
  address: string
  family?: number
}

export type DnsLookupFn = (hostname: string) => Promise<DnsAddressRecord[]>

const defaultLookup: DnsLookupFn = async (hostname: string) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true })
  return rows.map((r) => ({ address: r.address, family: r.family }))
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums as [number, number, number, number]
}

function isPrivateIpv4(ip: string): boolean {
  const oct = parseIpv4(ip)
  if (!oct) return true
  const [a, b, c] = oct
  if (a === 0) return true // 0.0.0.0/8 ("this" network)
  if (a === 10) return true // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return true // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18.0.0/15 (benchmark)
  if (a === 198 && b === 51 && c === 100) return true // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false
}

/** True bila alamat IP (IPv4 atau IPv6) termasuk privat, loopback, link-local, atau cadangan non-publik. */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = String(rawIp ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  const zoneIdx = ip.indexOf('%')
  const clean = zoneIdx >= 0 ? ip.slice(0, zoneIdx) : ip
  const kind = isIP(clean)
  if (kind === 4) return isPrivateIpv4(clean)
  if (kind !== 6) return true

  // Loopback / unspecified
  if (clean === '::' || clean === '::1') return true
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 atau hex ::ffff:7f00:1)
  if (clean.startsWith('::ffff:')) {
    const rest = clean.slice('::ffff:'.length)
    if (isIP(rest) === 4) return isPrivateIpv4(rest)
    const hexParts = rest.split(':')
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16)
      const lo = parseInt(hexParts[1], 16)
      if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
        const mapped = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
        return isPrivateIpv4(mapped)
      }
    }
    return true
  }
  // Unique Local Address fc00::/7 (fc.. / fd..), Link-local fe80::/10 (fe80..febf), Multicast ff00::/8
  const firstHextet = parseInt(clean.split(':')[0] || '0', 16)
  if (Number.isNaN(firstHextet)) return true
  if ((firstHextet & 0xfe00) === 0xfc00) return true // fc00::/7
  if ((firstHextet & 0xffc0) === 0xfe80) return true // fe80::/10
  if ((firstHextet & 0xff00) === 0xff00) return true // ff00::/8
  if (clean.startsWith('2001:db8:')) return true // dokumentasi
  return false
}

export interface DnsCheckResult {
  ok: boolean
  reason?: 'invalid_url' | 'dns_lookup_failed' | 'dns_empty' | 'private_ip_resolved'
  addresses: string[]
}

/**
 * Verifikasi bahwa URL lowongan publik tidak beresolusi ke IP privat/internal (pencegahan DNS rebinding).
 */
export async function verifyPublicUrlDns(
  rawUrl: unknown,
  opts: { lookup?: DnsLookupFn; timeoutMs?: number } = {}
): Promise<DnsCheckResult> {
  if (!isPublicHttpUrl(rawUrl)) {
    return { ok: false, reason: 'invalid_url', addresses: [] }
  }
  const host = new URL(String(rawUrl)).hostname.toLowerCase().replace(/\.+$/, '')
  const lookupFn = opts.lookup ?? defaultLookup
  const timeoutMs = opts.timeoutMs ?? 4_000

  let records: DnsAddressRecord[]
  try {
    records = await Promise.race([
      lookupFn(host),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns_timeout')), timeoutMs)),
    ])
  } catch {
    return { ok: false, reason: 'dns_lookup_failed', addresses: [] }
  }

  const addresses = (Array.isArray(records) ? records : [])
    .map((r) => String(r?.address ?? '').trim())
    .filter(Boolean)
  if (addresses.length === 0) {
    return { ok: false, reason: 'dns_empty', addresses: [] }
  }
  if (addresses.some((addr) => isPrivateOrReservedIp(addr))) {
    return { ok: false, reason: 'private_ip_resolved', addresses }
  }
  return { ok: true, addresses }
}
