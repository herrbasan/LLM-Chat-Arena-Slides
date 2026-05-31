// client/js/app.js

import { GatewayClient } from './gateway-client.js';
import { SlideTools } from './slide-tools.js';

class SlideshowApp {
    constructor() {
        this.state = {
            currentProject: null, // Holds the DB id
            deck: null,           // The loaded deck object
        };
        
        this.tools = new SlideTools(this);
        this.llmGateway = new GatewayClient({ 
            baseUrl: window.SLIDESHOW_CONFIG.GATEWAY_URL 
        });

        // Wait for NUI to be ready
        window.nui.ready().then(() => {
            this.init();
        });
    }

    async init() {
        console.log('[App] NUI is ready. Initializing app...');
        this.bindEvents();
        await this.loadProjectsList();
    }

    bindEvents() {
        // Tab routing / enabling
        const tabs = document.querySelector('nui-tabs');
        if (tabs) {
            tabs.addEventListener('change', (e) => {
                console.log('Tab changed to:', e.detail.tab.id);
            });
        }

        // Import logic
        const dropzone = document.getElementById('import-dropzone');
        if (dropzone) {
            dropzone.addEventListener('change', (e) => {
                const files = e.detail?.files;
                if (files && files.length > 0) {
                    this.handleImportFile(files[0]);
                }
            });
        }

        const fileInput = document.getElementById('import-file-input');
        const btnImport = document.getElementById('btn-import-file');
        if (btnImport && fileInput) {
            btnImport.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    this.handleImportFile(e.target.files[0]);
                }
            });
        }

        // Chat AI logic
        const chatInput = document.getElementById('chat-input');
        const btnSendObj = document.querySelector('[data-action="chat-send"]');
        if (chatInput && btnSendObj) {
            const sendHandler = async () => {
                const text = chatInput.value.trim();
                if (!text) return;
                chatInput.value = '';
                await this.sendChatToLLM(text);
            };
            btnSendObj.addEventListener('click', sendHandler);
            chatInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') sendHandler();
            });
        }
    }

    async loadProjectsList() {
        try {
            const res = await fetch('/api/projects');
            const data = await res.json();
            const listEl = document.getElementById('projects-list');
            
            if (!data.projects || data.projects.length === 0) {
                listEl.innerHTML = '<p style="color: var(--text-color-dim);">No projects yet. Import a JSON file to begin.</p>';
                return;
            }

            // Quick rendering of project list
            listEl.innerHTML = `
                <nui-link-list>
                    <nav>
                        ${data.projects.map(p => `
                            <a href="#" data-id="${p._id}" class="project-link">
                                ${p.source?.topic || 'Untitled Project'} 
                                <small style="display:block; color:var(--text-color-dim);">${new Date(p.createdAt).toLocaleDateString()}</small>
                            </a>
                        `).join('')}
                    </nav>
                </nui-link-list>
            `;

            // Bind clicks
            listEl.querySelectorAll('.project-link').forEach(link => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.loadProject(e.currentTarget.dataset.id);
                });
            });

        } catch (err) {
            console.error('[App] Failed to load projects:', err);
        }
    }

    async handleImportFile(file) {
        try {
            const text = await file.text();
            const json = JSON.parse(text);
            
            // Validate it's an arena export
            if (!json.messages || !json.id) {
                throw new Error("Invalid Arena Export format");
            }

            // Fallback generation for participants if empty or missing
            let participants = json.participants || [];
            if (!participants || participants.length === 0 || (participants.length === 2 && !participants[0] && !participants[1])) {
                const uniqueSpeakers = [...new Set(json.messages.filter(m => m.speaker).map(m => m.speaker))];
                participants = uniqueSpeakers;
            }

            console.log('[App] Parsed Arena JSON:', json.topic, json.messages.length, 'messages');
            
            const payload = {
                source: {
                    arenaExportId: json.id,
                    exportedAt: json.exportedAt || new Date().toISOString(),
                    topic: json.topic || 'Imported Conversation',
                    participants: participants,
                    messages: json.messages // We store all messages in the project so the LLM gateway can read them via tool
                },
                slides: [],
                voiceMapping: {
                    narrator: { voice: window.SLIDESHOW_CONFIG.DEFAULT_NARRATOR_VOICE, speed: window.SLIDESHOW_CONFIG.DEFAULT_NARRATOR_SPEED }
                }
            };
            
            // Auto-assign default voices for the participants for convenience
            if (participants[0]) payload.voiceMapping['participantA'] = { voice: 'en-US-Female', speed: 1.0, label: participants[0] };
            if (participants[1]) payload.voiceMapping['participantB'] = { voice: 'en-GB-Male', speed: 1.0, label: participants[1] };
            
            const res = await fetch('/api/projects', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });
            const result = await res.json();
            
            nui.components.banner?.show?.('Import successful', { type: 'success' });
            await this.loadProject(result.id);

        } catch (err) {
            console.error('Import failed', err);
            nui.components.banner?.show?.(`Import Error: ${err.message}`, { type: 'error' });
        }
    }

    async loadProject(id) {
        console.log('[App] Loading project', id);
        try {
            const res = await fetch(`/api/projects/${id}`);
            const deck = await res.json();
            this.state.currentProject = id;
            this.state.deck = deck;

            // Enable tabs
            document.getElementById('tab-edit').removeAttribute('disabled');
            document.getElementById('tab-preview').removeAttribute('disabled');
            document.getElementById('tab-render').removeAttribute('disabled');

            // Switch to Edit tab
            const tabs = document.querySelector('nui-tabs');
            if (tabs) {
                // Manually trigger tab switch according to NUI patterns
                const editTabBtn = document.getElementById('tab-edit');
                editTabBtn.click();
            }

            this.renderEditView();
            
        } catch (err) {
            console.error('Failed to load project', id, err);
        }
    }

    renderEditView() {
        const deck = this.state.deck;
        if (!deck) return;

        // Render voice mappings
        this.renderVoiceMappingUI(deck);

        // Render slides
        this.renderSlideDeck(deck.slides || []);
    }

    renderVoiceMappingUI(deck) {
        const container = document.getElementById('voice-mapping-ui');
        
        const renderRole = (roleKey, mapping) => {
            if (!mapping) return '';
            const label = mapping.label ? `${mapping.label} (${roleKey})` : roleKey;
            return `
            <div style="display:flex; flex-direction:column; gap: var(--nui-space-half); margin-bottom: var(--nui-space);">
                <div><strong>${label}</strong></div>
                <div style="display:flex; gap:var(--nui-space-half);">
                    <nui-input style="flex:1"><input type="text" value="${mapping.voice || ''}" placeholder="Voice ID"></nui-input>
                    <nui-input style="width: 70px;"><input type="number" step="0.1" value="${mapping.speed || 1}" title="Speed"></nui-input>
                </div>
            </div>`;
        };

        container.innerHTML = `
            ${renderRole('Narrator', deck.voiceMapping.narrator)}
            ${renderRole('Participant A', deck.voiceMapping.participantA)}
            ${renderRole('Participant B', deck.voiceMapping.participantB)}
        `;
    }

    renderSlideDeck(slides) {
        const container = document.getElementById('slide-deck-list');
        if (slides.length === 0) {
            container.innerHTML = `
                <nui-card>
                    <div style="text-align:center; padding: var(--nui-space-double);">
                        <p>No slides generated yet.</p>
                        <nui-button variant="primary" id="btn-generate-initial"><button type="button">Ask LLM to Auto-Generate Deck</button></nui-button>
                    </div>
                </nui-card>
            `;
            const btn = document.getElementById('btn-generate-initial');
            if (btn) btn.addEventListener('click', () => this.autoGenerateDeck());
            return;
        }

        container.innerHTML = slides.map((slide, idx) => `
            <nui-card>
                <div class="slide-card-header">
                    <span><strong>${slide.label || 'Unknown'}</strong> (${slide.type})</span>
                    <span>#${idx + 1}</span>
                </div>
                <div class="slide-card-text">
                    ${slide.text || slide.narration || ''}
                </div>
            </nui-card>
        `).join('');
    }

    async saveCurrentDeck() {
        if (!this.state.currentProject) return;
        try {
            await fetch(`/api/projects/${this.state.currentProject}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(this.state.deck)
            });
        } catch (e) {
            console.error('Failed to save deck', e);
        }
    }

    async sendChatToLLM(systemOrUserText, role = 'user') {
        const historyEl = document.getElementById('chat-history');
        
        // Render user message to UI
        if (role === 'user') {
            historyEl.innerHTML += `<div class="chat-message user">${this.escapeHtml(systemOrUserText)}</div>`;
            historyEl.scrollTop = historyEl.scrollHeight;
        }

        historyEl.innerHTML += `<div class="chat-message assistant" id="llm-typing"><i>Thinking...</i></div>`;
        
        try {
            // Build Context
            const messages = [
                { role: 'system', content: `You are the Slideshow Narration Director. 
You help process raw conversational data into a clean, narrated slideshow. 
You have tools to fetch the source messages, get the current slide deck, and insert/update slides.
When asked to auto-generate or refine, USE THE TOOLS to execute the actions and construct the slide array.` },
                { role: role, content: systemOrUserText }
            ];

            const requestParams = {
                model: "kimi-k2.5-chat", // Assume valid fallback model or define in config
                messages: messages,
                tools: this.tools.getToolDefinitions(),
                temperature: 0.7
            };

            const response = await this.llmGateway.chat(requestParams, false);
            
            // Handle Tool Calls
            if (response.tool_calls && response.tool_calls.length > 0) {
                document.getElementById('llm-typing').innerHTML = `<i>Executing Tool...</i>`;
                for (const call of response.tool_calls) {
                    await this.tools.executeToolCall(call);
                }
                document.getElementById('llm-typing').remove();
                historyEl.innerHTML += `<div class="chat-message assistant"><i>Tool execution complete.</i></div>`;
            } else {
                document.getElementById('llm-typing').innerText = response.content || "Empty response";
                document.getElementById('llm-typing').removeAttribute('id');
            }
            historyEl.scrollTop = historyEl.scrollHeight;
        } catch (err) {
            console.error('Chat error:', err);
            document.getElementById('llm-typing').innerText = "Error: " + err.message;
            document.getElementById('llm-typing').removeAttribute('id');
        }
    }

    autoGenerateDeck() {
        console.log('[App] autoGenerateDeck triggered');
        const prompt = "Please review the source Arena data using your tools, and generate a complete slide deck containing 1 intro narration slide, interspersed conversation slides containing cleaned text, and 1 outro narration slide. Do not bundle multiple source messages into a single slide. Use your slide generation tool repeatedly to populate the deck.";
        this.sendChatToLLM(prompt, 'user');
    }

    escapeHtml(unsafe) {
        return (unsafe || '').toString()
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
    }
}

// Bootstrap
const app = new SlideshowApp();
window.app = app; // Expose for debugging
