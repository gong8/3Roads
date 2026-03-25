# 👑 3Roads — Complete Session Handoff

This file is a comprehensive state transfer guide wrapping up all modifications, design choices, and bug fixes applied to this codebase for the next agent iteration.

---

## 🛠 SECTION 1: Game Mechanics & Engine (`packages/api`)

### 1. **Local Answer Judging (`judge.ts`)**
- **Problem:** Frequent artificial latency submitting answers due to unnecessary LLM spawns. Alternate matching on brackets fails matching on parenthesis sets (e.g., `Lord Byron (accept: George Gordon Byron)`).
- **Fixes:**
  - Standardized `parseAcceptableAnswers()` to extract prefixes/suffixes from BOTH brackets `[]` and parenthesis `()`.
  - Added a **Fast-Reject Threshold**: if Levenshtein distance similarity drops `< 0.3`, it rejects instantly instead of stalling on LLM fallback for empty string or junk submittals.
  - **Keyword Containment Extension:** Upgraded the keyword matcher from purely Suffix checking (matching `Bach` from `Johann Bach`) to **Prefix** checking (matching `Rhine` from `Rhine River`).
  - To prevent approval for answers containing purely generic words, added a `GENERIC_WORDS` block-list covering static geographic/study nouns (like `river`, `sea`, `treaty`).

### 2. **Game Loops Timers (`engine.ts` & `AnswerInput.tsx`)**
- **Interval Adjustments:** Hardcoded server artificial pauses (transition triggers between question parts, bonus sections, and dead tosses) were significantly reduced so the interface triggers immediately without arbitrary lockouts.
- **Auto-Submit Capture:** If the user’s buzzer runs out of time instead of pressing enter, `AnswerInput` leverages an auto-submit payload to transmit the current text buffer upstream accurately so it is registered before server clocks cycle. A 1-sec tolerance buffer was placed on the backend handlers to capture the packets properly.

---

## 🎨 SECTION 2: UI/UX Refactores (`packages/web`)

### 1. **Scoreboard & Frame Re-flows**
- Shifted absolute Scoreboard drawers strictly to the Hideable Left-Side layout to open up spacing nodes.
- Unrolled Question History strictly on page-level downward renders instead of isolated static scrollbox viewports to permit responsive layout scrolling.

### 2. **Anti-Flicker States (`GameRoom.tsx`)**
- **Problem:** Submitting bonus answers triggered state triggers assuming empty tossups, collapsing frames instantly and creating unmounting layout flickers.
- **Fix:** Fixed state-conditional triggers to accurately monitor if a `Tossup` is active vs a `Bonus` is active during judging sequences, suspending accurate context streams correctly.

---

## 💸 SECTION 3: LLM Optimization Scaffolds

Exposed controls explicitly allowing users to toggle background spending and trim prompt schemas:

### 1. **Frontend Model Selector (`Generate.tsx`)**
- Placed a select `<select>` node so generation requests can operate on **Claude 3.5 Haiku** (10x Cheaper output rendering) rather than defaulting all requests downstream on the premium **Sonnet** array.

### 2. **Model Gating (`generate-orchestrator.ts` & `cli-chat.ts`)**
- Subscribed "Phase 1 JSON planning lists" strictly to `Haiku` since creative outputs aren't necessary.
- **MCP Filter Trimming:** Trimmed extraneous MCP routers (like DB fetchers/creation tools) from setup feeds to CLI instructions, drastically lowering input token overheads.

---

## 🔍 Verification Layouts

All builds passed concurrently on executing `npx turbo typecheck`. 

*Incoming actions for Next Agent:*
- Build prompt injection headers for caching mechanics inside `fetchJudge()` to double efficiency for high bulk buzz cycles.
