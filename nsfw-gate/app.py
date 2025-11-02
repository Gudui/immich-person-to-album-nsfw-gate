from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from nudenet import NudeDetector

app = FastAPI(title="NSFW Gate", version="1.0.1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

detector = NudeDetector()

NSFW_KEYS = {
    "EXPOSED_BREAST",
    "FEMALE_BREAST_EXPOSED",
    "EXPOSED_GENITALIA",
    "MALE_BREAST_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "BUTTOCKS_EXPOSED",
    "EXPOSED_BUTTOCKS",
    "PUBIC_AREA_EXPOSED",
}

def norm_label(raw):
    if not raw:
        return ""
    s = str(raw).strip().upper().replace("-", "_")
    s = s.replace(" ", "_")
    # Common variants mapping
    if s == "EXPOSED_BUTTOCKS":
        s = "BUTTOCKS_EXPOSED"
    if s == "EXPOSED_PUBIC_AREA":
        s = "PUBIC_AREA_EXPOSED"
    return s

@app.post("/classify")
async def classify(file: UploadFile = File(...)):
    """
    Returns:
      { "score": float, "label": str, "detections": [{label, class, score, box}, ...] }
    """
    img_bytes = await file.read()
    dets = detector.detect(img_bytes)  # list of dict

    # Normalize detections and ensure both 'label' and 'class' are present
    norm_dets = []
    for d in dets:
        raw = d.get("label", d.get("class", ""))
        L = norm_label(raw)
        norm_dets.append({
            "label": L,               # normalized
            "class": L,               # duplicate for clients that read 'class'
            "score": float(d.get("score", 0.0)),
            "box": d.get("box", []),  # NudeNet uses [x, y, w, h]
        })

    # Promote top explicit class to top-level; accept EXPOSED_* or *_EXPOSED
    explicit = [d for d in norm_dets if (d["label"] in NSFW_KEYS)]
    if explicit:
        top = max(explicit, key=lambda d: d["score"])
        return {"score": top["score"], "label": top["label"].lower(), "detections": norm_dets}

    # Fallback: no explicit classes -> "none"
    return {"score": 0.0, "label": "none", "detections": norm_dets}
