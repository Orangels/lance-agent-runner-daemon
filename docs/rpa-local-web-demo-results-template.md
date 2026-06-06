# RPA Local Web Demo Results

Date:
Operator:
Machine / OS:
Branch / commit:

## Environment

- Node:
- pnpm:
- Python:
- Playwright browser:
- Browser mode:
- Daemon URL:
- RPA Web URL:
- Local fallback mock URL:
- RPA Web storage root:
- Network notes:

## Demo 1: Google Images Codegen Hardening

- Flow ID: `google_image_download`
- Flow name: `Google image keyword download`
- Target URL: `https://www.google.com/imghp?hl=en&ogbl`
- Keyword:
- Result index:
- Download file name:
- Codegen session ID:
- Daemon run ID:
- Conversation ID:
- Verify execution ID:
- Terminal status:
- Required artifacts present:
- Download artifact path:
- Screenshot artifact path:
- Logs path:
- Review bundle path:
- External blocker, if any:
- Fallback mock used:
- Fallback execution ID:
- Notes:

## Demo 2: weather.com.cn Natural-Language Generation

- Flow ID: `weather_city_date_lookup`
- Flow name: `Weather city date lookup`
- Target URL: `https://www.weather.com.cn/`
- City:
- Weather date:
- Visible forecast date confirmed:
- City page URL:
- Natural-language session ID:
- Daemon run ID:
- Conversation ID:
- Verify execution ID:
- Terminal status:
- Required artifacts present:
- Summary artifact path:
- Screenshot artifact path:
- Logs path:
- Review bundle path:
- Extracted date label:
- Extracted weather:
- Extracted high temperature:
- Extracted low temperature:
- Extracted wind:
- External blocker, if any:
- Fallback mock used:
- Fallback execution ID:
- Notes:

## Flow Reuse

- Source flow ID:
- Exported package:
- Imported flow ID:
- Imported package SHA-256:
- Imported provenance shown:
- Verify-before-run gate observed:
- Verify execution ID after import:
- Run enabled after verify:
- Reuse terminal status:
- Notes:

## Validation Commands

```bash
pnpm --filter @lance-agent-runner/rpa-local-web test
pnpm typecheck
pnpm build
git diff --check
rg -n "RPA|Playwright|DSL|selector|screenshot|trace|video|executionId|flowId|executor|chrome-devtools|mcp" apps/daemon/src
```

Results:

- RPA Web tests:
- Typecheck:
- Build:
- Diff check:
- Daemon boundary grep:

## Final Decision

- [ ] Demo ready.
- [ ] Demo blocked by external site.
- [ ] Demo blocked by product issue that needs a fix.

Decision notes:
