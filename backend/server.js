// const fs = require("fs");
// const path = require("path");
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");

const { OAuth2Client } = require("google-auth-library");
const cors = require("cors");
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const oAuth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EXTENSION_SECRET_KEY = process.env.EXTENSION_SECRET_KEY;
const ALLOWED_EMAILS = ["phamhongha.innerpiece@gmail.com", "linha6pct2017@gmail.com"];
app.use(cors());
// Increase allowed payload size to avoid PayloadTooLargeError for large requests
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

if (!OPENAI_API_KEY) {
  console.warn(
    "WARNING: OPENAI_API_KEY not set. The service will fail until provided.",
  );
}

async function verifyGoogleToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const secret_key = req.headers["x-api-key"];
  if (secret_key !== EXTENSION_SECRET_KEY) {
    return res.status(401).send('Invalid key');
  }
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send('Missing Token');
  }

  const token = authHeader.split(' ')[1];

  try {
    // Gọi API của Google để xác thực token
    const response = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
    const userInfo = await response.json();

    if (!userInfo.email) {
      return res.status(401).send('Invalid Token');
    }

    const userEmail = userInfo.email.toLowerCase();

    // KIỂM TRA WHITELIST
    if (!ALLOWED_EMAILS.includes(userEmail)) {
      console.log(`Từ chối truy cập từ: ${userEmail}`);
      return res.status(403).json({ error: "Email không có trong danh sách cấp phép!" });
    }

    // Nếu hợp lệ, lưu email vào request để dùng sau này (nếu cần)
    req.userEmail = userEmail;
    next();
  } catch (error) {
    console.error('Lỗi xác thực Google:', error);
    res.status(401).send('Unauthorized');
  }
}

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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  project: process.env.OPENAI_PROJECT_ID,
});
app.post("/grade", verifyGoogleToken, async (req, res) => {
  const items = req.body.items;
  const assistantId = process.env.ASSISTANT_ID;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "no_items_provided" });
  }

  const studentExercises = items
    .map((item) => `${item.question}\n${item.answer}`)
    .join("\n\n");

  const thread = await openai.beta.threads.create(); 
  try {
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: "BÀI TẬP CẦN CHẤM:\n" + studentExercises,
    });

    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
    });

    // POLLING LOGIC
    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);

    while (["in_progress", "queued"].includes(runStatus.status)) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }
    if (["failed", "cancelled", "expired"].includes(runStatus.status)) {
      console.error("Run Failed Details:", JSON.stringify(runStatus));
      throw new Error(runStatus);
    }
    if (runStatus.status !== "completed") {
      // Status can be "failed", "cancelled", "expired"
      // Detailed error for your console
      console.error(
        "Run Failed Details:",
        JSON.stringify(runStatus.last_error, null, 2),
      );
      throw new Error(runStatus);
    }

    // GET MESSAGES
    const messages = await openai.beta.threads.messages.list(thread.id);
    // FIND THE CORRECT MESSAGE
    // Filter to find the latest message where role is 'assistant'
    const assistantMessage = messages.data.find((m) => m.role === "assistant");
    if (!assistantMessage || !assistantMessage.content[0]) {
      throw new Error("Assistant completed but no message was found.");
    }

    let finalResponse = assistantMessage.content[0].text.value;

    // CLEANUP: Remove those annoying 【4:0†source】 tags
    finalResponse = finalResponse.replace(/【.*?】/g, "");
    await openai.beta.threads.del(thread.id); // Delete thread

    return res.json({
      success: true,
      assistantText: finalResponse,
    });
  } catch (err) {
    if (thread && thread.id)
      await openai.beta.threads.del(thread.id).catch(() => {});
    console.error("Detailed OpenAI Error:", JSON.stringify(err));
    return res.status(500).json({
      error: "openai_request_failed",
      details: err.message || "Unknown Error",
    });
  }
});

function parseOpenAIResponseText(responseData) {
  if (!responseData) return "";

  // New assistant endpoint format
  if (Array.isArray(responseData.output)) {
    const texts = [];
    for (const outputItem of responseData.output) {
      if (Array.isArray(outputItem.content)) {
        for (const content of outputItem.content) {
          if (typeof content.text === "string") {
            texts.push(content.text);
          } else if (typeof content.output_text === "string") {
            texts.push(content.output_text);
          }
        }
      }
    }
    if (texts.length > 0) return texts.join("\n\n");
  }

  // Old response model format
  if (Array.isArray(responseData.choices)) {
    if (responseData.choices[0]?.message?.content) {
      return responseData.choices[0].message.content;
    }
    if (typeof responseData.choices[0]?.text === "string") {
      return responseData.choices[0].text;
    }
  }

  if (typeof responseData.output_text === "string") {
    return responseData.output_text;
  }

  if (typeof responseData.text === "string") {
    return responseData.text;
  }

  return JSON.stringify(responseData);
}

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

/**
 * 1. Endpoint đổi 'code' lấy Access Token & Refresh Token (Lúc mới Login)
 */
app.post("/auth/google", async (req, res) => {
  const { code } = req.body;
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    // tokens sẽ chứa: access_token, refresh_token, expiry_date...
    tokens.refresh_token_expires_date =
      Date.now() + tokens.refresh_token_expires_in * 1000;
    res.json(tokens);
  } catch (error) {
    console.error("Error exchanging code:", error);
    res.status(500).json({ error: "Failed to exchange code" });
  }
});

/**
 * 2. Endpoint làm mới Access Token từ Refresh Token
 */
app.post("/auth/refresh", async (req, res) => {
  const { refreshToken } = req.body.refresh_token;

  if (!refreshToken) {
    return res.status(400).json({ error: "Refresh token is required" });
  }

  try {
    // Thiết lập refresh token vào client
    oAuth2Client.setCredentials({ refresh_token: refreshToken });
 
    // Yêu cầu Google cấp access token mới
    const response = await oAuth2Client.getAccessToken();
    const credentials = response.res.data;

    // Trả về cho Extension
    res.json({
      access_token: credentials.access_token,
      expiry_date: credentials.expiry_date || 3600 * 1000 + Date.now(),
      refresh_token: credentials.refresh_token,
      refresh_token_expires_date:
        Date.now() + tokens.refresh_token_expires_in * 1000,
    });
  } catch (error) {
    console.error("Error refreshing token:", error);
    res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});