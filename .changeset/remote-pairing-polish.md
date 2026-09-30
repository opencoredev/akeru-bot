---
"akeru-bot": minor
---

Remote pairing is easier on a headless machine. `akeru pair` prints a QR code on a terminal (turn it off with `--no-qr`), accepts `--public-url` for a tunnel you manage, and `akeru pair --admin` creates the first admin link until an admin device is paired. A new remote install prints one admin pairing link on first boot, which `akeru remote logs` now shows. Admins can see remote health, re-run the checks, and repair individual checks from Settings > Connections. The doctor now reports a fresh home as "not created yet" instead of raw file errors, and says that Kimi For Coding and OpenCode Go need no command on the machine.
