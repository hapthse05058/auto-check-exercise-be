# Project Structure

This document summarizes the repository layout and main components for quicker project understanding.

## Root

- `.gitignore` - Git ignore rules.
- `.instructions.md` - Local workspace instructions for Copilot/VS Code agent behavior.
- `.vscode/` - VS Code workspace settings and launch configurations.
- `Dockerfile` - Container build definition for the backend service.
- `DEPLOYMENT_GUIDE.md` - Deployment instructions and environment-specific details.
- `README.md` - High-level project title and backend mention.
- `SKILLS.md` - Repository skills documentation (likely for evaluation or system use).
- `backend/` - Main backend service implementation.

## backend/

- `.env` - Local environment variables for development (not normally committed).
- `firebase-service-account.json` - Firebase credentials/configuration file.
- `mama_prompt.txt` - Current Mama grading prompt stored as plaintext.
- `mama_res.txt` - Last model response or saved result related to Mama grading.
- `package.json` - Node.js backend dependencies and scripts.
- `package-lock.json` - Exact dependency lockfile for npm.
- `README.md` - Backend service description, API endpoints, setup, and usage.
- `server.js` - Express application implementing the Mama grading API.
- `node_modules/` - Installed Node dependencies.

## Backend overview

The backend is a small Express service that exposes a Mama grading agent API.

Endpoints:

- `GET /prompt` - Returns the current Mama grading prompt.
- `POST /prompt` - Updates the prompt stored by the service.
- `POST /grade` - Sends student items to the OpenAI API using the current prompt and returns raw/parsed responses.

Setup notes:

- Configure `OPENAI_API_KEY` in `.env`.
- Optionally set `MAMA_PROMPT` in `.env` or update it at runtime.
- Install dependencies with `npm install` inside `backend`.
- Start the service with `npm start`.

## Notes for AI readers

- The main implementation to inspect is `backend/server.js`.
- Runtime configuration is defined in `backend/.env` and `backend/mama_prompt.txt`.
- The backend is intentionally lightweight and focused on a single grading API.
