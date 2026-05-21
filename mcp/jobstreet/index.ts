import { BaseMCPClient, JobPosting, MCPResponse } from '../shared/types.js'
import { chromium } from 'playwright'

export class JobStreetMCPClient extends BaseMCPClient {
  name = 'jobstreet'
  baseUrl = 'https://www.jobstreet.co.id'
  private browser: any = null
  private context: any = null

  async initBrowser(headless = true) {
    this.browser = await chromium.launch({
      headless,
      args: ['--no-sandbox'],
    })

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
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
      const { keywords = '' } = params

      // Navigate to jobstreet
      await page.goto(`${this.baseUrl}/en/`, { waitUntil: 'networkidle' })

      // Search for jobs
      const searchInput = await page.waitForSelector('#searchKeywordsField', { timeout: 10000 })
      if (searchInput) {
        await searchInput.fill(keywords)
        await searchInput.press('Enter')
      }

      // Wait for results
      await page.waitForSelector('[data-automation="jobList"]', { timeout: 10000 })

      // Extract job listings
      const jobs = await page.evaluate(() => {
        const articles = document.querySelectorAll('article')
        return Array.from(articles).slice(0, 20).map((article: any, index: number) => {
          const titleEl = article.querySelector('h1 a')
          const companyEl = article.querySelector('[data-automation="jobTitle"]')
          const locationEl = article.querySelector('[data-automation="jobLocation"]')
          const timeEl = article.querySelector('time')

          return {
            id: `js-${index}`,
            title: titleEl?.textContent?.trim() || '',
            company: companyEl?.textContent?.trim() || '',
            location: locationEl?.textContent?.trim() || '',
            postedAt: timeEl?.getAttribute('datetime') || '',
            url: titleEl?.getAttribute('href') || '',
          }
        })
      })

      await page.close()

      const jobPostings: JobPosting[] = jobs
        .filter((j: any) => j.title)
        .map((j: any) => ({
          id: j.id,
          title: j.title,
          company: j.company || 'Unknown',
          location: j.location || 'Indonesia',
          description: '',
          url: j.url.startsWith('http') ? j.url : `${this.baseUrl}${j.url}`,
          posted_at: j.postedAt,
          work_type: 'onsite',
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
    return {
      success: false,
      error: 'JobStreet job details require browser navigation',
    }
  }
}
