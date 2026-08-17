---
title: Itinerary Agent Ollama
emoji: 🧳
colorFrom: blue
colorTo: green
sdk: docker
app_port: 11434
pinned: false
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
