# RPA Demo Flow And Compatibility Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock two low-risk external demo flows and a compatibility gate so the local B/S RPA MVP can be demonstrated and verified repeatably.

**Architecture:** Use RPA Web as the operator-facing demo surface and keep all demo/runbook material outside daemon core. The Google Images flow exercises the codegen-upload-hardening path; the weather.com.cn flow exercises the natural-language-generation path. External sites are treated as live smoke targets, not CI fixtures, because CAPTCHA, anti-bot rules, layout changes, and data freshness are outside our control. A small local fallback mock page is included as a P1 demo target so product-chain verification remains repeatable when external sites are blocked.

**Tech Stack:** Markdown runbooks, RPA Web codegen/NL flows, local Python Playwright executor, existing `.rpa.zip` import/export, existing RPA review bundle and execution artifacts.

---

## Demo Scope

### Demo 1: Google Images Keyword Search And Image Download

- **Primary production path:** Playwright codegen upload and hardening.
- **Target URL:** `https://www.google.com/imghp?hl=en&ogbl`.
- **Flow ID:** `google_image_download`.
- **Flow title:** `Google image keyword download`.
- **Runtime params:**
  - `image_keyword`: string, required, example `sunset mountain`.
  - `result_index`: number, optional, default `1`.
  - `download_file_name`: string, optional, default derived from keyword.
- **Operator action during codegen recording:** search the keyword, open the selected image result, stop recording after the large preview is visible.
- **Hardening expectation:** do not rely on OS right-click Save As. The hardened script should resolve the selected image `src` / `currentSrc` and write the image bytes into the execution downloads/artifacts directory.
- **Verify expectation:** in verify mode, the script can locate the image and produce a screenshot/log without writing a high-risk site action; image download may run only when the executor mode and dry-run policy allow a local download artifact.
- **External risk:** Google may show consent, CAPTCHA, region-specific layout, or block automation. If that occurs, record it as `external-blocked`, not as a product regression.

### Demo 2: weather.com.cn City/Date Weather Lookup

- **Primary production path:** natural-language script generation.
- **Target URL:** `https://www.weather.com.cn/`.
- **Flow ID:** `weather_city_date_lookup`.
- **Flow title:** `Weather city date lookup`.
- **Runtime params:**
  - `city_name`: string, required, example `北京`.
  - `weather_date`: date, required, must be within the forecast dates visible on the site during the demo.
- **Natural-language requirement:** search or navigate to the city weather page, find the row/card for `weather_date`, and extract weather description, high/low temperature, wind, and date label.
- **Output expectation:** write a small local artifact such as `weather-summary.json` or `weather-summary.md` under the execution artifact directory, and log the extracted values.
- **Expected JSON shape:** if the script writes `weather-summary.json`, use `{ "city": string, "date": string, "dateLabel": string, "weather": string, "temperature": { "high": string, "low": string }, "wind": string, "sourceUrl": string }`.
- **Verify expectation:** verify mode confirms navigation, city page resolution, date matching, and extraction without any write operation to the website.
- **External risk:** forecast range and city-search UI are time-sensitive. The demo date must be chosen from visible forecast dates on the day of the demo.

### Fallback Demo: Local Mock Search And Weather Page

- **Purpose:** provide a deterministic local target for product-chain verification when Google Images or weather.com.cn are blocked by network, CAPTCHA, consent, or layout drift.
- **Target route:** served by RPA Web under `/demo/mock-rpa-target.html`.
- **Coverage:** one page contains a Google-like image search area and a weather-like city/date forecast area.
- **Expected use:** run the same codegen and natural-language flows against the mock page only when the live external demo is blocked or when a repeatable smoke check is needed before customer-facing demo.
- **Boundary:** the mock page is a demo fixture, not product logic. It must not enter daemon core and must not replace live smoke demo documentation.

## Confirmation Gates

Before implementation starts, confirm these operator choices:

- Google Images default keyword for the demo.
- Whether the Google flow is allowed to create a local downloaded image artifact during verify, or only during run.
- weather.com.cn default city.
- weather.com.cn demo date rule: use today's visible forecast date, tomorrow, or a manually entered visible date.
- Local fallback mock page is required as a P1 task before manual demo verification.

## Prompt Fixture Boundary

This plan may include operator-facing prompt fixtures that are demo artifacts under `apps/rpa-local-web/demo/prompts/`. Those fixtures are part of the product demo runbook and are allowed.

Do not include reviewer-facing CC prompts in this plan or in the generated docs. CC review prompts should stay in chat only so the planning documents remain product/runbook material.

---

## File Structure

Create:

- `docs/rpa-local-web-demo-runbook.md`  
  Human-run demo steps for daemon + RPA Web startup, Google Images codegen path, weather.com.cn natural-language path, import/export reuse, and expected evidence.
- `docs/rpa-local-web-compatibility-checklist.md`  
  Environment checklist for Node, pnpm, Python, Playwright browser install, headed browser, screenshots, downloads, trace/video optionality, local Chrome path override, and network access.
- `docs/rpa-local-web-demo-results-template.md`  
  A short template for recording demo results, external-site blockers, generated flow IDs, execution IDs, artifact paths, and review bundle paths.
- `apps/rpa-local-web/demo/prompts/google-images-codegen-handoff.md`  
  Operator notes for what to record with Playwright codegen and what the hardening skill should produce.
- `apps/rpa-local-web/demo/prompts/weather-natural-language-request.md`  
  Natural-language prompt fixture for the weather.com.cn flow.
- `apps/rpa-local-web/public/demo/mock-rpa-target.html`  
  Static fallback target with image-search and weather-lookup sections for repeatable local smoke checks.

Modify:

- `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`  
  Link this execution plan under the `Demo Flow And Compatibility Gate` slice. Mark completed only after implementation, manual demo verification, and CC review.

No product source changes are required unless the demo run exposes a product defect. The static fallback mock page is allowed because it is a demo fixture under `apps/rpa-local-web/public/demo/`, not RPA product logic. If a product defect appears, stop and create a focused fix plan instead of hiding the issue in demo docs.

---

## Task 1: Demo Runbook

**Files:**
- Create: `docs/rpa-local-web-demo-runbook.md`

- [ ] **Step 1: Create the runbook with startup commands**

Create `docs/rpa-local-web-demo-runbook.md` with:

```markdown
# RPA Local Web Demo Runbook

This runbook verifies the local B/S RPA MVP with two live external smoke flows:

1. Google Images keyword search and image download through the codegen hardening path.
2. weather.com.cn city/date weather lookup through the natural-language generation path.

These flows are live smoke demos, not deterministic CI tests. CAPTCHA, consent screens, regional layout changes, and network failures must be recorded as external blockers.

## Startup

From the repository root:

```bash
pnpm install
pnpm dev:daemon
```

In another terminal:

```bash
pnpm dev:rpa-local-web
```

Open the RPA Web URL printed by the dev server.

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

Expected evidence:

- Required artifacts exist: `flow.dsl.json`, `flow.hardened.py`, `config.example.json`, `parameterization-report.md`, `hardening-report.md`.
- Verify execution reaches terminal `succeeded`, or records a clear external-site blocker.
- A current screenshot is visible in RPA Web.
- If download is enabled, an image artifact appears under execution artifacts.

## Demo 2: weather.com.cn Natural-Language Generation

Use the 自然语言生成 tab.

- Target URL: `https://www.weather.com.cn/`
- Flow ID: `weather_city_date_lookup`
- Flow name: `Weather city date lookup`
- Example runtime params:
  - `city_name`: `北京`
  - `weather_date`: choose a date visibly available on the forecast page during the demo.

Preflight:

1. Open weather.com.cn manually.
2. Confirm the demo city page is reachable by the intended path, either through site search or a stable direct city URL.
3. Confirm the selected weather date is visible on that page.
4. If city navigation is blocked or unclear, record the blocker before starting natural-language generation.

Requirement text:

```text
Open weather.com.cn, search or navigate to the city weather page for the city_name runtime parameter, find the weather forecast for weather_date, extract the date label, weather description, high/low temperature, and wind information, then write the result to a local weather-summary.json or weather-summary.md artifact. Do not submit any write operation to the website.
```

Expected evidence:

- Required artifacts exist.
- `flow.dsl.json.params` contains `city_name` and `weather_date`.
- Verify execution reaches terminal `succeeded`, or records a clear external-site blocker.
- Logs show the extracted weather values.
- A weather summary artifact is produced when the script runs in a mode that allows local output artifacts.
- If `weather-summary.json` is produced, it uses:

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

## Flow Reuse Check

For either generated flow:

1. Open the Flows tab.
2. Load the flow by Flow ID.
3. Export `.rpa.zip`.
4. Import the package into a clean local storage root or after moving the original `.rpa-local` aside.
5. Confirm imported provenance is shown.
6. Confirm Run is disabled before local Verify succeeds.
7. Run Verify.
8. Confirm Run becomes enabled after successful Verify.

## Result Recording

Use `docs/rpa-local-web-demo-results-template.md` to record the final run.
```

- [ ] **Step 2: Review runbook for unsupported promises**

Check that the runbook does not claim:

- Google will always allow automation.
- weather.com.cn always exposes arbitrary dates.
- Verify mode always downloads an image.
- The demo is a CI test.

Expected: the runbook consistently describes these as live smoke demos.

---

## Task 2: Demo Prompt Fixtures

**Files:**
- Create: `apps/rpa-local-web/demo/prompts/google-images-codegen-handoff.md`
- Create: `apps/rpa-local-web/demo/prompts/weather-natural-language-request.md`

- [ ] **Step 1: Create demo prompt directory**

Run:

```bash
mkdir -p apps/rpa-local-web/demo/prompts
```

- [ ] **Step 2: Add Google codegen handoff fixture**

Create `apps/rpa-local-web/demo/prompts/google-images-codegen-handoff.md`:

```markdown
# Google Images Codegen Handoff

Use this note while recording `google_image_download` through Playwright codegen.

## Recording Inputs

- Target URL: `https://www.google.com/imghp?hl=en&ogbl`
- Flow ID: `google_image_download`
- Flow name: `Google image keyword download`
- Demo keyword: `sunset mountain`

## Record Only This

1. Search the keyword.
2. Open the chosen image result.
3. Stop after the large image preview is visible.

Do not use OS right-click Save As during recording. The hardened script should resolve the image URL and save the bytes as a local execution artifact.

## Expected DSL Params

```json
{
  "image_keyword": {
    "type": "string",
    "label": "Image keyword",
    "required": true
  },
  "result_index": {
    "type": "number",
    "label": "Result index",
    "required": false,
    "default": 1
  },
  "download_file_name": {
    "type": "string",
    "label": "Download file name",
    "required": false
  }
}
```

## Expected Local Artifact

- Role: `download`
- Example file: `sunset-mountain.jpg`
```

- [ ] **Step 3: Add weather natural-language fixture**

Create `apps/rpa-local-web/demo/prompts/weather-natural-language-request.md`:

```markdown
# weather.com.cn Natural-Language Request

Use this fixture in the 自然语言生成 tab.

## Request

Target URL:

```text
https://www.weather.com.cn/
```

Flow ID:

```text
weather_city_date_lookup
```

Flow name:

```text
Weather city date lookup
```

Requirement:

```text
Open weather.com.cn, search or navigate to the city weather page for the city_name runtime parameter, find the weather forecast for weather_date, extract the date label, weather description, high/low temperature, and wind information, then write the result to a local weather-summary.json or weather-summary.md artifact. Do not submit any write operation to the website.
```

Business constraints:

```text
No login, no captcha solving, no write operation to the website. If the requested date is outside the visible forecast range, ask the user to choose a visible forecast date instead of guessing.
```

Safety notes:

```text
This is a live external smoke demo. If the site blocks automation or changes layout, report the blocker clearly and preserve screenshots/logs.
```

## Expected DSL Params

```json
{
  "city_name": {
    "type": "string",
    "label": "City name",
    "required": true
  },
  "weather_date": {
    "type": "date",
    "label": "Weather date",
    "required": true
  }
}
```

## Expected Summary Artifact

If the script writes `weather-summary.json`, use this shape:

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
```

- [ ] **Step 4: Run markdown smoke check**

Run:

```bash
rg -n "XXX|FIXME|fill[[:space:]]+in" apps/rpa-local-web/demo/prompts docs/rpa-local-web-demo-runbook.md
```

Expected: no output.

---

## Task 3: Local Fallback Mock Page

**Files:**
- Create: `apps/rpa-local-web/public/demo/mock-rpa-target.html`

- [ ] **Step 1: Create static demo fixture directory**

Run:

```bash
mkdir -p apps/rpa-local-web/public/demo
```

- [ ] **Step 2: Create the mock page**

Create `apps/rpa-local-web/public/demo/mock-rpa-target.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RPA Mock Target</title>
    <style>
      body {
        margin: 0;
        font-family: Arial, sans-serif;
        color: #1f2937;
        background: #f8fafc;
      }
      main {
        max-width: 960px;
        margin: 0 auto;
        padding: 24px;
      }
      section {
        margin-bottom: 24px;
        border: 1px solid #d8e0ea;
        border-radius: 6px;
        background: #fff;
        padding: 16px;
      }
      label {
        display: block;
        margin-bottom: 6px;
        font-weight: 700;
      }
      input,
      button {
        min-height: 34px;
        font: inherit;
      }
      input {
        min-width: 260px;
        border: 1px solid #b8c3d1;
        border-radius: 4px;
        padding: 4px 8px;
      }
      button {
        margin-left: 8px;
        border: 1px solid #1d4ed8;
        border-radius: 4px;
        background: #2563eb;
        color: #fff;
        padding: 4px 12px;
        cursor: pointer;
      }
      .results {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 14px;
      }
      .image-card,
      .weather-card {
        border: 1px solid #d8e0ea;
        border-radius: 6px;
        padding: 10px;
        background: #fdfefe;
      }
      .image-card img {
        width: 100%;
        aspect-ratio: 4 / 3;
        object-fit: cover;
        border-radius: 4px;
      }
      .weather-card[hidden],
      .image-card[hidden] {
        display: none;
      }
      .download-link {
        display: inline-block;
        margin-top: 8px;
      }
      pre {
        white-space: pre-wrap;
        background: #eef3f8;
        border-radius: 4px;
        padding: 8px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>RPA Mock Target</h1>
      <p>This local page is a deterministic fallback for RPA demo verification.</p>

      <section aria-labelledby="image-title">
        <h2 id="image-title">Mock Image Search</h2>
        <form id="image-form">
          <label for="image-keyword">Image keyword</label>
          <input id="image-keyword" name="image_keyword" value="sunset mountain" />
          <button id="image-search-button" type="submit">Search images</button>
        </form>
        <div id="image-results" class="results" aria-live="polite"></div>
      </section>

      <section aria-labelledby="weather-title">
        <h2 id="weather-title">Mock Weather Lookup</h2>
        <form id="weather-form">
          <label for="city-name">City name</label>
          <input id="city-name" name="city_name" value="北京" />
          <label for="weather-date">Weather date</label>
          <input id="weather-date" name="weather_date" type="date" value="2026-06-06" />
          <button id="weather-search-button" type="submit">Lookup weather</button>
        </form>
        <div id="weather-results" class="results" aria-live="polite"></div>
        <h3>Weather summary JSON</h3>
        <pre id="weather-summary-json">{}</pre>
      </section>
    </main>

    <script>
      const imageData = [
        { title: 'Sunset mountain 1', color: '#f97316' },
        { title: 'Sunset mountain 2', color: '#0ea5e9' },
        { title: 'Sunset mountain 3', color: '#22c55e' }
      ];

      const weatherData = [
        { city: '北京', date: '2026-06-06', dateLabel: '6月6日', weather: '晴', high: '30℃', low: '20℃', wind: '北风 3级' },
        { city: '北京', date: '2026-06-07', dateLabel: '6月7日', weather: '多云', high: '29℃', low: '21℃', wind: '南风 2级' },
        { city: '上海', date: '2026-06-06', dateLabel: '6月6日', weather: '小雨', high: '27℃', low: '22℃', wind: '东风 3级' }
      ];

      function svgDataUri(title, color) {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">' +
          '<rect width="640" height="480" fill="' + color + '"/>' +
          '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="32" fill="white">' +
          title +
          '</text></svg>';
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      }

      document.getElementById('image-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const keyword = document.getElementById('image-keyword').value.trim() || 'demo image';
        const container = document.getElementById('image-results');
        container.innerHTML = '';
        imageData.forEach((item, index) => {
          const title = keyword + ' result ' + (index + 1);
          const imageUrl = svgDataUri(title, item.color);
          const card = document.createElement('article');
          card.className = 'image-card';
          card.setAttribute('data-result-index', String(index + 1));
          card.innerHTML =
            '<h3>' + title + '</h3>' +
            '<img alt="' + title + '" src="' + imageUrl + '" data-download-url="' + imageUrl + '" />' +
            '<a class="download-link" download="' + keyword.replace(/\\s+/g, '-') + '-' + (index + 1) + '.svg" href="' + imageUrl + '">Download image</a>';
          container.appendChild(card);
        });
      });

      document.getElementById('weather-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const city = document.getElementById('city-name').value.trim();
        const date = document.getElementById('weather-date').value;
        const match = weatherData.find((item) => item.city === city && item.date === date);
        const container = document.getElementById('weather-results');
        container.innerHTML = '';
        const summary = match
          ? {
              city: match.city,
              date: match.date,
              dateLabel: match.dateLabel,
              weather: match.weather,
              temperature: { high: match.high, low: match.low },
              wind: match.wind,
              sourceUrl: window.location.href
            }
          : {
              city,
              date,
              error: 'No visible forecast card matched the requested city/date.',
              sourceUrl: window.location.href
            };
        const card = document.createElement('article');
        card.className = 'weather-card';
        card.innerHTML = match
          ? '<h3>' + summary.city + ' ' + summary.dateLabel + '</h3><p class="weather-desc">' + summary.weather + '</p><p class="temp">' + summary.temperature.high + ' / ' + summary.temperature.low + '</p><p class="wind">' + summary.wind + '</p>'
          : '<h3>No match</h3><p>No visible forecast card matched the requested city/date.</p>';
        container.appendChild(card);
        document.getElementById('weather-summary-json').textContent = JSON.stringify(summary, null, 2);
      });
    </script>
  </body>
</html>
```

- [ ] **Step 3: Add mock page references to runbook**

In `docs/rpa-local-web-demo-runbook.md`, add a fallback section:

```markdown
## Local Fallback Mock Page

If Google Images or weather.com.cn blocks automation, open:

```text
/demo/mock-rpa-target.html
```

Use this page only to verify the RPA product chain deterministically. Record the live-site blocker separately in the results template.
```

- [ ] **Step 4: Smoke check the mock page file**

Run:

```bash
rg -n "Mock Image Search|Mock Weather Lookup|download-link|weather-summary-json" apps/rpa-local-web/public/demo/mock-rpa-target.html
```

Expected: all key markers are present.

---

## Task 4: Compatibility Checklist

**Files:**
- Create: `docs/rpa-local-web-compatibility-checklist.md`

- [ ] **Step 1: Create compatibility checklist**

Create `docs/rpa-local-web-compatibility-checklist.md`:

```markdown
# RPA Local Web Compatibility Checklist

Use this checklist before declaring the local B/S RPA MVP ready for demo.

## Node And Package Runtime

- [ ] `node --version` is available and matches the project-supported Node version.
- [ ] `corepack enable` has been run if pnpm is not available.
- [ ] `pnpm install` completes.
- [ ] `pnpm typecheck` completes.
- [ ] `pnpm build` completes.

## Daemon

- [ ] `pnpm dev:daemon` starts without exposing secrets in logs.
- [ ] The selected profile allows the RPA skills.
- [ ] `rpa-script-generate` is available.
- [ ] `playwright-rpa-harden` is available.
- [ ] `chrome-devtools-mcp` is profile-provided if used by natural-language exploration.

## RPA Web

- [ ] `pnpm dev:rpa-local-web` starts.
- [ ] RPA Web can reach daemon health.
- [ ] Codegen tab can start and cancel a recording.
- [ ] Natural-language tab can create a generation session.
- [ ] Flows tab can export and import `.rpa.zip`.
- [ ] Execution tab can start verify and show logs/screenshots.

## Python And Playwright

- [ ] Python command configured for RPA executor is available.
- [ ] Required Python packages are installed for generated scripts; use each flow's `config.example.json` as the operator-facing dependency/config hint, with Python Playwright as the MVP baseline.
- [ ] Playwright browser dependencies are installed.
- [ ] Headed browser mode works on the local OS.
- [ ] Headless browser mode works on the local OS.
- [ ] Screenshot capture works.
- [ ] Download artifact writing works.
- [ ] Trace/video behavior is understood; trace/video remain optional for this MVP.

## Browser And Network

- [ ] Google Images opens from the demo machine.
- [ ] weather.com.cn opens from the demo machine.
- [ ] External site consent/CAPTCHA blockers are recorded if encountered.
- [ ] Local Chrome path override is documented if bundled Chromium is not suitable.

## Security And Data

- [ ] Demo uses no login, no CA/USB-Key, no real write operation.
- [ ] `.rpa.zip` export does not contain `storage_state`, cookies, tokens, secrets, trace, video, or downloaded image files.
- [ ] Screenshots and logs are reviewed for sensitive information before sharing.
- [ ] `.rpa-local/` remains out of git.
```

- [ ] **Step 2: Run checklist grep**

Run:

```bash
rg -n "CA/USB|storage_state|trace|video|chrome-devtools-mcp|pnpm dev:rpa-local-web" docs/rpa-local-web-compatibility-checklist.md
```

Expected: all key compatibility topics are present.

---

## Task 5: Demo Results Template

**Files:**
- Create: `docs/rpa-local-web-demo-results-template.md`

- [ ] **Step 1: Create results template**

Create `docs/rpa-local-web-demo-results-template.md`:

```markdown
# RPA Local Web Demo Results

Date:
Operator:
Machine / OS:
Branch / commit:

## Environment

- Node:
- pnpm:
- Python:
- Browser mode:
- Daemon URL:
- RPA Web URL:

## Demo 1: Google Images Codegen Hardening

- Flow ID: `google_image_download`
- Keyword:
- Codegen session ID:
- Daemon run ID:
- Conversation ID:
- Verify execution ID:
- Terminal status:
- Download artifact path:
- Screenshot artifact path:
- External blocker, if any:
- Notes:

## Demo 2: weather.com.cn Natural-Language Generation

- Flow ID: `weather_city_date_lookup`
- City:
- Weather date:
- Natural-language session ID:
- Daemon run ID:
- Conversation ID:
- Verify execution ID:
- Terminal status:
- Summary artifact path:
- Screenshot artifact path:
- External blocker, if any:
- Notes:

## Flow Reuse

- Exported package:
- Imported flow ID:
- Imported package SHA-256:
- Verify-before-run gate observed:
- Verify execution ID after import:
- Run enabled after verify:

## Validation Commands

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test
pnpm typecheck
pnpm build
git diff --check
rg -n "RPA|Playwright|DSL|selector|screenshot|trace|video|executionId|flowId|executor|chrome-devtools|mcp" apps/daemon/src
```

## Final Decision

- [ ] Demo ready.
- [ ] Demo blocked by external site.
- [ ] Demo blocked by product issue that needs a fix.
```

- [ ] **Step 2: Confirm runtime outputs are not committed**

Run:

```bash
git check-ignore .rpa-local
```

Expected: `.rpa-local` is ignored.

---

## Task 6: Manual Demo Verification

**Files:**
- Runtime-only: `.rpa-local/`
- Update after run: `docs/rpa-local-web-demo-results-template.md` copied to an untracked/local result file if needed.

- [ ] **Step 1: Run static verification before manual demo**

Run:

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test
pnpm typecheck
pnpm build
git diff --check
rg -n "RPA|Playwright|DSL|selector|screenshot|trace|video|executionId|flowId|executor|chrome-devtools|mcp" apps/daemon/src
```

Expected:

- RPA Web tests pass.
- Typecheck passes.
- Build passes.
- Diff check has no output.
- Daemon boundary grep has no output or only known generic MIME/path terms; no RPA business semantics.

- [ ] **Step 2: Start local services**

Run daemon:

```bash
pnpm dev:daemon
```

Run RPA Web:

```bash
pnpm dev:rpa-local-web
```

Expected:

- Daemon starts.
- RPA Web starts.
- RPA Web health/config calls succeed.

- [ ] **Step 3: Execute Google Images codegen demo**

Use `docs/rpa-local-web-demo-runbook.md` and `apps/rpa-local-web/demo/prompts/google-images-codegen-handoff.md`.

Expected:

- Codegen recording produces `flow.py`.
- Daemon hardening produces required artifacts.
- RPA Web validates DSL/artifacts.
- Verify reaches `succeeded`, or the result is recorded as an external blocker such as CAPTCHA/consent/automation block.

- [ ] **Step 4: Execute weather.com.cn natural-language demo**

Use `docs/rpa-local-web-demo-runbook.md` and `apps/rpa-local-web/demo/prompts/weather-natural-language-request.md`.

Expected:

- Operator manually confirms the city page path and visible date before generation.
- Natural-language generation produces required artifacts.
- `flow.dsl.json.params` contains `city_name` and `weather_date`.
- Verify reaches `succeeded`, or the result is recorded as an external blocker such as unsupported date, network failure, or automation block.

- [ ] **Step 5: Execute flow reuse demo**

For at least one successfully generated flow:

1. Export `.rpa.zip`.
2. Import it into a clean flow storage state.
3. Confirm provenance is visible.
4. Confirm Run is disabled before Verify.
5. Run Verify.
6. Confirm Run becomes enabled after Verify succeeds.

Expected: flow reuse works without carrying secrets or previous execution artifacts.

---

## Task 7: Main Plan Update And Commit

**Files:**
- Modify: `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md`
- Modify: `docs/superpowers/plans/2026-06-06-rpa-demo-flow-compatibility-gate.md`

- [ ] **Step 1: Align main plan deliverable list**

Before marking the slice complete, update `docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md` so the Demo slice file list matches this execution plan:

```markdown
**Files created:**

- Create: `docs/rpa-local-web-demo-runbook.md`
- Create: `docs/rpa-local-web-compatibility-checklist.md`
- Create: `docs/rpa-local-web-demo-results-template.md`
- Create: `apps/rpa-local-web/demo/prompts/google-images-codegen-handoff.md`
- Create: `apps/rpa-local-web/demo/prompts/weather-natural-language-request.md`
```

If a fallback mock page is confirmed and implemented, include its exact file path in the same list.

- [ ] **Step 2: Update main plan status after verification**

After docs, manual verification, and CC review are complete, update the main plan slice:

```markdown
## Slice: Demo Flow And Compatibility Gate (Completed)

**Execution plan:** `docs/superpowers/plans/2026-06-06-rpa-demo-flow-compatibility-gate.md`

**Status:** Implemented, manually verified, and CC reviewed.
```

Mark checklist items `[x]` only after the corresponding manual evidence exists.

- [ ] **Step 3: Commit**

Run:

```bash
git status --short
git add docs/superpowers/plans/2026-06-06-rpa-demo-flow-compatibility-gate.md docs/superpowers/plans/2026-06-05-rpa-local-bs-mvp.md docs/rpa-local-web-demo-runbook.md docs/rpa-local-web-compatibility-checklist.md docs/rpa-local-web-demo-results-template.md apps/rpa-local-web/demo/prompts
git commit -m "Document and validate RPA MVP demo flow"
```

---

## Review Notes

Before implementation, ask CC to review only this execution plan and these constraints:

- The two demo flows should be low-risk and no-login/no-real-write.
- Google Images should exercise codegen upload hardening.
- weather.com.cn should exercise natural-language generation.
- External-site instability should be documented as a smoke-demo risk, not hidden.
- The plan should not require daemon core changes.

Do not paste CC prompts into this document.
