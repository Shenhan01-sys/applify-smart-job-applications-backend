import { BaseMCPClient, BROWSER_LIKE_USER_AGENT, JobPosting, MCPResponse } from '../shared/types.js'
import { chromium } from 'playwright'
import { chromiumLaunchOptions } from '../shared/browser.js'

/**
 * Browser options for LinkedIn. Applify does not disguise its automation: no User-Agent rotation and no
 * flag that hides the automation marker (--disable-blink-features=AutomationControlled). One fixed,
 * ordinary desktop Chrome UA, the same one the other portal clients use (BROWSER_LIKE_USER_AGENT).
 * '--no-sandbox' stays because containers (Docker, EC2) cannot run Chromium's sandbox as root.
 */
export const LINKEDIN_LAUNCH_ARGS: string[] = ['--no-sandbox']

export function linkedinContextOptions(storageState?: string) {
  return {
    userAgent: BROWSER_LIKE_USER_AGENT,
    viewport: { width: 1280, height: 720 },
    ...(storageState ? { storageState } : {}),
  }
}

export class LinkedInMCPClient extends BaseMCPClient {
  name = 'linkedin'
  baseUrl = 'https://www.linkedin.com'
  displayName = 'LinkedIn'
  // Butuh sesi browser login -> tidak ikut agregasi default (opt-in lewat `platforms`).
  kind = 'browser' as const
  requiresCompany = false
  private browser: any = null
  private context: any = null
  private launchFn?: (opts: any) => Promise<any>

  constructor(opts?: { launch?: (opts: any) => Promise<any> }) {
    super()
    this.launchFn = opts?.launch
  }

  private launchBrowser(headless: boolean) {
    if (this.launchFn) {
      return this.launchFn(chromiumLaunchOptions({ headless, args: LINKEDIN_LAUNCH_ARGS }))
    }
    return chromium.launch(chromiumLaunchOptions({ headless, args: LINKEDIN_LAUNCH_ARGS }))
  }

  async initBrowser(headless = true, userDataDir?: string) {
    this.browser = await this.launchBrowser(headless)
    this.context = await this.browser.newContext(linkedinContextOptions(userDataDir))
  }

  async closeBrowser() {
    if (this.context) {
      await this.context.close()
      this.context = null
    }
    if (this.browser) {
      await this.browser.close()
      this.browser = null
    }
  }

  /**
   * Jalankan satu tugas halaman dengan isolasi context per permintaan (BS-P2-06):
   * bila caller tidak memanggil initBrowser() secara eksplisit, browser & context dibuat khusus
   * untuk panggilan ini dan selalu ditutup di finally agar tidak bocor atau bentrok antar-permintaan.
   */
  private async withPage<T>(fn: (page: any) => Promise<T>): Promise<T> {
    const owned = !this.context
    const browser = owned ? await this.launchBrowser(true) : null
    const context = owned ? await browser.newContext(linkedinContextOptions()) : this.context
    let page: any = null
    try {
      page = await context.newPage()
      return await fn(page)
    } finally {
      if (page) {
        try {
          await page.close()
        } catch {}
      }
      if (owned) {
        try {
          await context.close()
        } catch {}
        try {
          await browser.close()
        } catch {}
      }
    }
  }

  async searchJobs(params: {
    keywords?: string
    location?: string
    company?: string
    page?: number
    limit?: number
  }): Promise<MCPResponse> {
    try {
      const jobs = await this.withPage(async (page) => {
        const { keywords = '', location = '' } = params

        // Build search URL
        const searchUrl = new URL(`${this.baseUrl}/jobs/search`)
        if (keywords) searchUrl.searchParams.set('keywords', keywords)
        if (location) searchUrl.searchParams.set('location', location)
        searchUrl.searchParams.set('f_TPR', 'r86400') // Past 24 hours

        await page.goto(searchUrl.toString(), { waitUntil: 'networkidle' })

        // Wait for job listings
        await page.waitForSelector('[data-job-id]', { timeout: 10000 })

        // Extract job data
        return await page.evaluate(() => {
          const jobCards = document.querySelectorAll('[data-job-id]')
          return Array.from(jobCards).slice(0, 25).map((card: any) => {
            const jobId = card.getAttribute('data-job-id') || ''
            const titleEl = card.querySelector('.job-card-list__title')
            const companyEl = card.querySelector('.job-card-container__company-name')
            const locationEl = card.querySelector('.job-card-container__metadata-item')

            return {
              id: jobId,
              title: titleEl?.textContent?.trim() || '',
              company: companyEl?.textContent?.trim() || '',
              location: locationEl?.textContent?.trim() || '',
              url: `https://www.linkedin.com/jobs/view/${jobId}`,
            }
          })
        })
      })

      const jobPostings: JobPosting[] = jobs
        .filter((j: any) => j.id && j.title)
        .map((j: any) => ({
          id: j.id,
          title: j.title,
          company: j.company || 'Unknown',
          location: j.location || 'Remote',
          description: '',
          url: j.url,
          work_type: j.location?.toLowerCase().includes('remote') ? 'remote' : 'on-site',
          platform: 'linkedin',
          raw_data: j,
        }))

      return {
        success: true,
        data: { jobs: jobPostings, total: jobPostings.length },
      }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  async getJobDetails(jobId: string): Promise<MCPResponse> {
    try {
      const details = await this.withPage(async (page) => {
        await page.goto(`${this.baseUrl}/jobs/view/${jobId}`, {
          waitUntil: 'networkidle',
        })

        await page.waitForSelector('.jobs-unified-top-card', { timeout: 10000 })

        return await page.evaluate(() => {
          const title = document.querySelector('.jobs-unified-top-card__job-title')?.textContent?.trim()
          const company = document.querySelector('.jobs-unified-top-card__company-name')?.textContent?.trim()
          const location = document.querySelector('.jobs-unified-top-card__bullet')?.textContent?.trim()
          const description = document.querySelector('.jobs-description__container')?.textContent?.trim()

          return { title, company, location, description }
        })
      })

      return {
        success: true,
        data: details,
      }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }
}
