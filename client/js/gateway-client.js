// src/websocket/client-sdk.js
// Vendored from LLM-Gateway-Chat
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
        try { callback(...args); } catch (e) { console.error(`Error in event listener for ${event}:`, e); }
      }
    }
    return this;
  }
}

export class GatewayClient extends EventEmitter {
  constructor(options = {}) {
    super();
    const base = options.baseUrl || 'http://localhost:3400';
    this.restUrl = base;
    this.wsUrl = base.replace(/^http/, 'ws') + '/v1/realtime';
    this.accessKey = options.accessKey || '';
    this.sessionId = options.sessionId || `sess-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    this.operationMode = options.operationMode || 'websocket';
  }

  async getModels() {
    const headers = this.accessKey ? { 'Authorization': `Bearer ${this.accessKey}` } : {};
    const res = await fetch(`${this.restUrl}/v1/models`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Basic implementation of chat completion
  async chat(params) {
    const url = `${this.restUrl}/v1/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (this.accessKey) headers['Authorization'] = `Bearer ${this.accessKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
    });

    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    return response.json();
  }
}
