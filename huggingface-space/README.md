---
title: Itinerary Agent Ollama
emoji: 🧳
colorFrom: blue
colorTo: green
sdk: docker
app_port: 11434
pinned: false
---

**Not currently usable for free.** Hugging Face now requires a paid PRO
plan to create Docker/Gradio Spaces (anything that runs real compute) —
confirmed on both a personal account and an org, "Paid" badge shown at
creation time even without selecting compute hardware. Only Static Spaces
(no server-side process — can't run Ollama) are free. Kept in the repo in
case that changes, or in case you do have a paid HF plan. The project's
actual free path is `.github/workflows/generate-itineraries.yml` — see the
main README.

---

Private Ollama instance serving the itinerary-generation agent bound to the
1TripWiser "Trip Inquiries" Google Sheet. See the main repo README
(`../README.md`) for full setup instructions — this folder is just the
Space's Docker build.

**This Space must be set to Private** (Space settings → Visibility). Ollama
has no authentication of its own; Hugging Face's own auth proxy in front of
private Spaces is what keeps this endpoint from being publicly callable by
anyone who finds the URL. Calls to it need an `Authorization: Bearer <token>`
header using a Hugging Face access token that has access to this Space.
