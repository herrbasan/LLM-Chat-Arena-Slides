import { nui } from '/nui/nui.js';
import './page-init.js';

// Global app state
window.SLIDESHOW_APP = {
    currentProject: null,
    deck: null,
    voices: [],
    projects: []
};

// Theme toggle
document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;

    const actionSpec = actionEl.dataset.action;
    const [actionPart] = actionSpec.split('@');
    const [action, param] = actionPart.split(':');

    switch (action) {
        case 'toggle-sidebar':
            document.querySelector('nui-app').toggleSidebar(param || 'left');
            break;
        case 'toggle-theme': {
            const current = document.documentElement.style.colorScheme || 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.style.colorScheme = next;
            break;
        }
    }
});

// Sidebar navigation data builder
function getNavData() {
    const items = [
        { label: 'Projects', href: '#page=projects', icon: 'folder' }
    ];
    const projectId = window.SLIDESHOW_APP.currentProject;
    if (projectId) {
        items.push(
            { label: 'Editor', href: `#page=editor&id=${projectId}`, icon: 'edit' },
            { label: 'Render & Play', href: `#page=render&id=${projectId}`, icon: 'play' }
        );
    }
    return [{ label: 'Arena Slideshow', items }];
}

async function initSidebar() {
    await nui.ready();
    const nav = document.getElementById('main-navigation');
    if (!nav) return;

    function loadNav() {
        if (!nav.loadData) return;
        nav.loadData(getNavData());
    }

    if (nav.loadData) {
        loadNav();
    } else {
        customElements.whenDefined('nui-link-list').then(loadNav);
    }
}

// Rebuild sidebar when project changes
function refreshSidebar() {
    const nav = document.getElementById('main-navigation');
    if (nav && nav.loadData) {
        nav.loadData(getNavData());
    }
}
window.SLIDESHOW_APP.refreshSidebar = refreshSidebar;

// Router setup
nui.setupRouter({
    container: 'nui-content nui-main',
    navigation: 'nui-sidebar#main-navigation',
    basePath: '/pages',
    defaultPage: 'projects'
});

// Load voices in background
fetch('/api/voices')
    .then(r => r.ok ? r.json() : { voices: [] })
    .then(data => {
        window.SLIDESHOW_APP.voices = data.voices || [];
    })
    .catch(() => { window.SLIDESHOW_APP.voices = []; });

initSidebar();
