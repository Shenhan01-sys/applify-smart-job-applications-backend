import { GreenhouseMCPClient } from '../mcp/greenhouse/index.js'
import { LeverMCPClient } from '../mcp/lever/index.js'
import { AshbyMCPClient } from '../mcp/ashby/index.js'
import { WorkableMCPClient } from '../mcp/workable/index.js'
import { LinkedInMCPClient } from '../mcp/linkedin/index.js'
import { JobStreetMCPClient } from '../mcp/jobstreet/index.js'
import { BaseMCPClient } from '../mcp/shared/types.js'

export class MCPRegistry {
  private clients: Map<string, BaseMCPClient> = new Map()

  constructor() {
    this.register('greenhouse', new GreenhouseMCPClient())
    this.register('lever', new LeverMCPClient())
    this.register('ashby', new AshbyMCPClient())
    this.register('workable', new WorkableMCPClient())
    this.register('linkedin', new LinkedInMCPClient())
    this.register('jobstreet', new JobStreetMCPClient())
  }

  register(name: string, client: BaseMCPClient) {
    this.clients.set(name, client)
  }

  get(name: string): BaseMCPClient | undefined {
    return this.clients.get(name)
  }

  list(): string[] {
    return Array.from(this.clients.keys())
  }

  async searchAllPlatforms(params: {
    keywords?: string
    location?: string
    companies?: string[]
  }): Promise<Array<{ platform: string; jobs: any[] }>> {
    const results = []

    for (const [name, client] of this.clients) {
      try {
        const response = await client.searchJobs({
          keywords: params.keywords,
          location: params.location,
          company: params.companies?.[0],
        })

        if (response.success && response.data?.jobs) {
          results.push({
            platform: name,
            jobs: response.data.jobs,
          })
        }
      } catch (error) {
        console.error(`Failed to search ${name}:`, error)
      }
    }

    return results
  }
}

export const mcpRegistry = new MCPRegistry()
