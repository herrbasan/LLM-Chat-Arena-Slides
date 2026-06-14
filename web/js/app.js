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
        case 'open-app-settings': {
            openAppSettingsDialog();
            break;
        }
    }
});

// ─── App Settings Dialog ───────────────────────────────────────
//
// The gear button in the header opens a modal where the user can set
// the LLM gateway URL/model, the nSpeech URL, and the nVoice URL. All
// settings are stored server-side in nDB under '__app_settings__'.
// Changes apply live on the next server call — no restart needed.
//
// The model <select> is populated from GET /api/models (a proxy to
// the gateway's /v1/models). On gateway failure the <select> falls
// back to a free-text input so the user can still type a name.
async function openAppSettingsDialog() {
    await nui.ready();

    // Fetch current settings (with API key, for editing) and model list
    // in parallel.
    const [settingsRes, modelsRes] = await Promise.all([
        fetch('/api/settings?includeSecrets=1'),
        fetch('/api/models').catch(() => ({ ok: false, json: async () => ({ models: [] }) }))
    ]);
    const settings = settingsRes.ok ? await settingsRes.json() : {};
    const modelsData = modelsRes.ok ? await modelsRes.json() : { models: [] };
    const models = Array.isArray(modelsData.models) ? modelsData.models : [];
    const modelListFailed = models.length === 0;

    const formHtml = `
        <div class="settings-dialog">
            <div class="settings-section">
                <h3>LLM Gateway</h3>
                <p class="settings-hint">Used for the "Clean text with AI" step and the editor chat.</p>
                <nui-input-group>
                    <label for="cfg-llm-url">Gateway URL</label>
                    <nui-input>
                        <input type="text" id="cfg-llm-url" placeholder="http://192.168.0.100:3400" value="${escapeAttr(settings.llmGatewayUrl || '')}">
                    </nui-input>
                </nui-input-group>
                <nui-input-group>
                    <label for="cfg-llm-key">API key (optional)</label>
                    <nui-input>
                        <input type="password" id="cfg-llm-key" placeholder="Leave empty if gateway is open" value="${escapeAttr(settings.llmGatewayApiKey || '')}" autocomplete="off">
                    </nui-input>
                </nui-input-group>
                <nui-input-group>
                    <label for="cfg-cleanup-model">Cleanup model</label>
                    ${modelListFailed ? `
                        <nui-input>
                            <input type="text" id="cfg-cleanup-model" placeholder="badkid-llama-chat" value="${escapeAttr(settings.cleanupModel || '')}">
                        </nui-input>
                        <p class="settings-hint">Couldn't reach the gateway's /v1/models — type the model name.</p>
                    ` : `
                        <nui-select searchable id="cfg-cleanup-model">
                            <select>
                                <option value="">Select model...</option>
                                ${models.map(m => `<option value="${escapeAttr(m)}" ${m === settings.cleanupModel ? 'selected' : ''}>${escapeAttr(m)}</option>`).join('')}
                            </select>
                        </nui-select>
                    `}
                </nui-input-group>
            </div>
            <div class="settings-section">
                <h3>nSpeech (TTS)</h3>
                <nui-input-group>
                    <label for="cfg-nspeech-url">URL</label>
                    <nui-input>
                        <input type="text" id="cfg-nspeech-url" placeholder="http://192.168.0.100:3500" value="${escapeAttr(settings.nspeechUrl || '')}">
                    </nui-input>
                </nui-input-group>
            </div>
            <div class="settings-section">
                <h3>nVoice (alignment)</h3>
                <nui-input-group>
                    <label for="cfg-nvoice-url">URL</label>
                    <nui-input>
                        <input type="text" id="cfg-nvoice-url" placeholder="https://127.0.0.1:2244" value="${escapeAttr(settings.nvoiceUrl || '')}">
                    </nui-input>
                </nui-input-group>
            </div>
        </div>
    `;

    const { result } = nui.components.dialog.page(
        'App settings',
        formHtml,
        {
            buttons: [
                { label: 'Cancel', value: 'cancel', type: 'outline' },
                { label: 'Save', value: 'save', type: 'primary' }
            ]
        }
    );

    const button = await result;
    if (button !== 'save') return;

    // Read the form values. For the model field, support both <select>
    // and free-text input (depending on whether /api/models succeeded).
    const modelEl = document.querySelector('#cfg-cleanup-model') ||
        (document.querySelector('#cfg-cleanup-model select'));
    const modelValue = modelEl ? (modelEl.value || '').trim() : '';

    const patch = {
        llmGatewayUrl: (document.querySelector('#cfg-llm-url')?.value || '').trim(),
        llmGatewayApiKey: (document.querySelector('#cfg-llm-key')?.value || '').trim(),
        cleanupModel: modelValue,
        nspeechUrl: (document.querySelector('#cfg-nspeech-url')?.value || '').trim(),
        nvoiceUrl: (document.querySelector('#cfg-nvoice-url')?.value || '').trim()
    };

    try {
        const res = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }
        nui.components.banner.show({
            content: 'Settings saved. New URLs and model will apply on the next request.',
            priority: 'success',
            autoClose: 3000
        });
    } catch (err) {
        nui.components.banner.show({
            content: `Settings save failed: ${err.message}`,
            priority: 'alert',
            autoClose: 5000
        });
    }
}

function escapeAttr(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

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
