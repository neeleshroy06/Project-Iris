# Iris — Product Feature Document

**Version:** 1.0  
**Last updated:** March 2026  
**Product type:** Desktop application (Electron)  
**AI stack:** Google Gemini Multimodal Live API (`gemini-3.1-flash-live-preview`)

---

## 1. Product overview

**Iris** is a **hands-free desktop copilot** that combines **live voice** with **what you show on screen**. It listens, speaks, and sees periodic screen captures so answers stay grounded in your current context—documents, slides, IDE, browser, or meeting UI.

**Positioning:** An “agentic era” assistant: minimal chrome, voice-first, screen-aware, optimized for focus and real workflows rather than chat-only interaction.

---

## 2. Target users

- Knowledge workers who want **spoken help** while reading, writing, or presenting  
- Developers and technical users who already use **API keys** and are comfortable with desktop tooling  
- Anyone who wants **Gemini Live** (low-latency voice + vision) in a **dedicated window** with screen share and transcript  

---

## 3. Core value proposition

| Capability | User benefit |
|------------|----------------|
| **Live voice (bidirectional)** | Natural back-and-forth; Iris replies with speech and optional on-screen transcription |
| **Screen share to the model** | Iris “sees” your screen (~1 fps stills) so explanations match what is visible |
| **Transcript** | Readable log of the conversation for recall and clarity |
| **Desktop-native screen picker** | In Electron, themed in-app picker for display/window selection when OS dialogs are awkward |
| **Shell integration hooks** | Optional hooks for session state, focus regions, and overlays when running in the full Iris shell |

---

## 4. Current product features (shipped)

### 4.1 Session lifecycle

- **Start session** — Connects to Gemini Live with configured model and voice  
- **Stop** — Ends mic, screen capture, playback, and WebSocket session  
- **Connection status** — Visual status (idle / connecting / live / error)  
- **API key** — Loaded securely from environment (e.g. `GEMINI_API_KEY` via `.env`); user is prompted if missing  

### 4.2 Audio and vision

- **Microphone input** — Streamed to the Live API for speech input  
- **PCM playback** — Decodes and plays model audio replies  
- **Screen capture** — JPEG frames scaled for the model; preview in-app  
- **Interruption handling** — Aligns with Live API interrupt signals for barge-in style behavior  

### 4.3 Conversation UI

- **Conversation panel** — Rolling transcript with distinct styling for user vs Iris  
- **Screen preview panel** — Shows shared content when capture is active  

### 4.4 First-run experience

- **Welcome (landing) screen** — Shown on each app launch: hero, product line, **Get started** and **View demo**  
- **Demo modal** — Short bullet list of capabilities (voice, screen, transcript, shell features)  
- **Theme toggle** — Available on welcome and main chrome  

### 4.5 Visual design

- **Dark and light themes** — Global `data-theme` with consistent tokens (navy/sand palette in dark; warm neutrals in light)  
- **Animated backgrounds (dark & light)** — Layered blurred gradient “blobs” + film-grain-style noise; motion respects `prefers-reduced-motion`  
- **Accessibility** — `aria-hidden` coordination between welcome layer and main shell; keyboard (e.g. Escape on demo modal)  

### 4.6 Default assistant behavior (system instruction)

The Live session includes a **system instruction** that defines Iris’s personality and rules, including:

- **Grounding** — Short replies; awareness of focus/region metadata when the shell sends it  
- **Speech rehearsal coaching** — If the user says they want to **prepare or practice a speech** (or similar), Iris treats that as **full rehearsal mode**: it may give **brief, supportive** spoken feedback for excessive filler words (“um”, “uh”, etc.) or stuttering—**without** requiring a separate phrase like “stop me if I say um.” Coaching continues until the user signals they are done or changes topic  

---

## 5. User journeys (primary)

1. **Launch → Welcome → Get started** — Lands on main controls  
2. **Start session → Live** — Mic active; user can share screen when ready  
3. **Share screen** — Picker → preview updates → Iris can reason over visuals + voice  
4. **Stop** — Clean teardown of streams and session  

---

## 6. Technical overview (non-exhaustive)

| Area | Notes |
|------|--------|
| **Runtime** | Electron main + renderer; WebSocket to Generative Language API |
| **Model** | Configurable; default Gemini 3.1 Flash Live preview |
| **Media** | PCM mic, JPEG screen frames, inline audio from model |
| **Security** | CSP in renderer; API key not hardcoded; `.env` for local dev |

---

## 7. Roadmap / concept backlog (not all implemented)

The following are **product directions** discussed for Iris. Implementation may range from **prompting-only** to **client-side timers, memory, or integrations**:

| Idea | Summary |
|------|---------|
| **Live reading companion** | Passive, proactive short tips while scrolling dense docs (definitions, contradictions, time-on-page nudges) |
| **Presentation coach** | Rehearsal feedback: pace, fillers, skipped slide points (extends current speech coaching) |
| **Meeting shadow** | Whispered answers during calls from screen + audio context |
| **Debugging timekeeper** | Time-on-problem and repetition detection for stuck debugging |
| **Form filler** | Context-aware help for long forms using on-screen context (with confirmation) |
| **Price checker** | Compare prices across sites **only** when those pages were actually seen in session |
| **Context-aware clipboard** | React to copy actions with summaries or warnings when grounded in visible content |
| **Focus guardian** | Goal and timeboxed focus with gentle nudges when attention drifts |

**Note:** Proactive behaviors should be tuned for **trust**, **latency**, and **frequency** so Iris feels helpful, not noisy.

---

## 8. Requirements and constraints

- **Network** — Live API requires connectivity  
- **Permissions** — Mic and screen capture OS permissions where applicable  
- **API access** — Valid Gemini API key with Live model access  

---

## 9. Open product questions

- Opt-in **verbosity / coaching intensity** (quiet vs coach vs tutor)  
- **Session memory** policy for cross-tab “you saw this earlier” features  
- **Enterprise** concerns: logging, retention, and admin controls  

---

## 10. Document ownership

This document describes the **Iris** desktop product as implemented and envisioned in-repo. Update it when major features or positioning change.
