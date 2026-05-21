import { BaseMCPClient, JobPosting, MCPResponse } from '../shared/types.js'
import { chromium } from 'playwright'

export class LinkedInMCPClient extends BaseMCPClient {
  name = 'linkedin'
  baseUrl = 'https://www.linkedin.com'
  private browser: any = null
  private context: any = null

  async initBrowser(headless = true, userDataDir?: string) {
    this.browser = await chromium.launch({
      headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ],
    })

    this.context = await this.browser.newContext({
      userAgent: this.getRandomUserAgent(),
      viewport: { width: 1280, height: 720 },
      ...(userDataDir ? { storageState: userDataDir } : {}),
    })
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

  async searchJobs(params: {
    keywords?: string
    location?: string
    company?: string
    page?: number
    limit?: number
  }): Promise<MCPResponse> {
    if (!this.context) {
      await this.initBrowser()
    }

    try {
      const page = await this.context.newPage()
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
      const jobs = await page.evaluate(() => {
        const jobCards = document.querySelectorAll('[data-job-id]')
        return Array.from(jobCards).slice(0, 25).map((card) => {
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

      await page.close()

      const jobPostings: JobPosting[] = jobs
        .filter((j) => j.id && j.title)
        .map((j) => ({
          id: j.id,
          title: j.title,
          company: j.company || 'Unknown',
          location: j.location || 'Remote',
          description: '',
          url: j.url,
          work_type: j.location?.toLowerCase().includes('remote') ? 'remote' : 'onsite',
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
    if (!this.context) {
      await this.initBrowser()
    }

    try {
      const page = await this.context.newPage()
      await page.goto(`${this.baseUrl}/jobs/view/${jobId}`, {
        waitUntil: 'networkidle',
      })

      await page.waitForSelector('.jobs-unified-top-card', { timeout: 10000 })

      const details = await page.evaluate(() => {
        const title = document.querySelector('.jobs-unified-top-card__job-title')?.textContent?.trim()
        const company = document.querySelector('.jobs-unified-top-card__company-name')?.textContent?.trim()
        const location = document.querySelector('.jobs-unified-top-card__bullet')?.textContent?.trim()
        const description = document.querySelector('.jobs-description__container')?.textContent?.trim()

        return { title, company, location, description }
      })

      await page.close()

      return {
        success: true,
        data: details,
      }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  private getRandomUserAgent(): string {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ]
    return agents[Math.floor(Math.random() * agents.length)]
  }
}
