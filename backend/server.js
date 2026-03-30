const fs = require("fs");
const path = require("path");
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
// Increase allowed payload size to avoid PayloadTooLargeError for large requests
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn(
    "WARNING: OPENAI_API_KEY not set. The service will fail until provided.",
  );
}

// app.get("/prompt", (req, res) => {
//   res.json({ prompt: readPrompt() });
// });

// function writePrompt(text) {
//   fs.writeFileSync(PROMPT_FILE, text, "utf8");
// }

// app.post("/prompt", (req, res) => {
//   const { prompt } = req.body;
//   if (!prompt) return res.status(400).json({ error: "no prompt provided" });
//   writePrompt(prompt);
//   res.json({ ok: true });
// });

app.post("/exchange-token", async (req, res) => {
  const { code, redirectUri, refreshToken, grantType } = req.body;

  const clientId =
    "159733287448-jtf963s4659vl9oh6480bh125dhc2d5p.apps.googleusercontent.com";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientSecret) {
    return res.status(500).json({
      error: "client_secret_not_configured",
      message: "GOOGLE_CLIENT_SECRET not set in .env",
    });
  }

  let tokenParams;

  if (grantType === "refresh_token" && refreshToken) {
    // Handle refresh token request
    tokenParams = {
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    };
  } else if (code && redirectUri) {
    // Handle authorization code exchange
    tokenParams = {
      code: code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    };
  } else {
    return res.status(400).json({ error: "invalid_request_parameters" });
  }

  try {
    const tokenResponse = await axios.post(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams(tokenParams).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    return res.json(tokenResponse.data);
  } catch (err) {
    console.error("Token exchange error:", err.response?.data || err.message);
    return res.status(500).json({
      error: "token_exchange_failed",
      details: err.response?.data || err.message,
    });
  }
});

app.post("/grade", async (req, res) => {
  // return res.json({ raw: "Hong Ha test", parsed });
  const items = req.body.items;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "no_items" });

  // Fail early with a clear error if the OpenAI API key is not configured
  if (!OPENAI_API_KEY) {
    return res.status(500).json({
      error: "openai_api_key_missing",
      message:
        "OPENAI_API_KEY not set. Copy .env.example to .env and set OPENAI_API_KEY, or export the variable in your environment.",
    });
  }

  const userContent = items
    .map((item) => item.question + "/r" + item.answer)
    .join("/r/r/r");
    console.log(userContent);

  try {
    // Helper to call OpenAI with retries on 429 (quota / rate limit)
    async function callOpenAI(payload, maxRetries = 3) {
      // test fake response from openAI (local file), but do not send res here
      // const rawSSEPath = path.join(__dirname, "mama_res.txt");
      // const rawSSE = fs.readFileSync(rawSSEPath, "utf8");
      // // const decoded = decodeSSEStream(rawSSE);
      // const decoded = decodeSSEStream(rawSSE);

      // // Build a mock OpenAI-like response payload for local testing
      // const messageText =
      //   extractMessageText(decoded) || JSON.stringify(decoded);
      // return {
      //   data: {
      //     choices: [
      //       {
      //         message: {
      //           content: messageText,
      //         },  
      //       },
      //     ],
      //   },
      };
  } catch (err) {
    return res
      .status(500)
      .json({ error: err.message, details: err.response && err.response.data });
  }
});

function decodeSSEStream(rawText) {
  const lines = rawText.split("\n");
  const result = [];

  for (const line of lines) {
    // Bỏ qua dòng trống và event lines
    if (!line.startsWith("data: ")) continue;

    const dataStr = line.slice(6).trim();

    // Bỏ qua [DONE]
    if (dataStr === "[DONE]") continue;

    try {
      const parsed = JSON.parse(dataStr);
      result.push(parsed);
    } catch (e) {
      // Không phải JSON hợp lệ, bỏ qua
    }
  }

  return result;
}

function extractMessageText(decodedArray) {
  let fullText = "";

  for (const item of decodedArray) {
    // Lấy text ban đầu từ add event
    if (item.o === "add" && item.v?.message?.content?.parts) {
      fullText = item.v.message.content.parts[0] || "";
    }

    // Ghép các đoạn append từ patch events
    if (Array.isArray(item.v)) {
      for (const patch of item.v) {
        if (
          patch.p === "/message/content/parts/0" &&
          patch.o === "append" &&
          typeof patch.v === "string"
        ) {
          fullText += patch.v;
        }
      }
    }
  }

  return fullText;
}

app.listen(PORT, () => console.log(`Mama agent backend listening on ${PORT}`));
