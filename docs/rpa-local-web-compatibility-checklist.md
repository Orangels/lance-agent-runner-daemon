# RPA Local Web Compatibility Checklist

Use this checklist before declaring the local B/S RPA MVP ready for demo.

## Node And Package Runtime

- [ ] `node --version` is available and matches the project-supported Node version.
- [ ] `corepack enable` has been run if pnpm is not available.
- [ ] `pnpm --version` returns the expected pnpm version.
- [ ] `pnpm install` completes.
- [ ] `pnpm typecheck` completes.
- [ ] `pnpm build` completes.

## Daemon

- [ ] `pnpm dev:daemon` starts without exposing secrets in logs.
- [ ] Daemon health responds from RPA Web and from a direct browser or CLI check.
- [ ] The selected daemon profile allows the RPA skills used by the demo.
- [ ] `rpa-script-generate` is available to the selected profile.
- [ ] `playwright-rpa-harden` is available to the selected profile.
- [ ] `chrome-devtools-mcp` is profile-provided if natural-language exploration uses it.
- [ ] Daemon configuration does not allow requests to override `claudeConfigDir`, `claudeBin`, `skillRoots`, `allowedInputRoots`, or `permissionMode`.

## RPA Web

- [ ] `pnpm dev:rpa-local-web` starts.
- [ ] RPA Web can reach daemon health.
- [ ] Local fallback page `/demo/mock-rpa-target.html` opens from the RPA Web dev server.
- [ ] Codegen tab can start and cancel a recording.
- [ ] Natural-language tab can create a generation session.
- [ ] Flows tab can export and import `.rpa.zip`.
- [ ] Execution tab can start Verify and show logs.
- [ ] Execution tab can show current screenshots.
- [ ] Execution tab can list downloads and other execution artifacts.

## Python And Playwright

- [ ] Python command configured for the RPA executor is available.
- [ ] Required Python packages are installed for generated scripts; use each flow's `config.example.json` as the operator-facing dependency and config hint, with Python Playwright as the MVP baseline.
- [ ] Playwright browser dependencies are installed.
- [ ] Headed browser mode works on the local OS.
- [ ] Headless browser mode works on the local OS.
- [ ] Screenshot capture works in both headed and headless browser modes.
- [ ] Download artifact writing works and stores files under the execution artifact directory.
- [ ] Trace behavior is understood; trace capture remains optional for this MVP.
- [ ] Video behavior is understood; video capture remains optional for this MVP.

## Browser And Network

- [ ] Google Images opens from the demo machine.
- [ ] weather.com.cn opens from the demo machine.
- [ ] External site consent, CAPTCHA, region-specific layout, and automation blockers are recorded when encountered.
- [ ] Network policy permits the demo targets or the local mock page is used for deterministic product-chain verification.
- [ ] Local Chrome path override is documented when bundled Chromium is not suitable for the operator machine.
- [ ] Chrome path override is machine-local configuration and is not stored in `.rpa.zip`.

## Screenshots, Downloads, And Review Evidence

- [ ] Screenshots are captured as execution artifacts and are visible in RPA Web.
- [ ] Downloads are captured as execution artifacts and are visible in RPA Web.
- [ ] Google image download artifacts are produced by parsing the image URL and saving bytes locally, not by OS right-click Save As.
- [ ] Weather summary artifacts are written under the execution artifact directory.
- [ ] Review bundles contain enough screenshots, logs, and reports to distinguish product regressions from live-site blockers.
- [ ] Trace and video files, when manually enabled for diagnosis, are treated as local debugging evidence and are not included in exported `.rpa.zip` packages.

## Security And Data

- [ ] Demo uses no login, no CA/USB-Key, no real write operation, and no account-specific credentials.
- [ ] `.rpa.zip` export does not contain `storage_state`, cookies, tokens, secrets, trace, video, downloaded image files, or machine-local Chrome path overrides.
- [ ] Screenshots and logs are reviewed for sensitive information before sharing.
- [ ] Runtime directories such as `.rpa-local/` remain out of git.
- [ ] External-site blockers are recorded as smoke-demo conditions, not bypassed with credential capture or secret export.
