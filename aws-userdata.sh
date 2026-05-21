#!/bin/bash
# Applify Backend - Complete Bootstrap & Deploy Script
# All-in-one: Install dependencies, setup environment, deploy application
# For Ubuntu 24.04 LTS on AWS EC2

set -e

LOG_FILE="/var/log/applify-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "🚀 Applify Backend Setup - $(date)"

# ============================================================
# PHASE 1: SYSTEM SETUP
# ============================================================
echo ""
echo "📦 Phase 1: System Setup"
echo "========================"

# Update system
apt-get update -y
apt-get upgrade -y

# Install core dependencies
apt-get install -y \
    docker.io \
    docker-compose \
    git \
    curl \
    wget \
    htop \
    nano \
    vim \
    nginx \
    certbot \
    python3-certbot-nginx \
    chromium-browser \
    chromium-chromedriver

# Start Docker
systemctl enable docker
systemctl start docker
usermod -aG docker ubuntu

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Install PM2 globally
npm install -g pm2

# Setup swap (2GB for safety)
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Optimize system for containers
sysctl -w vm.max_map_count=262144
echo 'vm.max_map_count=262144' >> /etc/sysctl.conf

# ============================================================
# PHASE 2: APPLICATION SETUP
# ============================================================
echo ""
echo "📥 Phase 2: Application Setup"
echo "=============================="

# Create app directory
mkdir -p /var/www/applify
chown ubuntu:ubuntu /var/www/applify

# Clone repository
su - ubuntu -c 'cd /var/www/applify && git clone https://github.com/Shenhan01-sys/applify-smart-job-applications.git'

# Setup environment file
cat > /var/www/applify/applify-smart-job-applications/project/backend/.env << 'ENVEOF'
# Database
SUPABASE_URL=https://dreexbadvlxufkrvvwrq.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here

# Server
PORT=4000
FRONTEND_URL=http://localhost:3000

# Security - CHANGE THIS!
SESSION_ENCRYPTION_KEY=your-32-character-encryption-key-here!!

# AI (Optional but recommended)
OPENROUTER_API_KEY=sk-or-v1-your-key-here

# Queue
REDIS_URL=redis://localhost:6379

# Optional: Tracing
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://cloud.langfuse.com
ENVEOF

chown ubuntu:ubuntu /var/www/applify/applify-smart-job-applications/project/backend/.env

# ============================================================
# PHASE 3: INSTALL & BUILD
# ============================================================
echo ""
echo "🔨 Phase 3: Install & Build"
echo "============================="

cd /var/www/applify/applify-smart-job-applications/project/backend

# Install dependencies
su - ubuntu -c 'cd /var/www/applify/applify-smart-job-applications/project/backend && npm install'

# Build TypeScript
su - ubuntu -c 'cd /var/www/applify/applify-smart-job-applications/project/backend && npm run build'

# ============================================================
# PHASE 4: DEPLOY WITH DOCKER COMPOSE
# ============================================================
echo ""
echo "🐳 Phase 4: Deploy with Docker Compose"
echo "========================================"

cd /var/www/applify/applify-smart-job-applications/project/backend

# Start services
docker-compose up -d

# Wait for services to start
sleep 10

# ============================================================
# PHASE 5: SETUP AUTO-START
# ============================================================
echo ""
echo "🔄 Phase 5: Setup Auto-Start"
echo "============================="

# Create systemd service for Docker Compose
cat > /etc/systemd/system/applify.service << 'SERVICEEOF'
[Unit]
Description=Applify Backend
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/var/www/applify/applify-smart-job-applications/project/backend
ExecStart=/usr/bin/docker-compose up -d
ExecStop=/usr/bin/docker-compose down
User=ubuntu

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable applify

# Setup Nginx
cat > /etc/nginx/sites-available/applify << 'NGINXEEOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINXEEOF

ln -sf /etc/nginx/sites-available/applify /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
systemctl enable nginx

# ============================================================
# PHASE 6: HEALTH CHECK
# ============================================================
echo ""
echo "🏥 Phase 6: Health Check"
echo "========================"

sleep 5

# Test health endpoint
if curl -f http://localhost:4000/health; then
    echo "✅ Health check PASSED"
else
    echo "⚠️ Health check failed - check logs: docker-compose logs"
fi

# ============================================================
# PHASE 7: CLEANUP
# ============================================================
echo ""
echo "🧹 Phase 7: Cleanup"
echo "===================="

apt-get autoremove -y
apt-get autoclean -y

# ============================================================
# COMPLETE
# ============================================================
echo ""
echo "✅ Applify Setup Complete!"
echo "=========================="
echo ""
echo "📋 Next Steps:"
echo "1. SSH: ssh -i 22Des_010207.pem ubuntu@YOUR_IP"
echo "2. Edit env: nano /var/www/applify/applify-smart-job-applications/project/backend/.env"
echo "3. Check status: docker-compose ps"
echo "4. View logs: docker-compose logs -f"
echo ""
echo "🌐 API URL: http://YOUR_IP/api/platforms"
echo "📊 Health: http://YOUR_IP/health"
echo ""
echo "📊 System Status:"
free -h
df -h
echo ""
echo "✅ Done - $(date)"
