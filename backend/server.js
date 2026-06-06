const fs = require("fs");
const path = require("path");
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const OpenAI = require("openai");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

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
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key-change-in-production";
app.use(cors());
// Increase allowed payload size to avoid PayloadTooLargeError for large requests
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Initialize Firebase Admin
// Use the Cloud Run path, or fallback to a local file for development
const serviceAccountPath = process.env.NODE_ENV === 'production'
  ? '/secrets/firebase-service-account'
  : path.join(__dirname, 'firebase-service-account.json');

if (fs.existsSync(serviceAccountPath)) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountPath)
  });
} else {
  console.error("Critical: Service account file not found!");
}

const db = admin.firestore();

if (!OPENAI_API_KEY) {
  console.warn(
    "WARNING: OPENAI_API_KEY not set. The service will fail until provided.",
  );
}


async function isClassNameDuplicated(newClassName) {
  const snapshot = await db.collection('classes').get();
  const classes = [];
  snapshot.forEach(doc => {
    classes.push({ id: doc.id, name: doc.data().name.toLowerCase() });
  });
  const duplicateClassSnapshot = classes.filter((cls) => cls.name === newClassName.toLowerCase());
  return duplicateClassSnapshot.length > 0;
}

async function verifyToken(req, res, next) {
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
    // First, try to verify as JWT (for username/password login)
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.userEmail = decoded.email;
      return next();
    } catch (jwtError) {
      // If JWT fails, try Google token verification
    }

    // Try Google token verification (for Google OAuth)
    const response = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
    const userInfo = await response.json();

    if (!userInfo.email) {
      return res.status(401).send('Invalid Token');
    }

    const userEmail = userInfo.email.toLowerCase();
    const teacherDoc = await db.collection("teachers").where("gmail", "==", userEmail).get();
    if (teacherDoc.empty) {
      return res.status(403).json({ error: "Access denied. User is not a registered teacher." });
    }
    req.userEmail = userEmail;
    next();
  } catch (error) {
    console.error('Error verifying token:', error);
    res.status(401).send('Unauthorized');
  }
}

// Keep old name as alias for backwards compatibility
const verifyGoogleToken = verifyToken;

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
  apiKey: OPENAI_API_KEY,
  project: process.env.OPENAI_PROJECT_ID,
});
app.post("/grade", verifyGoogleToken, async (req, res) => {
  const items = req.body.items;
  const model = process.env.OPENAI_MODEL;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "no_items_provided" });
  }

  const studentExercises = items
    .map((item, index) => `\n[VIETNAMESE]: ${item.question}\n[STUDENT_ANSWER]: ${item.answer}`)
    .join("\n");

  try {
    const inputText = `DATASET TO EVALUATE:\`\`\`\n${studentExercises}\n\n\`\`\`[CRITICAL RULE]: Evaluate each item above strictly against the instruction guide. Output a single combined Markdown table. You must provide the clear reason/evaluation for the grade inside the table if the answer is incorrect.`;
    const instructionFilePath = path.join(__dirname, 'prompt_and_instruction_for_responses_api.txt');
    if (!fs.existsSync(instructionFilePath)) {
      throw new Error(`Instruction file not found: ${instructionFilePath}`);
    }
    const prompt_and_instruction_for_ai = fs.readFileSync(instructionFilePath, 'utf8');
    console.log(prompt_and_instruction_for_ai);
    // let inputText = "BÀI TẬP CẦN CHẤM: ".concat("```").concat(studentExercises).concat("```").concat(" \n[CRITICAL RULE]: Evaluate the student exercise strictly against the instruction guide. Return only the structured evaluation.");
    const response = await openai.responses.create({
      model: model,
      instructions: prompt_and_instruction_for_ai.trim(),
      temperature: 0.5,
      top_p: 0.14,
      input: inputText,
    });

    const aiResponse = response.output_text.replaceAll(/【.*?】/g, "").replaceAll("<br>", "").trim();

    if (!aiResponse) {
      throw new Error("Assistant returned no output.");
    }

    console.log(`[GRADE] Response received, length: ${aiResponse.length} bytes`);

    return res.json({
      success: true,
      assistantText: aiResponse,
    });
  } catch (err) {
    console.error("[GRADE] Detailed OpenAI Error:", JSON.stringify(err));
    return res.status(500).json({
      error: "openai_request_failed",
      details: err.message || "Unknown Error",
    });
  }
});

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
 * Login with username and password
 */
app.post("/auth/username-password", async (req, res) => {
  const secret_key = req.headers["x-api-key"];
  if (secret_key !== EXTENSION_SECRET_KEY) {
    return res.status(401).json({ error: "Invalid key" });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  try {
    // Query Firestore for teacher with matching username
    const teachersRef = db.collection('teachers');
    const snapshot = await teachersRef.where('username', '==', username).limit(1).get();

    if (snapshot.empty) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const teacherDoc = snapshot.docs[0];
    const teacherData = teacherDoc.data();

    // Verify password using bcrypt
    if (!teacherData.password) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const isPasswordValid = await bcrypt.compare(password, teacherData.password);
    if (!isPasswordValid) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // Generate JWT tokens
    const access_token = jwt.sign(
      { id: teacherDoc.id, email: teacherData.gmail, username: teacherData.username },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    const refresh_token = jwt.sign(
      { id: teacherDoc.id, email: teacherData.gmail, username: teacherData.username, type: 'refresh' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    const expires_in = 3600; // 1 hour in seconds
    const refresh_token_expires_date = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

    res.json({
      access_token,
      expires_in,
      refresh_token,
      refresh_token_expires_date
    });
  } catch (error) {
    console.error("Error in username/password login:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

/**
 * 2. Endpoint làm mới Access Token từ Refresh Token
 */
app.post("/auth/refresh", async (req, res) => {
  const refreshToken = req.body.refresh_token;

  if (!refreshToken) {
    return res.status(400).json({ error: "Refresh token is required" });
  }

  try {
    // First, try JWT refresh token
    try {
      const decoded = jwt.verify(refreshToken, JWT_SECRET);
      if (decoded.type !== 'refresh') {
        throw new Error('Invalid refresh token type');
      }

      // Generate new access token
      const access_token = jwt.sign(
        { id: decoded.id, email: decoded.email, username: decoded.username },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      return res.json({
        access_token,
        expiry_date: Date.now() + 3600 * 1000,
        refresh_token: refreshToken, // Keep the same refresh token
        refresh_token_expires_date: Date.now() + 30 * 24 * 60 * 60 * 1000
      });
    } catch (jwtError) {
      // If JWT fails, try Google refresh token
    }

    // Handle Google refresh token (original logic)
    oAuth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await oAuth2Client.refreshAccessToken();

    res.json({
      access_token: credentials.access_token,
      expiry_date: credentials.expiry_date || 3600 * 1000 + Date.now(),
      refresh_token: credentials.refresh_token,
      refresh_token_expires_date:
        Date.now() + credentials.refresh_token_expires_in * 1000,
    });
  } catch (error) {
    console.error("Error refreshing token:", error);
    res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

/**
 * Get teacher info for the authenticated user
 */
app.get("/teacher-info", verifyGoogleToken, async (req, res) => {
  try {
    const userEmail = req.userEmail;
    const teachersRef = db.collection('teachers');
    const snapshot = await teachersRef.where('gmail', '==', userEmail).limit(1).get();

    if (snapshot.empty) {
      return res.status(403).json({ error: 'Teacher not found' });
    }

    const teacherDoc = snapshot.docs[0];
    res.json({ id: teacherDoc.id, ...teacherDoc.data() });
  } catch (error) {
    console.error('Error fetching teacher info:', error);
    res.status(500).json({ error: 'Failed to fetch teacher info' });
  }
});

app.post("/teacher-signup", verifyGoogleToken, async (req, res) => {
  
  const userEmail = req.userEmail;
  try {
    const { name, phone, dob, address = '', notes = '', username, password, gmail } = req.body;
    // const userEmail = gmail?.trim().toLowerCase();

    if (!name || !phone || !dob) {
      return res.status(400).json({ error: 'Missing required fields: name, phone, dob' });
    }

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing required fields: username, password' });
    }

    const teachersRef = db.collection('teachers');
    // Check if teacher with this email already exists
    const existingEmailSnapshot = await teachersRef.where('gmail', '==', userEmail).limit(1).get();
    if (!existingEmailSnapshot.empty) {
      return res.status(409).json({ error: 'Teacher already exists' });
    }
    // Check if username already exists
    const existingUsernameSnapshot = await teachersRef.where('username', '==', username).limit(1).get();
    if (!existingUsernameSnapshot.empty) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    const teacherData = {
      gmail: userEmail,
      name,
      phone,
      dob,
      address,
      notes,
      username,
      password: hashedPassword,
      classIds: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const newDocRef = await teachersRef.add(teacherData);
    // Return response without the password hash
    const responseData = { ...teacherData };
    delete responseData.password;
    res.status(201).json({ id: newDocRef.id, ...responseData });
  } catch (error) {
    console.error('Error creating teacher:', error);
    res.status(500).json({ error: 'Failed to create teacher record' });
  }
});

app.post("/classes", verifyGoogleToken, async (req, res) => {
  try {
    const { name, classType = 'basic', currentLesson = null, teacherId } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Missing required field: name' });
    }

    // const teacherSnapshot = await db.collection('teachers')
    //   .where('gmail', '==', userEmail)
    //   .limit(1)
    //   .get();

    // if (teacherSnapshot.empty) {
    //   return res.status(403).json({ error: 'Teacher account not found' });
    // }

    // const teacherId = teacherSnapshot.docs[0].id;
    // const duplicateClassSnapshot = await db.collection('classes')
    //   .where('name', '==', name)
    //   .where('teacherId', 'array-contains', teacherId)
    //   .limit(1)
    //   .get();
    const isDuplicated = await isClassNameDuplicated(name);

    if (isDuplicated) {
      return res.status(409).json({ error: 'Class name already exists for this teacher' });
    }

    const classData = {
      name,
      classType,
      currentLesson: currentLesson || null,
      teacherId: [teacherId],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const classRef = await db.collection('classes').add(classData);
    res.status(201).json({ id: classRef.id, ...classData });
  } catch (error) {
    console.error('Error creating class:', error);
    res.status(500).json({ error: 'Failed to create class' });
  }
});

app.get("/classes/check-name", verifyGoogleToken, async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) {
      return res.status(400).json({ error: 'Class name is required' });
    }
    const isDuplicated = await isClassNameDuplicated(name);
    res.json({ exists: isDuplicated });
  } catch (error) {
    console.error('Error checking class name:', error);
    res.status(500).json({ error: 'Failed to verify class name' });
  }
});

app.post("/students", verifyGoogleToken, async (req, res) => {
  try {
    const { classId, students } = req.body;

    if (!classId || !Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: classId, students' });
    }
    const batch = db.batch();
    const studentsToSave = students
      .map((student) => ({
        classId: classId,
        gmail: student.gmail?.trim(),
        name: student.name?.trim(),
        ggDocLink: student.ggDocLink?.trim() || '',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }))
      .filter((student) => student.gmail && student.name);

    studentsToSave.forEach((student) => {
      // const docRef = db.collection('students').doc();
      const docRef = db.collection('students-testing-table').doc();
      batch.set(docRef, {
        ...student
      });
    });

    await batch.commit();
    res.status(201).json({ inserted: studentsToSave.length });
  } catch (error) {
    console.error('Error saving students:', error);
    res.status(500).json({ error: 'Failed to save students' });
  }
});

/**
 * Get classes for the authenticated user
 */
app.get("/classes", verifyGoogleToken, async (req, res) => {
  try {
    const teacherId = req.query.teacherId;
    if (!teacherId) {
      return res.status(400).json({ error: 'teacherId is required' });
    }
    const classesRef = db.collection('classes');
    let snapshot = await classesRef.where('teacherId', 'array-contains', teacherId).get();
    if (snapshot.empty) {
      return res.json([]);
    }
    const classes = [];
    snapshot.forEach(doc => {
      classes.push({ id: doc.id, ...doc.data() });
    });

    res.json(classes);
  } catch (error) {
    console.error("Error fetching classes:", error);
    res.status(500).json({ error: "Failed to fetch classes" });
  }
});

/**
 * Get lessons for the authenticated user and selected class
 */
app.get("/class-types", verifyGoogleToken, async (req, res) => {
  try {
    const classTypeRef = db.collection('classType');
    const snapshot = await classTypeRef.get();

    const classTypes = [];
    snapshot.forEach((doc) => {
      classTypes.push({ id: doc.id, ...doc.data() });
    });

    res.json(classTypes);
  } catch (error) {
    console.error("Error fetching class types:", error);
    res.status(500).json({ error: "Failed to fetch class types" });
  }
});

app.get("/lessons", verifyGoogleToken, async (req, res) => {
  try {
    const userEmail = req.userEmail;
    const classType = req.query.classType;

    if (!classType) {
      return res.status(400).json({ error: "classType is required" });
    }

    const lessonsRef = db.collection('lesson');
    const snapshot = await lessonsRef.where('classType', 'array-contains', classType).get();

    const lessons = [];
    snapshot.forEach(doc => {
      lessons.push({ id: doc.id, ...doc.data() });
    });

    res.json(lessons);
  } catch (error) {
    console.error("Error fetching lessons:", error);
    res.status(500).json({ error: "Failed to fetch lessons" });
  }
});

/**
 * Get current lesson for the selected class
 */
app.get("/current-lesson", verifyGoogleToken, async (req, res) => {
  try {
    const classId = req.query.classId;
    if (!classId) {
      return res.status(400).json({ error: "classId is required" });
    }

    const classRef = db.collection('classes').doc(classId);
    const classDoc = await classRef.get();

    if (!classDoc.exists) {
      return res.status(404).json({ error: "Class not found" });
    }

    const classData = classDoc.data();
    const currentLesson = classData?.currentLesson || null;
    res.json({ currentLesson });
  } catch (error) {
    console.error("Error fetching current lesson:", error);
    res.status(500).json({ error: "Failed to fetch current lesson" });
  }
});

app.patch("/classes/current-lesson", verifyGoogleToken, async (req, res) => {
  try {
    const { classId, currentLesson } = req.body;
    if (!classId || !currentLesson) {
      return res.status(400).json({ error: "classId and currentLesson are required" });
    }

    const classRef = db.collection('classes').doc(classId);
    const classDoc = await classRef.get();
    if (!classDoc.exists) {
      return res.status(404).json({ error: "Class not found" });
    }

    await classRef.update({ currentLesson });
    res.json({ success: true, currentLesson });
  } catch (error) {
    console.error("Error updating current lesson:", error);
    res.status(500).json({ error: "Failed to update current lesson" });
  }
});

/**
 * Get  for the selected class
 */
app.get("/students", verifyGoogleToken, async (req, res) => {
  try {
    // const userEmail = req.userEmail;
    const classId = req.query.classId;

    if (!classId) {
      return res.status(400).json({ error: "classId is required" });
    }

    const studentsRef = db.collection('students');
    // const studentsRef = db.collection('students-testing-table');
    const snapshot = await studentsRef.where('classId', '==', classId).get();

    const students = [];
    snapshot.forEach(doc => {
      students.push({ id: doc.id, ...doc.data() });
    });

    res.json(students);
  } catch (error) {
    console.error("Error fetching students:", error);
    res.status(500).json({ error: "Failed to fetch students" });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});