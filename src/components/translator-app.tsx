"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useDropzone } from "react-dropzone";
import {
  beginTabSession,
  clearAudio,
  clearDubbedVideo,
  clearProjectData,
  loadProject,
  saveAudio,
  saveDubbedVideo,
  saveProject,
  saveSubtitles,
  saveVideo,
} from "@/lib/db";
import {
  cleanupSessionBeacon,
  createDub,
  generateSubtitles,
  MAX_VIDEO_UPLOAD_BYTES,
  translateSrt,
} from "@/lib/api";
import { guessLanguage, parseSubtitles, serializeSrt, SOURCE_LANGUAGES } from "@/lib/srt";
import { useAppStore } from "@/lib/store";
import type { AppStep, SubtitleSegment, Voice } from "@/lib/types";

const STEPS: { id: AppStep; name: string; hint: string }[] = [
  { id: "upload", name: "Upload", hint: "Add your files" },
  { id: "translate", name: "Translate", hint: "Edit subtitles" },
  { id: "dub", name: "Dub", hint: "Create a voice track" },
  { id: "export", name: "Export", hint: "Download your work" },
];

const PIPELINE_STEPS = [
  "Extract audio",
  "Generate Khmer voice per segment",
  "Sync to subtitle timings",
  "Mix background audio",
  "Export video and audio",
];

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getSessionId() {
  const value = sessionStorage.getItem("processing_session_id");
  if (!value) throw new Error("The browser session is not ready. Refresh and try again.");
  return value;
}

const VIDEO_ACCEPT = {
  "video/mp4": [".mp4"],
  "video/x-matroska": [".mkv"],
  "video/quicktime": [".mov"],
  "video/webm": [".webm"],
} as const;

const SUBTITLE_ACCEPT = {
  "application/x-subrip": [".srt"],
  "text/plain": [".srt"],
  "text/vtt": [".vtt"],
} as const;

function DropArea({
  type,
  file,
  onFile,
  onError,
}: {
  type: "video" | "subtitle";
  file: File | null;
  onFile: (file: File) => void;
  onError: (message: string) => void;
}) {
  const accept = type === "video" ? VIDEO_ACCEPT : SUBTITLE_ACCEPT;
  const onDrop = useCallback(
    (files: File[]) => {
      if (files[0]) onFile(files[0]);
    },
    [onFile],
  );
  const onDropRejected = useCallback(
    () =>
      onError(
        type === "video"
          ? "Choose an MP4, MKV, MOV, or WebM video."
          : "Choose an SRT or VTT subtitle file.",
      ),
    [onError, type],
  );
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept,
    maxFiles: 1,
    multiple: false,
    noClick: true,
    onDrop,
    onDropRejected,
  });

  return (
    <div {...getRootProps({ className: `dropzone${isDragActive ? " dragging" : ""}` })}>
      <input {...getInputProps()} />
      {file ? (
        <div className="file-card">
          <div className="file-icon">{type === "video" ? "▶" : "≡"}</div>
          <div className="file-info">
            <div className="file-name">{file.name}</div>
            <div className="file-meta">{formatSize(file.size)} · Ready to use</div>
          </div>
          <span className="check-mark">✓</span>
          <button type="button" className="drop-button" onClick={open}>Replace</button>
        </div>
      ) : (
        <>
          <div className="drop-icon">{type === "video" ? "▶" : "▤"}</div>
          <div className="drop-title">
            {isDragActive
              ? "Drop your file here"
              : type === "video"
                ? "Drop your video here"
                : "Drop your subtitle file here"}
          </div>
          <div className="drop-copy">or browse files from your device</div>
          <button type="button" className="drop-button" onClick={open}>
            Browse {type === "video" ? "video" : "subtitles"}
          </button>
          <div className="accepted-types">
            {type === "video" ? "MP4 · MKV · MOV · WebM" : "SRT · VTT"}
          </div>
        </>
      )}
    </div>
  );
}

export function TranslatorApp() {
  const ready = useAppStore((state) => state.ready);
  const projectId = useAppStore((state) => state.projectId);
  const project = useAppStore((state) => state.project);
  const video = useAppStore((state) => state.video);
  const originalSrt = useAppStore((state) => state.originalSrt);
  const segments = useAppStore((state) => state.segments);
  const audio = useAppStore((state) => state.audio);
  const step = useAppStore((state) => state.step);
  const setReady = useAppStore((state) => state.setReady);
  const setProject = useAppStore((state) => state.setProject);
  const setVideo = useAppStore((state) => state.setVideo);
  const setSubtitles = useAppStore((state) => state.setSubtitles);
  const setAudio = useAppStore((state) => state.setAudio);
  const setStep = useAppStore((state) => state.setStep);

  const [pageError, setPageError] = useState("");
  const [working, setWorking] = useState(false);
  const [dubEnabled, setDubEnabled] = useState(true);
  const [voice, setVoice] = useState<Voice>("km-KH-PisethNeural");
  const [speed, setSpeed] = useState(1);
  const [keepBackgroundAudio, setKeepBackgroundAudio] = useState(true);
  const [progress, setProgress] = useState(0);
  const [videoUrl, setVideoUrl] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [generationProgress, setGenerationProgress] = useState<number | null>(null);
  const progressTimer = useRef<number | null>(null);
  const subtitleVideoInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const id = await beginTabSession();
        const saved = await loadProject(id);
        if (!active) return;
        if (saved.project) setProject(saved.project);
        if (saved.video) {
          setVideo({
            blob: saved.video.blob,
            name: saved.video.name,
            dubbedBlob: saved.video.dubbedBlob,
            dubbedName: saved.video.dubbedName,
          });
        }
        if (saved.subtitles) {
          setSubtitles(saved.subtitles.original, saved.subtitles.segments);
        }
        setAudio(saved.audio?.blob ?? null);
        setReady(id);
      } catch (error) {
        if (active) {
          setPageError(
            error instanceof Error ? error.message : "Could not initialize local storage.",
          );
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [setAudio, setProject, setReady, setSubtitles, setVideo]);

  useEffect(() => {
    if (!ready) return;
    const handlePageHide = () => cleanupSessionBeacon();
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [ready]);

  useEffect(() => {
    const urls: string[] = [];
    if (video?.dubbedBlob) {
      const url = URL.createObjectURL(video.dubbedBlob);
      urls.push(url);
      setVideoUrl(url);
    } else {
      setVideoUrl("");
    }
    if (audio) {
      const url = URL.createObjectURL(audio);
      urls.push(url);
      setAudioUrl(url);
    } else {
      setAudioUrl("");
    }
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [audio, video?.dubbedBlob]);

  useEffect(
    () => () => {
      if (progressTimer.current !== null) window.clearInterval(progressTimer.current);
    },
    [],
  );

  const videoFile = useMemo(
    () =>
      video
        ? new File([video.blob], video.name, { type: video.blob.type || "video/mp4" })
        : null,
    [video],
  );

  const handleVideo = useCallback(
    async (file: File) => {
      if (!projectId) return;
      if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
        setPageError("Video uploads must be 2 GB or smaller.");
        return;
      }
      try {
        setPageError("");
        await saveVideo(projectId, file);
        await clearAudio(projectId);
        setVideo({ blob: file, name: file.name });
        setAudio(null);
      } catch (error) {
        setPageError(error instanceof Error ? error.message : "Could not save the video.");
      }
    },
    [projectId, setAudio, setVideo],
  );

  const handleGenerateSubtitles = useCallback(
    async (file: File) => {
      if (!projectId || !project) return;
      if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
        setPageError("Video uploads must be 2 GB or smaller.");
        return;
      }
      setWorking(true);
      setGenerationProgress(0);
      setPageError("");
      try {
        const response = await generateSubtitles(file, getSessionId(), setGenerationProgress);
        const parsed = parseSubtitles(response.generated_srt);
        if (parsed.length === 0) {
          throw new Error("No speech was detected in the video.");
        }
        const updatedProject = {
          ...project,
          name: file.name.replace(/\.[^.]+$/, ""),
          sourceLang: guessLanguage(response.generated_srt),
        };
        await Promise.all([
          saveVideo(projectId, file),
          saveProject(updatedProject),
          saveSubtitles(projectId, response.generated_srt, parsed),
          clearAudio(projectId),
        ]);
        setVideo({ blob: file, name: file.name });
        setProject(updatedProject);
        setSubtitles(response.generated_srt, parsed);
        setAudio(null);
        setStep("translate");
      } catch (error) {
        setPageError(error instanceof Error ? error.message : "Could not generate subtitles.");
      } finally {
        setGenerationProgress(null);
        setWorking(false);
      }
    },
    [project, projectId, setAudio, setProject, setStep, setSubtitles, setVideo],
  );

  const handleSubtitle = useCallback(
    async (file: File) => {
      if (!projectId || !project) return;
      try {
        const text = await file.text();
        const parsed = parseSubtitles(text);
        if (parsed.length === 0) {
          setPageError("No valid subtitle cues were found. Check that the file is a valid SRT or VTT.");
          return;
        }
        const sourceLang = guessLanguage(text);
        const updatedProject = {
          ...project,
          name: file.name.replace(/\.(srt|vtt)$/i, ""),
          sourceLang,
        };
        await Promise.all([
          saveProject(updatedProject),
          saveSubtitles(projectId, text, parsed),
          clearAudio(projectId),
          clearDubbedVideo(projectId),
        ]);
        setProject(updatedProject);
        setSubtitles(text, parsed);
        setAudio(null);
        if (video) setVideo({ blob: video.blob, name: video.name });
        setPageError("");
      } catch (error) {
        setPageError(error instanceof Error ? error.message : "Could not read the subtitle file.");
      }
    },
    [project, projectId, setAudio, setProject, setSubtitles, setVideo, video],
  );

  const changeLanguage = async (sourceLang: string) => {
    if (!project || !projectId) return;
    const updated = { ...project, sourceLang };
    setProject(updated);
    try {
      const cleared = segments.map((segment) => ({ ...segment, translation: "" }));
      await Promise.all([
        saveProject(updated),
        saveSubtitles(projectId, originalSrt, cleared),
        clearAudio(projectId),
        clearDubbedVideo(projectId),
      ]);
      setSubtitles(originalSrt, cleared);
      setAudio(null);
      if (video) setVideo({ blob: video.blob, name: video.name });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not save the language choice.");
    }
  };

  const handleTranslationEdit = (id: number, translation: string) => {
    const updated = segments.map((segment) =>
      segment.id === id ? { ...segment, translation } : segment,
    );
    setSubtitles(originalSrt, updated);
    if (projectId && originalSrt) {
      void saveSubtitles(projectId, originalSrt, updated).catch((error: unknown) => {
        setPageError(error instanceof Error ? `Could not save subtitles: ${error.message}` : "Could not save subtitles.");
      });
    }
    if (projectId && (audio || video?.dubbedBlob)) {
      void Promise.all([clearAudio(projectId), clearDubbedVideo(projectId)]).catch((error: unknown) => {
        setPageError(error instanceof Error ? `Could not clear the outdated dub: ${error.message}` : "Could not clear the outdated dub.");
      });
      setAudio(null);
      if (video) setVideo({ blob: video.blob, name: video.name });
    }
  };

  const startNewProject = async () => {
    if (!projectId) return;
    try {
      await clearProjectData(projectId);
      const newProject = {
        id: projectId,
        name: "Untitled project",
        createdAt: new Date().toISOString(),
        sourceLang: "eng_Latn",
      };
      await saveProject(newProject);
      setProject(newProject);
      setVideo(null);
      setSubtitles("", []);
      setAudio(null);
      setProgress(0);
      setPageError("");
      setStep("upload");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Could not start a new project.");
    }
  };

  const runTranslation = async () => {
    if (!projectId || !originalSrt || !project || !segments.length) return;
    setWorking(true);
    setPageError("");
    try {
      const response = await translateSrt(originalSrt, project.sourceLang, getSessionId());
      const translated = parseSubtitles(response.translated_srt);
      if (translated.length !== segments.length) {
        throw new Error("The translation response did not match the subtitle cue count.");
      }
      const updated: SubtitleSegment[] = segments.map((segment, index) => ({
        ...segment,
        translation: translated[index].original,
      }));
      if (audio || video?.dubbedBlob) {
        await Promise.all([clearAudio(projectId), clearDubbedVideo(projectId)]);
        setAudio(null);
        if (video) setVideo({ blob: video.blob, name: video.name });
      }
      setSubtitles(originalSrt, updated);
      await saveSubtitles(projectId, originalSrt, updated);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : "Translation could not be completed.");
    } finally {
      setWorking(false);
    }
  };

  const runDubbing = async () => {
    if (!projectId || !videoFile || !dubEnabled) return;
    if (segments.some((segment) => !segment.translation.trim())) {
      setPageError("Translate all subtitle cues before starting the dub.");
      return;
    }
    setWorking(true);
    setProgress(3);
    setPageError("");
    progressTimer.current = window.setInterval(() => {
      setProgress((current) => Math.min(current + 1.4, 94));
    }, 800);
    try {
      const result = await createDub(
        videoFile,
        serializeSrt(segments),
        voice,
        speed,
        keepBackgroundAudio,
        getSessionId(),
      );
      await saveAudio(projectId, result.audio);
      setAudio(result.audio);
      if (result.video) {
        await saveDubbedVideo(projectId, result.video);
        setVideo({ blob: videoFile, name: videoFile.name, dubbedBlob: result.video, dubbedName: "khmer-dubbed.mp4" });
      }
      if (progressTimer.current !== null) window.clearInterval(progressTimer.current);
      progressTimer.current = null;
      setProgress(100);
    } catch (error) {
      if (progressTimer.current !== null) window.clearInterval(progressTimer.current);
      progressTimer.current = null;
      setProgress(0);
      setPageError(error instanceof Error ? error.message : "The dubbing process could not be completed.");
    } finally {
      setWorking(false);
    }
  };

  const canTranslate = segments.length > 0;
  const canDub = Boolean(video && canTranslate && segments.every((segment) => segment.translation.trim()));
  const canExportSrt = segments.some((segment) => segment.translation.trim());
  const canExportOriginalSrt = segments.some((segment) => segment.original.trim());
  const currentStepIndex = STEPS.findIndex((item) => item.id === step);
  const estimatedSeconds = video ? Math.max(30, Math.ceil(video.blob.size / (1024 * 1024) * 1.4)) : 0;
  const stageIndex = progress >= 100 ? PIPELINE_STEPS.length : Math.min(
    PIPELINE_STEPS.length - 1,
    Math.floor((progress / 100) * PIPELINE_STEPS.length),
  );

  const goTo = (destination: AppStep) => {
    if (destination === "translate" && !canTranslate) return;
    if (destination === "dub" && !canTranslate) return;
    if (destination === "export" && !canExportOriginalSrt && !canExportSrt && !audio && !video?.dubbedBlob) return;
    setPageError("");
    setStep(destination);
  };

  if (!ready) {
    return (
      <main className="app-shell">
        <div className="warning-banner">⚠️ Data is temporary. Closing this tab will delete all uploads and translations.</div>
        <div className="loading">{pageError || "Opening your private workspace…"}</div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="warning-banner">
        <span>⚠️</span>
        <span>Data is temporary. Closing this tab will delete all uploads and translations.</span>
      </div>
      <header className="topbar">
        <div className="brand">
          <Image className="brand-mark" src="/v-logo.png" alt="V logo" width={38} height={38} priority />
          <div>
            <div className="brand-name">Khmer Subtitle Translator</div>
            <div className="brand-caption">Subtitles in. Khmer voices out.</div>
          </div>
        </div>
        <div className="topbar-actions">
          <input
            ref={subtitleVideoInput}
            className="visually-hidden"
            type="file"
            accept=".mp4,.mkv,.mov,.webm,video/mp4,video/x-matroska,video/quicktime,video/webm"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void handleGenerateSubtitles(file);
            }}
          />
          <button
            type="button"
            className="button"
            onClick={() => subtitleVideoInput.current?.click()}
            disabled={working}
          >
            {generationProgress === null ? "✦ Generate subtitles" : `Generating subtitles… ${generationProgress}%`}
          </button>
          {generationProgress !== null && (
            <div className="generation-progress">
              <span>{generationProgress}%</span>
              <div
                className="generation-progress-track"
                role="progressbar"
                aria-label="Subtitle generation progress"
                aria-valuenow={generationProgress}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className="generation-progress-fill" style={{ width: `${generationProgress}%` }} />
              </div>
            </div>
          )}
          <div className="local-badge"><span className="local-dot" />Private workspace</div>
        </div>
      </header>

      <div className="main-wrap">
        <div className="eyebrow">Your story, in Khmer</div>
        <h1 className="page-heading">Translate. Dub. Share.</h1>
        <p className="page-description">
          Turn your favorite films and dramas into Khmer, with editable subtitles and natural-sounding voice dubbing.
        </p>

        <nav className="steps" aria-label="Project steps">
          {STEPS.map((item, index) => {
            const completed = index < currentStepIndex;
            return (
              <button
                type="button"
                key={item.id}
                className={`step-item${step === item.id ? " active" : ""}${completed ? " done" : ""}`}
                onClick={() => goTo(item.id)}
                disabled={working}
                aria-current={step === item.id ? "step" : undefined}
              >
                <span className="step-number">{completed ? "✓" : index + 1}</span>
                <span><span className="step-name">{item.name}</span><span className="step-hint">{item.hint}</span></span>
              </button>
            );
          })}
        </nav>

        {pageError && <div className="error-box" role="alert">{pageError}</div>}

        {step === "upload" && (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2 className="panel-title">Start with your files</h2>
                <p className="panel-subtitle">Everything stays in this browser tab. Upload a video, subtitles, or both.</p>
              </div>
              <span className="local-badge"><span className="local-dot" />Saved in this tab</span>
            </div>
            <div className="upload-grid">
              <DropArea type="video" file={video ? new File([video.blob], video.name) : null} onFile={handleVideo} onError={setPageError} />
              <DropArea
                type="subtitle"
                file={originalSrt && project?.name ? new File([originalSrt], `${project.name}.srt`) : null}
                onFile={handleSubtitle}
                onError={setPageError}
              />
            </div>
            <div className="form-row" style={{ marginTop: 18 }}>
              <div>
                <div className="field-label">Subtitle language</div>
                <div className="field-help">Detected from your subtitle text. Change it if needed.</div>
              </div>
              <select
                className="select"
                value={project?.sourceLang ?? "eng_Latn"}
                onChange={(event) => void changeLanguage(event.target.value)}
                aria-label="Subtitle source language"
              >
                {SOURCE_LANGUAGES.map(([code, label]) => <option value={code} key={code}>{label}</option>)}
              </select>
            </div>
            <div className="panel-footer">
              <span className="estimate">
                {video
                  ? `${formatSize(video.blob.size)} video · Approx. ${Math.max(1, Math.ceil(estimatedSeconds / 60))} min processing`
                  : "Video uploads must be 2 GB or smaller."}
              </span>
              <button type="button" className="button" disabled={!canTranslate} onClick={() => goTo("translate")}>
                Continue to translation <span aria-hidden="true">→</span>
              </button>
            </div>
          </section>
        )}

        {step === "translate" && (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2 className="panel-title">Subtitle translation</h2>
                <p className="panel-subtitle">Review and edit every Khmer line before creating your dub.</p>
              </div>
              <div className="toolbar">
                <button type="button" className="button button-secondary" onClick={() => goTo("upload")}>← Files</button>
                <button type="button" className="button" disabled={!originalSrt || working} onClick={() => void runTranslation()}>
                  {working ? "Translating…" : "✦ Translate all"}
                </button>
              </div>
            </div>
            {segments.length === 0 ? (
              <div className="empty-state">Upload an SRT or VTT file to begin translating.</div>
            ) : (
              <>
                <div className="notice-box" style={{ marginBottom: 14 }}>
                  {segments.length} subtitle cues · Source language: {SOURCE_LANGUAGES.find(([code]) => code === project?.sourceLang)?.[1] ?? project?.sourceLang} · Translation is generated locally by the configured NLLB-200 model.
                </div>
                <div className="table-wrap">
                  <table className="subtitle-table">
                    <thead>
                      <tr><th>#</th><th>Start</th><th>End</th><th>Original text</th><th>Khmer translation · editable</th></tr>
                    </thead>
                    <tbody>
                      {segments.map((segment) => (
                        <tr key={segment.id}>
                          <td className="number-cell">{segment.id}</td>
                          <td className="time-cell">{segment.start}</td>
                          <td className="time-cell">{segment.end}</td>
                          <td>{segment.original || <span style={{ color: "#a1aaa4" }}>(no dialogue)</span>}</td>
                          <td>
                            <textarea
                              className="translation-input"
                              lang="km"
                              aria-label={`Khmer translation for subtitle ${segment.id}`}
                              value={segment.translation}
                              onChange={(event) => handleTranslationEdit(segment.id, event.target.value)}
                              disabled={working}
                              placeholder="Translation will appear here…"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div className="panel-footer">
              <span className="estimate">Your edits are saved automatically in this tab.</span>
              <button type="button" className="button" disabled={!canTranslate} onClick={() => goTo("dub")}>
                Continue to dubbing <span aria-hidden="true">→</span>
              </button>
            </div>
          </section>
        )}

        {step === "dub" && (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2 className="panel-title">Give your story a Khmer voice</h2>
                <p className="panel-subtitle">Dubbing is optional. Your subtitle translation is always available to export.</p>
              </div>
              <button type="button" className="button button-secondary" onClick={() => goTo("translate")}>← Subtitles</button>
            </div>
            <div className="dub-layout">
              <div>
                <div className="switch-row">
                  <div><div className="field-label">Enable voice dubbing</div><div className="field-help">Generate a Khmer voice track from your translations</div></div>
                  <button type="button" className={`switch${dubEnabled ? " on" : ""}`} onClick={() => setDubEnabled((enabled) => !enabled)} aria-label="Toggle voice dubbing" aria-pressed={dubEnabled} />
                </div>
                <div className="form-row">
                  <div><div className="field-label">Khmer voice</div><div className="field-help">Choose a voice for the narration</div></div>
                  <select className="select" value={voice} onChange={(event) => setVoice(event.target.value as Voice)} disabled={!dubEnabled}>
                    <option value="km-KH-PisethNeural">Piseth · Male</option>
                    <option value="km-KH-SreymomNeural">Sreymom · Female</option>
                  </select>
                </div>
                <div className="form-row">
                  <div><div className="field-label">Speaking speed</div><div className="field-help">Adjust the pace of Khmer voice segments</div></div>
                  <div className="range-wrap">
                    <input type="range" min="0.8" max="1.5" step="0.1" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} disabled={!dubEnabled} aria-label="Speaking speed" />
                    <span className="range-value">{speed.toFixed(1)}×</span>
                  </div>
                </div>
                <div className="switch-row">
                  <div><div className="field-label">Keep original background audio</div><div className="field-help">Mix the original soundtrack at 20% volume</div></div>
                  <button type="button" className={`switch${keepBackgroundAudio ? " on" : ""}`} onClick={() => setKeepBackgroundAudio((enabled) => !enabled)} aria-label="Toggle background audio" aria-pressed={keepBackgroundAudio} disabled={!dubEnabled} />
                </div>
                <div className="panel-footer">
                  <span className="estimate">{audio ? "A Khmer audio track is ready." : "Create the dub when your translations are ready."}</span>
                  <button type="button" className="button" disabled={!canDub || !dubEnabled || working} onClick={() => void runDubbing()}>
                    {working ? "Creating your dub…" : audio ? "Regenerate dub" : "Create Khmer dub"}
                  </button>
                </div>
              </div>
              <div className="pipeline">
                <div className="pipeline-title">Dubbing pipeline</div>
                {PIPELINE_STEPS.map((label, index) => (
                  <div key={label} className={`pipeline-item${progress >= 100 || index < stageIndex ? " complete" : ""}${progress > 0 && progress < 100 && index === stageIndex ? " current" : ""}`}>
                    <span className="pipeline-dot">{progress >= 100 || index < stageIndex ? "✓" : index + 1}</span>{label}
                  </div>
                ))}
                <div className="progress-track" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                  <div className="progress-fill" style={{ width: `${progress}%` }} />
                </div>
                {progress > 0 && <div className="field-help" style={{ textAlign: "right", marginTop: 7 }}>{progress}%</div>}
              </div>
            </div>
            <div className="panel-footer">
              <span className="estimate">You can skip dubbing and export subtitles only.</span>
              <button type="button" className="button button-secondary" disabled={!canExportOriginalSrt && !canExportSrt && !audio} onClick={() => goTo("export")}>
                Continue to export <span aria-hidden="true">→</span>
              </button>
            </div>
          </section>
        )}

        {step === "export" && (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2 className="panel-title">Your subtitle exports are ready</h2>
                <p className="panel-subtitle">Download the original transcript, Khmer translation, audio track, or dubbed video.</p>
              </div>
              <button type="button" className="button button-secondary" onClick={() => goTo("dub")}>← Back</button>
            </div>
            <div className="export-grid">
              <div className="export-card">
                <div className="export-icon">≡</div>
                <div><div className="export-title">Original subtitles</div><div className="export-description">Speech transcript · {segments.length} cues</div></div>
                <button type="button" className="button button-secondary" disabled={!canExportOriginalSrt} onClick={() => downloadBlob(new Blob([originalSrt], { type: "text/plain;charset=utf-8" }), `${project?.name || "subtitles"}-original.srt`)}>
                  Download .SRT
                </button>
              </div>
              <div className="export-card">
                <div className="export-icon">▤</div>
                <div><div className="export-title">Khmer subtitles</div><div className="export-description">Editable SRT file · {segments.length} cues</div></div>
                <button type="button" className="button" disabled={!canExportSrt} onClick={() => downloadBlob(new Blob([serializeSrt(segments)], { type: "text/plain;charset=utf-8" }), `${project?.name || "subtitles"}-km.srt`)}>
                  Download .SRT
                </button>
              </div>
              <div className="export-card">
                <div className="export-icon">♫</div>
                <div><div className="export-title">Khmer voice track</div><div className="export-description">{audio ? `${formatSize(audio.size)} · MP3 audio` : "Generate a dub to download the audio track."}</div></div>
                <button type="button" className="button" disabled={!audio} onClick={() => audio && downloadBlob(audio, "khmer-audio.mp3")}>
                  Download .MP3
                </button>
                {audioUrl && <audio controls src={audioUrl} style={{ width: "100%" }} />}
              </div>
              <div className="export-card">
                <div className="export-icon">▶</div>
                <div><div className="export-title">Dubbed video</div><div className="export-description">{video?.dubbedBlob ? `${formatSize(video.dubbedBlob.size)} · MP4 video` : "Generate a dub with a video upload to create an MP4."}</div></div>
                <button type="button" className="button" disabled={!video?.dubbedBlob} onClick={() => video?.dubbedBlob && downloadBlob(video.dubbedBlob, video.dubbedName ?? "khmer-dubbed.mp4")}>
                  Download .MP4
                </button>
              </div>
              <div className="export-card">
                <div className="export-icon">◉</div>
                <div><div className="export-title">Preview your dub</div><div className="export-description">{video?.dubbedBlob ? "Watch your Khmer-dubbed video before downloading." : "Your video preview will appear here after dubbing."}</div></div>
                {videoUrl ? <video className="video-preview" controls src={videoUrl} /> : <button type="button" className="button button-secondary" disabled>Preview unavailable</button>}
              </div>
            </div>
            <div className="panel-footer">
              <span className="estimate">Exports are saved in this tab until it is closed.</span>
              <button type="button" className="button button-secondary" onClick={() => void startNewProject()}>Start another project</button>
            </div>
          </section>
        )}
        <p className="footnote">No accounts. No database. Your project is stored only in this browser tab.</p>
      </div>
    </main>
  );
}
