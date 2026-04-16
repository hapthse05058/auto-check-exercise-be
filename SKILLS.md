# Auto-Check Exercise Backend Skills

## Project Overview
This is a Node.js/Express backend service that provides an API for automatically grading student exercises using OpenAI's Assistant API. The service includes Google OAuth2 authentication with email whitelist authorization.

## Core Capabilities

### 1. API Endpoints
- **POST /grade** - Grade student exercises using OpenAI Assistant
- **POST /auth/google** - Exchange OAuth code for tokens
- **POST /auth/refresh** - Refresh access tokens
- **POST /exchange-token** - Token exchange helper

### 2. Authentication & Security
- Google OAuth2 integration
- Email whitelist authorization (ALLOWED_EMAILS)
- API key verification (x-api-key header)
- Bearer token validation

### 3. OpenAI Integration
- Thread-based conversation management
- Assistant API for grading
- Streaming response parsing
- Error handling for run states (failed, cancelled, expired)

## Development Best Practices

### Environment Variables Required
```env
PORT=8080
OPENAI_API_KEY=your_key
OPENAI_PROJECT_ID=your_project
ASSISTANT_ID=your_assistant_id
CLIENT_ID=google_client_id
GOOGLE_CLIENT_SECRET=google_secret
REDIRECT_URI=oauth_redirect_uri
EXTENSION_SECRET_KEY=api_key_for_extension
```

### Code Patterns

#### Authentication Middleware
```javascript
async function verifyGoogleToken(req, res, next) {
  // 1. Validate API key from x-api-key header
  // 2. Extract Bearer token from Authorization header
  // 3. Verify token with Google API
  // 4. Check email against whitelist
  // 5. Attach user info to request
}
```

#### OpenAI Thread Management
```javascript
// Always create thread -> add message -> run -> poll -> get response -> delete thread
const thread = await openai.beta.threads.create(thread.id);
try {
  // ... processing
} catch (err) {
  // Always cleanup thread in error case
  await openai.beta.threads.del(thread.id).catch(() => {});
}
```

#### Error Handling
- Validate input arrays before processing
- Handle OpenAI run states: in_progress, queued, completed, failed, cancelled, expired
- Clean up resources (threads) in finally/error blocks
- Return structured error responses with details

### Testing Guidelines
1. Mock OpenAI API responses for unit tests
2. Test authentication flow with valid/invalid tokens
3. Test email whitelist rejection
4. Test payload size limits (10mb configured)
5. Verify CORS configuration

### Performance Considerations
- Polling interval: 5 seconds for OpenAI runs
- Payload limit: 10mb for JSON/urlencoded
- Production dependencies only in Docker
- Use slim Node image (node:20-slim)

## Common Issues & Solutions

### Issue: OpenAI Run Failed
**Solution**: Check run status, log last_error, ensure ASSISTANT_ID is valid

### Issue: Token Exchange Failed
**Solution**: Verify GOOGLE_CLIENT_SECRET, check redirect_uri matches

### Issue: PayloadTooLargeError
**Solution**: Increase express.json limit (currently 10mb)

### Issue: CORS Errors
**Solution**: Verify cors() middleware is enabled

## Deployment Checklist
- [ ] All environment variables set
- [ ] Node version >= 18
- [ ] Docker image built successfully
- [ ] Port 8080 exposed
- [ ] Health check endpoint (if needed)
- [ ] Logging configured
- [ ] Error monitoring setup
