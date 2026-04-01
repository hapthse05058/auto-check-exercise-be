const fs = require("fs");
const path = require("path");
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const OpenAI = require("openai");

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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/grade", async (req, res) => {
  const items = req.body.items;
  const assistantId = process.env.ASSISTANT_ID;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "no_items" });
  }

  // Đọc nội dung file prompt (Nếu cần gửi kèm thêm hướng dẫn)
  let systemInstructions = "";
  try {
    const promptPath = path.join(__dirname, "mama_prompt.txt");
    systemInstructions = fs.readFileSync(promptPath, "utf8");
  } catch (e) {
    console.error("Không tìm thấy file mama_prompt.txt");
  }

  const studentExercises = items
    .map((item) => `${item.question}\n${item.answer}`)
    .join("\n\n");

  try {
    // BƯỚC 1: Tạo một Thread
    const thread = await openai.beta.threads.create();

    // BƯỚC 2: Thêm bài tập của học sinh vào Thread
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: systemInstructions + "\n\nBÀI TẬP CẦN CHẤM:\n" + studentExercises,
    });

    // BƯỚC 3: Tạo một Run để Assistant xử lý
    const run = await openai.beta.threads.runs.create(thread.id, {
      assistant_id: assistantId,
    });

    // BƯỚC 4: Chờ kết quả (Polling)
    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    
    // Đợi tối đa (ví dụ 30s) cho đến khi hoàn thành
    while (runStatus.status !== "completed") {
      if (runStatus.status === "failed" || runStatus.status === "cancelled") {
        throw new Error(`Run status: ${runStatus.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Nghỉ 1s
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }

    // BƯỚC 5: Lấy danh sách tin nhắn để lấy câu trả lời mới nhất
    const messages = await openai.beta.threads.messages.list(thread.id);
    const lastMessage = messages.data[0].content[0].text.value;

    return res.json({
      success: true,
      assistantText: lastMessage,
    });

  } catch (err) {
    console.error("OpenAI request failed:", err.message);
    return res.status(500).json({
      error: "openai_request_failed",
      details: err.message,
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

app.listen(PORT, () => console.log(`Mama agent backend listening on ${PORT}`));
