#!/bin/bash
# Applify Backend Bootstrap Script
# Auto-install untuk Ubuntu 24.04 LTS
# Created: 20 May 2026

set -e  # Exit on error

echo "🚀 Starting Applify Backend Setup..."

# 1. System Update
echo "📦 Updating system packages..."
apt-get update -y
apt-get upgrade -y

# 2. Install Docker
echo "🐳 Installing Docker..."
apt-get install -y docker.io docker-compose
usermod -aG docker ubuntu
systemctl enable docker
systemctl start docker

# 3. Install Node.js 22
echo "⬢ Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# 4. Install PM2 (optional, for non-Docker deploy)
echo "⚡ Installing PM2..."
npm install -g pm2

# 5. Install Chrome/Chromium for Playwright
echo "🌐 Installing Chromium browser..."
apt-get install -y chromium-browser chromium-chromedriver

# 6. Install Git and utilities
echo "🛠️ Installing utilities..."
apt-get install -y git curl wget htop nano vim

# 7. Install Nginx
echo "🌐 Installing Nginx..."
apt-get install -y nginx
systemctl enable nginx

# 8. Setup swap (2GB untuk safety)
echo "💾 Setting up swap..."
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# 9. Optimize system for Docker
echo "🔧 Optimizing system..."
sysctl -w vm.max_map_count=262144
echo 'vm.max_map_count=262144' >> /etc/sysctl.conf

# 10. Create app directory
echo "📁 Creating application directory..."
mkdir -p /var/www/applify
chown ubuntu:ubuntu /var/www/applify

# 11. Clone repository (as ubuntu user)
echo "📥 Cloning repository..."
su - ubuntu -c 'cd /var/www/applify && git clone https://github.com/Shenhan01-sys/applify-smart-job-applications.git'

# 12. Setup environment file template
echo "📝 Creating environment template..."
cat > /var/www/applify/applify-smart-job-applications/project/backend/.env << 'EOF'
# Database
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Server
PORT=4000
FRONTEND_URL=https://your-domain.com

# Security (GANTI INI!)
SESSION_ENCRYPTION_KEY=change-me-32-characters-key!!

# AI (Optional tapi recommended)
OPENROUTER_API_KEY=sk-or-v1-...

# Queue
REDIS_URL=redis://localhost:6379

# Tracing (Optional)
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://cloud.langfuse.com
EOF

chown ubuntu:ubuntu /var/www/applify/applify-smart-job-applications/project/backend/.env

# 13. Install PM2 ecosystem (as ubuntu user)
echo "📋 Setting up PM2..."
su - ubuntu -c 'cd /var/www/applify/applify-smart-job-applications/project/backend && npm install'

# 14. Setup Docker Compose to start on boot
echo "🔄 Setting up auto-start..."
cat > /etc/systemd/system/applify-docker.service << 'EOF'
[Unit]
Description=Applify Docker Compose
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
EOF

systemctl daemon-reload
systemctl enable applify-docker

# 15. Create health check script
echo "🏥 Creating health check script..."
cat > /usr/local/bin/applify-health.sh << 'EOF'
#!/bin/bash
# Health check script
curl -f http://localhost:4000/health || exit 1
EOF
chmod +x /usr/local/bin/applify-health.sh

# 16. Final cleanup
echo "🧹 Cleaning up..."
apt-get autoremove -y
apt-get autoclean -y

echo ""
echo "✅ Setup Complete!"
echo ""
echo "📋 Next Steps:"
echo "1. SSH ke instance: ssh -i 22Des_010207.pem ubuntu@YOUR_IP"
echo "2. Edit .env file: nano /var/www/applify/applify-smart-job-applications/project/backend/.env"
echo "3. Deploy: cd /var/www/applify/applify-smart-job-applications/project/backend && docker-compose up -d"
echo ""
echo "📊 Resource Usage:"
free -h
df -h
