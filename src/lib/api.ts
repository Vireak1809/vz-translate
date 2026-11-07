import type { Voice } from "@/lib/types";
import JSZip from "jszip";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
export const MAX_VIDEO_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

async function fetchApi(path: string, body: FormData) {
  try {
    return await fetch(`${API_URL}${path}`, { method: "POST", body });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        `Cannot connect to the backend at ${API_URL}. Start the FastAPI service and try again.`,
      );
    }
    throw error;
  }
}

async function request<T>(path: string, body: FormData): Promise<T> {
  const response = await fetchApi(path, body);
  if (!response.ok) {
    let message = `Processing failed (${response.status})`;
    try {
      const payload = (await response.json()) as { detail?: string };
      message = payload.detail ?? message;
    } catch {
      // The response body may not be JSON.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function translateSrt(
  srt: string,
  sourceLang: string,
  sessionId: string,
) {
  const body = new FormData();
  body.set("srt_file", new Blob([srt], { type: "text/plain" }), "subtitles.srt");
  body.set("source_lang", sourceLang);
  body.set("session_id", sessionId);
  return request<{ translated_srt: string }>("/translate", body);
}

export async function generateSubtitles(
  video: File,
  sessionId: string,
  onProgress: (progress: number) => void,
) {
  const progressId = crypto.randomUUID();
  const body = new FormData();
  body.set("video_file", video);
  body.set("session_id", sessionId);
  body.set("progress_id", progressId);

  return new Promise<{ generated_srt: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let pollTimer: number | undefined;

    const finish = (error?: Error, result?: { generated_srt: string }) => {
      if (settled) return;
      settled = true;
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("Subtitle generation returned an empty response."));
    };

    const pollProgress = async () => {
      if (settled) return;
      try {
        const response = await fetch(
          `${API_URL}/generate-subtitles/progress/${encodeURIComponent(progressId)}`,
        );
        if (response.ok) {
          const status = (await response.json()) as { progress: number; status: string };
          if (!Number.isInteger(status.progress) || status.progress < 0 || status.progress > 100) {
            throw new Error("The backend returned an invalid subtitle generation progress value.");
          }
          onProgress(status.progress);
        } else if (response.status !== 404) {
          throw new Error(`Could not read generation progress (${response.status}).`);
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Could not read subtitle generation progress."));
        xhr.abort();
        return;
      }
      if (!settled) pollTimer = window.setTimeout(() => void pollProgress(), 500);
    };

    xhr.open("POST", `${API_URL}/generate-subtitles`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 20));
      }
    };
    xhr.upload.onload = () => void pollProgress();
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        const payload = xhr.response as { detail?: string } | null;
        finish(new Error(payload?.detail ?? `Subtitle generation failed (${xhr.status}).`));
        return;
      }
      if (
        typeof xhr.response !== "object"
        || xhr.response === null
        || typeof (xhr.response as { generated_srt?: unknown }).generated_srt !== "string"
      ) {
        finish(new Error("The backend returned an invalid subtitle generation response."));
        return;
      }
      onProgress(100);
      finish(undefined, xhr.response as { generated_srt: string });
    };
    xhr.onerror = () => {
      finish(new Error(`Cannot connect to the backend at ${API_URL}. Start the FastAPI service and try again.`));
    };
    xhr.onabort = () => {
      if (!settled) finish(new Error("Subtitle generation was interrupted."));
    };
    xhr.send(body);
  });
}

export async function createDub(
  video: File,
  srt: string,
  voice: Voice,
  speed: number,
  keepBackgroundAudio: boolean,
  sessionId: string,
) {
  const body = new FormData();
  body.set("video_file", video);
  body.set("translated_srt", srt);
  body.set("voice", voice);
  body.set("speed", String(speed));
  body.set("keep_background_audio", String(keepBackgroundAudio));
  body.set("session_id", sessionId);
  const response = await fetchApi("/dub", body);
  if (!response.ok) {
    let message = `Dubbing failed (${response.status})`;
    try {
      const payload = (await response.json()) as { detail?: string };
      message = payload.detail ?? message;
    } catch {
      // The response body may not be JSON.
    }
    throw new Error(message);
  }
  const archive = await JSZip.loadAsync(await response.blob());
  const audioFile = archive.file("khmer-audio.mp3");
  if (!audioFile) throw new Error("The dubbing response did not contain an audio track.");
  const audio = await audioFile.async("blob");
  const videoFile = archive.file("khmer-dubbed.mp4");
  const dubbedVideo = videoFile ? await videoFile.async("blob") : null;
  return { audio, video: dubbedVideo };
}

export function cleanupSessionBeacon() {
  const sessionId = sessionStorage.getItem("processing_session_id");
  if (!sessionId) return;
  const data = new FormData();
  data.set("session_id", sessionId);
  navigator.sendBeacon(`${API_URL}/cleanup`, data);
}
