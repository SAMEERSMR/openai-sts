import React, { useState, useRef, useCallback, useEffect } from "react";

interface AudioContextRef {
  audioContext: AudioContext | null;
  processor: ScriptProcessorNode | null;
  source: MediaStreamAudioSourceNode | null;
}

const LiveTranslator: React.FC = () => {
  // State management
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState("Ready to translate");
  const [statusType, setStatusType] = useState<
    "ready" | "recording" | "processing" | "error"
  >("ready");
  const [englishText, setEnglishText] = useState("Speak in English...");
  const [hindiText, setHindiText] = useState("Translation will appear here...");
  const [isPlaying, setIsPlaying] = useState(false);

  // Refs
  const websocketRef = useRef<WebSocket | null>(null);
  const audioRefs = useRef<AudioContextRef>({
    audioContext: null,
    processor: null,
    source: null,
  });
  const audioQueueRef = useRef<Uint8Array[]>([]);

  // WebSocket connection
  const connectWebSocket = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.hostname}:8080`;

    websocketRef.current = new WebSocket(wsUrl);

    websocketRef.current.onopen = () => {
      console.log("WebSocket connected");
      setStatus("Initializing real-time translation...");
      setStatusType("processing");
      websocketRef.current?.send(
        JSON.stringify({
          type: "init",
          sessionId: Date.now().toString(),
        })
      );
    };

    websocketRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      handleWebSocketMessage(data);
    };

    websocketRef.current.onclose = () => {
      console.log("WebSocket disconnected");
      setStatus("Connection lost");
      setStatusType("error");
    };

    websocketRef.current.onerror = (error) => {
      console.error("WebSocket error:", error);
      setStatus("Connection error");
      setStatusType("error");
    };
  }, []);

  // Handle WebSocket messages
  const handleWebSocketMessage = useCallback((data: any) => {
    switch (data.type) {
      case "session_ready":
        setStatus("Real-time translation ready - Start speaking!");
        setStatusType("ready");
        break;
      case "translated_audio":
        handleTranslatedAudio(data.audio);
        break;
      case "transcription":
        setEnglishText(data.text);
        break;
      case "translation":
        setHindiText(data.text);
        break;
      case "session_stopped":
        setStatus("Translation session stopped");
        setStatusType("ready");
        break;
      case "error":
        setStatus(`Translation error: ${data.message}`);
        setStatusType("error");
        break;
    }
  }, []);

  // Convert Float32 to Int16 (PCM16)
  const convertFloat32ToInt16 = useCallback(
    (buffer: Float32Array): ArrayBuffer => {
      const length = buffer.length;
      const result = new Int16Array(length);
      for (let i = 0; i < length; i++) {
        const sample = Math.max(-1, Math.min(1, buffer[i]));
        result[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      return result.buffer;
    },
    []
  );

  // Send audio to server
  const sendAudioToServer = useCallback((audioBuffer: ArrayBuffer) => {
    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      try {
        websocketRef.current.send(
          JSON.stringify({
            type: "audio",
            audio: Array.from(new Uint8Array(audioBuffer)),
          })
        );
      } catch (error) {
        console.error("Error sending audio:", error);
      }
    }
  }, []);

  // Handle translated audio
  const handleTranslatedAudio = useCallback((audioData: number[]) => {
    try {
      if (!audioData || audioData.length === 0) {
        console.log("Received empty audio data, skipping...");
        return;
      }

      const audioBuffer = new Uint8Array(audioData);

      if (audioBuffer.length < 2) {
        console.log("Audio buffer too small, skipping...");
        return;
      }

      audioQueueRef.current.push(audioBuffer);
      playNextAudio();
    } catch (error) {
      console.error("Error handling translated audio:", error);
    }
  }, []);

  // Play next audio in queue
  const playNextAudio = useCallback(async () => {
    if (isPlaying || audioQueueRef.current.length === 0) return;

    setIsPlaying(true);
    const audioData = audioQueueRef.current.shift()!;

    try {
      const pcmData = new Uint8Array(audioData);

      if (pcmData.length < 2) {
        console.log("Audio data too small, skipping playback");
        setIsPlaying(false);
        return;
      }

      const numSamples = Math.floor(pcmData.length / 2);

      if (numSamples === 0) {
        console.log("No audio samples to play");
        setIsPlaying(false);
        return;
      }

      const audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      const audioBuffer = audioContext.createBuffer(1, numSamples, 24000);
      const channelData = audioBuffer.getChannelData(0);

      for (let i = 0; i < pcmData.length - 1; i += 2) {
        const sample = pcmData[i] | (pcmData[i + 1] << 8);
        channelData[i / 2] =
          sample < 32768 ? sample / 32768 : (sample - 65536) / 32768;
      }

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);

      source.onended = () => {
        setIsPlaying(false);
        if (audioQueueRef.current.length > 0) {
          playNextAudio();
        }
      };

      source.start();
    } catch (error) {
      console.error("Error playing audio:", error);
      setIsPlaying(false);
    }
  }, [isPlaying]);

  // Start translation
  const startTranslation = useCallback(async () => {
    try {
      setStatus("Requesting microphone access...");
      setStatusType("processing");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 24000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      // Setup Web Audio API
      const audioContext = new (window.AudioContext ||
        (window as any).webkitAudioContext)({
        sampleRate: 24000,
      });

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(8192, 1, 1);

      processor.onaudioprocess = (event) => {
        if (isRecording) {
          const inputData = event.inputBuffer.getChannelData(0);
          const pcmData = convertFloat32ToInt16(inputData);
          sendAudioToServer(pcmData);
        }
      };

      source.connect(processor);
      processor.connect(audioContext.destination);

      // Store references
      audioRefs.current = { audioContext, processor, source };

      connectWebSocket();
      setIsRecording(true);
      setStatus("Recording... Speak in English");
      setStatusType("recording");
    } catch (error) {
      console.error("Error starting translation:", error);
      setStatus("Microphone access denied");
      setStatusType("error");
      alert("Please allow microphone access to use the translation feature.");
    }
  }, [isRecording, convertFloat32ToInt16, sendAudioToServer, connectWebSocket]);

  // Stop translation
  const stopTranslation = useCallback(() => {
    setIsRecording(false);

    // Clean up Web Audio API
    if (audioRefs.current.processor) {
      audioRefs.current.processor.disconnect();
    }
    if (audioRefs.current.source) {
      audioRefs.current.source.disconnect();
    }
    if (audioRefs.current.audioContext) {
      audioRefs.current.audioContext.close();
    }

    if (websocketRef.current?.readyState === WebSocket.OPEN) {
      websocketRef.current.send(JSON.stringify({ type: "stop" }));
      websocketRef.current.close();
    }

    setStatus("Ready to translate");
    setStatusType("ready");
  }, []);

  // Play last translation
  const playLastTranslation = useCallback(() => {
    if (audioQueueRef.current.length > 0) {
      playNextAudio();
    }
  }, [playNextAudio]);

  // Clear text
  const clearText = useCallback(() => {
    setEnglishText("Speak in English...");
    setHindiText("Translation will appear here...");
    audioQueueRef.current = [];
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (websocketRef.current) {
        websocketRef.current.close();
      }
      if (audioRefs.current.audioContext) {
        audioRefs.current.audioContext.close();
      }
    };
  }, []);

  return (
    <>
      <header>
        <h1>🎤 Live Translation</h1>
        <p>English → Hindi Real-time Translation</p>
      </header>

      <main>
        <div className="translation-box">
          <div className="status-indicator">
            <span className={`status-dot ${statusType}`}></span>
            <span>{status}</span>
          </div>

          <div className="controls">
            <button
              className="btn btn-primary"
              onClick={startTranslation}
              disabled={isRecording}
            >
              <span>🎤</span>
              Start Translation
            </button>
            <button
              className="btn btn-secondary"
              onClick={stopTranslation}
              disabled={!isRecording}
            >
              <span>⏹️</span>
              Stop Translation
            </button>
          </div>

          <div className="translation-display">
            <div className="input-section">
              <h3>English Input</h3>
              <div className="text-display">{englishText}</div>
            </div>

            <div className="output-section">
              <h3>Hindi Translation</h3>
              <div className="text-display">{hindiText}</div>
            </div>
          </div>

          <div className="audio-controls">
            <button
              className="btn btn-small"
              onClick={playLastTranslation}
              disabled={audioQueueRef.current.length === 0}
            >
              🔊 Play Hindi Audio
            </button>
            <button className="btn btn-small" onClick={clearText}>
              🗑️ Clear
            </button>
          </div>
        </div>

        <div className="instructions">
          <h3>How to use:</h3>
          <ol>
            <li>Click "Start Translation" to begin</li>
            <li>Allow microphone access when prompted</li>
            <li>Speak clearly in English</li>
            <li>Listen to the Hindi translation</li>
            <li>Click "Stop Translation" when done</li>
          </ol>
        </div>
      </main>

      <footer>
        <p>Powered by OpenAI Realtime API</p>
      </footer>
    </>
  );
};

export default LiveTranslator;
