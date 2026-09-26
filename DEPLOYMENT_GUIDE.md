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

### Step 5: Background grading jobs (Cloud Tasks)

Grading runs on the backend, so teachers can close the tab once a job has
started (`POST /grading-jobs`, see `backend/lib/gradingJobs.js`). Each step of a
job is a Cloud Tasks task that calls back `POST /internal/tasks/grading`. Do
this once per environment (dev and prod), **before** deploying the website build
that uses `/grading-jobs`.

```bash
PROJECT=YOUR_PROJECT_ID
REGION=YOUR_REGION            # same region as the Cloud Run service
SERVICE=auto-check-exercise-be
SERVICE_URL=$(gcloud run services describe $SERVICE --region $REGION --format 'value(status.url)')
# The service's runtime identity (empty = the default compute service account).
RUN_SA=$(gcloud run services describe $SERVICE --region $REGION --format 'value(spec.template.spec.serviceAccountName)')

gcloud services enable cloudtasks.googleapis.com

# 1. The queue. These numbers are load-bearing:
#    - 4 concurrent writes keep Docs API usage well under 60 writes/min/user
#      and the shared TeacherPoint document under ~1 write/sec;
#    - JOB_STALE_MS in lib/gradingJobs.js (2h) is derived from the 30-min task
#      deadline + --max-retry-duration. Change them together.
gcloud tasks queues create grading-jobs --location=$REGION \
  --max-concurrent-dispatches=4 \
  --max-attempts=5 \
  --max-retry-duration=3600s \
  --min-backoff=10s --max-backoff=300s

# 2. The identity Cloud Tasks signs its calls with. The route accepts ONLY
#    OIDC tokens for this account, with the route URL as audience.
gcloud iam service-accounts create grading-tasks-invoker
INVOKER=grading-tasks-invoker@$PROJECT.iam.gserviceaccount.com

# 3. The service creates tasks (enqueuer) that act as the invoker (actAs).
gcloud projects add-iam-policy-binding $PROJECT \
  --member=serviceAccount:$RUN_SA --role=roles/cloudtasks.enqueuer
gcloud iam service-accounts add-iam-policy-binding $INVOKER \
  --member=serviceAccount:$RUN_SA --role=roles/iam.serviceAccountUser
# Only needed if the service is ever made private (no --allow-unauthenticated):
gcloud run services add-iam-policy-binding $SERVICE --region $REGION \
  --member=serviceAccount:$INVOKER --role=roles/run.invoker

# 4. Key that encrypts stored Google refresh tokens (32 random bytes).
node -e "process.stdout.write('v1:' + require('crypto').randomBytes(32).toString('base64'))" \
  | gcloud secrets create grading-token-enc-keys --data-file=-
gcloud secrets add-iam-policy-binding grading-token-enc-keys \
  --member=serviceAccount:$RUN_SA --role=roles/secretmanager.secretAccessor

# 5. Wire it up. --timeout=1800 lets the prepare step (read + grade a whole
#    class) run up to the 30-min task deadline.
gcloud run services update $SERVICE --region $REGION --timeout=1800 \
  --update-secrets GOOGLE_TOKEN_ENC_KEYS=grading-token-enc-keys:latest \
  --update-env-vars TASKS_MODE=cloud,TASKS_PROJECT=$PROJECT,TASKS_LOCATION=$REGION,TASKS_QUEUE=grading-jobs,TASKS_TARGET_URL=$SERVICE_URL/internal/tasks/grading,TASKS_INVOKER_SA=$INVOKER,GOOGLE_TOKEN_ENC_KEY_CURRENT=v1
```

**Firestore rules.** The backend reaches Firestore through the Admin SDK only.
Make sure the security rules of BOTH databases deny client access to
`teacherGoogleTokens`, `gradingJobs` and `gradingJobLocks` (a rule set that
denies everything by default already does).

**Rotating the token key.** Add a new version to the secret
(`v1:<old>,v2:<new>`), set `GOOGLE_TOKEN_ENC_KEY_CURRENT=v2`, deploy. Tokens are
re-encrypted under v2 the next time they are used; remove v1 only after that.

**Checking a job.** `gradingJobs/{jobId}` holds the status and counters,
`gradingJobs/{jobId}/docs/{docId}` each doc's outcome and warnings. Failed
tasks show up in the Cloud Tasks console for the `grading-jobs` queue, and in
the service logs under `[GRADING-JOB]`.

### Step 6: Scheduled grading (Cloud Scheduler)

Teachers can give a class a weekly schedule (students' deadline + grading
deadline); the backend reminds them ~30 minutes before and grades the class's
current lesson on its own (`backend/lib/gradingSchedules.js`). Nothing runs it
but a tick every 5 minutes, which queues the due steps on the SAME
`grading-jobs` queue as Step 5. Do this after Step 5, once per environment.

```bash
gcloud services enable cloudscheduler.googleapis.com

# Signed by the same invoker account as the task route; the audience is the
# tick route itself (override with SCHEDULE_TICK_URL if it differs).
gcloud scheduler jobs create http grading-schedule-tick \
  --location=$REGION \
  --schedule="*/5 * * * *" \
  --time-zone="Asia/Ho_Chi_Minh" \
  --http-method=POST \
  --uri=$SERVICE_URL/internal/tasks/schedule-tick \
  --oidc-service-account-email=$INVOKER \
  --oidc-token-audience=$SERVICE_URL/internal/tasks/schedule-tick \
  --attempt-deadline=60s
```

The 5-minute cadence is load-bearing only loosely: a step that fails or dies
is picked up again by the next tick (the schedule does not move on until the
step has committed), and a reminder up to ~10 minutes late still keeps the
planned grading time. Optional env: `GRADING_OFFPEAK_UTC` (default
`16:30-00:30`, DeepSeek off-peak = 23:30–07:30 Vietnam time),
`GRADING_REMIND_MIN` (default 30).

**Firestore rules.** Also deny client access to `gradingSchedules` (and its
`runs` subcollection) and `pointReservations`.

**Checking a schedule.** `gradingSchedules/{classId}` holds the weekly
definition and the next week (`next`, `nextStep`, `nextDueAt`);
`gradingSchedules/{classId}/runs/{YYYY-MM-DD}` records each week — its state
(`reminded`, `running`, `done`, `cancelled_*`, `missed`, …), the counts, the
job id and the lesson move. Logs are under `[GRADING-SCHEDULE]`, and each
week's outcome is a `grading.scheduleEvent` audit row.

### Step 7: Courses

A class follows one **course** — Basic, IELTS, … (`courses/{id}`, managed by
admins under "Quản lý khóa"); the course decides the class's lessons. Before
this, the class's lessons came from its student-doc template code in
`classes.classType`. To move existing data over:

1. Deploy the backend and the website (the backend still serves classes that
   have no course yet).
2. Dry-run, then apply, the migration — it creates the `basic` course (all
   lessons of the old templates) and sets `courseId: "basic"` on every class;
   `classes.classType` is left as it was. Re-running it changes nothing.

   ```bash
   cd backend
   node scripts/migrate-courses.js --db prod           # dry-run
   node scripts/migrate-courses.js --db prod --apply   # asks CONFIRM-PROD
   ```

**Firestore rules.** Deny client access to `courses` as well.

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
