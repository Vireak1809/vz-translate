import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Project, SubtitleSegment } from "@/lib/types";

interface TranslatorDatabase extends DBSchema {
  projects: { key: string; value: Project };
  videos: {
    key: string;
    value: {
      projectId: string;
      blob: Blob;
      name: string;
      dubbedBlob?: Blob;
      dubbedName?: string;
    };
  };
  subtitles: {
    key: string;
    value: {
      projectId: string;
      original: string;
      segments: SubtitleSegment[];
    };
  };
  audio: { key: string; value: { projectId: string; blob: Blob; name: string } };
}

const DATABASE_NAME = "khmer_translator_db";
let databasePromise: Promise<IDBPDatabase<TranslatorDatabase>> | undefined;
let tabSessionPromise: Promise<string> | undefined;

function database() {
  if (!databasePromise) {
    databasePromise = openDB<TranslatorDatabase>(DATABASE_NAME, 1, {
      upgrade(db) {
        db.createObjectStore("projects", { keyPath: "id" });
        db.createObjectStore("videos", { keyPath: "projectId" });
        db.createObjectStore("subtitles", { keyPath: "projectId" });
        db.createObjectStore("audio", { keyPath: "projectId" });
      },
    });
  }
  return databasePromise;
}

export function beginTabSession(): Promise<string> {
  if (!tabSessionPromise) {
    tabSessionPromise = (async () => {
      if (sessionStorage.getItem("app_session_active") === null) {
        databasePromise = undefined;
        await deleteDB(DATABASE_NAME);
        sessionStorage.setItem("app_session_active", "true");
      }

      let projectId = sessionStorage.getItem("active_project_id");
      if (!projectId) {
        projectId = crypto.randomUUID();
        sessionStorage.setItem("active_project_id", projectId);
      }
      if (!sessionStorage.getItem("processing_session_id")) {
        sessionStorage.setItem("processing_session_id", crypto.randomUUID());
      }

      const db = await database();
      let project = await db.get("projects", projectId);
      if (!project) {
        project = {
          id: projectId,
          name: "Untitled project",
          createdAt: new Date().toISOString(),
          sourceLang: "eng_Latn",
        };
        await db.put("projects", project);
      }
      return projectId;
    })();
  }
  return tabSessionPromise;
}

export async function loadProject(projectId: string) {
  const db = await database();
  const [project, video, subtitles, audio] = await Promise.all([
    db.get("projects", projectId),
    db.get("videos", projectId),
    db.get("subtitles", projectId),
    db.get("audio", projectId),
  ]);
  return { project, video, subtitles, audio };
}

export async function saveProject(project: Project) {
  await (await database()).put("projects", project);
}

export async function saveVideo(projectId: string, file: File) {
  await (await database()).put("videos", {
    projectId,
    blob: file,
    name: file.name,
  });
}

export async function saveDubbedVideo(projectId: string, blob: Blob) {
  const db = await database();
  const previous = await db.get("videos", projectId);
  if (!previous) throw new Error("Upload a video before saving a dubbed export.");
  await db.put("videos", {
    ...previous,
    dubbedBlob: blob,
    dubbedName: "khmer-dubbed.mp4",
  });
}

export async function saveSubtitles(
  projectId: string,
  original: string,
  segments: SubtitleSegment[],
) {
  await (await database()).put("subtitles", { projectId, original, segments });
}

export async function saveAudio(projectId: string, blob: Blob) {
  await (await database()).put("audio", {
    projectId,
    blob,
    name: "khmer-dub.mp3",
  });
}

export async function clearAudio(projectId: string) {
  await (await database()).delete("audio", projectId);
}

export async function clearDubbedVideo(projectId: string) {
  const db = await database();
  const previous = await db.get("videos", projectId);
  if (!previous) return;
  await db.put("videos", { projectId, blob: previous.blob, name: previous.name });
}

export async function clearProjectData(projectId: string) {
  const db = await database();
  await Promise.all([
    db.delete("videos", projectId),
    db.delete("subtitles", projectId),
    db.delete("audio", projectId),
  ]);
}
