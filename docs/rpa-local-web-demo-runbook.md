# RPA Local Web Demo Runbook

This runbook verifies the local B/S RPA MVP with two live external smoke flows:

1. Google Images keyword search and image download through the codegen hardening path.
2. weather.com.cn city/date weather lookup through the natural-language generation path.

These flows are live smoke demos, not deterministic CI tests. CAPTCHA, consent screens, regional layout changes, unavailable forecast dates, and network failures must be recorded as external blockers.

Use `/demo/mock-rpa-target.html` only as a deterministic fallback when an external site is blocked, or when a repeatable local smoke check is needed before a customer-facing demo.

## Startup

From the repository root, install dependencies if needed:

```bash
pnpm install
```

Start the daemon:

```bash
pnpm dev:daemon
```

In another terminal, start RPA Web:

```bash
pnpm dev:rpa-local-web
```

Open the RPA Web URL printed by the dev server. Confirm the web app can reach daemon health/config before starting a demo flow.

## Demo 1: Google Images Codegen Hardening

Use the Codegen 加固 tab.

- Target URL: `https://www.google.com/imghp?hl=en&ogbl`
- Flow ID: `google_image_download`
- Flow name: `Google image keyword download`
- Example runtime params:
  - `image_keyword`: `sunset mountain`
  - `result_index`: `1`
  - `download_file_name`: `sunset-mountain.jpg`

Recording procedure:

1. Start codegen from RPA Web.
2. In the browser opened by Playwright codegen, search the demo keyword.
3. Open the selected image result so the large preview is visible.
4. Stop codegen.
5. Let RPA Web upload `flow.py` to daemon and run `playwright-rpa-harden`.
6. If a question form appears, answer using the runtime params above.
7. Verify the generated flow in RPA Web.

Hardening expectation:

- Do not use OS right-click Save As during recording.
- The hardened script should resolve the selected image `src` or `currentSrc` and write the image bytes into the execution downloads/artifacts directory.
- Verify mode may confirm the selected image and produce screenshot/log evidence without downloading. Image download should run only when executor mode and dry-run policy allow a local download artifact.

Expected evidence:

- Required artifacts exist: `flow.dsl.json`, `flow.hardened.py`, `config.example.json`, `parameterization-report.md`, `hardening-report.md`.
- Verify execution reaches terminal `succeeded`, or records a clear external-site blocker.
- A current screenshot is visible in RPA Web.
- If download is enabled, an image artifact appears under execution artifacts.

External-site handling:

- If Google shows consent, CAPTCHA, region-specific layout, or automation blocking, stop the live flow and record the result as `external-blocked`.
- Preserve screenshots/logs that show the blocker.
- Continue with the local fallback mock page only to prove the RPA product chain, not as evidence that the live Google flow passed.

## Demo 2: weather.com.cn Natural-Language Generation

Use the 自然语言生成 tab.

- Target URL: `https://www.weather.com.cn/`
- Flow ID: `weather_city_date_lookup`
- Flow name: `Weather city date lookup`
- Example runtime params:
  - `city_name`: `北京`
  - `weather_date`: choose a date visibly available on the forecast page during the demo.

## Weather Preflight

Run this preflight before natural-language generation:

1. Open weather.com.cn manually.
2. Confirm the demo city page is reachable by the intended path, either through site search or a stable direct city URL.
3. Confirm the selected `weather_date` is visible on that page.
4. Confirm the visible forecast card/row includes date label, weather description, high/low temperature, and wind.
5. If city navigation is blocked, the selected date is outside the visible range, or the page is unclear, record the blocker before starting natural-language generation.

Requirement text:

```text
Open weather.com.cn, search or navigate to the city weather page for the city_name runtime parameter, find the weather forecast for weather_date, extract the date label, weather description, high/low temperature, and wind information, then write the result to a local weather-summary.json or weather-summary.md artifact. Do not submit any write operation to the website.
```

Business constraints:

- No login.
- No CAPTCHA solving.
- No write operation to the website.
- If the requested date is outside the visible forecast range, ask the operator to choose a visible forecast date instead of guessing.

Expected evidence:

- Required artifacts exist.
- `flow.dsl.json.params` contains `city_name` and `weather_date`.
- Verify execution reaches terminal `succeeded`, or records a clear external-site blocker.
- Logs show the extracted weather values.
- A weather summary artifact is produced when the script runs in a mode that allows local output artifacts.
- If `weather-summary.json` is produced, it uses this shape:

```json
{
  "city": "北京",
  "date": "2026-06-06",
  "dateLabel": "6月6日",
  "weather": "晴",
  "temperature": {
    "high": "30℃",
    "low": "20℃"
  },
  "wind": "北风 3级",
  "sourceUrl": "https://www.weather.com.cn/"
}
```

External-site handling:

- If weather.com.cn blocks automation, changes navigation, fails to load, or does not show the selected forecast date, record the result as `external-blocked`.
- Preserve screenshots/logs that show the blocker.
- Continue with the local fallback mock page only to prove the RPA product chain, not as evidence that the live weather flow passed.

## Flow Reuse Check

For either generated flow:

1. Open the Flows tab.
2. Load the flow by Flow ID.
3. Export `.rpa.zip`.
4. Import the package into a clean local storage root, or move the original `.rpa-local` aside before import.
5. Confirm imported provenance is shown.
6. Confirm Run is disabled before local Verify succeeds.
7. Run Verify.
8. Confirm Run becomes enabled after successful Verify.

Expected evidence:

- Exported package path is recorded.
- Imported flow ID is recorded.
- Imported package SHA-256 is recorded if available.
- Verify-before-run gate behavior is recorded.
- Verify execution ID after import is recorded.
- Run-enabled-after-verify behavior is recorded.

## Local Fallback Mock Page

If Google Images or weather.com.cn blocks automation, open:

```text
/demo/mock-rpa-target.html
```

Use this page only to verify the RPA product chain deterministically. Record the live-site blocker separately in the results template.

Fallback procedure:

1. Start daemon and RPA Web as described in Startup.
2. Open the fallback page through the RPA Web dev server.
3. For the Google-style path, record or generate against the Mock Image Search section using the same Flow ID, flow name, and runtime params when practical.
4. For the weather-style path, generate against the Mock Weather Lookup section using `city_name` and `weather_date`.
5. Verify the generated fallback flow.
6. Record the fallback run as local fallback evidence, separate from the live external demo result.

Note: the mock image search produces SVG placeholder images. This differs from the live demo's `sunset-mountain.jpg` example and is expected.

Fallback boundary:

- The mock page is a demo fixture.
- It is not daemon core logic.
- It does not replace the live smoke demo documentation.
- It should be used when external sites are blocked, or when a deterministic pre-demo smoke check is needed.

## Result Recording

Use `docs/rpa-local-web-demo-results-template.md` to record the final run.

Record at least:

- Environment versions and URLs.
- Google flow IDs, run IDs, execution IDs, artifact paths, and external blockers.
- Weather flow IDs, run IDs, execution IDs, artifact paths, selected visible date, and external blockers.
- Flow reuse export/import details and verify-before-run gate result.
- Validation command results.
- Final decision: demo ready, blocked by external site, or blocked by product issue.
