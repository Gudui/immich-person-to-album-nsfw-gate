// NsfwGate.ts — drop-in replacement
// Dependencies: node-fetch@2, form-data
import fetch from "node-fetch";
import FormData from "form-data";

type BufferLike = Buffer;

interface GateDetection {
  label?: string;
  class?: string;
  score?: number;
  box?: number[]; // [x, y, w, h]
}

interface GateVerdict {
  score: number;
  label: string; // "none" or normalized class lowercased
  detections: GateDetection[];
}

const NSFW_DEBUG = String(process.env.NSFW_DEBUG || "0") === "1";
const IMMICH_API_URL = String(process.env.IMMICH_API_URL || "").replace(/\/+$/, "");
const NSFW_GATE_URL = String(process.env.NSFW_GATE_URL || "");
const NSFW_ALWAYS_ORIGINAL = String(process.env.NSFW_ALWAYS_ORIGINAL || "0") === "1";

// preview sizing (Immich preview endpoint ignores height sometimes; width is enough)
const PREVIEW_W = Number(process.env.NSFW_PREVIEW_WIDTH || "1536");

// Explicit classes (normalized UPPER_SNAKE)
const NSFW_KEYS = new Set<string>([
  "EXPOSED_BREAST",
  "FEMALE_BREAST_EXPOSED",
  "EXPOSED_GENITALIA",
  "MALE_GENITALIA_EXPOSED",
  "FEMALE_GENITALIA_EXPOSED",
  "BUTTOCKS_EXPOSED",
  "EXPOSED_BUTTOCKS",
  "PUBIC_AREA_EXPOSED",
]);

const norm = (s?: string): string => {
  if (!s) return "";
  let t = String(s).trim().toUpperCase().replace(/[-\s]+/g, "_").replace(/[^A-Z_]/g, "_");
  // common variants
  if (t === "EXPOSED_BUTTOCKS") t = "BUTTOCKS_EXPOSED";
  if (t === "EXPOSED_PUBIC_AREA") t = "PUBIC_AREA_EXPOSED";
  if (t === "EXPOSED_GENITALIA_F") t = "FEMALE_GENITALIA_EXPOSED";
  if (t === "EXPOSED_GENITALIA_M") t = "MALE_GENITALIA_EXPOSED";
  if (t === "EXPOSED_BREAST_F") t = "FEMALE_BREAST_EXPOSED";
  return t;
};

const normalizeDetections = (detections: unknown): GateDetection[] => {
  if (!Array.isArray(detections)) return [];
  return detections.map((raw: unknown) => {
    const d = (raw || {}) as Record<string, unknown>;
    const cls = norm((d["class"] as string) ?? (d["label"] as string) ?? "");
    const score =
      typeof d["score"] === "number" ? (d["score"] as number) : Number(d["score"] ?? 0) || 0;
    const box = Array.isArray(d["box"]) ? (d["box"] as number[]) : [];
    return {
      class: cls || undefined,
      label: cls || undefined,
      score,
      box,
    };
  });
};

const promoteExplicitTop = (verdict: Partial<GateVerdict>): GateVerdict => {
  const normDets = normalizeDetections(verdict?.detections ?? []);
  const topLabel = (verdict?.label ?? "none").toString().toLowerCase();
  let topScore =
    typeof verdict?.score === "number" ? (verdict?.score as number) : Number(verdict?.score) || 0;

  // if already explicit, keep; otherwise promote the best explicit detection
  if (topLabel !== "none" && NSFW_KEYS.has(norm(topLabel))) {
    return {
      score: topScore,
      label: topLabel,
      detections: normDets,
    };
  }

  const explicit = normDets.filter((d) => d.class && NSFW_KEYS.has(d.class));
  if (explicit.length) {
    const best = explicit.reduce((a, b) => ((b.score || 0) > (a.score || 0) ? b : a), explicit[0]!);
    return {
      score: best.score || 0,
      label: String(best.class || "none").toLowerCase(),
      detections: normDets,
    };
  }

  return {
    score: 0,
    label: "none",
    detections: normDets,
  };
};

async function postToGate(
  bytes: BufferLike,
  filename: string,
  mime: string,
): Promise<GateVerdict> {
  if (!NSFW_GATE_URL) throw new Error("NSFW_GATE_URL is not set");
  const form = new FormData();
  form.append("file", bytes, { filename, contentType: mime });

  const res = await fetch(NSFW_GATE_URL, {
    method: "POST",
    body: form as any,
    // node-fetch@2 handles form-data headers internally when body is a stream
    headers: (form as any).getHeaders ? (form as any).getHeaders() : undefined,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`NSFW gate ${res.status} ${res.statusText} ${txt}`.trim());
  }

  const json = (await res.json()) as unknown;
  // normalize/promotion here so callers always get a consistent structure
  return promoteExplicitTop(json as Partial<GateVerdict>);
}

async function fetchAssetImage(
  assetId: string,
  apiKey: string,
): Promise<{ data: BufferLike; filename: string; mime: string }> {
  const headers: Record<string, string> = { "x-api-key": apiKey };

  // 1) preview first unless forced-original
  if (!NSFW_ALWAYS_ORIGINAL) {
    const previewUrl = `${IMMICH_API_URL}/api/assets/${assetId}/thumbnail?size=preview&format=JPEG&width=${PREVIEW_W}`;
    if (NSFW_DEBUG) console.log(`Fetching PREVIEW for NSFW check: ${assetId}`);
    const p = await fetch(previewUrl, { headers });
    if (p.ok) {
      const arrayBuf = await p.arrayBuffer();
      const data = Buffer.from(arrayBuf);
      // Immich doesn't always set filename for previews; synthesize one
      const mime = p.headers.get("content-type") || "image/jpeg";
      const filename = `${assetId}.jpg`;
      return { data, filename, mime };
    }
    if (NSFW_DEBUG)
      console.warn(`Preview fetch failed ${p.status} ${p.statusText}; falling back to ORIGINAL`);
  }

  // 2) original
  const originalUrl = `${IMMICH_API_URL}/api/assets/${assetId}/original`;
  if (NSFW_DEBUG) console.log(`Fetching ORIGINAL for NSFW check: ${assetId}`);
  const r = await fetch(originalUrl, { headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Original fetch ${r.status} ${r.statusText} ${txt}`.trim());
  }
  const arrayBuf = await r.arrayBuffer();
  const data = Buffer.from(arrayBuf);
  const disp = r.headers.get("content-disposition") || "";
  const match = /filename\*?=(?:UTF-8'')?([^;]+)/i.exec(disp);
  const filename = match ? decodeURIComponent(match[1].replace(/["']/g, "")) : `${assetId}.bin`;
  const mime = r.headers.get("content-type") || "application/octet-stream";
  return { data, filename, mime };
}

// ======== PUBLIC API ========

export async function classifyAsset(assetId: string, apiKey: string): Promise<GateVerdict> {
  if (!assetId) throw new Error("classifyAsset: assetId is required");
  if (!apiKey) throw new Error("classifyAsset: apiKey is required");

  const src = await fetchAssetImage(assetId, apiKey);
  if (NSFW_DEBUG) {
    console.log(
      `Posting to NSFW gate: ${src.filename} (${src.mime}), ~${Math.round(
        (src.data.byteLength || 0) / 1024,
      )} KiB`,
    );
  }

  const verdict = await postToGate(src.data, src.filename, src.mime);

  if (NSFW_DEBUG) {
    console.log(`Gate verdict for ${assetId}: ${JSON.stringify(verdict).slice(0, 500)}`);
  }

  // If we used preview implicitly (NSFW_ALWAYS_ORIGINAL=0) and got an empty result,
  // retry once with original to improve recall.
  const usedPreviewImplicitly = !NSFW_ALWAYS_ORIGINAL; // fetchAssetImage tried preview first
  const empty =
    (!verdict?.detections || verdict.detections.length === 0) &&
    (!verdict?.label || verdict.label === "none");

  if (usedPreviewImplicitly && empty) {
    try {
      const original = await fetchAssetImage(assetId, apiKey); // will be ORIGINAL on second call if preview already tried
      if (NSFW_DEBUG) {
        console.log(
          `Preview looked empty; retrying with ORIGINAL for ${assetId} (~${Math.round(
            original.data.byteLength / 1024,
          )} KiB)`,
        );
      }
      const v2 = await postToGate(original.data, original.filename, original.mime);
      if (NSFW_DEBUG) {
        console.log(`Gate verdict (original) for ${assetId}: ${JSON.stringify(v2).slice(0, 500)}`);
      }
      // prefer original if explicit or higher score
      const v1Score = typeof verdict?.score === "number" ? verdict.score : 0;
      const v2Score = typeof v2?.score === "number" ? v2.score : 0;
      const v2HasExplicit = (v2?.detections ?? []).some(
        (d: GateDetection) => !!d.class && NSFW_KEYS.has(d.class),
      );
      if (v2HasExplicit || v2Score > v1Score) return v2;
    } catch (e) {
      if (NSFW_DEBUG) console.warn(`Original retry failed for ${assetId}: ${String(e)}`);
    }
  }

  return verdict;
}
