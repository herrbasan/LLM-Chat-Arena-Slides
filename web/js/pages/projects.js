import { nui } from '/nui/nui.js';

nui.registerPage('projects', {
    html: 'projects.html',
    async init(element, params, nui) {
        await nui.ready();
        await customElements.whenDefined('nui-list');
        await customElements.whenDefined('nui-dropzone');

        const list = element.querySelector('#project-list');
        const dropzone = element.querySelector('#import-dropzone');
        const importInput = element.querySelector('#import-file-input');

        // Load projects
        async function loadProjects() {
            try {
                const res = await fetch('/api/projects');
                const data = await res.json();
                const projects = data.projects || [];
                window.SLIDESHOW_APP.projects = projects;

                if (projects.length === 0) {
                    if (list) list.innerHTML = `
                        <div style="padding: var(--nui-space-double); text-align: center; color: var(--text-color-dim);">
                            <p>No projects yet.</p>
                            <p>Import an Arena JSON export to get started.</p>
                        </div>
                    `;
                    return;
                }

                list.loadData({
                    data: projects.map((p, idx) => ({
                        id: p._id,
                        title: p.source?.topic || 'Untitled',
                        date: p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '',
                        slides: (p.slides || []).length,
                        oidx: idx
                    })),
                    render: (item) => {
                        const el = document.createElement('div');
                        el.style.cssText = 'padding: var(--nui-space); border-bottom: 1px solid var(--border-shade1); display: flex; justify-content: space-between; align-items: center;';
                        el.innerHTML = `
                            <div style="flex: 1; cursor: pointer; min-width: 0;">
                                <div style="font-weight: bold; margin-bottom: 2px;">${item.title}</div>
                                <div style="font-size: var(--font-size-xsmall); color: var(--text-color-dim);">
                                    ${item.date} — ${item.slides} slides
                                </div>
                            </div>
                            <nui-button variant="icon" data-delete-id="${item.id}">
                                <button type="button" aria-label="Delete project"><nui-icon name="delete"></nui-icon></button>
                            </nui-button>
                        `;
                        const contentArea = el.querySelector('div:first-child');
                        contentArea.addEventListener('click', () => {
                            window.SLIDESHOW_APP.currentProject = item.id;
                            window.location.hash = `#page=editor&id=${item.id}`;
                        });
                        const deleteBtn = el.querySelector('[data-delete-id]');
                        if (deleteBtn) {
                            deleteBtn.addEventListener('click', async (e) => {
                                e.stopPropagation();
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
                    },
                    search: [{ prop: 'title' }],
                    sort: [
                        { label: 'Date', prop: 'date' },
                        { label: 'Title', prop: 'title' }
                    ],
                    sort_default: 0,
                    sort_direction_default: 'down'
                });
            } catch (err) {
                console.error('[Projects] Failed to load:', err);
                if (list) list.innerHTML = `<div style="padding: var(--nui-space); color: var(--color-danger);">Failed to load projects</div>`;
            }
        }

        // Handle import
        if (dropzone) {
            dropzone.addEventListener('nui-drop', async (e) => {
                const files = e.detail?.dataTransfer?.files;
                if (files && files.length > 0) {
                    await importFile(files[0]);
                }
            });
        }

        if (importInput) {
            importInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    importFile(e.target.files[0]);
                }
            });
        }

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
