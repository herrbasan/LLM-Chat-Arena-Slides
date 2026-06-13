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
            el.className = 'project-row';
            el.innerHTML = `
                <div class="project-card-body" data-project-id="${item.id}">
                    <div class="project-row-title">${item.title}</div>
                    <div class="project-row-meta">
                        ${item.dateDisplay} — ${item.subtitle || (item.slides + ' slides')}
                    </div>
                </div>
                <nui-button variant="icon" data-delete-id="${item.id}">
                    <button type="button" aria-label="Delete project"><nui-icon name="delete"></nui-icon></button>
                </nui-button>
            `;
            el.querySelector('[data-project-id]').addEventListener('click', (ev) => {
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

        let lastProjectsFingerprint = '';

        function fingerprintProjects(projects) {
            return projects.map(p => `${p._id}:${p.updatedAt || p.createdAt || 0}`).join('|');
        }

        async function loadProjects() {
            try {
                const res = await fetch('/api/projects');
                const data = await res.json();
                const projects = data.projects || [];
                window.SLIDESHOW_APP.projects = projects;
                setState(projects.length > 0);

                if (projects.length === 0 || !list) return;

                const fingerprint = fingerprintProjects(projects);
                if (fingerprint === lastProjectsFingerprint && list.data) {
                    // Data unchanged since last visit; don't clear/rebuild the list.
                    // Just make sure the list wrapper is visible.
                    setState(true);
                    return;
                }
                lastProjectsFingerprint = fingerprint;

                const items = projects.map((p, idx) => {
                    const isV3 = p.version === 3;
                    const msgCount = (p.messages || []).length;
                    const paraCount = isV3 ? msgCount > 0 ? p.messages.reduce((s, m) => s + (m.paragraphs?.length || 0), 0) : 0 : 0;
                    const slideCount = (p.slides || []).length;
                    return {
                        id: p._id,
                        title: p.source?.topic || 'Untitled',
                        date: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : '',
                        dateDisplay: formatDate(p.createdAt),
                        slides: slideCount,
                        isV3,
                        msgCount,
                        paraCount,
                        subtitle: isV3
                            ? `${msgCount} messages · ${paraCount} paragraphs`
                            : `${slideCount} slides`,
                        oidx: idx
                    };
                });

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
                if (list) list.innerHTML = `<div class="projects-load-error">Failed to load projects</div>`;
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

                if (!json.messages || !(json.id || json.chatInfo?.id)) {
                    throw new Error('Invalid Arena Export format');
                }

                // Raw import: build a v3 project skeleton without running
                // the LLM cleaning pass. The user goes to the editor and
                // explicitly clicks "Clean text with AI" to run the cleaning
                // pass (which calls /api/v3/generate-deck). This keeps the
                // import flow fast and transparent: no surprise LLM calls.
                nui.components.banner.show({ content: 'Importing conversation…', priority: 'info' });

                const res = await fetch('/api/v3/import-raw', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify(json)
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || `Server returned ${res.status}`);
                }

                const project = await res.json();

                // Save as a new project
                const saveRes = await fetch('/api/projects', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(project)
                });
                const saveResult = await saveRes.json();

                const paraCount = project.messages?.reduce((s, m) => s + (m.paragraphs?.length || 0), 0) || 0;
                nui.components.banner.show({
                    content: `Imported (raw): ${project.messages?.length || 0} messages, ${paraCount} paragraphs. Open the editor and click "Clean text with AI" to clean up text.`,
                    priority: 'success',
                    autoClose: 5000
                });

                window.SLIDESHOW_APP.currentProject = saveResult.id;
                if (window.SLIDESHOW_APP.updateStepper) window.SLIDESHOW_APP.updateStepper();
                window.location.hash = `#page=editor&id=${saveResult.id}`;
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
