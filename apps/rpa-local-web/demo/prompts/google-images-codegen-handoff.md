# Google Images Codegen Handoff

Use this note while recording `google_image_download` through Playwright codegen.

## Recording Inputs

- Target URL: `https://www.google.com/imghp?hl=en&ogbl`
- Flow ID: `google_image_download`
- Flow name: `Google image keyword download`
- Demo keyword: `sunset mountain`
- Example result index: `1`
- Example download file name: `sunset-mountain.jpg`

## Record Only This

1. Open the target URL.
2. Search the keyword.
3. Open the chosen image result.
4. Stop after the large image preview is visible.

Do not use OS right-click Save As during recording. The recording should capture only browser navigation and image selection. The hardened script should parse the selected preview image URL from `src`, `currentSrc`, `srcset`, or a stable enclosing link attribute, fetch the image bytes, and save the file as a local execution artifact.

## Hardening Expectations

- Resolve the selected image URL in page JavaScript rather than relying on native browser context menus.
- Prefer the large preview image over a thumbnail when both are present.
- Validate that the resolved URL uses `http:`, `https:`, `data:`, or another scheme explicitly supported by the executor.
- Save the image under the execution downloads or artifacts directory managed by the runner.
- Use `download_file_name` when provided; otherwise derive a safe file name from `image_keyword`.
- Log the resolved source URL, selected result index, and local artifact path.
- In verify mode, locate the selected image and capture screenshot/log evidence. Create the local download artifact only when the executor mode and dry-run policy allow local artifact writes.
- If Google shows consent, CAPTCHA, regional layout drift, or automation blocking, report `external-blocked` with screenshot evidence instead of treating it as a product failure.

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
- Artifact content: image bytes saved by the hardened script from the resolved image URL.
