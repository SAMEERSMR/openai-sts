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
  let currentTranslation = ""; // Accumulate translation text
  let audioChunks = []; // Accumulate audio chunks

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`Server: Received message type: ${data.type}`);

      if (data.type === "init") {
        console.log("Processing init message");
        await initializeOpenAISession(ws, data.sessionId);
      } else if (data.type === "audio") {
        console.log(`Server: Audio message - openaiWs: ${!!openaiWs}, isSessionActive: ${isSessionActive}`);
        console.log(`Server: Received audio data, length: ${data.audio ? data.audio.length : 'undefined'} bytes`);
        if (openaiWs && isSessionActive) {
          await streamAudioToOpenAI(ws, data.audio);
        } else {
          console.log("Audio message received but session not ready");
        }
      } else if (data.type === "stop") {
        await stopSession(ws);
      } else {
        console.log(`Unknown message type: ${data.type}`);
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
              voice: "shimmer",
              input_audio_format: "pcm16",
              output_audio_format: "pcm16",
              input_audio_transcription: {
                model: "whisper-1",
              },
              turn_detection: {
                type: "server_vad",
                threshold: 0.3,
                prefix_padding_ms: 300,
                silence_duration_ms: 800,
              },
            },
          })
        );

        connections.set(ws, { sessionId, openaiWs });
        isSessionActive = true;
        console.log("OpenAI session is now active, ready to receive audio");

        ws.send(
          JSON.stringify({
            type: "session_ready",
            message: "Real-time translation ready",
          })
        );
        console.log("Sent session_ready message to frontend");
      });

      openaiWs.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          console.log(`OpenAI message type: ${message.type}`);

          switch (message.type) {
            case "session.updated":
              console.log("OpenAI session updated successfully");
              break;

            case "response.created":
              responseInProgress = true;
              currentTranslation = ""; // Reset translation for new response
              audioChunks = []; // Reset audio chunks for new response
              console.log("OpenAI creating response");
              break;

            case "response.audio.delta":
              console.log(`Received audio delta: ${message.delta ? message.delta.length : 0} bytes`);
              if (message.delta) {
                // Accumulate audio chunks instead of sending immediately
                const audioBytes = Buffer.from(message.delta, 'base64');
                audioChunks.push(audioBytes);
                console.log(`Accumulated audio chunk, total chunks: ${audioChunks.length}`);
              }
              break;

            case "response.output_item.done":
              if (message.item && message.item.type === "message") {
                console.log("Translation completed");
              }
              break;

            case "response.audio_transcript.delta":
              if (message.delta) {
                currentTranslation += message.delta;
                console.log(`Translation fragment: ${message.delta}`);
                console.log(`Full translation so far: ${currentTranslation}`);
                ws.send(
                  JSON.stringify({
                    type: "translation",
                    text: currentTranslation,
                  })
                );
              }
              break;

            case "response.done":
              responseInProgress = false;
              console.log("Response completed");
              
              // Send complete audio as one chunk
              if (audioChunks.length > 0) {
                const completeAudio = Buffer.concat(audioChunks);
                const audioArray = Array.from(completeAudio);
                console.log(`Sending complete audio: ${audioArray.length} bytes from ${audioChunks.length} chunks`);
                ws.send(
                  JSON.stringify({
                    type: "translated_audio",
                    audio: audioArray,
                  })
                );
                audioChunks = []; // Clear chunks after sending
              }
              break;

            case "input_audio_buffer.speech_started":
              console.log("Speech detected - user started speaking");
              ws.send(
                JSON.stringify({
                  type: "speech_started",
                  message: "Listening...",
                })
              );
              break;

            case "input_audio_buffer.speech_stopped":
              console.log("Speech ended - processing translation");
              ws.send(
                JSON.stringify({
                  type: "speech_stopped",
                  message: "Processing...",
                })
              );
              // Let server VAD handle the commit and response automatically
              break;

            case "input_audio_buffer.committed":
              console.log("Audio buffer committed by OpenAI VAD");
              break;

            case "conversation.item.created":
              console.log("Conversation item created");
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

            default:
              console.log(`Unhandled OpenAI message type: ${message.type}`);
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
    if (!openaiWs || !isSessionActive) {
      console.log(`Cannot stream audio - openaiWs: ${!!openaiWs}, isSessionActive: ${isSessionActive}`);
      return;
    }

    if (!audioData) {
      console.log("No audio data received");
      return;
    }

    try {
      // Convert Uint8Array to Buffer
      const newData = Buffer.from(audioData);
      console.log(`Received audio chunk: ${newData.length} bytes`);

      // With server VAD, just send audio directly - let OpenAI handle buffering and commits
      const base64Audio = newData.toString("base64");
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: base64Audio,
        })
      );
      
      console.log(`Sent ${newData.length} bytes to OpenAI`);
      
    } catch (error) {
      console.error("Error streaming audio:", error);
    }
  }

  async function stopSession(ws) {
    if (openaiWs && isSessionActive) {
      try {
        console.log("Stopping translation session");
        
        setTimeout(() => {
          if (openaiWs) {
            openaiWs.close();
            isSessionActive = false;
            responseInProgress = false;
            openaiWs = null;
          }
        }, 500);

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
