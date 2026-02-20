# DeFi Bot Deploy Script
# Usage: .\deploy.ps1
# Deploys code to server, installs deps, builds, restarts PM2

$SERVER = "john@152.53.135.86"
$REMOTE_DIR = "~/defi-bot"

Write-Host "=== Deploying DeFi Bot ===" -ForegroundColor Cyan

# 1. Package code
Write-Host "  Packaging code..." -ForegroundColor Yellow
Compress-Archive -Path src, package.json, package-lock.json, tsconfig.json, tsconfig.build.json, ecosystem.config.cjs -DestinationPath deploy.zip -Force

# 2. Upload
Write-Host "  Uploading to server..." -ForegroundColor Yellow
scp deploy.zip "${SERVER}:${REMOTE_DIR}/deploy.zip"

# 3. Extract, install, build, restart on server
Write-Host "  Extracting, building, restarting..." -ForegroundColor Yellow
ssh $SERVER "export NVM_DIR=/home/john/.nvm; source /home/john/.nvm/nvm.sh; cd $REMOTE_DIR && unzip -o deploy.zip && rm deploy.zip && npm ci --production=false && npx tsc -p tsconfig.build.json && pm2 restart ecosystem.config.cjs && pm2 logs defi-bot --lines 5 --nostream"

# 4. Cleanup
Remove-Item deploy.zip -ErrorAction SilentlyContinue

Write-Host "=== Deploy Complete ===" -ForegroundColor Green
