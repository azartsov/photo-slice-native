# Photo Slice Native

`Photo Slice Native` is an Android-first Expo / React Native arcade prototype inspired by Xonix, where each level is built from a random photo on the device.

The project focuses on a tactile cut-and-reveal loop: the player slices into a hidden image, avoids moving hazards, and gradually opens the photo by capturing safe areas.

## Current Feature Set

- mobile-first single-screen gameplay prototype
- random level photos loaded from the media library
- demo backdrop fallback when photo access is unavailable
- five difficulty levels: `Sunny`, `Cloudy`, `Stormy`, `Blizzard`, `Apocalypse`
- hazard counts per difficulty: `3`, `4`, `5`, `6`, `8`
- moving cursor that travels along the hidden area perimeter
- tap-driven `90` degree turns while a cut is active
- per-difficulty counters for completed photo openings
- local sound effects for reveal and hazard clear events
- EAS build profiles for preview APK and production AAB outputs

## Tech Stack

- Expo
- React Native
- TypeScript
- local asset-based audio
- GitHub Actions CI for type checking

## Main Scripts

- `npm install` — install dependencies
- `npm run start` — start the Expo dev server
- `npm run android` — build and run the Android app locally
- `npm run ios` — build and run the iOS app locally
- `npm run web` — launch the web preview
- `npm run prebuild` — regenerate native Expo projects
- `npm run typecheck` — run `tsc --noEmit`
- `npm run apk` — create an Android preview build through EAS
- `npm run aab` — create a production Android App Bundle through EAS

## Gameplay Loop

- tap the field to send the cursor into the hidden area
- while a cut is active, each next tap turns it by `90` degrees toward the tap side
- if a hazard touches the cut before it closes, the attempt fails
- when a cut reaches the boundary, the smaller captured area is revealed
- hazards inside the revealed area are removed
- when all hazards are cleared, the photo is fully opened and the run continues on a new random image

## Local Run

1. `cd /Users/valeryazartsov/photo-slice-native`
2. `npm install`
3. `npm run android`

## Project Notes

- Android package: `com.valeryazartsov.photoslicenative`
- Expo slug: `photo-slice-native`
- TypeScript-only codebase
- CI validates type checking on push and pull request

## Changelog

Project-level updates are tracked in [CHANGELOG.md](CHANGELOG.md).