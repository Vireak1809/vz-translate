export type SubtitleSegment = {
  id: number;
  start: string;
  end: string;
  original: string;
  translation: string;
};

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  sourceLang: string;
};

export type VideoAsset = {
  blob: Blob;
  name: string;
  dubbedBlob?: Blob;
  dubbedName?: string;
};

export type AppStep = "upload" | "translate" | "dub" | "export";

export type Voice = "km-KH-PisethNeural" | "km-KH-SreymomNeural";
