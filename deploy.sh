#!/bin/bash
# Quick Deploy Script (run this after bootstrap finishes)
# Copy this to User Data or run manually after first SSH

cd /var/www/applify/applify-smart-job-applications/project/backend

# 1. Install dependencies
npm install

# 2. Build TypeScript
npm run build

# 3. Start with Docker Compose (Recommended)
docker-compose up -d

# OR start with PM2 (Alternative)
# pm2 start ecosystem.config.cjs

# 4. Check status
echo "📊 Deployment Status:"
docker-compose ps

# 5. Test health
echo "🏥 Health Check:"
sleep 5
curl http://localhost:4000/health
