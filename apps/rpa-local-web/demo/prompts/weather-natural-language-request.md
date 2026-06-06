# weather.com.cn Natural-Language Request

Use this fixture in the natural-language generation tab.

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
No login, no captcha solving, no CA/USB-Key usage, no real write operation to the website, and no assumption that arbitrary future dates are visible. If the requested date is outside the visible forecast range, ask the operator to choose a visible forecast date instead of guessing. Treat weather.com.cn as a live smoke target whose layout and forecast range can change.
```

Safety notes:

```text
This flow reads public weather information only. Preserve screenshots and logs when the site blocks automation, redirects unexpectedly, fails to resolve the city, or hides the requested date. Do not store cookies, tokens, storage state, credentials, or personal account information in generated flow artifacts.
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

## Expected Extraction

- `city`: the city resolved by the site.
- `date`: the requested date in `YYYY-MM-DD` format.
- `dateLabel`: the visible date label on the forecast row or card.
- `weather`: the visible weather description.
- `temperature.high`: the visible high temperature.
- `temperature.low`: the visible low temperature.
- `wind`: the visible wind description.
- `sourceUrl`: the final page URL used for extraction.

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

If the script writes `weather-summary.md`, include the same fields in a compact human-readable summary and keep `weather-summary.json` as the preferred machine-readable artifact when possible.
