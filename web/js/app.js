import { nui } from '/nui/nui.js';
import './page-init.js';

// Global app state
window.SLIDESHOW_APP = {
    currentProject: null,
    deck: null,
    voices: [],
    // voicesReady: a Promise that resolves to the voices array. Pages
    // (e.g. the editor's voice panel) can `await SLIDESHOW_APP.voicesReady`
    // to render with a populated <select> on the first paint.
    voicesReady: null,
    projects: []
};

const STEPS = ['projects', 'editor', 'render'];

// ─── Stepper ────────────────────────────────────────────────────
//
// The stepper lives in the header and reflects the current route. It
// also enforces the workflow: steps 2 (Editor) and 3 (Render & Play)
// are disabled until a project is loaded. The "current" step is the
// one whose page is active.
//
// Wiring:
//   - data-action="goto-step:<step>" navigates to that step's URL.
//   - data-action="toggle-theme" toggles light/dark color scheme.
//   - The "is-active" class and `variant` attribute are updated on
//     every route change via the nui-route-change event.

function getActiveStep() {
    const hash = window.location.hash || '';
    if (hash.includes('page=editor')) return 'editor';
    if (hash.includes('page=render')) return 'render';
    if (hash.includes('page=projects')) return 'projects';
    return 'projects'; // default
}

function stepHref(step) {
    const projectId = window.SLIDESHOW_APP.currentProject;
    if (step === 'projects') return '#page=projects';
    if (projectId) {
        if (step === 'editor') return `#page=editor&id=${projectId}`;
        if (step === 'render') return `#page=render&id=${projectId}`;
    }
    return '#page=projects';
}

function updateStepper() {
    const active = getActiveStep();
    const projectId = window.SLIDESHOW_APP.currentProject;
    const stepper = document.querySelector('.stepper');
    if (!stepper) return;

    for (const step of STEPS) {
        const btn = stepper.querySelector(`nui-button[data-step="${step}"]`);
        if (!btn) continue;
        const innerBtn = btn.querySelector('button');
        const isActive = step === active;
        const requiresProject = step !== 'projects';
        const isEnabled = !requiresProject || !!projectId;

        // Update href so click navigates correctly
        const wrapper = btn;
        const href = stepHref(step);
        // We render <nui-button><button>...</button></nui-button>. The
        // inner <button> doesn't natively navigate; we use the data-action
        // handler which reads the step from the data-action. So we don't
        // need to set href on the inner button. But we should keep the
        // nui-button in sync visually.

        if (isActive) {
            btn.setAttribute('variant', 'primary');
            btn.classList.add('is-active');
        } else {
            btn.setAttribute('variant', isEnabled ? 'outline' : 'ghost');
            btn.classList.remove('is-active');
        }
        if (innerBtn) {
            innerBtn.disabled = !isEnabled;
        }
    }
}

window.SLIDESHOW_APP.updateStepper = updateStepper;
window.SLIDESHOW_APP.stepHref = stepHref;

// Re-render the stepper whenever the route changes
document.addEventListener('nui-route-change', updateStepper);
window.addEventListener('hashchange', updateStepper);

// Global data-action handler (theme toggle + stepper navigation)
document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;

    const actionSpec = actionEl.dataset.action;
    const [actionPart] = actionSpec.split('@');
    const [action, param] = actionPart.split(':');

    switch (action) {
        case 'goto-step': {
            const step = param;
            const projectId = window.SLIDESHOW_APP.currentProject;
            if ((step === 'editor' || step === 'render') && !projectId) {
                nui.components.banner.show({
                    content: 'Select or import a project first.',
                    priority: 'info',
                    autoClose: 3000
                });
                return;
            }
            window.location.hash = stepHref(step);
            break;
        }
        case 'toggle-theme': {
            const current = document.documentElement.style.colorScheme || 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.style.colorScheme = next;
            break;
        }
    }
});

// Router setup. We no longer have a sidebar, so no `navigation` option
// is provided. The stepper is updated by the nui-route-change listener
// above.
nui.setupRouter({
    container: 'nui-content nui-main',
    basePath: '/pages',
    defaultPage: 'projects'
});

// ─── Voices fetch (in-memory) ──────────────────────────────────
//
// On startup, fetch the list of available voices from nSpeech once.
// Store them on SLIDESHOW_APP.voices and resolve SLIDESHOW_APP.voicesReady
// when the fetch completes. Pages (e.g. the editor's voice panel) can
// await voicesReady so the <select> options are present on the first
// paint. The user's voice *selection* is persisted on the project
// record (deck.voiceMapping) — see the editor's voice panel for the
// per-project save path. We deliberately don't cache the voice list
// across sessions: it changes whenever nSpeech adds/retires voices.

window.SLIDESHOW_APP.voicesReady = (async () => {
    try {
        const res = await fetch('/api/voices');
        const data = res.ok ? await res.json() : { voices: [] };
        const voices = Array.isArray(data.voices) ? data.voices : [];
        window.SLIDESHOW_APP.voices = voices;
        return voices;
    } catch (err) {
        console.warn('[Voices] fetch failed:', err.message);
        window.SLIDESHOW_APP.voices = [];
        return [];
    }
})();

// Initial stepper render once NUI is ready
nui.ready().then(() => {
    updateStepper();
});
