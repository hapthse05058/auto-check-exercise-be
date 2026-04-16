# Deployment Guide: Auto-Check Exercise Backend to Free Cloud Hosts

This guide covers deploying your Node.js backend to various free cloud hosting platforms.

## Prerequisites

Before deploying, ensure you have:

1. ✅ All environment variables configured
2. ✅ Dockerfile is ready (already provided)
3. ✅ Node.js version >= 18
4. ✅ Git repository initialized
5. ✅ Required API keys:
   - OpenAI API Key
   - Google OAuth2 credentials
   - Extension secret key

## Environment Variables Setup

Create a list of all required environment variables:

```env
PORT=8080
OPENAI_API_KEY=your_openai_key
OPENAI_PROJECT_ID=your_openai_project
ASSISTANT_ID=your_assistant_id
CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_secret
REDIRECT_URI=https://your-domain.com/callback
EXTENSION_SECRET_KEY=your_secret_key
ALLOWED_EMAILS=phamhongha.innerpiece@gmail.com,linha6pct2017@gmail.com
```

⚠️ **Important**: Never commit these to Git! Store them securely in your hosting platform's environment variables section.

---

## Option 1: Google Cloud Run (Recommended) ⭐

**Free Tier**: 2 million requests/month, 360,000 GB-seconds memory, 180,000 vCPU-seconds

### Step 1: Prepare Docker Image

```bash
# Build Docker image
docker build -t gcr.io/YOUR_PROJECT_ID/auto-check-exercise-be .

# Test locally
docker run -p 8080:8080 --env-file .env auto-check-exercise-be
```

### Step 2: Push to Google Container Registry

```bash
# Authenticate with gcloud
gcloud auth configure-docker

# Tag image
docker tag auto-check-exercise-be gcr.io/YOUR_PROJECT_ID/auto-check-exercise-be

# Push to registry
docker push gcr.io/YOUR_PROJECT_ID/auto-check-exercise-be
```

### Step 3: Deploy to Cloud Run

```bash
gcloud run deploy auto-check-exercise-be \
  --image gcr.io/YOUR_PROJECT_ID/auto-check-exercise-be \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars PORT=8080,OPENAI_API_KEY=xxx,OPENAI_PROJECT_ID=xxx,ASSISTANT_ID=xxx,CLIENT_ID=xxx,GOOGLE_CLIENT_SECRET=xxx,REDIRECT_URI=xxx,EXTENSION_SECRET_KEY=xxx
```

### Step 4: Configure Authentication

Since your app requires Google OAuth2:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to APIs & Services > Credentials
3. Add your Cloud Run URL to authorized redirect URIs
4. Update `REDIRECT_URI` environment variable

### Pros
- ✅ Generous free tier
- ✅ Auto-scaling
- ✅ Built-in HTTPS
- ✅ Easy integration with other Google services
- ✅ No server management

### Cons
- ❌ Cold starts (can be mitigated with Cloud Scheduler pings)
- ❌ Requires credit card for setup
- ❌ Statelessness (no persistent storage)

---

## Option 2: Railway

**Free Tier**: $5 free credit/month (~500 hours of runtime)

### Step 1: Connect GitHub Repository

1. Go to [Railway.app](https://railway.app/)
2. Sign in with GitHub
3. Click "New Project"
4. Select "Deploy from GitHub repo"
5. Choose your repository

### Step 2: Configure Environment Variables

In Railway dashboard:
1. Go to your project
2. Click "Variables" tab
3. Add all environment variables from the list above

### Step 3: Deploy

Railway auto-detects Node.js and deploys automatically.

For Docker deployment:
1. Add `railway.toml` file:

```toml
[build]
builder = "DOCKERFILE"

[deploy]
startCommand = "node backend/server.js"
```

### Pros
- ✅ Very easy setup
- ✅ Automatic deployments from Git
- ✅ Free PostgreSQL/Redis if needed
- ✅ No Docker knowledge required

### Cons
- ❌ Limited free credit
- ❌ Sleeps after inactivity
- ❌ Requires GitHub repository

---

## Option 3: Render

**Free Tier**: 750 hours/month (continuous uptime)

### Step 1: Create Web Service

1. Go to [Render.com](https://render.com/)
2. Click "New +" > "Web Service"
3. Connect your repository
4. Configure:
   - **Name**: auto-check-exercise-be
   - **Environment**: Node
   - **Build Command**: `cd backend && npm install`
   - **Start Command**: `cd backend && node server.js`

### Step 2: Set Environment Variables

In Render dashboard:
1. Go to your service
2. Click "Environment" tab
3. Add all variables

### Step 3: Docker Deployment (Alternative)

For Docker-based deployment:

1. Choose "Docker" as environment
2. Render will use your Dockerfile automatically
3. Set environment variables as above

### Pros
- ✅ True free tier (no credit card required)
- ✅ Automatic HTTPS
- ✅ Continuous deployment from Git
- ✅ 750 hours/month free

### Cons
- ❌ Service sleeps after 15 minutes of inactivity
- ❌ Limited to 512MB RAM
- ❌ Slower cold starts

---

## Option 4: Fly.io

**Free Tier**: 3 shared VMs (256MB each), 3GB persistent volume

### Step 1: Install Fly CLI

```bash
# Windows (PowerShell)
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"

# Or via npm
npm install -g @flyio/flyctl
```

### Step 2: Authenticate and Create App

```bash
# Login
flyctl auth signup
flyctl auth login

# Create app
flyctl launch --name auto-check-exercise-be

# Don't deploy yet, just create the app
```

### Step 3: Configure for Deployment

Create `fly.toml` in root directory:

```toml
app = "auto-check-exercise-be"
primary_region = "sin"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]

[env]
  PORT = "8080"
  # Add other environment variables here or use flyctl secrets
```

### Step 4: Set Secrets

```bash
flyctl secrets set OPENAI_API_KEY=xxx
flyctl secrets set OPENAI_PROJECT_ID=xxx
flyctl secrets set ASSISTANT_ID=xxx
flyctl secrets set CLIENT_ID=xxx
flyctl secrets set GOOGLE_CLIENT_SECRET=xxx
flyctl secrets set REDIRECT_URI=xxx
flyctl secrets set EXTENSION_SECRET_KEY=xxx
```

### Step 5: Deploy

```bash
flyctl deploy
```

### Pros
- ✅ Generous free allowance
- ✅ Global edge locations
- ✅ Persistent storage available
- ✅ Auto-start/stop to save resources

### Cons
- ❌ Requires credit card
- ❌ More complex setup
- ❌ Limited to 3 free VMs

---

## Option 5: Oracle Cloud Free Tier

**Free Tier**: Always Free resources (ARM Ampere A1 Compute)

### Step 1: Create Oracle Cloud Account

1. Go to [Oracle Cloud](https://www.oracle.com/cloud/free/)
2. Sign up for Always Free account
3. Verify identity (requires phone number)

### Step 2: Create Compute Instance

1. Go to Compute > Instances
2. Click "Create Instance"
3. Choose:
   - **Image**: Ubuntu 22.04
   - **Shape**: VM.Standard.A1.Flex (ARM, 4 OCPUs, 24GB RAM)
   - **Networking**: Create new VCN
4. Add SSH key (or use cloud-init)

### Step 3: Install Docker on Instance

SSH into your instance:

```bash
ssh -i your_key.pem ubuntu@YOUR_IP

# Install Docker
sudo apt update
sudo apt install docker.io -y
sudo usermod -aG docker $USER
newgrp docker

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

### Step 4: Deploy Application

```bash
# Clone your repo
git clone YOUR_REPO_URL
cd auto-check-exercise-be

# Create .env file
nano .env
# Add all environment variables

# Build and run
docker build -t auto-check-exercise-be .
docker run -d -p 8080:8080 --env-file .env --restart always auto-check-exercise-be
```

### Step 5: Configure Firewall

In Oracle Cloud Console:
1. Go to your instance
2. Click on subnet link
3. Add Ingress Rule:
   - Source CIDR: 0.0.0.0/0
   - Destination Port Range: 8080

### Pros
- ✅ Most generous free tier (4 OCPUs, 24GB RAM)
- ✅ Always on (no sleeping)
- ✅ Full control over server
- ✅ No credit card required for Always Free

### Cons
- ❌ Complex setup (manual server management)
- ❌ Requires SSH and Linux knowledge
- ❌ You're responsible for security updates
- ❌ Account approval can take time

---

## Option 6: Hugging Face Spaces

**Free Tier**: CPU basic spaces (16GB RAM, 2 vCPU)

### Step 1: Create Space

1. Go to [Hugging Face](https://huggingface.co/)
2. Click your profile > "New Space"
3. Choose:
   - **Space SDK**: Docker
   - **License**: MIT
   - **Visibility**: Public or Private

### Step 2: Configure Dockerfile

Hugging Face will use your existing Dockerfile.

### Step 3: Set Environment Variables

1. Go to your Space settings
2. Scroll to "Variables and secrets"
3. Add all required variables as "Repository secrets"

### Step 4: Push Code

```bash
git clone https://huggingface.co/spaces/YOUR_USERNAME/YOUR_SPACE
cd YOUR_SPACE
cp /path/to/your/Dockerfile .
cp /path/to/your/backend ./backend
git add .
git commit -m "Initial deployment"
git push
```

### Pros
- ✅ Free CPU instances
- ✅ Easy deployment
- ✅ Built-in HTTPS
- ✅ Good for ML/AI projects

### Cons
- ❌ Public by default (private requires Pro)
- ❌ Limited customization
- ❌ Primarily designed for ML demos

---

## Comparison Table

| Platform | Free Tier | Sleeping | Credit Card | Ease of Use | Best For |
|----------|-----------|----------|-------------|-------------|----------|
| **Cloud Run** | 2M req/mo | Optional | Required | ⭐⭐⭐⭐ | Production |
| **Railway** | $5 credit | Yes | Required | ⭐⭐⭐⭐⭐ | Quick Deploy |
| **Render** | 750 hrs/mo | Yes | Optional | ⭐⭐⭐⭐⭐ | Hobby Projects |
| **Fly.io** | 3 VMs | Optional | Required | ⭐⭐⭐ | Global Apps |
| **Oracle Cloud** | 4 OCPUs/24GB | No | Required | ⭐⭐ | Heavy Workloads |
| **Hugging Face** | CPU Basic | Yes | Optional | ⭐⭐⭐⭐ | AI/ML Projects |

---

## Post-Deployment Checklist

After deploying, verify:

- [ ] **Health Check**: Access your endpoint and verify it responds
  ```bash
  curl https://your-app-url.com/
  ```

- [ ] **Environment Variables**: Check all variables are set correctly
  ```bash
  # Add a temporary debug endpoint to verify env vars
  ```

- [ ] **CORS Configuration**: Test from your frontend extension
  ```javascript
  fetch('https://your-app-url.com/grade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
  ```

- [ ] **Authentication Flow**: Test Google OAuth2 login
  - Verify redirect URI is correct
  - Test token exchange endpoint

- [ ] **OpenAI Integration**: Test /grade endpoint with sample data
  ```bash
  curl -X POST https://your-app-url.com/grade \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_TOKEN" \
    -H "x-api-key: YOUR_SECRET" \
    -d '{"items":[{"question":"2+2","answer":"4"}]}'
  ```

- [ ] **Error Handling**: Verify errors are logged and returned properly

- [ ] **Monitoring**: Set up basic monitoring (uptime, error rates)

---

## Troubleshooting Common Issues

### Issue: Container fails to start
**Solution**: Check logs, verify PORT environment variable is set to 8080

### Issue: CORS errors from frontend
**Solution**: Ensure `app.use(cors())` is enabled, configure allowed origins if needed

### Issue: Environment variables not loading
**Solution**: 
- Verify variable names match exactly
- Restart the service after setting variables
- Check platform-specific secret management

### Issue: Cold starts too slow
**Solution**: 
- Use Cloud Scheduler to ping endpoint every 5 minutes
- Upgrade to paid tier for always-on
- Choose platform with no sleeping (Oracle Cloud)

### Issue: Memory limit exceeded
**Solution**: 
- Reduce concurrent requests
- Optimize OpenAI thread handling
- Increase memory allocation (if platform allows)

### Issue: OAuth2 redirect fails
**Solution**: 
- Update redirect URI in Google Cloud Console
- Ensure HTTPS is used in production
- Match exact redirect URI in environment variables

---

## Security Best Practices

1. **Use HTTPS only** - All platforms provide free HTTPS
2. **Rotate secrets regularly** - Change API keys every 3-6 months
3. **Restrict CORS origins** - Don't allow all origins in production
4. **Monitor logs** - Set up alerts for authentication failures
5. **Rate limiting** - Add rate limiting to prevent abuse
6. **Input validation** - Validate all incoming requests
7. **Update dependencies** - Run `npm audit` regularly

---

## Cost Optimization Tips

1. **Minimize cold starts** - Use keep-alive pings if needed
2. **Optimize Docker image** - Use slim images, multi-stage builds
3. **Cache responses** - Implement caching for repeated requests
4. **Monitor usage** - Set up billing alerts
5. **Use CDN** - For static assets if any
6. **Right-size resources** - Don't over-provision

---

## Recommended Choice

For your auto-check-exercise backend, I recommend:

### 🥇 **Google Cloud Run** (Best Overall)
- Perfect fit for your Google OAuth2 integration
- Generous free tier
- Production-ready
- Easy scaling

### 🥈 **Render** (Easiest Setup)
- No credit card required
- Simple deployment
- Good for testing

### 🥉 **Oracle Cloud** (Most Resources)
- If you need always-on service
- Most powerful free tier
- Requires more setup effort

---

## Next Steps

1. Choose your hosting platform
2. Set up environment variables securely
3. Deploy using the steps above
4. Test all endpoints thoroughly
5. Update your frontend extension with new backend URL
6. Monitor and maintain

Good luck with your deployment! 🚀
