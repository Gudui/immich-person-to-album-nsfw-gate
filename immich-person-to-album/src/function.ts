/* eslint-disable no-console */

/**
 * function.ts — drop-in replacement (Immich v2.20+)
 *
 * Enhancements for recall:
 * - Area-Weighted Union Gate (AWUG): sum_c( unionArea_c * maxScore_c ) >= τ  -> NSFW
 * - Cross-Class Consensus (XCC): >= K explicit classes each with medium score -> NSFW
 * - Keeps prior recall tools: per-class min-area, area-easing, same-class consensus, weak-top rescue
 * - Strict person scoping: enumerate by person AND verify each asset actually contains personId
 *
 * Taxonomy: strictly NudeNet exposed-region classes only (no expansion).
 */

import { classifyAsset } from "./lib/nsfwGate";

// ---------- Env & constants ----------
const IMMICH_API_URL = (process.env.IMMICH_API_URL || "").replace(/\/+$/, "");
if (!IMMICH_API_URL) throw new Error("IMMICH_API_URL is required");

const NSFW_GATE_URL = (process.env.NSFW_GATE_URL || "").replace(/\/+$/, "");
if (!NSFW_GATE_URL) throw new Error("NSFW_GATE_URL is required");

const NSFW_DEBUG = String(process.env.NSFW_DEBUG || "0") === "1";

const NSFW_THRESHOLD: number =
  Number.isFinite(Number(process.env.NSFW_THRESHOLD))
    ? Number(process.env.NSFW_THRESHOLD)
    : 0.55;

const NSFW_FAIL_MODE: "fail-open" | "fail-closed" =
  (String(process.env.NSFW_FAIL_MODE || "fail-closed") as "fail-open" | "fail-closed");

const NSFW_TAG_NAME: string = String(process.env.NSFW_TAG_NAME || "nsfw-auto");

// Global min area floor (fallback) and per-class overrides for tiny explicit regions (bath shots etc.)
const GLOBAL_MIN_AREA_RATIO: number =
  Number.isFinite(Number(process.env.NSFW_MIN_AREA_RATIO))
    ? Number(process.env.NSFW_MIN_AREA_RATIO)
    : 0.01;

const DEFAULT_MIN_AREA_PER_CLASS: Record<string, number> = {
  BUTTOCKS_EXPOSED: 0.003,
  EXPOSED_BUTTOCKS: 0.003,
  PUBIC_AREA_EXPOSED: 0.003,
  MALE_GENITALIA_EXPOSED: 0.003,
  FEMALE_GENITALIA_EXPOSED: 0.003,
  FEMALE_BREAST_EXPOSED: 0.004,
  MALE_BREAST_EXPOSED: 0.004,
};
const MIN_AREA_PER_CLASS: Record<string, number> = (() => {
  try {
    const raw = process.env.NSFW_MIN_AREA_RATIO_PER_CLASS;
    if (!raw) return DEFAULT_MIN_AREA_PER_CLASS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_MIN_AREA_PER_CLASS, ...(parsed || {}) };
  } catch {
    return DEFAULT_MIN_AREA_PER_CLASS;
  }
})();

// Recall controls (tunable via env)
const CONSENSUS_MIN_SCORE: number =
  Number.isFinite(Number(process.env.NSFW_CONSENSUS_MIN_SCORE))
    ? Number(process.env.NSFW_CONSENSUS_MIN_SCORE)
    : 0.42;

const CONSENSUS_MIN_COUNT: number =
  Number.isFinite(Number(process.env.NSFW_CONSENSUS_MIN_COUNT))
    ? Number(process.env.NSFW_CONSENSUS_MIN_COUNT)
    : 2;

const TOP_WEAK_RESCUE: number =
  Number.isFinite(Number(process.env.NSFW_TOP_WEAK_RESCUE))
    ? Number(process.env.NSFW_TOP_WEAK_RESCUE)
    : 0.48;

const AREA_EASE_MAX: number =
  Number.isFinite(Number(process.env.NSFW_AREA_EASE_MAX))
    ? Number(process.env.NSFW_AREA_EASE_MAX)
    : 0.15;

const AREA_EASE_GAIN: number =
  Number.isFinite(Number(process.env.NSFW_AREA_EASE_GAIN))
    ? Number(process.env.NSFW_AREA_EASE_GAIN)
    : 0.50;

// NEW: Area-Weighted Union Gate (AWUG)
const AREA_UNION_SCORE_GATE: number =
  Number.isFinite(Number(process.env.NSFW_AREA_UNION_SCORE_GATE))
    ? Number(process.env.NSFW_AREA_UNION_SCORE_GATE)
    : 0.008; // τ: sum over classes of (unionArea * maxScore)

// NEW: Cross-Class Consensus (XCC)
const XCC_MIN_SCORE: number =
  Number.isFinite(Number(process.env.NSFW_XCC_MIN_SCORE))
    ? Number(process.env.NSFW_XCC_MIN_SCORE)
    : 0.43;
const XCC_MIN_CLASSES: number =
  Number.isFinite(Number(process.env.NSFW_XCC_MIN_CLASSES))
    ? Math.max(2, Number(process.env.NSFW_XCC_MIN_CLASSES))
    : 2;

// Immich search paging
const SEARCH_PAGE_SIZE: number =
  Number.isFinite(Number(process.env.IMMICH_SEARCH_PAGE_SIZE))
    ? Math.max(50, Math.min(1000, Number(process.env.IMMICH_SEARCH_PAGE_SIZE)))
    : 200;
const SEARCH_MAX_PAGES: number =
  Number.isFinite(Number(process.env.IMMICH_SEARCH_MAX_PAGES))
    ? Math.max(1, Math.min(5000, Number(process.env.IMMICH_SEARCH_MAX_PAGES)))
    : 2000;

// ---------- Explicit classes & thresholds (NudeNet-aligned) ----------
const DEFAULT_CLASS_THRESHOLDS: Record<string, number> = {
  EXPOSED_BREAST: 0.55,
  FEMALE_BREAST_EXPOSED: 0.55,
  MALE_BREAST_EXPOSED: 0.55,       // added & supported
  EXPOSED_GENITALIA: 0.60,
  MALE_GENITALIA_EXPOSED: 0.60,
  FEMALE_GENITALIA_EXPOSED: 0.60,
  BUTTOCKS_EXPOSED: 0.55,
  EXPOSED_BUTTOCKS: 0.55,
  PUBIC_AREA_EXPOSED: 0.60,
};
const NSFW_CLASS_THRESHOLDS: Record<string, number> = (() => {
  try {
    const raw = process.env.NSFW_CLASS_THRESHOLDS;
    if (!raw) return DEFAULT_CLASS_THRESHOLDS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CLASS_THRESHOLDS, ...(parsed || {}) };
  } catch {
    return DEFAULT_CLASS_THRESHOLDS;
  }
})();
const NSFW_CLASSES = new Set<string>(Object.keys(DEFAULT_CLASS_THRESHOLDS));
function thrFor(cls: string): number {
  return NSFW_CLASS_THRESHOLDS[cls] ?? 0.60;
}

// ---------- Types ----------
type UUID = string;

interface GateDetection {
  label?: string;
  class?: string;
  score?: number;
  box?: number[]; // [x, y, w, h]
}
interface GateVerdict {
  score: number;
  label: string; // "none" or explicit class (lowercased)
  detections: GateDetection[];
}
interface LinkInput {
  personId: UUID;
  albumId: UUID;
  apiKey: string;
  description?: string;
}
interface SearchResponse {
  items?: Array<{ id?: UUID }>;
  results?: Array<{ id?: UUID }>;
  hits?: Array<{ id?: UUID }>;
  assets?: { items?: Array<{ id?: UUID }>; nextPage?: string | null } | Array<{ id?: UUID }>;
  nextPage?: string | null;
  page?: number;
}

// ---------- HTTP helpers ----------
function headersJSON(apiKey: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-immich-api-key": apiKey,
  };
}
async function getJson<T = any>(url: string, apiKey: string): Promise<T> {
  const res = await fetch(url, { headers: headersJSON(apiKey) as any });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText} :: ${text}`);
  }
  return (await res.json()) as T;
}
async function postJson<T = any>(url: string, body: any, apiKey: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: headersJSON(apiKey) as any,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`POST ${url} -> ${res.status} ${res.statusText} :: ${text}`);
  }
  return (await res.json()) as T;
}
async function putJson<T = any>(url: string, body: any, apiKey: string): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: headersJSON(apiKey) as any,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`PUT ${url} -> ${res.status} ${res.statusText} :: ${text}`);
  }
  return (await res.json().catch(() => ({}))) as T;
}
async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// ---------- Utilities ----------
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function coerceId(x: any): string | null {
  return (
    (x && typeof x === "object" && typeof (x as any).id === "string" && (x as any).id) ||
    (typeof x === "string" ? x : null)
  );
}
/** Extract asset IDs from all known result shapes. */
function extractIdsFromSearch(json: SearchResponse): string[] {
  const pools: any[] = [];
  if (Array.isArray(json?.items)) pools.push(...json.items);
  if (Array.isArray(json?.results)) pools.push(...json.results);
  if (Array.isArray(json?.hits)) pools.push(...json.hits);
  if ((json as any)?.assets) {
    const a: any = (json as any).assets;
    if (Array.isArray(a)) pools.push(...a);
    else if (Array.isArray(a?.items)) pools.push(...a.items);
  }
  const ids = pools.map(coerceId).filter(Boolean) as string[];
  return Array.from(new Set(ids));
}

// ---------- Immich ops (v2.20-safe) ----------
async function getPersonAssetIds(personId: UUID, apiKey: string): Promise<UUID[]> {
  const ids: UUID[] = [];
  const url = `${IMMICH_API_URL}/api/search/metadata`;
  let page = 1;
  let lastFirstId: string | null = null;
  for (; page <= SEARCH_MAX_PAGES; page++) {
    const body = {
      personId,
      page,
      size: SEARCH_PAGE_SIZE,
      order: "desc",
      withPeople: false,
      withExif: false,
      withStacked: true,
      trashed: false,
    };
    let json: SearchResponse;
    try {
      json = await postJson<SearchResponse>(url, body, apiKey);
    } catch (e) {
      if (NSFW_DEBUG) console.warn(`POST /api/search/metadata failed (page ${page}): ${String(e)}`);
      break;
    }
    const batch = extractIdsFromSearch(json);
    if (batch.length === 0) break;
    if (lastFirstId && batch[0] === lastFirstId) break; // server ignored paging; stop
    lastFirstId = batch[0];
    ids.push(...batch);
    if (batch.length < SEARCH_PAGE_SIZE) break;
    if (json?.nextPage === null) break;
  }
  return Array.from(new Set(ids));
}

async function assetHasPerson(assetId: UUID, personId: UUID, apiKey: string): Promise<boolean> {
  try {
    const url = `${IMMICH_API_URL}/api/assets/${encodeURIComponent(assetId)}`;
    const j = await getJson<any>(url, apiKey);
    const arr = Array.isArray(j?.people) ? j.people : Array.isArray(j?.persons) ? j.persons : [];
    for (const p of arr) {
      const pid =
        (typeof p?.id === "string" && p.id) ||
        (typeof p?.personId === "string" && p.personId) ||
        null;
      if (pid === personId) return true;
    }
    const faces = Array.isArray(j?.faces) ? j.faces : [];
    for (const f of faces) {
      const pid = (typeof f?.personId === "string" && f.personId) || null;
      if (pid === personId) return true;
    }
    return false;
  } catch (e) {
    if (NSFW_DEBUG) console.warn(`assetHasPerson(${assetId}) failed: ${String(e)}`);
    return false;
  }
}

async function getAssetDims(assetId: UUID, apiKey: string): Promise<{ w: number; h: number }> {
  try {
    const url = `${IMMICH_API_URL}/api/assets/${encodeURIComponent(assetId)}`;
    const json = await getJson<any>(url, apiKey);
    const w =
      Number(json?.exif?.imageWidth ?? json?.originalWidth ?? json?.resizePathWidth ?? json?.width);
    const h =
      Number(
        json?.exif?.imageHeight ?? json?.originalHeight ?? json?.resizePathHeight ?? json?.height,
      );
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { w, h };
  } catch {}
  return { w: 1920, h: 1440 };
}

async function addAssetsToAlbum(albumId: UUID, assetIds: UUID[], apiKey: string): Promise<void> {
  const url = `${IMMICH_API_URL}/api/albums/${encodeURIComponent(albumId)}/assets`;
  for (const batch of chunk(assetIds, 100)) await putJson(url, { ids: batch }, apiKey);
}

// ---------- Tags (direct HTTP) ----------
async function listTags(apiKey: string): Promise<Array<{ id: string; name: string }>> {
  const url = `${IMMICH_API_URL}/api/tags`;
  try {
    const res = await getJson<any>(url, apiKey);
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.items)) return res.items;
    return [];
  } catch (e) {
    if (NSFW_DEBUG) console.warn(`GET /api/tags failed: ${String(e)}`);
    return [];
  }
}
async function createTag(name: string, apiKey: string): Promise<string> {
  const url = `${IMMICH_API_URL}/api/tags`;
  try {
    const res = await postJson<any>(url, { name }, apiKey);
    const id = res?.id || res?._id || null;
    if (typeof id === "string" && id) return id;
  } catch (e) {
    if (NSFW_DEBUG) console.warn(`POST /api/tags failed: ${String(e)}`);
  }
  const tags = await listTags(apiKey);
  const found = tags.find((t) => (t?.name || "").toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`Unable to create or find tag "${name}"`);
  return found.id;
}
async function ensureTagId(name: string, apiKey: string): Promise<string> {
  const tags = await listTags(apiKey);
  const hit = tags.find((t) => (t?.name || "").toLowerCase() === name.toLowerCase());
  if (hit?.id) return hit.id;
  return await createTag(name, apiKey);
}
async function addAssetsToTag(tagId: string, assetIds: string[], apiKey: string): Promise<void> {
  const url = `${IMMICH_API_URL}/api/tags/${encodeURIComponent(tagId)}/assets`;
  for (const batch of chunk(assetIds, 200)) await putJson(url, { ids: batch }, apiKey);
}

// ---------- Decision helpers (NudeNet-aligned) ----------
function normCls(raw?: string): string {
  if (!raw) return "";
  let t = String(raw).toUpperCase().replace(/[^A-Z_]+/g, "_");
  // Canonicalize NudeNet synonyms across versions
  if (t === "EXPOSED_GENITALIA_F") t = "FEMALE_GENITALIA_EXPOSED";
  if (t === "EXPOSED_GENITALIA_M") t = "MALE_GENITALIA_EXPOSED";
  if (t === "EXPOSED_BREAST_F") t = "FEMALE_BREAST_EXPOSED";
  if (t === "EXPOSED_BREAST_M") t = "MALE_BREAST_EXPOSED";
  if (t === "EXPOSED_BUTTOCKS") t = "BUTTOCKS_EXPOSED";
  if (t === "EXPOSED_PUBIC_AREA") t = "PUBIC_AREA_EXPOSED";
  return t;
}
function minAreaForClass(cls: string): number {
  return MIN_AREA_PER_CLASS[cls] ?? GLOBAL_MIN_AREA_RATIO;
}

/** Compute union area ratio per explicit class using a cheap 2D merge. */
function unionAreaRatioByClass(
  dets: Array<{ cls: string; box: number[] }>,
  imgArea: number,
): Map<string, number> {
  const byClass = new Map<string, number[][]>();
  for (const d of dets) {
    if (!d.cls || !Array.isArray(d.box) || d.box.length < 4) continue;
    const [x, y, w, h] = d.box.map(Number);
    if (!(w > 0 && h > 0)) continue;
    const arr = byClass.get(d.cls) || [];
    arr.push([x, y, w, h]);
    byClass.set(d.cls, arr);
  }
  const res = new Map<string, number>();
  for (const [cls, boxes] of byClass) {
    boxes.sort((a, b) => a[0] - b[0]);
    const merged: number[][] = [];
    for (const b of boxes) {
      if (!merged.length) {
        merged.push(b.slice(0));
        continue;
      }
      const last = merged[merged.length - 1];
      const [lx, ly, lw, lh] = last;
      const [x, y, w, h] = b;
      const lxr = lx + lw, xr = x + w;
      const lyr = ly + lh, yr = y + h;
      const xOverlap = x <= lxr && xr >= lx;
      const yOverlap = y <= lyr && yr >= ly;
      if (xOverlap && yOverlap) {
        last[0] = Math.min(lx, x);
        last[1] = Math.min(ly, y);
        last[2] = Math.max(lxr, xr) - last[0];
        last[3] = Math.max(lyr, yr) - last[1];
      } else {
        merged.push(b.slice(0));
      }
    }
    const unionArea = merged.reduce((s, m) => s + m[2] * m[3], 0);
    res.set(cls, Math.max(0, Math.min(1, unionArea / imgArea)));
  }
  return res;
}

function isNsfwVerdict(
  verdict: GateVerdict,
  imgW: number,
  imgH: number,
): { nsfw: boolean; reason: string; class?: string; score?: number } {
  const imgArea = Math.max(1, imgW * imgH);
  const dets = Array.isArray(verdict?.detections) ? verdict.detections : [];

  // Normalize & filter to explicit classes with per-class min area
  const explicit = dets
    .map((d) => {
      const cls = normCls(d?.class ?? d?.label);
      const score = Number(d?.score ?? 0);
      const box = Array.isArray(d?.box) ? d.box.map(Number) : [0, 0, 0, 0];
      const areaRatio = (box[2] * box[3]) / imgArea;
      return { cls, score, box, areaRatio };
    })
    .filter((d) => NSFW_CLASSES.has(d.cls) && d.areaRatio >= minAreaForClass(d.cls));

  // Weak-top rescue
  const topLabelNorm = normCls(String(verdict?.label || "none"));
  const topScore = Number(verdict?.score || 0);
  if (topLabelNorm !== "NONE" && NSFW_CLASSES.has(topLabelNorm) && topScore >= TOP_WEAK_RESCUE) {
    return { nsfw: true, reason: "top-weak-rescue", class: topLabelNorm, score: topScore };
  }

  if (explicit.length === 0) return { nsfw: false, reason: "no-explicit-dets" };

  // Area-aware easing per class
  const unionByClass = unionAreaRatioByClass(
    explicit.map((e) => ({ cls: e.cls, box: e.box })),
    imgArea,
  );

  let bestHit: { cls: string; score: number; thrEff: number } | null = null;
  for (const e of explicit) {
    const baseThr = thrFor(e.cls);
    const unionArea = unionByClass.get(e.cls) || 0;
    const ease = Math.min(AREA_EASE_MAX, AREA_EASE_GAIN * Math.sqrt(unionArea));
    const thrEff = Math.max(0.35, baseThr - ease);
    if (e.score >= thrEff) {
      if (!bestHit || e.score > bestHit.score) bestHit = { cls: e.cls, score: e.score, thrEff };
    }
  }
  if (bestHit) {
    return { nsfw: true, reason: "area-eased", class: bestHit.cls, score: bestHit.score };
  }

  // Same-class consensus (unchanged logic)
  const byClass = new Map<string, number>();
  for (const e of explicit) {
    if (e.score >= CONSENSUS_MIN_SCORE && e.areaRatio >= Math.max(0.5 * minAreaForClass(e.cls), 0.002)) {
      byClass.set(e.cls, (byClass.get(e.cls) || 0) + 1);
    }
  }
  for (const [cls, cnt] of byClass) {
    if (cnt >= CONSENSUS_MIN_COUNT) {
      const maxScore = Math.max(...explicit.filter((e) => e.cls === cls).map((x) => x.score));
      return { nsfw: true, reason: "consensus", class: cls, score: maxScore };
    }
  }

  // NEW: Area-Weighted Union Gate (AWUG)
  const awug = (() => {
    let sum = 0;
    const classes = Array.from(unionByClass.keys());
    for (const cls of classes) {
      const U = unionByClass.get(cls) || 0; // union area ratio for the class
      if (U <= 0) continue;
      const S = Math.max(...explicit.filter((e) => e.cls === cls).map((e) => e.score || 0), 0);
      if (S <= 0) continue;
      sum += U * S;
    }
    return sum;
  })();
  if (awug >= AREA_UNION_SCORE_GATE) {
    // pick class with largest U*S contribution for logging
    let bestCls = "unknown";
    let bestVal = -1;
    for (const cls of unionByClass.keys()) {
      const U = unionByClass.get(cls) || 0;
      const S = Math.max(...explicit.filter((e) => e.cls === cls).map((e) => e.score || 0), 0);
      const val = U * S;
      if (val > bestVal) { bestVal = val; bestCls = cls; }
    }
    const topScoreByBest = Math.max(...explicit.filter((e) => e.cls === bestCls).map((e) => e.score || 0), 0);
    return { nsfw: true, reason: "union-area-score", class: bestCls, score: topScoreByBest };
  }

  // NEW: Cross-Class Consensus (XCC)
  const qualifyingClasses = new Set<string>();
  for (const [cls, cnt] of byClass) {
    // reuse byClass only counts e.score>=CONSENSUS_MIN_SCORE; we require a slightly higher floor for XCC
    const maxScore = Math.max(...explicit.filter((e) => e.cls === cls).map((e) => e.score || 0), 0);
    if (maxScore >= XCC_MIN_SCORE) qualifyingClasses.add(cls);
  }
  if (qualifyingClasses.size >= XCC_MIN_CLASSES) {
    const topCls = Array.from(qualifyingClasses).sort(
      (a, b) =>
        Math.max(...explicit.filter((e) => e.cls === b).map((e) => e.score || 0), 0) -
        Math.max(...explicit.filter((e) => e.cls === a).map((e) => e.score || 0), 0),
    )[0];
    const topScore2 = Math.max(...explicit.filter((e) => e.cls === topCls).map((e) => e.score || 0), 0);
    return { nsfw: true, reason: "cross-class-consensus", class: topCls, score: topScore2 };
  }

  // Global top-score gate (respects env)
  const topIsNsfw = topLabelNorm !== "NONE" && topScore >= NSFW_THRESHOLD;
  if (topIsNsfw) {
    return { nsfw: true, reason: "top-threshold", class: topLabelNorm, score: topScore };
  }
  return { nsfw: false, reason: "below-thresholds" };
}

// ---------- Main runner ----------
export async function run(link: LinkInput): Promise<void> {
  const { personId, albumId, apiKey, description } = link;
  const title = description ?? `${personId} → ${albumId}`;
  console.log(`=== ${title} ===`);

  // 1) Enumerate candidate assets for this person (v2.20-safe)
  const enumerated = await getPersonAssetIds(personId, apiKey);
  if (enumerated.length === 0) {
    console.log(`No assets found for person ${personId}; skipping.`);
    return;
  }
  console.log(`Found ${enumerated.length} asset(s) to evaluate (pre-verification).`);

  const flagged: UUID[] = [];
  const safe: UUID[] = [];

  // 2) Evaluate each asset via gate + decision, only if the asset contains personId
  for (const assetId of enumerated) {
    const contains = await assetHasPerson(assetId, personId, apiKey);
    if (!contains) {
      if (NSFW_DEBUG) console.log(`↪︎ Skipping ${assetId} — asset does not contain person ${personId}`);
      continue;
    }
    try {
      const verdict: GateVerdict = await classifyAsset(assetId, apiKey);
      const { w, h } = await getAssetDims(assetId, apiKey);
      const { nsfw, reason, class: label, score } = isNsfwVerdict(verdict, w, h);
      if (nsfw) {
        flagged.push(assetId);
        console.log(
          `⛔ NSFW ${assetId} (${label}=${(score ?? 0).toFixed(2)}, reason=${reason}) — tagging & skipping`,
        );
      } else {
        safe.push(assetId);
        if (NSFW_DEBUG) {
          console.log(`✅ SAFE ${assetId} (top=${verdict.label}:${verdict.score?.toFixed?.(2) ?? "0"})`);
        }
      }
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      if (NSFW_FAIL_MODE === "fail-open") {
        console.warn(`NSFW gate failed for ${assetId} (fail-open) — adding anyway: ${message}`);
        safe.push(assetId);
      } else {
        console.warn(`NSFW gate failed for ${assetId} (fail-closed) — tagging & skipping: ${message}`);
        flagged.push(assetId);
      }
    }
  }

  // 3) Tag NSFW assets
  if (flagged.length > 0) {
    const tagId = await ensureTagId(NSFW_TAG_NAME, apiKey);
    await addAssetsToTag(tagId, flagged, apiKey);
  }

  // 4) Add SAFE assets to album
  if (safe.length > 0) {
    console.log(`➕ Adding ${safe.length} assets to album ${albumId}...`);
    await addAssetsToAlbum(albumId, safe, apiKey);
  }

  // 5) Summary
  console.log(`Done. Safe added: ${safe.length}. Flagged (tagged & skipped): ${flagged.length}.`);
}
