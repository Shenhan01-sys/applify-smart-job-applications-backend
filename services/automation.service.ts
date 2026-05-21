import { supabase } from '../api/index.js'
import { mcpRegistry } from './mcp-registry.js'
import { BaseMCPClient, JobPosting } from '../mcp/shared/types.js'

export interface SearchParams {
  keywords?: string
  location?: string
  platforms?: string[]
  userId: string
}

export interface ApplyParams {
  userId: string
  jobId: string
  platform: string
  jobData: JobPosting
  settings: any
}

export class AutomationService {
  async searchJobs(params: SearchParams) {
    const { keywords, location, platforms, userId } = params

    // Get user's automation settings
    const { data: settings } = await supabase
      .from('user_automation_settings')
      .select('*')
      .eq('user_id', userId)
      .single()

    // Determine which platforms to search
    const platformsToSearch = platforms || ['greenhouse', 'lever', 'ashby', 'workable']
    const allResults: Array<{ platform: string; jobs: JobPosting[] }> = []

    for (const platformName of platformsToSearch) {
      const client = mcpRegistry.get(platformName)
      if (!client) continue

      try {
        const response = await client.searchJobs({
          keywords: keywords || settings?.search_keywords?.join(' ') || '',
          location: location || settings?.search_location || '',
        })

        if (response.success && response.data?.jobs) {
          // Filter by user's preferences
          let jobs = response.data.jobs as JobPosting[]

          // Apply blacklist filters
          if (settings?.blacklist_companies?.length > 0) {
            const blacklist = settings.blacklist_companies.map((c: string) =>
              c.toLowerCase()
            )
            jobs = jobs.filter(
              (j) => !blacklist.includes(j.company?.toLowerCase())
            )
          }

          if (settings?.blacklist_words?.length > 0) {
            const badWords = settings.blacklist_words.map((w: string) =>
              w.toLowerCase()
            )
            jobs = jobs.filter((j) => {
              const text = `${j.title} ${j.description}`.toLowerCase()
              return !badWords.some((word: string) => text.includes(word))
            })
          }

          // Filter by work type
          if (settings?.work_type_filter?.length > 0) {
            jobs = jobs.filter((j) =>
              settings.work_type_filter.includes(j.work_type)
            )
          }

          // Filter by experience level
          if (settings?.experience_level_filter?.length > 0) {
            jobs = jobs.filter((j) =>
              settings.experience_level_filter.includes(j.experience_level)
            )
          }

          allResults.push({ platform: platformName, jobs })
        }
      } catch (error) {
        console.error(`Search failed for ${platformName}:`, error)
      }
    }

    // Log the search action
    await this.logAction(userId, 'scan', 'multiple', '', '', 'success', {
      keywords,
      location,
      platforms: platformsToSearch,
      results_count: allResults.reduce((sum, r) => sum + r.jobs.length, 0),
    })

    return allResults
  }

  async logAction(
    userId: string,
    action: string,
    platform: string,
    jobId: string,
    jobTitle: string,
    status: string,
    details?: any
  ) {
    try {
      await supabase.from('application_logs').insert({
        user_id: userId,
        action,
        platform,
        job_id: jobId,
        job_title: jobTitle,
        status,
        details,
      })
    } catch (error) {
      console.error('Failed to log action:', error)
    }
  }
}

export const automationService = new AutomationService()
