# Khmer Subtitle Translator

A browser-based subtitle translator and optional Khmer video dubbing tool. The frontend is Next.js 14 + TypeScript; a stateless FastAPI service runs the NLLB-200 translation model, Edge TTS, and FFmpeg.

## Run locally

### Docker Compose

```powershell
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The API health check is at [http://localhost:8000/health](http://localhost:8000/health).

The NLLB model (`facebook/nllb-200-distilled-600M`) is downloaded from Hugging Face when translation is first requested. The first translation may take a while and needs internet access. Edge TTS also needs an internet connection; it does not require an API key. The Docker backend runs on CPU by default, so dubbing and translation speed depends on the computer.

Use **Generate subtitles** in the header to upload a video and transcribe its speech into timed SRT cues with the local Whisper model (`openai/whisper-small`). The header progress indicator reports upload and processing progress. The model is downloaded from Hugging Face the first time and may take a while. Generated subtitles are saved in the current browser project; choose the source language and use **Translate all** to optionally translate them into Khmer. Video uploads are limited to 2 GB by default (`MAX_VIDEO_UPLOAD_BYTES`).

### Run the services separately

In one terminal:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
uvicorn backend.main:app --reload --port 8000
```

FFmpeg and ffprobe must be installed and available on `PATH` for subtitle generation and dubbing. In another terminal:

```powershell
npm install
$env:NEXT_PUBLIC_API_URL = "http://localhost:8000"
npm run dev
```

The backend allows frontend origins at `localhost` and `127.0.0.1` on ports 3000–3005. Restart the backend after changing its CORS settings. Open the URL printed by Next.js. For a production frontend build, run `npm run build` and `npm start`.

## Deploy to Render

The root `render.yaml` defines two Docker web services: the FastAPI API and the Next.js frontend. Push this repository to a Git provider connected to Render, then choose **New → Blueprint** and select the repository. Keep the service names `vz-translate-api` and `vz-translate-web`; the API URL and CORS origin in the Blueprint use their corresponding `onrender.com` hostnames.

The API uses Render's `pro` plan (2 CPUs / 4 GB RAM) because the Whisper and NLLB models need substantially more memory than a free instance provides. The frontend uses the free plan and may spin down when idle. Model files are not on persistent storage, so they may need to download again after an API restart or deploy. Upgrade the API plan if model inference runs out of memory.

The app's upload limit is 2 GB, but the Render plan or HTTP ingress may impose additional upload constraints. Verify the actual video sizes you intend to use after deployment.

## Data and privacy

- There is no database, account system, or server-side permanent storage.
- The browser stores project metadata, source video, original and translated subtitles, generated audio, and dubbed video in IndexedDB (`khmer_translator_db`).
- `sessionStorage` marks a browser-tab session. A fresh session clears the IndexedDB database; a page refresh in the same tab reuses it.
- The banner warns that project data is temporary. Closing the tab ends that tab session; its data is cleared when the app is next opened as a fresh session.
- Each processing request uses a temporary `/tmp/session_<sessionId>/` workspace (or the operating system temp directory when running directly on Windows). Uploads and generated files are removed after processing and response delivery. A `pagehide` beacon also requests cleanup.
- The browser's own IndexedDB quota still applies. Video uploads are limited to 2 GB by default (`MAX_VIDEO_UPLOAD_BYTES`); other backend uploads default to 3 GB (`MAX_UPLOAD_BYTES`).

## API

All processing endpoints are stateless: every request includes the input data it needs. `session_id` is a UUID used only to scope temporary files and cleanup.

| Method and path | Request | Response |
|---|---|---|
| `GET /health` | — | Service status and model target |
| `POST /generate-subtitles` | Multipart: `video_file`, `session_id` | JSON: `generated_srt` |
| `GET /generate-subtitles/progress/{progress_id}` | — | JSON: `progress`, `status` |
| `POST /translate` | Multipart: `srt_file`, `source_lang` (NLLB code), `session_id` | JSON: `translated_srt` |
| `POST /dub` | Multipart: `video_file`, `translated_srt`, `voice`, `speed` (0.8–1.5), `keep_background_audio`, `session_id` | ZIP containing `khmer-audio.mp3` and `khmer-dubbed.mp4` |
| `POST /cleanup` | Multipart: `session_id` | JSON cleanup status |

Supported translation source codes are listed in the upload screen. Khmer is the fixed target (`khm_Khmr`). Dubbing supports `km-KH-PisethNeural` and `km-KH-SreymomNeural`.
