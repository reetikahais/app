# Prompt: Create an Animated GPS Map from RaahMitra JSON

Update the existing file:

`docs/raahmitra_corrected_route.html`

Create an animated Leaflet map that reads GPS data from a local `.json` or `.jsone` file. The application must work entirely in the browser without a backend or data upload.

## JSON Structure

The export contains:

```json
{
  "raw_locations": [],
  "processed_locations": [],
  "events": [],
  "configuration": {}
}
```

A raw location contains fields such as:

```json
{
  "id": 1,
  "fix_timestamp_ms": 1787124669806,
  "received_timestamp_ms": 1787124837022,
  "latitude": 31.0953934,
  "longitude": 77.1541224,
  "horizontal_accuracy_m": 14.29,
  "speed_mps": 0,
  "app_state": "foreground",
  "battery_pct": 32,
  "created_at": "2026-08-19T07:33:57.022Z"
}
```

A processed location contains fields such as:

```json
{
  "id": 1,
  "raw_fix_id": 1,
  "filtered_latitude": 31.0953934,
  "filtered_longitude": 77.1541224,
  "processing_status": "STALE_FALLBACK",
  "position_confidence": "LOW",
  "movement_state": "UNKNOWN",
  "is_route_point": 0
}
```

## File Loading

Add a file picker:

```html
<input id="jsonInput" type="file" accept=".json,.jsone,application/json">
```

Read the file locally using `FileReader` and `JSON.parse`:

```javascript
const reader = new FileReader();

reader.onload = (event) => {
  const data = JSON.parse(event.target.result);
  renderGpsAnimation(data);
};

reader.readAsText(file);
```

Support both formats:

- `data.logs`
- `data.raw_locations` with `data.processed_locations`

Do not assume raw and processed arrays are in the same order. Match records using:

```javascript
processed.raw_fix_id === raw.id
```

Use timestamps in this order:

```javascript
fix_timestamp_ms || received_timestamp_ms || Date.parse(created_at)
```

Sort all valid records chronologically before rendering.

## Map Layers

Use Leaflet and display:

1. **Raw route**
   - Orange dashed polyline
   - Coordinates from `raw_locations.latitude` and `raw_locations.longitude`

2. **Processed route**
   - Blue solid polyline
   - Coordinates from `filtered_latitude` and `filtered_longitude`

3. **Animated marker**
   - Large marker moving through processed locations
   - Smoothly interpolate latitude and longitude between points

4. **Dropped or stale fixes**
   - Gray circle markers
   - Mark records where:
     - `processing_status === "STALE_FALLBACK"`
     - `is_route_point === 0`
     - `position_confidence === "LOW"`

5. **Accuracy circles**
   - Optional circles around raw points
   - Radius from `horizontal_accuracy_m`

After loading data, fit the map bounds to all valid coordinates.

## Animation Controls

Add controls for:

- Play
- Pause
- Stop/reset
- Timeline slider
- Playback speed: `0.25x`, `0.5x`, `1x`, `2x`, `5x`, `10x`
- Current timestamp
- Latitude and longitude
- Speed
- Accuracy
- Battery percentage
- App state
- Movement state
- Processing status

Use `requestAnimationFrame` for smooth playback.

The marker must follow the real timestamp difference between GPS fixes:

```javascript
const elapsedMs = next.timestampMs - current.timestampMs;
const animationDuration = Math.min(elapsedMs / playbackSpeed, 3000);
```

When Play is clicked:

1. Start from the selected timeline position.
2. Move smoothly between processed points.
3. Continuously update telemetry and the timeline.
4. Stop at the final point.

When Pause is clicked, preserve the current marker position. When Reset is clicked, return to the first valid point. Changing the slider must move the marker without automatically starting playback.

Interpolate coordinates with:

```javascript
function interpolate(start, end, progress) {
  return {
    latitude: start.latitude + (end.latitude - start.latitude) * progress,
    longitude: start.longitude + (end.longitude - start.longitude) * progress
  };
}
```

## Timeline

Use the chronological timestamp range:

```javascript
const startTime = points[0].timestampMs;
const endTime = points[points.length - 1].timestampMs;
const progress = (currentTime - startTime) / (endTime - startTime);
```

Display timestamps using:

```javascript
new Date(timestampMs).toLocaleString()
```

Limit very large timestamp gaps so playback does not appear frozen. Show gaps in the telemetry or event panel.

## Validation and Errors

Handle these cases in the page UI:

- Invalid JSON
- Missing `logs` and `raw_locations`
- Empty location arrays
- Missing or invalid coordinates
- Missing processed records
- Duplicate IDs
- Out-of-order timestamps
- Large timestamp gaps
- Missing accuracy or confidence values

Skip invalid coordinates safely and display a clear warning. Do not rely only on `console.log`.

## UI and Privacy Requirements

- Preserve the existing styling and Export HTML button.
- Add a clear map legend.
- Make the controls usable on desktop and mobile.
- Do not hard-code the supplied GPS coordinates.
- Allow another compatible JSON file to be selected later.
- Process all location data locally in the browser.
- Never upload GPS data to a server.
- Keep the JavaScript modular with functions such as `readJsonFile`, `normalizeExport`, `matchLocations`, `renderRoutes`, `renderMarker`, `animateRoute`, and `updateTelemetry`.
- Validate the final HTML JavaScript syntax after editing.
