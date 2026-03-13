/**
 * server/storage.ts — Google Cloud Storage integration with local fallback.
 *
 * Uploads screenshots and logs to GCS bucket.
 * Gracefully degrades to local file storage on GCS failure.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

// ── Module Logger ───────────────────────────────────────────────────
const LOG_PREFIX = "[storage]";
function log(level: string, msg: string) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${LOG_PREFIX} ${level}: ${msg}`);
}

// ── Configuration ───────────────────────────────────────────────────
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME?.trim();
const GCS_CREDENTIALS_PATH = process.env.GCS_CREDENTIALS_PATH?.trim();
const GCS_PROJECT_ID = process.env.GCS_PROJECT_ID?.trim();
const LOCAL_SCREENSHOTS_DIR = "./runs/screenshots";

// Ensure local fallback directory exists
fs.mkdirSync(LOCAL_SCREENSHOTS_DIR, { recursive: true });

// ── GCS Client (lazy init) ──────────────────────────────────────────
let gcsStorage: any = null;
let gcsBucket: any = null;
let gcsAvailable = false;

async function initGCS() {
  if (gcsStorage !== null) return gcsAvailable;

  if (!GCS_BUCKET_NAME) {
    log("WARNING", "GCS_BUCKET_NAME not set — using local storage");
    gcsAvailable = false;
    return false;
  }

  try {
    const { Storage } = await import("@google-cloud/storage");
    const opts: any = {};
    if (GCS_PROJECT_ID) opts.projectId = GCS_PROJECT_ID;
    if (GCS_CREDENTIALS_PATH) opts.keyFilename = GCS_CREDENTIALS_PATH;

    gcsStorage = new Storage(opts);
    gcsBucket = gcsStorage.bucket(GCS_BUCKET_NAME);

    // Test connectivity
    await gcsBucket.exists();
    gcsAvailable = true;
    log("INFO", `GCS connected — bucket: ${GCS_BUCKET_NAME}`);
    return true;
  } catch (err) {
    log("WARNING", `GCS init failed: ${err} — falling back to local storage`);
    gcsAvailable = false;
    return false;
  }
}

// ── Upload ──────────────────────────────────────────────────────────
export interface UploadResult {
  url: string;
  isLocal: boolean;
  path: string;
}

/**
 * Upload a file to GCS (or local fallback).
 * Returns the URL for frontend display.
 */
export async function uploadScreenshot(
  filePath: string,
  destName?: string
): Promise<UploadResult> {
  const filename = destName || path.basename(filePath);

  // Try GCS first
  await initGCS();

  if (gcsAvailable && gcsBucket) {
    try {
      const gcsPath = `screenshots/${filename}`;
      await gcsBucket.upload(filePath, {
        destination: gcsPath,
        metadata: {
          contentType: "image/jpeg",
          metadata: {
            uploadedBy: "phoenix-shopping-sniper",
            uploadedAt: new Date().toISOString(),
          },
        },
      });

      const file = gcsBucket.file(gcsPath);
      const [signedUrl] = await file.getSignedUrl({
        action: "read" as const,
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      log("INFO", `Uploaded to GCS: ${gcsPath}`);
      return { url: signedUrl, isLocal: false, path: gcsPath };
    } catch (err) {
      log("WARNING", `GCS upload failed: ${err} — falling back to local`);
    }
  }

  // Local fallback
  return uploadLocal(filePath, filename);
}

/**
 * Upload a buffer (e.g., screenshot bytes) to GCS or local.
 */
export async function uploadBuffer(
  buffer: Buffer,
  filename: string,
  contentType = "image/jpeg"
): Promise<UploadResult> {
  await initGCS();

  if (gcsAvailable && gcsBucket) {
    try {
      const gcsPath = `screenshots/${filename}`;
      const file = gcsBucket.file(gcsPath);
      await file.save(buffer, {
        contentType,
        metadata: {
          uploadedBy: "phoenix-shopping-sniper",
          uploadedAt: new Date().toISOString(),
        },
      });

      // Make public
      try {
        await file.makePublic();
        const publicUrl = `https://storage.googleapis.com/${GCS_BUCKET_NAME}/${gcsPath}`;
        log("INFO", `Uploaded buffer to GCS: ${gcsPath} (public)`);
        return { url: publicUrl, isLocal: false, path: gcsPath };
      } catch {
        // If can't make public, use signed URL
        const [signedUrl] = await file.getSignedUrl({
          action: "read" as const,
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });
        log("INFO", `Uploaded buffer to GCS: ${gcsPath} (signed)`);
        return { url: signedUrl, isLocal: false, path: gcsPath };
      }
    } catch (err) {
      log("WARNING", `GCS buffer upload failed: ${err} — local fallback`);
    }
  }

  // Local fallback
  const localPath = path.join(LOCAL_SCREENSHOTS_DIR, filename);
  fs.writeFileSync(localPath, buffer);
  log("INFO", `Saved buffer locally: ${localPath}`);
  return {
    url: `/api/screenshots/${filename}`,
    isLocal: true,
    path: localPath,
  };
}

/** Upload log file to GCS for audit trail. */
export async function uploadLog(
  logContent: string,
  logName: string
): Promise<UploadResult> {
  await initGCS();

  if (gcsAvailable && gcsBucket) {
    try {
      const gcsPath = `logs/${logName}`;
      const file = gcsBucket.file(gcsPath);
      await file.save(logContent, { contentType: "text/plain" });
      log("INFO", `Log uploaded to GCS: ${gcsPath}`);
      return {
        url: `gs://${GCS_BUCKET_NAME}/${gcsPath}`,
        isLocal: false,
        path: gcsPath,
      };
    } catch (err) {
      log("WARNING", `GCS log upload failed: ${err}`);
    }
  }

  // Local fallback
  const logsDir = "./runs/logs";
  fs.mkdirSync(logsDir, { recursive: true });
  const localPath = path.join(logsDir, logName);
  fs.writeFileSync(localPath, logContent);
  return { url: localPath, isLocal: true, path: localPath };
}

// ── Local Fallback ──────────────────────────────────────────────────
function uploadLocal(filePath: string, filename: string): UploadResult {
  const localDest = path.join(LOCAL_SCREENSHOTS_DIR, filename);
  if (filePath !== localDest) {
    fs.copyFileSync(filePath, localDest);
  }
  log("INFO", `Saved locally: ${localDest}`);
  return {
    url: `/api/screenshots/${filename}`,
    isLocal: true,
    path: localDest,
  };
}
