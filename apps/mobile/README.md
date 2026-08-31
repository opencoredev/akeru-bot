# Akeru Bot Mobile

Akeru Bot Mobile is the React Native client for iOS and Android. It connects directly to an Akeru
Bot server through pairing, a saved bearer connection, LAN access, or Tailscale.

## Requirements

The app uses native modules and does not run in Expo Go. Use the Expo development client.

Run commands from `apps/mobile`.

## Development

Start Metro:

```bash
vp run dev:client
```

Build and run the local iOS development app:

```bash
vp run ios:dev
```

Build a self-contained iOS release app:

```bash
vp run ios:release
```

Build the local preview app:

```bash
vp run ios:preview
```

A Personal Team build needs a bundle identifier that you control:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.akeru.dev \
vp run ios:dev
```

Personal Team builds omit extensions and entitlements that require a paid Apple Developer account.

## Configuration

Inspect the resolved Expo configuration:

```bash
vp run config:dev
vp run config:preview
```

The JavaScript review highlighter is the default. Set
`EXPO_PUBLIC_REVIEW_HIGHLIGHTER_ENGINE=native` only when testing the native engine.

Run native static checks:

```bash
node ../../scripts/mobile-native-static-check.ts
```

The task runs SwiftLint, ktlint, and detekt when those tools are installed.

## EAS builds

CI can use Expo fingerprinting to reuse compatible preview builds. Manual commands are:

```bash
vp run eas:ios:preview:dev
vp run eas:ios:dev
vp run eas:ios:preview
vp run eas:android:dev
vp run eas:android:preview:dev
vp run eas:android:preview
```

No hosted account or hosted transport configuration is required. The app stores saved
environment records on the device and connects to each server directly.
