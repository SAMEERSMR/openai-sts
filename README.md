# Live Translation App - English to Hindi

A real-time translation application that converts English speech to Hindi using OpenAI's Realtime API.

## Features

- 🎤 **Real-time Speech Recognition**: Captures English speech from microphone
- 🔄 **Live Translation**: Converts English to Hindi using OpenAI Realtime API
- 🔊 **Audio Output**: Speaks the Hindi translation back to you
- 🌐 **Web-based Interface**: Clean, responsive HTML/CSS/JS frontend
- ⚡ **Low Latency**: Uses WebSocket for real-time communication

## Prerequisites

- Node.js (v16 or higher)
- OpenAI API key with Realtime API access
- Modern web browser with microphone support

## Installation

1. **Clone or download the project**
   ```bash
   cd /home/sameer/Downloads/openai
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp env.example .env
   ```
   
   Edit `.env` file and add your OpenAI API key:
   ```
   OPENAI_API_KEY=your_actual_api_key_here
   PORT=3000
   ```

## Usage

1. **Start the server**
   ```bash
   npm start
   ```
   
   For development with auto-restart:
   ```bash
   npm run dev
   ```

2. **Open your browser**
   Navigate to `http://localhost:3000`

3. **Allow microphone access** when prompted

4. **Click "Start Translation"** and speak in English

5. **Listen to the Hindi translation** played back automatically

## Project Structure

```
openai/
├── server.js              # Express server with WebSocket support
├── package.json           # Node.js dependencies
├── env.example           # Environment variables template
├── README.md             # This file
└── public/               # Frontend files
    ├── index.html        # Main HTML page
    ├── styles.css        # CSS styling
    └── script.js         # JavaScript functionality
```

## How It Works

1. **Frontend**: Captures audio from microphone using WebRTC
2. **WebSocket**: Sends audio chunks to backend in real-time
3. **Backend**: Processes audio with OpenAI Realtime API
4. **Translation**: Converts English speech to Hindi
5. **Audio Output**: Plays Hindi translation back to user

## API Configuration

The app uses OpenAI's Realtime API with these settings:
- Model: `gpt-4o-realtime-preview-2024-12-17`
- Voice: `alloy`
- Input format: PCM16
- Output format: PCM16
- Turn detection: Server VAD

## Browser Compatibility

- Chrome/Chromium (recommended)
- Firefox
- Safari (limited WebRTC support)
- Edge

## Troubleshooting

### Microphone Issues
- Ensure microphone permissions are granted
- Check if another application is using the microphone
- Try refreshing the page

### Connection Issues
- Verify OpenAI API key is correct
- Check if ports 3000 and 8080 are available
- Ensure stable internet connection

### Audio Playback Issues
- Check browser audio settings
- Ensure speakers/headphones are working
- Try different browser

## Development

To modify the translation behavior, edit the `instructions` in `server.js`:

```javascript
instructions: `You are a real-time translator. When you receive English speech, translate it to Hindi and speak it back. 
Only respond with the Hindi translation, no additional text or explanations.`
```

## License

MIT License - feel free to modify and distribute.

## Support

For issues related to:
- OpenAI API: Check [OpenAI Documentation](https://platform.openai.com/docs/realtime-api)
- WebRTC: Check browser compatibility
- This app: Create an issue in the repository
