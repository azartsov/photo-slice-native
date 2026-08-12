# Photo Slice Native

`Photo Slice Native` is an Expo + React Native arcade prototype inspired by Xonix, where the playfield is built from a random photo on the device.

## Current state

- Mobile-first single-screen gameplay prototype
- Demo backdrop fallback when photo access is unavailable
- Random level photos loaded from the media library
- Five difficulty levels: Sunny, Cloudy, Stormy, Blizzard, Apocalypse
- Hazard counts per difficulty: 3, 4, 5, 6, 8
- A moving cursor that travels along the hidden area perimeter
- 90-degree cut turns driven by taps
- Per-difficulty opened-photo counters
- Local sound effects for reveal and hazard clear events
- EAS profiles for preview APK and production AAB builds

## Development

- `npm run start` starts the Expo dev server
- `npm run android` builds and runs the Android app locally
- `npm run ios` builds and runs the iOS app locally
- `npm run web` starts the web preview
- `npm run prebuild` regenerates native projects
- `npm run typecheck` runs `tsc --noEmit`

## EAS builds

- `npm run apk` creates an Android preview build through EAS
- `npm run aab` creates a production Android App Bundle through EAS

## Gameplay rules

- Tap the field to send the cursor into the hidden area.
- While a cut is active, each next tap turns it by 90 degrees toward the tap side.
- If a hazard touches the cut before it closes, the attempt fails.
- When a cut reaches the boundary, the smaller captured area is revealed.
- Hazards inside the revealed area are removed.
- When all hazards are cleared, the photo is fully opened and the next run can continue on a new random photo.

## Project notes

- Android package: `com.valeryazartsov.photoslicenative`
- Expo project slug: `photo-slice-native`
- TypeScript-only codebase with local asset-based audio
- CI currently validates TypeScript on push and pull request