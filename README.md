# Applify Backend

Automation backend for Applify - MCP servers, ATS APIs, AI pipeline, and job queue.

> **Queue: DATABASE-AS-QUEUE (tidak butuh Redis/BullMQ).** Sejak 2026-08-03,
> `services/queue.service.ts` menulis job langsung ke tabel `automation_queue`
> (Supabase), dan proses pekerjaan ditangani oleh **Worker terpisah**
> (`worker/` via `claim_automation_jobs`). Backend kini **start tanpa Redis**.
> `REDIS_URL` tidak lagi diperlukan (deprecated).

## Architecture

```
api/                      # Fastify API server
  routes/
    automation.ts         # Automation settings, logs, queue
    platforms.ts          # Job platforms CRUD
    sessions.ts           # Encrypted platform sessions
    ai.ts                 # AI generation endpoints
    queue.ts              # Queue status / enqueue (DB-as-queue)
  middleware/
    auth.ts               # JWT auth middleware
mcp/                      # Klien sumber lowongan + Applify Jobs MCP server
  shared/
    types.ts              # BaseMCPClient, JobPosting, SearchParams, SourceKind
    utils.ts              # htmlToText, filter lokasi/kata kunci, skor relevansi
  greenhouse/ lever/ ashby/ workable/ smartrecruiters/   # ATS global (API publik per perusahaan)
  jobstreet/ glints/ kalibrr/                            # Portal lowongan Indonesia (endpoint pencarian publik)
  linkedin/               # Butuh sesi browser (opt-in)
  server.ts               # Applify Jobs MCP server (stdio / Streamable HTTP)
  smoke-portals.ts        # Smoke test live + bukti JSON di project/uat/aggregation/
  __tests__/              # Uji normalizer, agregasi, ingest (offline)
config/
  job-boards.json         # Daftar papan karier (slug) per sumber ATS
services/                 # Business logic
  mcp-registry.ts         # Registry klien sumber + papan default
  job-aggregation.service.ts # Agregasi lintas sumber, dedupe, ranking relevansi
  job-ingest.service.ts   # Simpan hasil ke tabel jobs (dedupe external_url)
  automation.service.ts   # Orkestrasi pencarian + preferensi pengguna
  ai-pipeline.service.ts  # OpenRouter AI integration
  form-autofill.service.ts # Form field auto-filling
  queue.service.ts        # Database-as-queue (no Redis)
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

# Agregasi lowongan multi-portal
npm run test:portals                 # uji offline (normalizer, agregasi, ingest)
npm run smoke:portals                # uji live semua sumber -> project/uat/aggregation/proof-aggregation-latest.json
npm run smoke:portals -- --via-mcp   # + uji jalur MCP (spawn server stdio, panggil tool)
npm run mcp:jobs                     # Applify Jobs MCP server via stdio (untuk agen AI)
npm run mcp:jobs:http                # Applify Jobs MCP server via Streamable HTTP (untuk worker)
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
| `REDIS_URL` | No | Deprecated — queue memakai DB-as-queue, tanpa Redis |
| `APPLIFY_JOBS_MCP_PORT` | No | Port Applify Jobs MCP server mode HTTP (default 8090) |
| `JOB_BOARDS_CONFIG` | No | Path alternatif untuk `config/job-boards.json` |
| `GLINTS_BROWSER_FALLBACK` | No | `false` untuk mematikan fallback Playwright saat API Glints diblok WAF |

## Skor kecocokan (`jobs.match_score`)

Setiap lowongan yang disimpan oleh `POST /api/automation/search` (dan oleh handler `search` di `worker/`) mendapat
`jobs.match_score`, bilangan bulat 0-100, dari skor relevansi deterministik `relevanceScore`
(`mcp/shared/utils.ts`). Tanpa LLM, dan siapa pun dapat menghitung ulangnya dari data yang sama.

```
bobot maksimum = 3 x (jumlah token kata kunci unik) + 2 x (jumlah skill profil unik)
bobot cocok    = 3 per token yang ada di judul, atau 1 per token yang hanya ada di deskripsi,
                 + 2 per skill profil yang ada di judul atau deskripsi
match_score    = round(100 x bobot cocok / bobot maksimum)
```

- Kata kunci berasal dari pencarian (atau `user_automation_settings.search_keywords`), skill dari `user_skills`
  milik pengguna yang mencari. Token kurang dari 2 huruf dan kata henti dibuang.
- Tidak ada kata kunci dan tidak ada skill: `match_score` = `null` (tidak ada yang dibandingkan). Layar menampilkan
  "—", bukan 0%.
- `jobs` dipakai bersama semua pengguna, jadi kolom ini menyimpan skor untuk pengguna yang pencariannya pertama kali
  menyimpan lowongan itu. Lowongan lama tidak ditimpa; yang `match_score`-nya masih kosong diisi. Skor untuk pengguna
  yang sedang mencari selalu ada di respons (`jobs[].match_score`, `jobs[].relevance`).

## API Endpoints

### Automation
- `GET /api/automation/settings` - Get user automation settings
- `PUT /api/automation/settings` - Update settings
- `POST /api/automation/search` - Agregasi lowongan lintas sumber. Body: `{ keywords?, location? ('Indonesia' default, 'any'), platforms?, companies?: {platform: slug[]}, persist? (default true), limit? }`. Respons: `{ jobs, total, results, total_jobs, stats, ingest, query, durationMs }`
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

| Sumber | Jenis | Akses | Butuh `company` | Catatan |
|--------|-------|-------|-----------------|---------|
| Greenhouse | ATS | Board API publik | Ya | `boards-api.greenhouse.io` |
| Lever | ATS | Postings API publik | Ya | `api.lever.co/v0/postings` |
| Ashby | ATS | Posting API publik | Ya | `api.ashbyhq.com/posting-api` |
| Workable | ATS | Widget API publik | Ya | `apply.workable.com/api/v1/widget` |
| SmartRecruiters | ATS | Posting API publik | Ya | Formulir lamaran publik tanpa login |
| JobStreet (SEEK) | Portal | JobSearch API v5 | Tidak | `id.jobstreet.com/api/jobsearch/v5` |
| Glints | Portal | GraphQL `searchJobsV3` | Tidak | Fallback Playwright bila diblok WAF |
| Kalibrr | Portal | `kjs/job_board/search` | Tidak | |
| LinkedIn | Browser | Sesi login | Tidak | Opt-in lewat `platforms`; worker memakai linkedin-mcp-server |

Papan default untuk sumber ATS ada di `config/job-boards.json`. Sumber yang gagal tidak
menggagalkan pencarian: error dicatat per sumber di `stats[].errors`.

## Applify Jobs MCP Server

Semua klien di atas juga diekspos sebagai server Model Context Protocol (`mcp/server.ts`)
dengan tool `list_platforms`, `search_jobs`, `search_all_platforms`, dan `get_job_details`.

- **stdio** (`npm run mcp:jobs`): untuk agen AI desktop. Contoh konfigurasi klien MCP:
  `{ "command": "npx", "args": ["tsx", "mcp/server.ts"], "cwd": "<path>/project/backend" }`
- **Streamable HTTP** (`npm run mcp:jobs:http`): endpoint `http://localhost:8090/mcp`
  (stateless), health check `GET /health`. Dipakai worker lewat `APPLIFY_JOBS_MCP_URL`.

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
