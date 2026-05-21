import { Queue, Worker, Job } from 'bullmq'
import IORedis from 'ioredis'
import { supabase } from '../api/index.js'
import { automationService } from './automation.service.js'
import { aiPipelineService } from './ai-pipeline.service.js'

const redisConnection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
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

    const filterByUser = (jobs: Job[]) =>
      jobs.filter((j) => j.data.userId === userId)

    return {
      scan: {
        waiting: filterByUser(scanJobs.filter((j) => j.status === 'waiting')).length,
        active: filterByUser(scanJobs.filter((j) => j.status === 'active')).length,
        completed: filterByUser(scanJobs.filter((j) => j.status === 'completed')).length,
        failed: filterByUser(scanJobs.filter((j) => j.status === 'failed')).length,
      },
      apply: {
        waiting: filterByUser(applyJobs.filter((j) => j.status === 'waiting')).length,
        active: filterByUser(applyJobs.filter((j) => j.status === 'active')).length,
        completed: filterByUser(applyJobs.filter((j) => j.status === 'completed')).length,
        failed: filterByUser(applyJobs.filter((j) => j.status === 'failed')).length,
      },
      analyze: {
        waiting: filterByUser(analyzeJobs.filter((j) => j.status === 'waiting')).length,
        active: filterByUser(analyzeJobs.filter((j) => j.status === 'active')).length,
        completed: filterByUser(analyzeJobs.filter((j) => j.status === 'completed')).length,
        failed: filterByUser(analyzeJobs.filter((j) => j.status === 'failed')).length,
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
