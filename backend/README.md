Mama Agent Backend

This small Express service exposes the Mama grading agent via a simple HTTP API.

Endpoints

- GET /prompt
  - Returns the currently configured Mama prompt.

- POST /prompt
  - Body: { "prompt": "..." }
  - Saves a new prompt to be used for grading.

- POST /grade
  - Body: { "items": ["student sentence 1", "student sentence 2", ...] }
  - Calls the OpenAI API with the configured Mama prompt and returns the raw model output and parsed JSON (if model returned JSON).

Setup

1. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.

2. (Optional) Set `MAMA_PROMPT` in `.env` or use `POST /prompt` to set it at runtime.

3. Install and run:

```bash
cd backend
npm install
npm start
```

Example request (curl):

```bash
curl -X POST http://localhost:3000/grade \
  -H "Content-Type: application/json" \
  -d '{"items":["1. Student sentence here","2. Another sentence"]}'
```

Security note

- Do not commit `.env` with your OpenAI API key.
- This service is intended for local or trusted network use; add authentication if deploying.
