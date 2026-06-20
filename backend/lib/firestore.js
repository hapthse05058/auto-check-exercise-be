/**
 * Single source of truth for Firebase Admin init + the Firestore handle.
 *
 * The target database is chosen by FIRESTORE_DATABASE_ID:
 *   - unset / "(default)"   → the production default database
 *   - "auto-check-exer-dev" → the development database (same GCP project)
 *
 * Shared by server.js and the standalone scripts so every entry point talks to
 * the same database the env selects. The service account (same project) has
 * access to every database in the project, so no credential change is needed.
 */
const fs = require("fs");
const path = require("path");
// Load .env by ABSOLUTE path so it works no matter the cwd a script is run from
// (dotenv otherwise resolves relative to process.cwd()).
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

// Cloud Run mounts the secret; locally it's a file next to the backend root.
const serviceAccountPath =
  process.env.NODE_ENV === "production"
    ? "/secrets/firebase-service-account"
    : path.join(__dirname, "..", "firebase-service-account.json");

if (!admin.apps.length) {
  if (fs.existsSync(serviceAccountPath)) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccountPath),
    });
  } else {
    console.error("Critical: Service account file not found!");
  }
}

const databaseId = process.env.FIRESTORE_DATABASE_ID || "(default)";
// "(default)" is the literal id of the default database, so this one call
// works for both prod and a named dev database.
const db = getFirestore(admin.app(), databaseId);

/** Returns a Firestore handle for an explicit database id (used by scripts that
 *  need BOTH dev and prod open at once). */
function getDb(id) {
  return getFirestore(admin.app(), id || "(default)");
}

module.exports = { admin, db, databaseId, getDb, serviceAccountPath };
