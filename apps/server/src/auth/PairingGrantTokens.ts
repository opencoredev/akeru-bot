import * as Duration from "effect/Duration";

export const DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES = Duration.minutes(5);

// The desktop-bootstrap grant rides on a trusted IPC channel (fd3 or
// stdin) at backend launch, so it doesn't have to be short-lived the
// way a user-facing pairing link does. Letting it live for the
// lifetime of the backend process (24h is more than long enough for
// practical desktop use, and well under "forever" in case the seed
// gets logged anywhere by accident) means a page reload past the 5-min
// window can still recover by re-bootstrapping rather than locking
// the user out of the backend.
export const DESKTOP_BOOTSTRAP_TTL_HOURS = Duration.hours(24);

// A dev server's startup token is read off a log by whoever (or whatever) is
// driving the session, often minutes later — after a `node --watch` restart, a
// detour into another task, or a hand-off to the person actually doing the
// testing. Five minutes turns that into a restart-the-server loop for no
// security benefit: the token only unlocks a local dev backend, and its holder
// could read the log anyway. Same reasoning (and duration) as the desktop
// bootstrap grant above. Only applies when a dev URL is configured; user-issued
// pairing links and real servers keep the 5-minute default.
export const DEV_STARTUP_TTL_HOURS = Duration.hours(24);

export const PAIRING_TOKEN_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export const PAIRING_TOKEN_LENGTH = 12;

export const PAIRING_TOKEN_REJECTION_LIMIT =
  Math.floor(256 / PAIRING_TOKEN_ALPHABET.length) * PAIRING_TOKEN_ALPHABET.length;
