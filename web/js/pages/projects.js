import { nui } from '/nui/nui.js';

nui.registerPage('projects', {
    html: 'projects.html',
    async init(element, params, nui) {
        await nui.ready();
        await customElements.whenDefined('nui-list');
        await customElements.whenDefined('nui-dropzone');

        const emptyState = element.querySelector('.projects-empty');
        const listState = element.querySelector('.projects-list');
        const list = element.querySelector('#project-list');
        const dropzones = element.querySelectorAll('nui-dropzone');
        const importInput = ensureImportInput(element);

        function formatDate(iso) {
            if (!iso) return '';
            const d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
        }

        function renderProjectRow(item) {
            const el = document.createElement('div');
            el.style.cssText = 'padding: var(--nui-space); border-bottom: 1px solid var(--border-shade1); display: flex; justify-content: space-between; align-items: center; gap: var(--nui-space);';
            el.innerHTML = `
                <div class="project-card-body" style="flex: 1; cursor: pointer; min-width: 0;">
                    <div style="font-weight: bold; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.title}</div>
                    <div style="font-size: var(--font-size-xsmall); color: var(--text-color-dim);">
                        ${item.dateDisplay} — ${item.slides} slides
                    </div>
                </div>
                <nui-button variant="icon" data-delete-id="${item.id}">
                    <button type="button" aria-label="Delete project"><nui-icon name="delete"></nui-icon></button>
                </nui-button>
            `;
            el.querySelector('.project-card-body').addEventListener('click', (ev) => {
                ev.stopPropagation();
                window.SLIDESHOW_APP.currentProject = item.id;
                if (window.SLIDESHOW_APP.updateStepper) window.SLIDESHOW_APP.updateStepper();
                window.location.hash = `#page=editor&id=${item.id}`;
            });
            const deleteBtn = el.querySelector('[data-delete-id]');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    const ok = await nui.components.dialog.confirm('Delete project?', `Remove "${item.title}"? This cannot be undone.`);
                    if (!ok) return;
                    try {
                        const res = await fetch(`/api/projects/${item.id}`, { method: 'DELETE' });
                        if (!res.ok) throw new Error('Delete failed');
                        nui.components.banner.show({ content: 'Project deleted', priority: 'success', autoClose: 3000 });
                        loadProjects();
                    } catch (err) {
                        nui.components.banner.show({ content: 'Delete failed: ' + err.message, priority: 'alert', autoClose: 5000 });
                    }
                });
            }
            return el;
        }

        function setState(hasProjects) {
            if (emptyState) emptyState.hidden = hasProjects;
            if (listState) listState.hidden = !hasProjects;
        }

        async function loadProjects() {
            try {
                const res = await fetch('/api/projects');
                const data = await res.json();
                const projects = data.projects || [];
                window.SLIDESHOW_APP.projects = projects;
                setState(projects.length > 0);

                if (projects.length === 0 || !list) return;

                const items = projects.map((p, idx) => ({
                    id: p._id,
                    title: p.source?.topic || 'Untitled',
                    date: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : '',
                    dateDisplay: formatDate(p.createdAt),
                    slides: (p.slides || []).length,
                    oidx: idx
                }));

                if (list.data) {
                    list.updateData(items);
                } else {
                    list.loadData({
                        data: items,
                        render: renderProjectRow,
                        search: [{ prop: 'title' }],
                        sort: [
                            { label: 'Date', prop: 'date' },
                            { label: 'Title', prop: 'title' }
                        ],
                        sort_default: 0,
                        sort_direction_default: 'down',
                        events: (e) => {
                            if (e.type === 'selection' && e.value > 0) {
                                list.setSelection([]);
                            }
                        }
                    });
                }
            } catch (err) {
                console.error('[Projects] Failed to load:', err);
                if (list) list.innerHTML = `<div style="padding: var(--nui-space); color: var(--color-danger);">Failed to load projects</div>`;
            }
        }

        // Wire up all dropzones (empty state + populated state)
        dropzones.forEach(dz => {
            dz.addEventListener('nui-drop', async (e) => {
                const files = e.detail?.dataTransfer?.files;
                if (files && files.length > 0) {
                    await importFile(files[0]);
                }
            });
        });

        if (importInput) {
            importInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    importFile(e.target.files[0]);
                }
            });
        }

        // "Import another" / "Select File" buttons (data-action="import-pick")
        element.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="import-pick"]');
            if (btn && importInput) importInput.click();
        });

        async function importFile(file) {
            try {
                const text = await file.text();
                const json = JSON.parse(text);

                if (!json.messages || !json.id) {
                    throw new Error('Invalid Arena Export format');
                }

                let participants = json.participants || [];
                if (!participants || participants.length === 0) {
                    const uniqueSpeakers = [...new Set(json.messages.filter(m => m.speaker).map(m => m.speaker))];
                    participants = uniqueSpeakers;
                }

                const payload = {
                    source: {
                        arenaExportId: json.id,
                        exportedAt: json.exportedAt || new Date().toISOString(),
                        topic: json.topic || 'Imported Conversation',
                        participants: participants,
                        messages: json.messages
                    },
                    slides: [],
                    voiceMapping: {
                        narrator: { voice: window.SLIDESHOW_CONFIG.DEFAULT_NARRATOR_VOICE, speed: window.SLIDESHOW_CONFIG.DEFAULT_NARRATOR_SPEED }
                    }
                };

                if (participants[0]) {
                    payload.voiceMapping.participantA = { voice: 'en-US-Female', speed: 1.0, label: participants[0] };
                }
                if (participants[1]) {
                    payload.voiceMapping.participantB = { voice: 'en-GB-Male', speed: 1.0, label: participants[1] };
                }

                const res = await fetch('/api/projects', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const result = await res.json();

                nui.components.banner.show({
                    content: 'Import successful',
                    priority: 'success',
                    autoClose: 3000
                });

                window.SLIDESHOW_APP.currentProject = result.id;
                if (window.SLIDESHOW_APP.updateStepper) window.SLIDESHOW_APP.updateStepper();
                window.location.hash = `#page=editor&id=${result.id}`;
            } catch (err) {
                console.error('Import failed:', err);
                nui.components.banner.show({
                    content: `Import failed: ${err.message}`,
                    priority: 'alert',
                    autoClose: 5000
                });
            }
        }

        loadProjects();
    }
});

// The import file input is a single shared hidden <input> that lives at
// the document level — it lets us trigger the native file picker from
// any "Select File" / "Import" button without re-creating it.
let _importInput = null;
function ensureImportInput(scope) {
    if (_importInput && document.body.contains(_importInput)) return _importInput;
    _importInput = document.createElement('input');
    _importInput.type = 'file';
    _importInput.accept = 'application/json';
    _importInput.hidden = true;
    document.body.appendChild(_importInput);
    return _importInput;
}
