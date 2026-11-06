---
"akeru-bot": minor
---

Each environment now describes its machine: OS, CPU and memory load, installed tools such as Xcode, Docker, and browsers, ready providers, and projects. Bots can call `list_environments` to see where they may run work and why other environments are left out. Bots stay on their home environment unless they are allowed others.
