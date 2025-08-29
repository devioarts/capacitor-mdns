// electron/mdns.ts
import type { Service, Browser } from 'bonjour-service';
import Bonjour from 'bonjour-service'
import { ipcMain, app } from 'electron'
import type { BrowserWindow } from 'electron'

const CHANNELS = ['mdns:startBroadcast', 'mdns:stopBroadcast', 'mdns:discover'] as const


export type MdnsTxt = Record<string, string>

export interface MdnsService {
  name: string
  type: string      // e.g. "_http._tcp."
  domain: string    // "local."
  port: number
  hosts?: string[]  // IPv4/IPv6 numeric addrs
  txt?: MdnsTxt
}

export interface MdnsBroadcastOptions {
  type?: string    // default "_http._tcp."
  id?: string      // default "CapacitorMDNS"
  domain?: string  // ignored here; always "local." in mDNS
  port: number     // required
  txt?: MdnsTxt
}

export interface MdnsDiscoverOptions {
  type?: string       // default "_http._tcp."
  id?: string         // normalized exact OR prefix match
  timeoutMs?: number  // default 3000
}

// ---- util: safe stop guards (řeší TS2722 + prázdné catch) -------------------
function hasCbStop(x: unknown): x is { stop: (cb?: () => void) => void } {
  return !!x && typeof (x as any).stop === 'function'
}
async function safeStopService(svc: Service | undefined): Promise<void> {
  if (!svc || !hasCbStop(svc)) return
  try {
    await new Promise<void>(res => {
      try { svc.stop(() => res()) } catch (e) {
        console.warn('[mDNS] service.stop threw:', e); res()
      }
    })
  } catch (err) {
    console.warn('[mDNS] service.stop awaited error:', err)
  }
}
function safeStopBrowser(b: Browser | null | undefined): void {
  if (!b) return
  try { b.stop() } catch (err) { console.warn('[mDNS] browser.stop error:', err) }
}

// ---- Manager ----------------------------------------------------------------
class ElectronMDNS {
  private bonjour = new Bonjour()
  private advertiser?: Service

  private normalize(name: string): string { return name.replace(/ \(\d+\)$/, '') }
  private matchesTarget(candidate: string, target?: string | null): boolean {
    if (!target) return true
    const c = this.normalize(candidate), t = this.normalize(target)
    return c === t || c.startsWith(t)
  }

  private parseType(typeWithDot?: string): { type: string; protocol: 'tcp' | 'udp' } {
    const s = (typeWithDot ?? '_http._tcp.').replace(/\.$/, '')
    const m = /^_([^.]+)\._(tcp|udp)$/.exec(s)
    if (!m) throw new Error(`Invalid mDNS type "${typeWithDot}". Expected e.g. "_http._tcp."`)
    return { type: m[1], protocol: m[2] as 'tcp' | 'udp' }
  }
  private toFullType(type: string, protocol: 'tcp' | 'udp'): string { return `_${type}._${protocol}.` }

  /** Start advertising; resolves po 'up' s finálním (případně uniquified) jménem. */
  async startBroadcast(opts: MdnsBroadcastOptions): Promise<{ publishing: boolean; name: string }> {
    const { type, protocol } = this.parseType(opts.type)
    const name = (opts.id?.trim() || 'CapacitorMDNS')
    const port = Number(opts.port || 0)
    if (!Number.isInteger(port) || port <= 0) throw new Error('Missing/invalid port')

    await this.stopBroadcast() // ensure single advertiser

    return new Promise<{ publishing: boolean; name: string }>((resolve, reject) => {
      try {
        const svc = this.bonjour.publish({ name, type, protocol, port, txt: opts.txt })

        const onUp = (): void => {
          svc.removeListener('error', onError)
          resolve({ publishing: true, name: svc.name || name })
        }
        const onError = (err: unknown): void => {
          try {
            if (hasCbStop(svc)) svc.stop()      // guard → žádný TS2722
          } catch (e) {
            console.warn('[mDNS] publish stop on error:', e)
          }
          svc.removeListener('up', onUp)
          reject(err instanceof Error ? err : new Error(String(err)))
        }

        svc.once('up', onUp)
        svc.once('error', onError)
        this.advertiser = svc
      } catch (e) {
        console.warn('[mDNS] publish threw:', e)
        reject(e as Error)
      }
    })
  }

  /** Stop advertising (no-op if not running). */
  async stopBroadcast(): Promise<{ publishing: boolean }> {
    if (this.advertiser) {
      await safeStopService(this.advertiser)   // guard + log
      this.advertiser = undefined
    }
    return { publishing: false }
  }

  /** Discover services; optional early-exit při matchi; timeboxed timeoutMs. */
  async discover(opts: MdnsDiscoverOptions = {}): Promise<{ services: MdnsService[] }> {
    const { type, protocol } = this.parseType(opts.type)
    const targetId = opts.id?.trim()
    const timeoutMs = Number.isInteger(opts.timeoutMs) ? (opts.timeoutMs as number) : 3000

    return new Promise<{ services: MdnsService[] }>(resolve => {
      const services: MdnsService[] = []
      let browser: Browser | null = null
      let finished = false
      let timer: NodeJS.Timeout | null = null

      const finish = (): void => {
        if (finished) return
        finished = true
        if (timer) { clearTimeout(timer); timer = null }
        safeStopBrowser(browser)
        resolve({ services })
      }

      try {
        browser = this.bonjour.find({ type, protocol }, (s) => {
          if (!this.matchesTarget(s.name || '', targetId)) return

          const item: MdnsService = {
            name: s.name || '',
            type: this.toFullType(type, protocol),
            domain: 'local.',
            port: s.port ?? 0,
            hosts: Array.isArray(s.addresses) ? s.addresses.slice() : [],
            txt: (s.txt && Object.keys(s.txt).length ? (s.txt as Record<string, string>) : undefined),
          }

          const key = `${item.name}:${item.port}`
          if (!services.some(x => `${x.name}:${x.port}` === key)) services.push(item)

          if (targetId && this.matchesTarget(item.name, targetId)) finish() // early-exit
        })

        timer = setTimeout(finish, timeoutMs)
        browser.on('error', (err: unknown) => {
          console.warn('[mDNS] browser error:', err)
          // necháme doběhnout timeout, ať vrátíme co už máme
        })
      } catch (err) {
        console.warn('[mDNS] discover threw:', err)
        finish()
      }
    })
  }


  async dispose(): Promise<void> {
    await this.stopBroadcast()
    try { this.bonjour.destroy() } catch (err) {
      console.warn('[mDNS] bonjour.destroy error:', err)
    }
  }
}

// ---- singleton + IPC --------------------------------------------------------
let mdnsSingleton: ElectronMDNS | null = null
export const getMdns = (): ElectronMDNS => (mdnsSingleton ??= new ElectronMDNS())

/** Call once from main after app is ready. */
export function registerMdnsIpc(): void {
  const mdns = getMdns()
  ipcMain.handle('mdns:startBroadcast', (_e, opts: MdnsBroadcastOptions) => mdns.startBroadcast(opts))
  ipcMain.handle('mdns:stopBroadcast',  (_e)                              => mdns.stopBroadcast())
  ipcMain.handle('mdns:discover',       (_e, opts: MdnsDiscoverOptions)   => mdns.discover(opts))
}

export async function teardownMdns(): Promise<void> {
  if (mdnsSingleton) {
    await mdnsSingleton.dispose()
    mdnsSingleton = null
  }
}
app.on('before-quit', () => { void teardownMdns() })

/** Wrapper „jako TCPClient“ – registruje IPC v konstruktoru, jednou za proces. */
export class MDNSMain {
  private static registered = false
  private win?: BrowserWindow

  constructor(win?: BrowserWindow) {
    this.win = win

    if (!MDNSMain.registered) {
      // HMR/reauth-safe: odeber staré handlery, pak zaregistruj
      for (const ch of CHANNELS) {
        try { ipcMain.removeHandler(ch) } catch (e) {
          console.warn(`[mDNS] removeHandler(${ch})`, e)
        }
      }
      registerMdnsIpc()
      MDNSMain.registered = true
    }
  }

  /** Volitelné – kdybys chtěl explicitně uklízet při zavírání app. */
  async dispose(): Promise<void> {
    await teardownMdns()
    MDNSMain.registered = false
  }
}
