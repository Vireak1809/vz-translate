import asyncio
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
import zipfile
from collections.abc import Callable
from pathlib import Path

import edge_tts
import torch
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("khmer-translator")

MODEL_NAME = os.getenv("NLLB_MODEL", "facebook/nllb-200-distilled-600M")
TARGET_LANGUAGE = "khm_Khmr"
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(3 * 1024 * 1024 * 1024)))
MAX_VIDEO_UPLOAD_BYTES = int(
    os.getenv("MAX_VIDEO_UPLOAD_BYTES", str(2 * 1024 * 1024 * 1024))
)
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "openai/whisper-small")
TEMP_ROOT = Path(
    os.getenv(
        "KHMER_TEMP_DIR",
        "/tmp" if os.name != "nt" else tempfile.gettempdir(),
    )
)
LANGUAGES = {
    "eng_Latn",
    "fra_Latn",
    "spa_Latn",
    "zho_Hans",
    "jpn_Jpan",
    "kor_Hang",
    "tha_Thai",
    "vie_Latn",
    "hin_Deva",
    "rus_Cyrl",
    "arb_Arab",
    "ind_Latn",
}
VOICES = {"km-KH-PisethNeural", "km-KH-SreymomNeural"}
TIME_RE = re.compile(
    r"((?:\d{2}:)?\d{2}:\d{2}[,.]\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}[,.]\d{3})"
)
SESSION_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)

app = FastAPI(title="Khmer Subtitle Translator API", version="1.0.0")
allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        ",".join(
            f"http://{host}:{port}"
            for host in ("localhost", "127.0.0.1")
            for port in range(3000, 3006)
        ),
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1):300[0-5]$",
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_model = None
_tokenizer = None
_model_lock = asyncio.Lock()
_asr_pipeline = None
_asr_lock = asyncio.Lock()
_generation_progress: dict[str, tuple[int, str, float]] = {}


class TranslationResponse(BaseModel):
    translated_srt: str


class SubtitleGenerationResponse(BaseModel):
    generated_srt: str


class SubtitleGenerationProgressResponse(BaseModel):
    progress: int
    status: str


def _set_generation_progress(
    progress_id: str, progress: int, status: str = "processing"
) -> None:
    now = time.monotonic()
    expired = [
        key for key, (_, _, updated_at) in _generation_progress.items()
        if now - updated_at > 3600
    ]
    for key in expired:
        del _generation_progress[key]
    _generation_progress[progress_id] = (progress, status, now)


def _session_root(session_id: str) -> Path:
    if not SESSION_RE.fullmatch(session_id):
        raise HTTPException(status_code=400, detail="Invalid processing session ID.")
    return TEMP_ROOT / f"session_{session_id}"


def _new_workspace(session_id: str) -> tuple[Path, Path]:
    root = _session_root(session_id)
    workspace = root / str(uuid.uuid4())
    workspace.mkdir(parents=True, exist_ok=False)
    return root, workspace


def _remove_workspace(root: Path, workspace: Path) -> None:
    try:
        shutil.rmtree(workspace, ignore_errors=False)
    except FileNotFoundError:
        pass
    try:
        root.rmdir()
    except OSError:
        pass


async def _save_upload(
    upload: UploadFile,
    destination: Path,
    max_bytes: int = MAX_UPLOAD_BYTES,
    progress_callback: Callable[[int], None] | None = None,
) -> None:
    size = 0
    with destination.open("wb") as target:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"Upload exceeds the {max_bytes // (1024 * 1024)} MB server limit.",
                )
            target.write(chunk)
            if progress_callback is not None and upload.size:
                progress_callback(round(size / upload.size * 20))
    if size == 0:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")


def _parse_srt(content: str) -> list[dict[str, str]]:
    normalized = content.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    normalized = re.sub(r"^WEBVTT[^\n]*\n", "", normalized, flags=re.IGNORECASE)
    cues = []
    for block in re.split(r"\n\s*\n", normalized.strip()):
        lines = block.split("\n")
        time_index = next(
            (index for index, line in enumerate(lines) if TIME_RE.search(line)), None
        )
        if time_index is None:
            continue
        match = TIME_RE.search(lines[time_index])
        if match is None:
            continue
        start = match.group(1).replace(".", ",")
        end = match.group(2).replace(".", ",")
        if start.count(":") == 1:
            start = f"00:{start}"
        if end.count(":") == 1:
            end = f"00:{end}"
        cues.append(
            {
                "start": start,
                "end": end,
                "text": "\n".join(lines[time_index + 1 :]).strip(),
            }
        )
    return cues


def _to_seconds(timestamp: str) -> float:
    hours, minutes, remainder = timestamp.replace(",", ".").split(":")
    seconds, milliseconds = remainder.split(".")
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(milliseconds) / 1000


def _format_srt_timestamp(seconds: float) -> str:
    milliseconds = round(seconds * 1000)
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{whole_seconds:02},{milliseconds:03}"


def _load_asr_pipeline():
    from transformers import pipeline

    device = 0 if torch.cuda.is_available() else -1
    return pipeline(
        "automatic-speech-recognition",
        model=WHISPER_MODEL,
        chunk_length_s=30,
        device=device,
    )


async def _generate_srt(
    video_path: Path,
    duration: float,
    workspace: Path,
    progress_callback: Callable[[int], None],
) -> str:
    global _asr_pipeline
    cues = []
    chunk_duration = 5 * 60
    chunk_count = max(1, (int(duration) + chunk_duration - 1) // chunk_duration)
    progress_callback(22)
    async with _asr_lock:
        if _asr_pipeline is None:
            try:
                _asr_pipeline = await asyncio.to_thread(_load_asr_pipeline)
            except Exception as error:
                logger.exception("Could not load speech recognition model")
                raise HTTPException(
                    status_code=503,
                    detail=f"Could not load speech recognition model {WHISPER_MODEL}: {error}",
                ) from error

        progress_callback(30)
        for chunk_index, offset in enumerate(range(0, int(duration) + 1, chunk_duration)):
            if offset >= duration:
                break
            audio_path = workspace / f"audio_{chunk_index:05d}.wav"
            segment_duration = min(chunk_duration, duration - offset)
            _run(
                [
                    "ffmpeg",
                    "-y",
                    "-nostdin",
                    "-loglevel",
                    "error",
                    "-ss",
                    str(offset),
                    "-i",
                    str(video_path),
                    "-t",
                    f"{segment_duration:.3f}",
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    str(audio_path),
                ],
                "Audio extraction",
            )
            try:
                result = await asyncio.to_thread(
                    _asr_pipeline,
                    str(audio_path),
                    return_timestamps=True,
                    generate_kwargs={"task": "transcribe"},
                )
            except Exception as error:
                logger.exception("Speech recognition failed for audio segment %s", chunk_index + 1)
                raise HTTPException(
                    status_code=500,
                    detail=f"Speech recognition failed for audio segment {chunk_index + 1}: {error}",
                ) from error

            for chunk in result.get("chunks", []):
                text = chunk.get("text", "").strip()
                timestamp = chunk.get("timestamp")
                if not text or not timestamp or timestamp[0] is None:
                    continue
                start = offset + max(0.0, float(timestamp[0]))
                end_value = timestamp[1]
                end = offset + (
                    float(end_value) if end_value is not None else segment_duration
                )
                end = min(end, duration)
                if end <= start:
                    continue
                cues.append(
                    f"{len(cues) + 1}\n{_format_srt_timestamp(start)} --> "
                    f"{_format_srt_timestamp(end)}\n{text}"
                )
            progress_callback(30 + round((chunk_index + 1) / chunk_count * 65))

    if not cues:
        raise HTTPException(status_code=400, detail="No speech was detected in the video.")
    return "\n\n".join(cues) + "\n"


async def _translate_cues(cues: list[dict[str, str]], source_language: str) -> str:
    global _model, _tokenizer
    if _model is None or _tokenizer is None:
        async with _model_lock:
            if _model is None or _tokenizer is None:
                try:
                    tokenizer = AutoTokenizer.from_pretrained(
                        MODEL_NAME, src_lang=source_language
                    )
                    model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_NAME)
                    if torch.cuda.is_available():
                        model = model.to("cuda")
                    _tokenizer, _model = tokenizer, model
                except Exception as error:
                    logger.exception("Could not load NLLB model")
                    raise HTTPException(
                        status_code=503,
                        detail=f"Could not load translation model {MODEL_NAME}: {error}",
                    ) from error

    translated = []
    async with _model_lock:
        try:
            _tokenizer.src_lang = source_language
            target_token = _tokenizer.convert_tokens_to_ids(TARGET_LANGUAGE)
            if target_token == _tokenizer.unk_token_id:
                raise RuntimeError(f"Tokenizer does not recognize {TARGET_LANGUAGE}.")
            for cue in cues:
                text = cue["text"]
                if text.strip():
                    inputs = _tokenizer(
                        text,
                        return_tensors="pt",
                        truncation=True,
                        max_length=512,
                    )
                    inputs = {key: value.to(_model.device) for key, value in inputs.items()}
                    with torch.inference_mode():
                        generated = _model.generate(
                            **inputs,
                            forced_bos_token_id=target_token,
                            max_new_tokens=256,
                        )
                    text = _tokenizer.batch_decode(
                        generated, skip_special_tokens=True
                    )[0]
                translated.append(
                    f"{len(translated) + 1}\n{cue['start']} --> {cue['end']}\n{text}"
                )
        except HTTPException:
            raise
        except Exception as error:
            logger.exception("NLLB subtitle translation failed")
            raise HTTPException(
                status_code=500, detail=f"Subtitle translation failed: {error}"
            ) from error
    return "\n\n".join(translated) + "\n"


def _run(command: list[str], operation: str) -> str:
    try:
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=60 * 60,
        )
        return completed.stdout.strip()
    except FileNotFoundError as error:
        raise HTTPException(
            status_code=503, detail=f"{operation} requires FFmpeg and ffprobe on PATH."
        ) from error
    except subprocess.TimeoutExpired as error:
        raise HTTPException(status_code=504, detail=f"{operation} exceeded its time limit.") from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip()[-1200:] if error.stderr else str(error)
        logger.error("%s failed: %s", operation, detail)
        raise HTTPException(status_code=500, detail=f"{operation} failed: {detail}") from error


def _probe_video(video_path: Path) -> tuple[float, bool]:
    payload = _run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type",
            "-of",
            "default=noprint_wrappers=1",
            str(video_path),
        ],
        "Video inspection",
    )
    duration = None
    has_audio = False
    for line in payload.splitlines():
        if line.startswith("duration="):
            try:
                duration = float(line.split("=", 1)[1])
            except ValueError:
                continue
        if line.partition("=")[2].strip() == "audio":
            has_audio = True
    if duration is None or duration <= 0:
        raise HTTPException(status_code=400, detail="Could not determine the video duration.")
    return duration, has_audio


async def _synthesize_cues(
    cues: list[dict[str, str]], voice: str, speed: float, workspace: Path
) -> list[tuple[Path, int]]:
    rate_percent = round((speed - 1) * 100)
    rate = f"{rate_percent:+d}%"
    synthesized = []
    for index, cue in enumerate(cues):
        text = re.sub(r"\s+", " ", cue["text"]).strip()
        if not text:
            continue
        segment_path = workspace / f"segment_{index:05d}.mp3"
        try:
            await edge_tts.Communicate(text, voice, rate=rate).save(str(segment_path))
        except Exception as error:
            logger.exception("Khmer text-to-speech failed for cue %s", index + 1)
            raise HTTPException(
                status_code=502, detail=f"Khmer voice generation failed at cue {index + 1}: {error}"
            ) from error
        synthesized.append((segment_path, round(_to_seconds(cue["start"]) * 1000)))
    if not synthesized:
        raise HTTPException(status_code=400, detail="No translated subtitle text is available to dub.")
    return synthesized


async def _create_audio_mix(
    video_path: Path,
    cues: list[dict[str, str]],
    voice: str,
    speed: float,
    keep_background_audio: bool,
    workspace: Path,
) -> tuple[Path, Path, float]:
    duration, has_background = _probe_video(video_path)
    segments = await _synthesize_cues(cues, voice, speed, workspace)
    output_audio = workspace / "khmer-audio.mp3"
    command = ["ffmpeg", "-y", "-nostdin", "-loglevel", "error"]
    for segment_path, _ in segments:
        command.extend(["-i", str(segment_path)])
    filters = []
    mix_inputs = []
    for index, (_, delay_ms) in enumerate(segments):
        filters.append(f"[{index}:a]adelay={delay_ms}|{delay_ms}[a{index}]")
        mix_inputs.append(f"[a{index}]")
    filters.append(
        f"{''.join(mix_inputs)}amix=inputs={len(segments)}:duration=longest:"
        f"dropout_transition=0:normalize=0,apad,atrim=duration={duration:.3f}[dub]"
    )
    command.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[dub]",
            "-t",
            f"{duration:.3f}",
            "-c:a",
            "libmp3lame",
            "-q:a",
            "3",
            str(output_audio),
        ]
    )
    _run(command, "Khmer audio synchronization")

    output_video = workspace / "khmer-dubbed.mp4"
    if keep_background_audio and has_background:
        video_command = [
            "ffmpeg",
            "-y",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            str(video_path),
            "-i",
            str(output_audio),
            "-filter_complex",
            f"[0:a:0]volume=0.2,apad[bg];[bg][1:a:0]amix=inputs=2:duration=longest:"
            f"dropout_transition=0:normalize=0,atrim=duration={duration:.3f}[mix]",
            "-map",
            "0:v:0",
            "-map",
            "[mix]",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-t",
            f"{duration:.3f}",
            "-movflags",
            "+faststart",
            str(output_video),
        ]
    else:
        video_command = [
            "ffmpeg",
            "-y",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            str(video_path),
            "-i",
            str(output_audio),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-t",
            f"{duration:.3f}",
            "-movflags",
            "+faststart",
            str(output_video),
        ]
    _run(video_command, "Dubbed video export")
    return output_audio, output_video, duration


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL_NAME, "target_language": TARGET_LANGUAGE}


@app.post("/translate", response_model=TranslationResponse)
async def translate(
    srt_file: UploadFile = File(...),
    source_lang: str = Form(...),
    session_id: str = Form(...),
):
    if source_lang not in LANGUAGES:
        raise HTTPException(status_code=400, detail="Unsupported NLLB source language.")
    root, workspace = _new_workspace(session_id)
    try:
        source_path = workspace / "source.srt"
        await _save_upload(srt_file, source_path)
        content = source_path.read_text(encoding="utf-8-sig")
        cues = _parse_srt(content)
        if not cues:
            raise HTTPException(status_code=400, detail="No valid SRT or VTT subtitle cues were found.")
        translated = await _translate_cues(cues, source_lang)
        return TranslationResponse(translated_srt=translated)
    finally:
        _remove_workspace(root, workspace)


@app.post("/generate-subtitles", response_model=SubtitleGenerationResponse)
async def generate_subtitles(
    video_file: UploadFile = File(...),
    session_id: str = Form(...),
    progress_id: str = Form(...),
):
    try:
        uuid.UUID(progress_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid subtitle generation progress ID.") from error
    _set_generation_progress(progress_id, 0)
    workspace_paths = None
    try:
        workspace_paths = _new_workspace(session_id)
        _, workspace = workspace_paths
        video_path = workspace / "input_video"
        await _save_upload(
            video_file,
            video_path,
            MAX_VIDEO_UPLOAD_BYTES,
            lambda value: _set_generation_progress(progress_id, value),
        )
        duration, has_audio = _probe_video(video_path)
        if not has_audio:
            raise HTTPException(status_code=400, detail="The uploaded video has no audio track.")
        generated_srt = await _generate_srt(
            video_path,
            duration,
            workspace,
            lambda value: _set_generation_progress(progress_id, value),
        )
        _set_generation_progress(progress_id, 100, "complete")
        return SubtitleGenerationResponse(generated_srt=generated_srt)
    except Exception:
        _set_generation_progress(progress_id, 0, "failed")
        raise
    finally:
        if workspace_paths is not None:
            _remove_workspace(*workspace_paths)


@app.get(
    "/generate-subtitles/progress/{progress_id}",
    response_model=SubtitleGenerationProgressResponse,
)
async def get_subtitle_generation_progress(progress_id: str):
    try:
        uuid.UUID(progress_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid subtitle generation progress ID.") from error
    record = _generation_progress.get(progress_id)
    if record is None or time.monotonic() - record[2] > 3600:
        raise HTTPException(status_code=404, detail="Subtitle generation progress was not found.")
    return SubtitleGenerationProgressResponse(progress=record[0], status=record[1])


@app.post("/dub")
async def dub(
    video_file: UploadFile = File(...),
    translated_srt: str = Form(...),
    voice: str = Form(...),
    speed: float = Form(...),
    keep_background_audio: bool = Form(True),
    session_id: str = Form(...),
):
    if voice not in VOICES:
        raise HTTPException(status_code=400, detail="Unsupported Khmer voice.")
    if speed < 0.8 or speed > 1.5:
        raise HTTPException(status_code=400, detail="Speaking speed must be between 0.8x and 1.5x.")
    cues = _parse_srt(translated_srt)
    if not cues:
        raise HTTPException(status_code=400, detail="No valid translated subtitle cues were provided.")
    root, workspace = _new_workspace(session_id)
    try:
        video_path = workspace / "input_video"
        await _save_upload(video_file, video_path, MAX_VIDEO_UPLOAD_BYTES)
        audio_path, dubbed_video_path, _ = await _create_audio_mix(
            video_path,
            cues,
            voice,
            speed,
            keep_background_audio,
            workspace,
        )
        archive_path = workspace / "exports.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.write(audio_path, "khmer-audio.mp3")
            archive.write(dubbed_video_path, "khmer-dubbed.mp4")
        return FileResponse(
            archive_path,
            media_type="application/zip",
            filename="khmer-exports.zip",
            background=BackgroundTask(_remove_workspace, root, workspace),
        )
    except Exception:
        _remove_workspace(root, workspace)
        raise


@app.post("/cleanup")
async def cleanup(session_id: str = Form(...)):
    root = _session_root(session_id)
    try:
        if root.exists():
            await asyncio.to_thread(shutil.rmtree, root)
    except FileNotFoundError:
        pass
    except OSError as error:
        logger.exception("Could not clean temporary session files")
        raise HTTPException(status_code=500, detail="Temporary files could not be cleaned.") from error
    return {"status": "cleaned"}


@app.on_event("startup")
async def ensure_temp_root():
    TEMP_ROOT.mkdir(parents=True, exist_ok=True)
