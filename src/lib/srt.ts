import type { SubtitleSegment } from "@/lib/types";

const TIMESTAMP =
  /((?:\d{2}:)?\d{2}:\d{2}[,.]\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}[,.]\d{3})/;

function normalizeTimestamp(value: string) {
  const timestamp = value.replace(",", ".");
  return timestamp.split(":").length === 2 ? `00:${timestamp}` : timestamp;
}

export function parseSubtitles(input: string): SubtitleSegment[] {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const blocks = normalized
    .replace(/^WEBVTT[^\n]*\n/i, "")
    .split(/\n\s*\n/)
    .filter((block) => block.trim());

  const segments: SubtitleSegment[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timeIndex = lines.findIndex((line) => TIMESTAMP.test(line));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex].match(TIMESTAMP);
    if (!match) continue;
    const text = lines
      .slice(timeIndex + 1)
      .join("\n")
      .replace(/<[^>]*>/g, "")
      .trim();
    segments.push({
      id: segments.length + 1,
      start: normalizeTimestamp(match[1]),
      end: normalizeTimestamp(match[2]),
      original: text,
      translation: "",
    });
  }
  return segments;
}

export function serializeSrt(segments: SubtitleSegment[]): string {
  return `${segments
    .map(
      (segment, index) =>
        `${index + 1}\n${segment.start.replace(".", ",")} --> ${segment.end.replace(".", ",")}\n${segment.translation.trim()}`,
    )
    .join("\n\n")}\n`;
}

export function guessLanguage(input: string): string {
  const text = input.slice(0, 12000);
  const lower = text.toLowerCase();
  if (/[\u3040-\u30ff]/.test(text)) return "jpn_Jpan";
  if (/[\uac00-\ud7af]/.test(text)) return "kor_Hang";
  if (/[\u4e00-\u9fff]/.test(text)) return "zho_Hans";
  if (/[\u0400-\u04ff]/.test(text)) return "rus_Cyrl";
  if (/[\u0600-\u06ff]/.test(text)) return "arb_Arab";
  if (/[\u0e00-\u0e7f]/.test(text)) return "tha_Thai";
  if (/[\u0900-\u097f]/.test(text)) return "hin_Deva";
  if (/[ăâđêôơư]/i.test(text)) return "vie_Latn";
  if (/[áéíóúñ¿¡]/i.test(text)) return "spa_Latn";
  if (/[àâçèéêëîïôùûüÿœ]/i.test(text)) return "fra_Latn";
  const score = (words: string[]) =>
    words.reduce((total, word) => total + (new RegExp(`\\b${word}\\b`, "i").test(lower) ? 1 : 0), 0);
  const french = score(["bonjour", "avec", "vous", "nous", "pour", "mais", "est", "pas", "une", "dans"]);
  const spanish = score(["hola", "con", "usted", "nosotros", "para", "pero", "está", "una", "como", "por"]);
  const indonesian = score(["yang", "dan", "dengan", "untuk", "tidak", "saya", "kamu", "ini", "itu", "dari"]);
  if (indonesian >= 2 && indonesian > french && indonesian > spanish) return "ind_Latn";
  if (french >= 2 && french > spanish) return "fra_Latn";
  if (spanish >= 2) return "spa_Latn";
  return "eng_Latn";
}

export const SOURCE_LANGUAGES = [
  ["eng_Latn", "English"],
  ["fra_Latn", "French"],
  ["spa_Latn", "Spanish"],
  ["zho_Hans", "Chinese (Simplified)"],
  ["jpn_Jpan", "Japanese"],
  ["kor_Hang", "Korean"],
  ["tha_Thai", "Thai"],
  ["vie_Latn", "Vietnamese"],
  ["hin_Deva", "Hindi"],
  ["rus_Cyrl", "Russian"],
  ["arb_Arab", "Arabic"],
  ["ind_Latn", "Indonesian"],
] as const;
