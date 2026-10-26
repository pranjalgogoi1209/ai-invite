import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import ffmpegPath from "ffmpeg-static";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import ffprobe from "ffprobe-static";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 5000);

const API = "https://api.sync.so/v2";
const API_KEY = process.env.SYNC_API_KEY;
const VOICE_ID = process.env.SYNC_VOICE_ID;
const MODEL = process.env.SYNC_MODEL || "lipsync-2";

const REFERENCE_VIDEO = path.resolve(
  process.env.REFERENCE_VIDEO || "./videos/all-cuts/reference.mp4",
);

const ENDING_VIDEOS = {
  extraSmall: path.resolve(
    process.env.EXTRA_SMALL_ENDING_VIDEO ||
      "./videos/all-cuts/all-endings/extra-small-name-ending.mp4",
  ),
  small: path.resolve(
    process.env.SMALL_ENDING_VIDEO ||
      "./videos/all-cuts/all-endings/small-name-ending.mp4",
  ),
  medium: path.resolve(
    process.env.MEDIUM_ENDING_VIDEO ||
      "./videos/all-cuts/all-endings/medium-name-ending.mp4",
  ),
  big: path.resolve(
    process.env.BIG_ENDING_VIDEO ||
      "./videos/all-cuts/all-endings/big-name-ending.mp4",
  ),
};

const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || "./output");

const GENERATED_DIR = path.join(OUTPUT_DIR, "sync-generated");
const FINAL_DIR = path.join(OUTPUT_DIR, "final");

fs.mkdirSync(GENERATED_DIR, { recursive: true });
fs.mkdirSync(FINAL_DIR, { recursive: true });

if (!ffmpegPath) {
  throw new Error("FFmpeg was not found.");
}

// --------------------------------------------------
// Validate configuration
// --------------------------------------------------

function validateConfiguration() {
  if (!API_KEY) {
    throw new Error("SYNC_API_KEY is missing from .env");
  }

  if (!VOICE_ID) {
    throw new Error("SYNC_VOICE_ID is missing from .env");
  }

  if (!fs.existsSync(REFERENCE_VIDEO)) {
    throw new Error(`Reference video was not found: ${REFERENCE_VIDEO}`);
  }

  for (const [endingType, endingPath] of Object.entries(ENDING_VIDEOS)) {
    if (!fs.existsSync(endingPath)) {
      throw new Error(
        `Ending video for "${endingType}" was not found: ${endingPath}`,
      );
    }
  }
}

// --------------------------------------------------
// FFmpeg helper
// --------------------------------------------------

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let errorOutput = "";

    child.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg exited with code ${code}:\n${errorOutput.slice(-4000)}`,
          ),
        );
      }
    });
  });
}

// --------------------------------------------------
// Sync API helper
// --------------------------------------------------

async function sync(endpoint, options = {}) {
  const response = await fetch(`${API}${endpoint}`, {
    ...options,
    headers: {
      "x-api-key": API_KEY,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });

  const responseText = await response.text();

  let data;

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = { message: responseText };
  }

  if (!response.ok) {
    throw new Error(
      `Sync API error ${response.status}: ${JSON.stringify(data)}`,
    );
  }

  return data;
}

// --------------------------------------------------
// Upload video to Sync
// --------------------------------------------------

async function uploadVideo(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Video not found: ${filePath}`);
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);

  const upload = await sync("/assets/upload", {
    method: "POST",
    body: JSON.stringify({
      fileName,
      contentType: "video/mp4",
      size: fileBuffer.length,
    }),
  });

  if (!upload.uploadUrl || !upload.url) {
    throw new Error(
      `Sync did not return uploadUrl and url: ${JSON.stringify(upload)}`,
    );
  }

  // Upload to the signed URL without sending the Sync API key.
  const uploadResponse = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(fileBuffer.length),
    },
    body: fileBuffer,
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();

    throw new Error(
      `Video upload failed (${uploadResponse.status}): ${errorText}`,
    );
  }

  const asset = await sync("/assets", {
    method: "POST",
    body: JSON.stringify({
      url: upload.url,
      type: "VIDEO",
      name: fileName,
    }),
  });

  if (!asset.id) {
    throw new Error(
      `Sync did not return an asset ID: ${JSON.stringify(asset)}`,
    );
  }

  return asset.id;
}

// --------------------------------------------------
// Get media duration using FFprobe
// --------------------------------------------------

async function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe.path, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`FFprobe failed: ${stderr}`));
      }

      const duration = Number(stdout.trim());

      if (!Number.isFinite(duration) || duration <= 0) {
        return reject(new Error("Could not determine media duration."));
      }

      resolve(duration);
    });
  });
}

// --------------------------------------------------
// Download generated audio temporarily and measure it
// --------------------------------------------------

async function getAudioDuration(audioUrl) {
  const response = await fetch(audioUrl);

  if (!response.ok) {
    throw new Error(`Audio download failed: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  const tempAudioPath = path.join(
    os.tmpdir(),
    `audio-${crypto.randomUUID()}.mp3`,
  );

  try {
    fs.writeFileSync(tempAudioPath, buffer);
    return await getVideoDuration(tempAudioPath);
  } finally {
    fs.rmSync(tempAudioPath, { force: true });
  }
}

// --------------------------------------------------
// Generate speech using the configured voice
// --------------------------------------------------

async function generateSpeech(name) {
  const speech = await sync("/tts", {
    method: "POST",
    body: JSON.stringify({
      script: `${name} की तरफ से`,
      voiceId: VOICE_ID,
      provider: "elevenlabs",
      stability: 0.5,
      similarityBoost: 0.8,
    }),
  });

  if (!speech.url) {
    throw new Error(
      `Sync did not return a speech URL: ${JSON.stringify(speech)}`,
    );
  }

  return speech;
}

// --------------------------------------------------
// Choose ending based on measured audio duration
// --------------------------------------------------

function selectEndingVideo(audioDuration) {
  if (audioDuration >= 1.25 && audioDuration < 1.3) {
    return {
      type: "extra-small",
      path: ENDING_VIDEOS.extraSmall,
    };
  }

  if (audioDuration >= 1.3 && audioDuration < 1.45) {
    return {
      type: "small",
      path: ENDING_VIDEOS.small,
    };
  }

  if (audioDuration >= 1.45 && audioDuration < 1.5) {
    return {
      type: "medium",
      path: ENDING_VIDEOS.medium,
    };
  }

  if (audioDuration >= 1.5 && audioDuration <= 1.7) {
    return {
      type: "big",
      path: ENDING_VIDEOS.big,
    };
  }

  return null;
}

// --------------------------------------------------
// Start Sync video generation
// --------------------------------------------------

async function startVideoGeneration({
  videoAssetId,
  speechUrl,
  outputFileName,
}) {
  const generation = await sync("/generate", {
    method: "POST",
    body: JSON.stringify({
      model: MODEL,
      input: [
        {
          type: "video",
          assetId: videoAssetId,
        },
        {
          type: "audio",
          url: speechUrl,
        },
      ],
      options: {
        sync_mode: "cut_off",
      },
      outputFileName,
    }),
  });

  const generationId = generation.id || generation.generationId;

  if (!generationId) {
    throw new Error(
      `Sync did not return a generation ID: ${JSON.stringify(generation)}`,
    );
  }

  return generationId;
}

// --------------------------------------------------
// Wait for Sync generation to finish
// --------------------------------------------------

async function waitForGeneration(generationId) {
  const deadline = Date.now() + 15 * 60 * 1000;

  while (Date.now() < deadline) {
    const result = await sync(`/generate/${encodeURIComponent(generationId)}`);

    console.log(`Generation ${generationId}:`, result.status);

    if (result.status === "COMPLETED") {
      if (!result.outputUrl) {
        throw new Error(
          `Generation completed but outputUrl is missing: ${JSON.stringify(result)}`,
        );
      }

      return result.outputUrl;
    }

    if (
      ["FAILED", "REJECTED", "CANCELED", "CANCELLED"].includes(
        String(result.status).toUpperCase(),
      )
    ) {
      throw new Error(`Video generation failed: ${JSON.stringify(result)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 4000));
  }

  throw new Error(`Timed out waiting for generation ${generationId}`);
}

// --------------------------------------------------
// Download generated video
// --------------------------------------------------

async function downloadVideo(url, destination) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Generated video download failed: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (!buffer.length) {
    throw new Error("Downloaded video is empty.");
  }

  fs.writeFileSync(destination, buffer);

  console.log("Generated video saved:", destination);
}

// --------------------------------------------------
// Normalize video clips before merging
// --------------------------------------------------

async function normalizeVideo(inputPath, outputPath) {
  await runFFmpeg([
    "-y",
    "-i",
    inputPath,

    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",

    "-vf",
    "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1",

    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",

    "-c:a",
    "aac",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-b:a",
    "128k",

    "-af",
    "aresample=async=1:first_pts=0",

    "-movflags",
    "+faststart",

    outputPath,
  ]);
}

// --------------------------------------------------
// Merge generated video + selected ending video
// --------------------------------------------------

async function mergeVideos(
  generatedVideoPath,
  endingVideoPath,
  finalVideoPath,
) {
  if (!fs.existsSync(generatedVideoPath)) {
    throw new Error(`Generated video not found: ${generatedVideoPath}`);
  }

  if (!fs.existsSync(endingVideoPath)) {
    throw new Error(`Ending video not found: ${endingVideoPath}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-invitation-"));

  try {
    const normalizedGenerated = path.join(tempDir, "generated-normalized.mp4");

    const normalizedEnding = path.join(tempDir, "ending-normalized.mp4");

    const concatFile = path.join(tempDir, "concat.txt");

    await normalizeVideo(generatedVideoPath, normalizedGenerated);
    await normalizeVideo(endingVideoPath, normalizedEnding);

    const escapePath = (filePath) =>
      filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");

    fs.writeFileSync(
      concatFile,
      [
        `file '${escapePath(normalizedGenerated)}'`,
        `file '${escapePath(normalizedEnding)}'`,
      ].join("\n"),
      "utf8",
    );

    await runFFmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatFile,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      finalVideoPath,
    ]);

    console.log("Final video saved:", finalVideoPath);
  } finally {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
    });
  }
}

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Sync invitation server is running.",
  });
});

// --------------------------------------------------
// Generate invitation
// --------------------------------------------------

app.post("/generate-invitation", async (req, res) => {
  try {
    validateConfiguration();

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";

    if (!name) {
      return res.status(400).json({
        success: false,
        error: "Please provide a name.",
      });
    }

    // 1. Measure reference video duration.
    const referenceVideoDuration = await getVideoDuration(REFERENCE_VIDEO);

    console.log(
      `Reference video duration: ${referenceVideoDuration.toFixed(3)} seconds`,
    );

    const id = crypto.randomUUID();

    const outputFileName = `invitation_${id}`;

    const generatedPath = path.join(GENERATED_DIR, `${id}-name.mp4`);

    const finalPath = path.join(FINAL_DIR, `${id}-final.mp4`);

    console.log("Starting invitation generation:", {
      id,
      name,
    });

    // 2. Generate speech.
    const speech = await generateSpeech(name);

    // 3. Measure the actual generated audio duration.
    const audioDuration = await getAudioDuration(speech.url);

    console.log(
      `Generated audio duration: ${audioDuration.toFixed(3)} seconds`,
    );

    // 4. Select ending based on audio duration, not name length.
    const selectedEnding = selectEndingVideo(audioDuration);

    if (!selectedEnding) {
      return res.status(422).json({
        success: false,
        error: `Generated audio duration ${audioDuration.toFixed(3)} seconds is outside the supported range of 1.25–1.70 seconds. No ending video was selected.`,
        generatedAudioSeconds: Number(audioDuration.toFixed(3)),
        supportedRangeSeconds: {
          min: 1.25,
          max: 1.7,
        },
      });
    }

    console.log(
      `Selected ending (${selectedEnding.type}): ${selectedEnding.path}`,
    );

    // 5. Upload the reference video to Sync.
    const videoAssetId = await uploadVideo(REFERENCE_VIDEO);

    console.log("Video uploaded to Sync:", videoAssetId);

    // 6. Generate the lip-synced video.
    const generationId = await startVideoGeneration({
      videoAssetId,
      speechUrl: speech.url,
      outputFileName,
    });

    console.log("Generation ID:", generationId);

    // 7. Wait for Sync to finish.
    const generatedVideoUrl = await waitForGeneration(generationId);

    // 8. Download the generated video.
    await downloadVideo(generatedVideoUrl, generatedPath);

    // 9. Measure the generated video duration.
    const generatedVideoDuration = await getVideoDuration(generatedPath);

    console.log(
      `Generated video duration: ${generatedVideoDuration.toFixed(3)} seconds`,
    );

    // 10. Merge the generated video with the selected ending.
    await mergeVideos(generatedPath, selectedEnding.path, finalPath);

    // 11. Return the generated and final video details.
    return res.status(200).json({
      success: true,
      id,
      name,
      generationId,

      selectedEnding: {
        type: selectedEnding.type,
        file: path.basename(selectedEnding.path),
      },

      durations: {
        referenceVideoSeconds: Number(referenceVideoDuration.toFixed(3)),
        generatedAudioSeconds: Number(audioDuration.toFixed(3)),
        generatedVideoSeconds: Number(generatedVideoDuration.toFixed(3)),
      },

      generatedVideo: {
        path: generatedPath,
        url: `/sync-generated/${path.basename(generatedPath)}`,
      },

      finalVideo: {
        path: finalPath,
        url: `/final/${path.basename(finalPath)}`,
      },
    });
  } catch (error) {
    console.error("Invitation generation error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Video generation failed.",
    });
  }
});

// --------------------------------------------------
// Serve generated and final videos
// --------------------------------------------------

app.use("/sync-generated", express.static(GENERATED_DIR));
app.use("/final", express.static(FINAL_DIR));

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Generated videos: ${GENERATED_DIR}`);
  console.log(`Final videos: ${FINAL_DIR}`);
});
