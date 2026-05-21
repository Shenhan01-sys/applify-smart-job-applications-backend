import { Queue, Worker } from 'bullmq'
import { Redis } from 'ioredis'
import { supabase } from '../api/index.js'
import { automationService } from './automation.service.js'
import { aiPipelineService } from './ai-pipeline.service.js'

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})

// Job queues
export const scanQueue = new Queue('job-scan', { connection: redisConnection })
export const applyQueue = new Queue('job-apply', { connection: redisConnection })
export const analyzeQueue = new Queue('job-analyze', { connection: redisConnection })

// Queue Service
export class QueueService {
  async addScanJob(userId: string, params: {
    keywords?: string
    location?: string
    platforms?: string[]
  }) {
    return scanQueue.add('scan', {
      userId,
      ...params,
    }, {
      priority: 1,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    })
  }

  async addApplyJob(userId: string, jobData: any) {
    return applyQueue.add('apply', {
      userId,
      ...jobData,
    }, {
      priority: 2,
      attempts: 2,
      backoff: { type: 'fixed', delay: 10000 },
    })
  }

  async addAnalyzeJob(userId: string, jobDescription: string, userSkills: string[]) {
    return analyzeQueue.add('analyze', {
      userId,
      jobDescription,
      userSkills,
    }, {
      priority: 3,
      attempts: 2,
    })
  }

  async getQueueStatus(userId: string) {
    const [scanJobs, applyJobs, analyzeJobs] = await Promise.all([
      scanQueue.getJobs(['waiting', 'active', 'completed', 'failed']),
      applyQueue.getJobs(['waiting', 'active', 'completed', 'failed']),
      analyzeQueue.getJobs(['waiting', 'active', 'completed', 'failed']),
    ])

    const filterByUserAndStatus = (jobs: any[], status: string) =>
      jobs.filter((j) => j.data?.userId === userId && (j as any).status === status)

    return {
      scan: {
        waiting: filterByUserAndStatus(scanJobs, 'waiting').length,
        active: filterByUserAndStatus(scanJobs, 'active').length,
        completed: filterByUserAndStatus(scanJobs, 'completed').length,
        failed: filterByUserAndStatus(scanJobs, 'failed').length,
      },
      apply: {
        waiting: filterByUserAndStatus(applyJobs, 'waiting').length,
        active: filterByUserAndStatus(applyJobs, 'active').length,
        completed: filterByUserAndStatus(applyJobs, 'completed').length,
        failed: filterByUserAndStatus(applyJobs, 'failed').length,
      },
      analyze: {
        waiting: filterByUserAndStatus(analyzeJobs, 'waiting').length,
        active: filterByUserAndStatus(analyzeJobs, 'active').length,
        completed: filterByUserAndStatus(analyzeJobs, 'completed').length,
        failed: filterByUserAndStatus(analyzeJobs, 'failed').length,
      },
    }
  }
}

// Workers
export function initializeWorkers() {
  // Scan worker
  new Worker('job-scan', async (job) => {
    const { userId, keywords, location, platforms } = job.data

    // Update Supabase queue status
    await supabase.from('automation_queue').update({
      status: 'processing',
      processed_at: new Date().toISOString(),
    }).eq('user_id', userId).eq('job_type', 'scan_jobs')

    try {
      const results = await automationService.searchJobs({
        userId,
        keywords,
        location,
        platforms,
      })

      // Save results to applications table for review
      for (const platformResult of results) {
        for (const jobPosting of platformResult.jobs) {
          await supabase.from('jobs').upsert({
            platform: platformResult.platform,
            title: jobPosting.title,
            company: jobPosting.company,
            location: jobPosting.location,
            description: jobPosting.description,
            url: jobPosting.url,
            posted_at: jobPosting.posted_at,
            experience_level: jobPosting.experience_level,
            job_type: jobPosting.job_type,
            work_type: jobPosting.work_type,
            raw_data: jobPosting.raw_data,
          }, { onConflict: 'url' })
        }
      }

      // Update status
      await supabase.from('automation_queue').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      }).eq('user_id', userId).eq('job_type', 'scan_jobs')

      return { success: true, count: results.reduce((sum: number, r: any) => sum + r.jobs.length, 0) }
    } catch (error: any) {
      await supabase.from('automation_queue').update({
        status: 'failed',
        error_message: error.message,
      }).eq('user_id', userId).eq('job_type', 'scan_jobs')

      throw error
    }
  }, { connection: redisConnection, concurrency: 3 })

  // Analyze worker
  new Worker('job-analyze', async (job) => {
    const { userId, jobDescription, userSkills } = job.data

    try {
      const analysis = await aiPipelineService.analyzeJobMatch(jobDescription, userSkills)

      // Log the analysis
      await automationService.logAction(
        userId,
        'analyze',
        'ai',
        '',
        '',
        'success',
        analysis
      )

      return analysis
    } catch (error: any) {
      await automationService.logAction(
        userId,
        'analyze',
        'ai',
        '',
        '',
        'failed',
        { error: error.message }
      )
      throw error
    }
  }, { connection: redisConnection, concurrency: 5 })

  console.log('Queue workers initialized')
}

export const queueService = new QueueService()
