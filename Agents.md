# Agent Instructions & General Project Rules

## Core Development Maxims

- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla JS:** No TypeScript anywhere. Code must stay as close to the bare platform as possible for easy optimization and debugging. `.d.ts` files are generated strictly for LLM/editor context, not used at runtime.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Configuration must be explicit - missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause.
- **Collaborative Development:** The human user is a partner, not just a reviewer. When facing architectural decisions, trade-offs, or uncertain paths, pause and ask for input. Explain the options clearly. The user's domain knowledge and preferences are valuable — include them in the loop. Avoid long silent stretches of trial-and-error; converse, don't just execute.
- **Use Provided Tools:** Always use the built-in VS Code read/write tools to apply changes directly when asked. Do NOT use terminal commands, shell commands, or scripts to edit files, as these bypass VS Code's file tracking, history, and diff views, making it impossible for the human partner to follow along. Do not output giant code blocks in text for the user to copy-paste.

## NUI Web Components — Critical Guidance

This project uses the **NUI Web Components** library (`nui_wc2`). This is a high-performance, browser-native UI toolkit that breaks with many common web development patterns. **Any LLM building this MUST internalize these rules before writing HTML or CSS.**

### Key NUI Rules

1. **Every NUI component wraps a native HTML element.** In development, NUI auto-creates the inner element if missing. For production, always include it explicitly. Example: `<nui-button><button type="button">Text</button></nui-button>` — NOT `<nui-button>Text</nui-button>`.

2. **Use `data-action` for declarative wiring**, not scattered event listeners. Example: `<nui-button data-action="dialog-open@#my-dialog"><button>Open</button></nui-button>`.

3. **`<nui-app>` requires EXACT children in order:** skip-links -> app-header -> sidebar -> content -> footer (optional). Each layout wrapper MUST contain its native HTML element (`<header>`, `<nav>`, `<main>`, `<footer>`).

4. **NEVER style NUI components.** No inline `style=""`, no `<style>` blocks targeting `nui-*` elements, no custom CSS classes on NUI components. Visual variation comes from attributes (`variant`, `type`, `size`, `fill`), not CSS. For spacing between components, use your own wrapper `<div>` with theme variables like `gap: var(--nui-space)`.

5. **Use only NUI theme CSS variables** for any custom styling: `--color-base`, `--color-shade1-9`, `--text-color`, `--text-color-dim`, `--color-highlight`, `--border-shade1-4`, `--nui-space`, `--nui-space-half`, `--nui-space-double`, `--border-radius1-3`, etc. Never invent new variables.

6. **Addons require BOTH JS import AND CSS link.** Forgetting either = broken component with zero errors. Core components work without imports.

7. **`await nui.ready()` before calling programmatic APIs.** The library initializes asynchronously.

8. **In page scripts, use `element.querySelector()` not `document.querySelector()`.** The element is the page wrapper passed to `init()`.

9. **Do not listen for `nui-click`** — it's internal. Use `data-action` or listen for the native event on the inner element.

### When Tempted to Add CSS

| You want to... | Do this instead |
|---------------|-----------------|
| Change a button's color | Use `variant="primary\|outline\|ghost\|danger\|warning"` |
| Change spacing between elements | Use your own wrapper `<div>` with `gap: var(--nui-space)` |
| Add a border to something | Check if `<nui-card>` already does what you want |
| Change font size | Use `<h1>`–`<h6>` or NUI typography — the component handles it |
| Add a shadow/elevation | NUI components handle elevation — check component docs |
| Still stuck? | Read the component's `.md` doc in `lib/nui_wc2/documentation/components/` |

### Key Components for This Project

| Component | Usage |
|-----------|-------|
| `<nui-app>` | Application shell (no sidebar needed — just header + content) |
| `<nui-button>` | All buttons. Variants: `primary`, `outline`, `ghost`, `icon` |
| `<nui-input>` | Text inputs (nSpeech endpoint, speed) |
| `<nui-select>` | Voice dropdowns, model selection. Use `searchable` attribute |
| `<nui-tabs>` | Switch between Import / Edit / Playback views |
| `<nui-card>` | Slide preview cards in the timeline |
| `<nui-dialog>` | Settings, confirmations, voice mapping |
| `<nui-progress>` | TTS generation progress, playback progress |
| `<nui-banner>` | Status notifications (import success, TTS complete) |
| `<nui-slider>` | Speed control per voice |

### NUI Source Files

- **Cheatsheet** (read first): `lib/nui_wc2/LLM-CHEATSHEET.md`
- **Philosophy & Architecture**: `lib/nui_wc2/documentation/DOCUMENTATION.md`
- **Component Registry**: `lib/nui_wc2/documentation/components.json`
- **Component Docs**: `lib/nui_wc2/documentation/components/{name}.md`
- **Theme CSS**: `lib/nui_wc2/css/nui-theme.css`
- **Core JS**: `lib/nui_wc2/nui.js`
