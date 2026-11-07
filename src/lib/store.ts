import { create } from "zustand";
import type { AppStep, Project, SubtitleSegment, VideoAsset } from "@/lib/types";

type AppState = {
  ready: boolean;
  projectId: string | null;
  project: Project | null;
  video: VideoAsset | null;
  originalSrt: string;
  segments: SubtitleSegment[];
  audio: Blob | null;
  step: AppStep;
  setReady: (projectId: string) => void;
  setProject: (project: Project) => void;
  setVideo: (video: VideoAsset | null) => void;
  setSubtitles: (original: string, segments: SubtitleSegment[]) => void;
  setAudio: (audio: Blob | null) => void;
  setStep: (step: AppStep) => void;
};

export const useAppStore = create<AppState>((set) => ({
  ready: false,
  projectId: null,
  project: null,
  video: null,
  originalSrt: "",
  segments: [],
  audio: null,
  step: "upload",
  setReady: (projectId) => set({ projectId, ready: true }),
  setProject: (project) => set({ project }),
  setVideo: (video) => set({ video }),
  setSubtitles: (originalSrt, segments) => set({ originalSrt, segments }),
  setAudio: (audio) => set({ audio }),
  setStep: (step) => set({ step }),
}));
