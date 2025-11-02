# immich-person-to-album + NSFW Gate (local-only)

Automate “person → album” population in Immich **with a strict, NudeNet-aligned NSFW filter**.
Only assets that:

1. **Contain the configured person**, and
2. **Pass the exposed-region gate** (NudeNet classes)

…are added to the target album. Anything tripping the gate is **tagged** and **not** added.

> This setup is fully local. You build both images and run with Docker Compose.
> No images are fetched from or sent to the internet.

---

## Features

* **Strict person scoping**
  Enumerate by person and re-verify each asset contains `personId` via `/api/assets/:id` (`people[]`/`faces[].personId`).

* **High-recall exposed-region filtering** (NudeNet taxonomy only)
  Classes: `FEMALE_BREAST_EXPOSED`, `MALE_BREAST_EXPOSED`, `FEMALE_GENITALIA_EXPOSED`, `MALE_GENITALIA_EXPOSED`, `PUBIC_AREA_EXPOSED`, `BUTTOCKS_EXPOSED` (+ normalized synonyms).

* **Robust decisioning**

  * Per-class **minimum area** floors (tiny but meaningful regions still count)
  * **Area-aware easing** of thresholds for large coverage
  * **Same-class consensus** (multiple medium hits)
  * **AWUG**: Area-Weighted Union Gate — (\sum_c U_c \cdot S_c \ge \tau)
  * **XCC**: Cross-Class Consensus — multiple explicit classes each with medium scores
  * **Weak-top rescue** for explicit top labels near threshold

* **Immich v2.20-safe**
  Enumeration via `POST /api/search/metadata` with pagination guards.

* **No external dependencies**
  Tag API used directly: `GET/POST /api/tags`, `PUT /api/tags/:id/assets`.

---

## Requirements

* Docker + Docker Compose
* Immich **v2.20+**
* Immich **API key** with access to:

  * people, assets, albums, tags

---

## Directory Layout

```
.
├─ nsfw-gate/
│  ├─ Dockerfile
│  ├─ app.py
│  ├─ requirements.txt
│  └─ healthcheck.jpg           # any harmless local image for liveness
└─ repos/
   └─ immich-person-to-album/
      ├─ Dockerfile
      ├─ package.json
      ├─ tsconfig.json
      └─ src/
         └─ function.ts         # <-- drop-in from this repo
```

---

## Quick Start

1. Place files as shown above.
2. Edit `docker-compose.yml` (example below) — set `IMMICH_API_URL`, `IMMICH_API_KEY`, and the `CONFIG` block (person/album UUIDs).
3. Build & run:

   ```bash
   docker compose build nsfw-gate
   docker compose build immich-person-to-album
   docker compose up -d
   ```
4. Tail logs:

   ```bash
   docker logs -f immich_person_to_album
   ```

---

## docker-compose.yml (example)

```yaml
version: "3.8"

services:
  nsfw-gate:
    build: ./nsfw-gate
    image: local/nsfw-gate:latest
    container_name: nsfw_gate
    restart: unless-stopped
    ports:
      - "9109:9109"   # optional if everything shares the same docker network
    volumes:
      - /home/you/nsfw-gate:/nsfw-gate
    healthcheck:
      test: ["CMD-SHELL", "curl -sf -X POST -F \"file=@/nsfw-gate/healthcheck.jpg\" http://localhost:9109/classify | grep -q '\"score\"'"]
      interval: 60s
      timeout: 10s
      retries: 3

  immich-person-to-album:
    build:
      context: ./repos/immich-person-to-album
    image: local/immich-person-to-album:patched
    container_name: immich_person_to_album
    restart: unless-stopped

    environment:
      - IMMICH_API_URL=http://immich-server:2283
      - IMMICH_API_KEY=REPLACE_WITH_YOUR_API_KEY
      - NSFW_GATE_URL=http://nsfw-gate:9109/classify
      - NSFW_THRESHOLD=0.55
      - NSFW_FAIL_MODE=fail-closed
      - NSFW_TAG_NAME=nsfw-auto
      - NSFW_MIN_AREA_RATIO=0.01
      - NSFW_MIN_AREA_RATIO_PER_CLASS={"BUTTOCKS_EXPOSED":0.0025,"PUBIC_AREA_EXPOSED":0.0025,"MALE_GENITALIA_EXPOSED":0.0025,"FEMALE_GENITALIA_EXPOSED":0.0025,"MALE_BREAST_EXPOSED":0.0035,"FEMALE_BREAST_EXPOSED":0.0035}
      - NSFW_DEBUG=1
      - NSFW_ALWAYS_ORIGINAL=1
      - NSFW_AREA_UNION_SCORE_GATE=0.007
      - NSFW_XCC_MIN_SCORE=0.43
      - NSFW_XCC_MIN_CLASSES=2
      - AREA_EASE_GAIN=0.60
      - AREA_EASE_MAX=0.18
      - TZ=Europe/Copenhagen
      - |
        CONFIG={
          "immichServer": "http://immich-server:2283",
          "schedule": "*/10 * * * *",
          "users": [
            {
              "apiKey": "REPLACE_WITH_YOUR_API_KEY",
              "personLinks": [
                {
                  "description": "Person A",
                  "personId": "11111111-1111-1111-1111-111111111111",
                  "albumId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
                },
                {
                  "description": "Person B",
                  "personId": "22222222-2222-2222-2222-222222222222",
                  "albumId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
                }
              ]
            }
          ]
        }
    depends_on:
      - nsfw-gate
    volumes:
      - /media/config/immich-person-to-album:/data
```

> Use **UUIDs** from your Immich instance. Do **not** commit secrets or real IDs.

---

## Configuration (ENV)

| Variable                        | Purpose                          | Default       |
| ------------------------------- | -------------------------------- | ------------- |
| `IMMICH_API_URL`                | Immich base URL                  | —             |
| `IMMICH_API_KEY`                | Immich API key                   | —             |
| `NSFW_GATE_URL`                 | nsfw-gate classify endpoint      | —             |
| `NSFW_THRESHOLD`                | Global top-label threshold       | `0.55`        |
| `NSFW_FAIL_MODE`                | `fail-closed` or `fail-open`     | `fail-closed` |
| `NSFW_TAG_NAME`                 | Tag applied to NSFW assets       | `nsfw-auto`   |
| `NSFW_MIN_AREA_RATIO`           | Global min area fallback (ratio) | `0.01`        |
| `NSFW_MIN_AREA_RATIO_PER_CLASS` | JSON per-class min area          | see compose   |
| `NSFW_ALWAYS_ORIGINAL`          | Prefer original over preview     | `0`           |
| `NSFW_DEBUG`                    | Verbose logging                  | `0`           |
| `NSFW_AREA_UNION_SCORE_GATE`    | **AWUG τ**                       | `0.008`       |
| `NSFW_XCC_MIN_SCORE`            | **XCC** per-class min            | `0.43`        |
| `NSFW_XCC_MIN_CLASSES`          | **XCC** class count              | `2`           |
| `AREA_EASE_GAIN`                | Easing slope vs √area            | `0.50`        |
| `AREA_EASE_MAX`                 | Easing cap                       | `0.15`        |

---

## How it decides (summary)

1. **Normalize** common synonyms to NudeNet canon:

   * `EXPOSED_BREAST_F` → `FEMALE_BREAST_EXPOSED`
   * `EXPOSED_BREAST_M` → `MALE_BREAST_EXPOSED`
   * `EXPOSED_GENITALIA_F/M` → `FEMALE_GENITALIA_EXPOSED` / `MALE_GENITALIA_EXPOSED`
   * `EXPOSED_BUTTOCKS` → `BUTTOCKS_EXPOSED`
   * `EXPOSED_PUBIC_AREA` → `PUBIC_AREA_EXPOSED`

2. **Per-class min area** keeps tiny but relevant regions.

3. **Area-aware easing** reduces per-class thresholds with increasing union area.

4. **Same-class consensus**: multiple medium hits of the same class → NSFW.

5. **AWUG**: (\sum_c (\text{unionArea}_c \times \text{maxScore}_c)) ≥ τ → NSFW.

6. **XCC**: ≥K distinct explicit classes each ≥ `NSFW_XCC_MIN_SCORE` → NSFW.

7. **Weak-top rescue** for explicit top labels near threshold.

8. **Global top threshold**: final guard via `NSFW_THRESHOLD`.

**Person scoping:** Each candidate is re-checked. If `/api/assets/:id` doesn’t show the configured `personId` in `people[]` or `faces[].personId`, the asset is **not** added.

---

## Logs

* SAFE:

  ```
  ✅ SAFE <assetId> (top=<label>:<score>)
  ```
* NSFW:

  ```
  ⛔ NSFW <assetId> (<class>=<score>, reason=<area-eased|consensus|union-area-score|cross-class-consensus|top-weak-rescue|top-threshold>)
  ```
* Person guard:

  ```
  ↪︎ Skipping <assetId> — asset does not contain person <personId>
  ```

---

## Tuning (no rebuild)

* **Missed explicit**

  * `NSFW_AREA_UNION_SCORE_GATE=0.007` (more recall)
  * Lower specific class thresholds via `NSFW_CLASS_THRESHOLDS` (JSON)
  * Slightly reduce per-class area floors in `NSFW_MIN_AREA_RATIO_PER_CLASS`

* **Too many positives**

  * `NSFW_XCC_MIN_SCORE=0.45`
  * `AREA_EASE_GAIN=0.45`
  * Raise a specific class threshold in `NSFW_CLASS_THRESHOLDS`

After changes:

```bash
docker compose up -d immich-person-to-album
```

---

## Troubleshooting

* **Tags endpoint error (“Failed to parse URL …/api/tags”)**
  `IMMICH_API_URL` must be a valid URL (e.g., `http://immich-server:2283`), not your API key.

* **No assets added**

  * Confirm person link UUIDs are correct.
  * Ensure API key has rights.
  * Check for “asset does not contain person …” messages.

* **nsfw-gate healthcheck fails**

  * Ensure the bind mount path and `healthcheck.jpg` exist inside the container.
  * Manual test:

    ```bash
    curl -X POST -F "file=@/path/to/local.jpg" http://localhost:9109/classify
    ```

---

## Security & Privacy

* Entire pipeline is local.
* Do not commit real UUIDs, API keys, or sample media.

---

## FAQ

**Q: Does this broaden to non-NudeNet classes?**
A: No. It strictly uses the exposed-region classes listed above; no taxonomy creep.

**Q: Why re-verify person membership?**
A: Enumeration can return stacked/related assets. Re-verification prevents cross-contamination.

---

## License

Follow upstream `immich-person-to-album` licensing for your fork. NudeNet model licensing remains under its original terms.
