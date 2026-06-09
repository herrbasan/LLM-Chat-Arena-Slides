class EventEmitter {
    constructor() {
        this.listeners = new Map();
    }
    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(callback);
        return this;
    }
    emit(event, ...args) {
        if (this.listeners.has(event)) {
            for (const callback of this.listeners.get(event)) {
                try { callback(...args); } catch (e) { console.error(`Error in listener for ${event}:`, e); }
            }
        }
        return this;
    }
}

export class GatewayClient extends EventEmitter {
    constructor(options = {}) {
        super();
        // The chat endpoint is a same-origin proxy on the slideshow
        // server (`POST /api/chat`). The browser can't reach the LLM
        // gateway directly: the server's CSP locks connect-src to
        // 'self', and the gateway URL (LLM_GATEWAY_URL) may live on
        // a host the browser can't see. The server forwards our
        // request and streams the response back. SSE semantics are
        // preserved end-to-end so the parser below is unchanged.
        //
        // `baseUrl` is kept only for `getModels()`, which still
        // pokes the gateway directly. It's unused by the editor.
        const base = options.baseUrl || '';
        this.restUrl = base;
        this.accessKey = options.accessKey || '';
        this.sessionId = options.sessionId || `sess-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    }

    async getModels() {
        if (!this.restUrl) throw new Error('GatewayClient: no baseUrl configured');
        const headers = this.accessKey ? { 'Authorization': `Bearer ${this.accessKey}` } : {};
        const res = await fetch(`${this.restUrl}/v1/models`, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async *streamChatIterable(params) {
        const controller = new AbortController();
        const url = '/api/chat';
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream'
        };
        if (this.accessKey) headers['Authorization'] = `Bearer ${this.accessKey}`;

        const bodyParams = { ...params, stream: true, session_id: this.sessionId };

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(bodyParams),
            signal: controller.signal
        });

        if (!response.ok) {
            const err = await response.text();
            yield { type: 'error', error: `HTTP ${response.status}: ${err}` };
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        const accumulatedToolCalls = new Map(); // index -> { id, type, function: { name, arguments } }

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const t = line.trim();
                    if (!t || t.startsWith(':')) continue;
                    if (!t.startsWith('data:')) continue;

                    const dataStr = t.substring(5).trim();
                    if (dataStr === '[DONE]') continue;

                    let dataObj;
                    try { dataObj = JSON.parse(dataStr); } catch { continue; }

                    const delta = dataObj?.choices?.[0]?.delta;
                    if (delta?.content !== undefined) {
                        yield { type: 'delta', content: delta.content || '' };
                    }

                    // Accumulate tool call deltas
                    if (delta?.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index;
                            if (!accumulatedToolCalls.has(idx)) {
                                accumulatedToolCalls.set(idx, {
                                    id: tc.id || '',
                                    type: tc.type || 'function',
                                    function: {
                                        name: tc.function?.name || '',
                                        arguments: tc.function?.arguments || ''
                                    }
                                });
                            } else {
                                const existing = accumulatedToolCalls.get(idx);
                                if (tc.function?.arguments) {
                                    existing.function.arguments += tc.function.arguments;
                                }
                                if (tc.id) existing.id = tc.id;
                                if (tc.type) existing.type = tc.type;
                                if (tc.function?.name) existing.function.name = tc.function.name;
                            }
                        }
                    }

                    if (dataObj?.choices?.[0]?.finish_reason) {
                        const finishReason = dataObj.choices[0].finish_reason;
                        const toolCalls = finishReason === 'tool_calls'
                            ? Array.from(accumulatedToolCalls.values())
                            : undefined;
                        yield { type: 'done', finish_reason: finishReason, tool_calls: toolCalls };
                    }
                }
            }
        } finally {
            controller.abort();
        }
    }
}
