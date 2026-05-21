# Applify Backend

Automation backend for Applify - MCP servers, ATS APIs, AI pipeline, and job queue.

## Architecture

```
api/                      # Fastify API server
  routes/
    automation.ts         # Automation settings, logs, queue
    platforms.ts          # Job platforms CRUD
    sessions.ts           # Encrypted platform sessions
    ai.ts                 # AI generation endpoints
  middleware/
    auth.ts               # JWT auth middleware
mcp/                      # Model Context Protocol servers
  shared/
    types.ts              # Base types and interfaces
  greenhouse/             # Greenhouse ATS MCP
  lever/                  # Lever ATS MCP
  ashby/                  # Ashby ATS MCP
  workable/               # Workable ATS MCP
services/                 # Business logic
  mcp-registry.ts         # MCP client registry
  automation.service.ts   # Main automation orchestrator
  ai-pipeline.service.ts  # OpenRouter AI integration
  form-autofill.service.ts # Form field auto-filling
```

## Quick Start

```bash
# Install dependencies
npm install

# Copy env and configure
cp .env.example .env

# Development
npm run dev

# Build
npm run build

# Production
npm start
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key (server-side only) |
| `PORT` | No | Server port (default: 4000) |
| `FRONTEND_URL` | No | CORS allowed origin |
| `SESSION_ENCRYPTION_KEY` | Yes | 32-char key for session encryption |
| `OPENROUTER_API_KEY` | No | For AI features (optional) |
| `REDIS_URL` | No | For BullMQ queue (optional) |

## API Endpoints

### Automation
- `GET /api/automation/settings` - Get user automation settings
- `PUT /api/automation/settings` - Update settings
- `POST /api/automation/search` - Search jobs across platforms
- `GET /api/automation/logs` - Get application logs
- `GET /api/automation/queue` - Get queue status
- `POST /api/automation/queue` - Add job to queue

### AI
- `POST /api/ai/cover-letter` - Generate cover letter
- `POST /api/ai/answer` - Generate answer for question
- `POST /api/ai/extract-skills` - Extract skills from JD
- `POST /api/ai/analyze-match` - Analyze job match score
- `POST /api/ai/fill-form` - Auto-fill form fields

### Platforms
- `GET /api/platforms` - List supported platforms
- `GET /api/platforms/:name` - Get platform details

### Sessions
- `GET /api/sessions` - List platform sessions
- `POST /api/sessions/:platform` - Save session
- `GET /api/sessions/:platform/data` - Get decrypted session
- `DELETE /api/sessions/:platform` - Deactivate session

## Supported Job Platforms

| Platform | Type | Auth | Status |
|----------|------|------|--------|
| Greenhouse | API | None | Ready |
| Lever | API | None | Ready |
| Ashby | API | None | Ready |
| Workable | API | None | Ready |
| LinkedIn | Browser | Session | In Progress |
| JobStreet | Browser | Session | In Progress |
| Kalibrr | Scraper | None | In Progress |

## Authentication

All protected endpoints require a Bearer token from Supabase Auth:

```
Authorization: Bearer <supabase-jwt-token>
```

## Database Schema

See migration: `add_automation_schema`

### Tables
- `user_automation_settings` - User automation preferences
- `platform_sessions` - Encrypted platform session cookies
- `application_logs` - Audit trail for all actions
- `job_platforms` - Platform configuration
- `automation_queue` - Job queue for processing

## License

MIT
