# E2E Testing Guide for Applify Automation

## Test Scenarios

### 1. Job Search Flow
```
User logs in → Navigates to Jobs → AI scans multiple platforms
→ Jobs appear in feed → User filters by preferences
```

**Test Steps:**
1. Login with valid credentials
2. Go to `/jobs`
3. Click "Scan Jobs" button
4. Verify loading state appears
5. Check that jobs from multiple platforms load
6. Test filters (remote, experience level, salary)
7. Verify job cards show match scores

### 2. AI Application Flow
```
User selects job → AI analyzes match → Generates cover letter
→ User reviews → Approves → AI submits → Status tracked
```

**Test Steps:**
1. Select a job from feed
2. Click "AI Apply"
3. Wait for match analysis
4. Review generated cover letter
5. Check application answers (if form detected)
6. Approve or reject
7. If approved, verify submission status updates

### 3. Human Approval Flow
```
AI prepares application → User gets notification
→ Opens approval modal → Reviews/edits cover letter
→ Approves or rejects with reason
```

**Test Steps:**
1. Trigger AI application (via test data)
2. Navigate to `/approvals`
3. Verify pending approval appears
4. Click "Review Application"
5. Edit cover letter
6. Test regenerate button
7. Approve and verify queue status
8. Reject and verify reason saved

### 4. Settings Configuration
```
User navigates to Automation Settings → Updates personal info
→ Sets search preferences → Configures AI model → Saves
```

**Test Steps:**
1. Go to `/automation-settings`
2. Fill in personal information
3. Set application answers
4. Configure search keywords and filters
5. Toggle behavior settings
6. Select AI provider and model
7. Save and verify persistence

### 5. Session Management
```
User checks LinkedIn session → Sees no session
→ Gets instructions → Exports cookies → Imports → Verified
```

**Test Steps:**
1. Go to session management (in automation settings)
2. Check LinkedIn status (should be inactive)
3. View import instructions
4. Import test session data
5. Verify session shows as active
6. Test session refresh

### 6. Rate Limiting
```
User hits daily quota → Sees limit reached → Next day resets
```

**Test Steps:**
1. Check rate limit status
2. Submit applications up to daily limit
3. Verify 429 error on excess requests
4. Check rate limit status shows 0 remaining
5. Wait for reset (or mock time)
6. Verify quota resets

## Mock Data

### Test Job Posting
```json
{
  "id": "test-job-123",
  "title": "Senior React Developer",
  "company": "TestCorp",
  "location": "Remote",
  "description": "We are looking for an experienced React developer with 5+ years of experience. Skills: React, TypeScript, Node.js.",
  "url": "https://example.com/job/123",
  "experience_level": "senior",
  "job_type": "full-time",
  "work_type": "remote"
}
```

### Test User Profile
```json
{
  "first_name": "Test",
  "last_name": "User",
  "years_of_experience": "5",
  "skills": ["React", "TypeScript", "Node.js", "Python"],
  "desired_salary": 120000,
  "current_ctc": 90000,
  "notice_period": 30
}
```

## API Test Scripts

### Using curl
```bash
# Health check
curl http://localhost:4000/health

# Get platforms
curl http://localhost:4000/api/platforms

# Search jobs (requires auth)
curl -X POST http://localhost:4000/api/automation/search \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"keywords":"react","location":"remote"}'

# Generate cover letter
curl -X POST http://localhost:4000/api/ai/cover-letter \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "jobTitle":"Senior React Developer",
    "company":"TestCorp",
    "jobDescription":"Looking for React expert...",
    "userProfile":{"firstName":"Test","lastName":"User","yearsOfExperience":"5","skills":["React","TypeScript"],"summary":"Experienced developer"}
  }'
```

### Using Playwright
```typescript
// tests/e2e/application-flow.spec.ts
import { test, expect } from '@playwright/test'

test('full application flow', async ({ page }) => {
  // Login
  await page.goto('/login')
  await page.fill('[name=email]', 'test@example.com')
  await page.fill('[name=password]', 'password')
  await page.click('button[type=submit]')
  
  // Navigate to jobs
  await page.goto('/jobs')
  await expect(page.locator('text=Job Feed')).toBeVisible()
  
  // Scan jobs
  await page.click('text=Scan Jobs')
  await expect(page.locator('[data-testid=job-card]')).toHaveCount({ min: 1 }, { timeout: 30000 })
  
  // Select job and apply
  await page.click('[data-testid=job-card]:first-child')
  await page.click('text=AI Apply')
  
  // Wait for approval modal
  await expect(page.locator('text=Review Application')).toBeVisible({ timeout: 30000 })
  
  // Approve
  await page.click('text=Approve & Submit')
  
  // Verify success
  await expect(page.locator('text=Application approved')).toBeVisible()
})
```

## Environment Setup for Testing

### Local Development
```bash
# Terminal 1 - Backend
cd project/backend
npm install
npm run dev

# Terminal 2 - Frontend
cd project/applify-smart-job-applications
npm install
npm run dev

# Terminal 3 - Redis (for BullMQ)
docker run -d -p 6379:6379 redis:7-alpine

# Terminal 4 - Tests
cd project/applify-smart-job-applications
npx playwright test
```

### CI/CD
```yaml
# .github/workflows/e2e.yml
name: E2E Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7-alpine
        ports: ['6379:6379']
    steps:
      - uses: actions/checkout@v3
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '22'
      - name: Install Backend Dependencies
        run: cd backend && npm ci
      - name: Start Backend
        run: cd backend && npm start &
      - name: Install Frontend Dependencies
        run: cd applify-smart-job-applications && npm ci
      - name: Install Playwright
        run: cd applify-smart-job-applications && npx playwright install
      - name: Run E2E Tests
        run: cd applify-smart-job-applications && npx playwright test
```

## Performance Benchmarks

| Operation | Target Time | Max Time |
|-----------|-------------|----------|
| Job search (4 platforms) | < 5s | < 10s |
| Cover letter generation | < 3s | < 8s |
| Form autofill (10 fields) | < 1s | < 3s |
| Match analysis | < 2s | < 5s |
| Page load (dashboard) | < 1s | < 3s |

## Troubleshooting

### Common Issues

**Issue:** AI generation fails with timeout
**Solution:** Check OpenRouter API key, verify network connectivity

**Issue:** LinkedIn scraping blocked
**Solution:** Verify session cookies, check if account flagged

**Issue:** Queue jobs stuck in pending
**Solution:** Check Redis connection, verify BullMQ workers running

**Issue:** Database connection errors
**Solution:** Verify Supabase credentials, check network rules

---

*Generated for Applify v1.0.0*
