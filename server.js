const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const path = require("path");
require("dotenv").config();

// Audio configuration - LARGE CHUNKS to prevent buffer errors
const SAMPLE_RATE = 24000; // 24 kHz for OpenAI Realtime API
const CHANNELS = 1; // mono
const BITS = 16; // 16-bit PCM
const CHUNK_MS = 500; // 500ms chunks (5x larger!)
const BYTES_PER_SAMPLE = BITS / 8;
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS;
const CHUNK_BYTES = Math.floor(BYTES_PER_SECOND * (CHUNK_MS / 1000));
const MIN_BUFFER_SIZE = Math.floor(BYTES_PER_SECOND * 0.2); // 200ms minimum

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use(express.static("frontend/build"));

// Store active connections
const connections = new Map();

// WebSocket server for real-time communication
const wss = new WebSocket.Server({ port: 8080 });

wss.on("connection", (ws) => {
  console.log("New WebSocket connection established");

  let openaiWs = null;
  let isSessionActive = false;
  let responseInProgress = false;
  let audioBuffer = Buffer.alloc(0);
  let lastCommitTime = 0;
  let totalAudioSent = 0; // Track total audio sent since last commit

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === "init") {
        await initializeOpenAISession(ws, data.sessionId);
      } else if (data.type === "audio" && openaiWs && isSessionActive) {
        await streamAudioToOpenAI(ws, data.audio);
      } else if (data.type === "stop") {
        await stopSession(ws);
      }
    } catch (error) {
      console.error("Error processing message:", error);
      ws.send(JSON.stringify({ type: "error", message: error.message }));
    }
  });

  ws.on("close", async () => {
    console.log("WebSocket connection closed");
    if (openaiWs) {
      await stopSession(ws);
    }
    connections.delete(ws);
  });

  async function initializeOpenAISession(ws, sessionId) {
    try {
      openaiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1",
          },
        }
      );

      openaiWs.on("open", () => {
        console.log("Connected to OpenAI Realtime API");

        openaiWs.send(
          JSON.stringify({
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              instructions:
                "You are a real-time translator. When you receive English speech, translate it to Hindi and speak it back immediately. Only respond with the Hindi translation, no additional text or explanations. Keep responses short and natural.",
              voice: "alloy",
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              input_audio_transcription: {
                model: "whisper-1",
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
              },
            },
          })
        );

        connections.set(ws, { sessionId, openaiWs });
        isSessionActive = true;

        ws.send(
          JSON.stringify({
            type: "session_ready",
            message: "Real-time translation ready",
          })
        );
      });

      openaiWs.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());

          switch (message.type) {
            case "response.created":
              responseInProgress = true;
              break;

            case "response.audio.delta":
              ws.send(
                JSON.stringify({
                  type: "translated_audio",
                  audio: message.audio,
                })
              );
              break;

            case "response.transcript.delta":
              ws.send(
                JSON.stringify({
                  type: "translation",
                  text: message.transcript,
                })
              );
              break;

            case "response.done":
              responseInProgress = false;
              break;

            case "input_audio_buffer.speech_started":
              ws.send(
                JSON.stringify({
                  type: "speech_started",
                  message: "Listening...",
                })
              );
              break;

            case "input_audio_buffer.speech_stopped":
              ws.send(
                JSON.stringify({
                  type: "speech_stopped",
                  message: "Processing...",
                })
              );
              break;

            case "error":
              console.error("OpenAI Realtime API error:", message);
              responseInProgress = false;
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Translation error: " + message.error.message,
                })
              );
              break;
          }
        } catch (error) {
          console.error("Error parsing OpenAI message:", error);
        }
      });

      openaiWs.on("close", () => {
        console.log("OpenAI Realtime API connection closed");
        isSessionActive = false;
        responseInProgress = false;
      });

      openaiWs.on("error", (error) => {
        console.error("OpenAI Realtime API error:", error);
        responseInProgress = false;
        ws.send(
          JSON.stringify({
            type: "error",
            message: "OpenAI connection error",
          })
        );
      });
    } catch (error) {
      console.error("Failed to create OpenAI session:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Failed to initialize translation session",
        })
      );
    }
  }

  async function streamAudioToOpenAI(ws, audioData) {
    if (!openaiWs || !isSessionActive) return;

    try {
      // Convert Uint8Array to Buffer and append to audio buffer
      const newData = Buffer.from(audioData);
      audioBuffer = Buffer.concat([audioBuffer, newData]);

      console.log(
        `Received audio chunk: ${newData.length} bytes, total buffer: ${audioBuffer.length} bytes`
      );

      // Send chunks when we have enough data (500ms worth = 24,000 bytes)
      while (audioBuffer.length >= CHUNK_BYTES) {
        const chunk = audioBuffer.slice(0, CHUNK_BYTES);
        audioBuffer = audioBuffer.slice(CHUNK_BYTES);

        const base64Audio = chunk.toString("base64");
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: base64Audio,
          })
        );
        totalAudioSent += CHUNK_BYTES;
        console.log(
          `Sent audio chunk: ${CHUNK_BYTES} bytes (${CHUNK_MS}ms), total sent: ${totalAudioSent} bytes`
        );
      }

      // Auto-commit every 2 seconds ONLY if we have enough data (200ms minimum)
      const now = Date.now();
      if (
        audioBuffer.length >= MIN_BUFFER_SIZE &&
        now - lastCommitTime > 2000
      ) {
        // Send any remaining data
        if (audioBuffer.length > 0) {
          const base64Audio = audioBuffer.toString("base64");
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: base64Audio,
            })
          );
          console.log(`Sent remaining audio: ${audioBuffer.length} bytes`);
          totalAudioSent += audioBuffer.length;
          audioBuffer = Buffer.alloc(0);
        }

        // VALIDATE: Only commit if we actually sent enough audio data
        const minRequiredBytes = Math.floor(BYTES_PER_SECOND * 0.1); // 100ms = 12,000 bytes

        console.log("minRequiredBytes", minRequiredBytes);
        console.log("totalAudioSent", totalAudioSent);
        if (totalAudioSent >= minRequiredBytes) {
          // We have enough audio data, safe to commit
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.commit",
            })
          );
          console.log(
            `✅ Committed audio buffer (sent ${totalAudioSent} bytes, required ${minRequiredBytes} bytes)`
          );
          totalAudioSent = 0; // Reset counter
        } else {
          console.log(
            `❌ Skipping commit - not enough audio (sent ${totalAudioSent} bytes, required ${minRequiredBytes} bytes)`
          );
        }

        lastCommitTime = now;

        // Create response if not already in progress
        if (!responseInProgress) {
          openaiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "Translate the user audio into fluent Hindi and speak it back, preserving meaning and tone. Do not include English.",
              },
            })
          );
          responseInProgress = true;
          console.log("Created response for translation");
        }
      }
    } catch (error) {
      console.error("Error streaming audio:", error);
    }
  }

  async function stopSession(ws) {
    if (openaiWs && isSessionActive) {
      try {
        // Send any remaining audio data
        if (audioBuffer.length > 0) {
          const base64Audio = audioBuffer.toString("base64");
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: base64Audio,
            })
          );
          totalAudioSent += audioBuffer.length;
          console.log(
            `Sent final audio: ${audioBuffer.length} bytes, total: ${totalAudioSent} bytes`
          );
        }

        // VALIDATE: Only commit if we have enough audio data
        const minRequiredBytes = Math.floor(BYTES_PER_SECOND * 0.1); // 100ms

        if (totalAudioSent >= minRequiredBytes) {
          // Commit the final buffer
          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.commit",
            })
          );
          console.log(`✅ Final commit (sent ${totalAudioSent} bytes)`);
        } else {
          console.log(
            `❌ Skipping final commit - not enough audio (${totalAudioSent} bytes)`
          );
        }

        setTimeout(() => {
          if (openaiWs) {
            openaiWs.close();
            isSessionActive = false;
            responseInProgress = false;
            openaiWs = null;
          }
        }, 1000);

        ws.send(
          JSON.stringify({
            type: "session_stopped",
            message: "Translation session stopped",
          })
        );
      } catch (error) {
        console.error("Error stopping session:", error);
        if (openaiWs) {
          openaiWs.close();
        }
        isSessionActive = false;
        responseInProgress = false;
        openaiWs = null;
      }
    }
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Serve React app
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "frontend/build", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server running on port 8080`);
  console.log(
    `Audio config: ${SAMPLE_RATE}Hz, ${CHUNK_MS}ms chunks, ${CHUNK_BYTES} bytes per chunk`
  );
});
