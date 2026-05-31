const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');

// Attempt to load nDB
let nDB;
try {
    nDB = require('../modules/nDB/napi/index.js');
    console.log('[Server] Successfully loaded nDB driver.');
} catch (err) {
    console.error('[Server] Failed to load nDB natively:', err.message);
    console.error('Ensure that the prebuilt binaries exist and are compatible.');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Explicit Configuration Validation
const requiredEnvVars = ['PORT', 'LLM_GATEWAY_URL', 'NSPEECH_URL', 'NVOICE_URL', 'NDB_DATA_PATH'];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`[FATAL] Missing required environment variable: ${envVar}`);
        process.exit(1);
    }
}

const PORT = process.env.PORT || 3600;

// Initialize Database Storage
const dbPath = path.resolve(__dirname, process.env.NDB_DATA_PATH);
if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
}

let db;
if (nDB) {
    db = new nDB.Database(path.join(dbPath, 'slideshows.jsonl'));
}

// Serve Client Config dynamically to avoid hardcoding frontend
app.get('/js/config.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    const configScript = `
// ============================================
// Dynamically Generated Slideshow Configuration
// ============================================
window.SLIDESHOW_CONFIG = {
    GATEWAY_URL: ${JSON.stringify(process.env.LLM_GATEWAY_URL)},
    NSPEECH_URL: ${JSON.stringify(process.env.NSPEECH_URL)},
    NVOICE_URL: ${JSON.stringify(process.env.NVOICE_URL)},
    DEFAULT_NARRATOR_VOICE: 'en-US-Male',
    DEFAULT_NARRATOR_SPEED: 0.95
};
if (!window.SLIDESHOW_CONFIG.GATEWAY_URL) {
    throw new Error('FATAL: Slideshow client is missing required configuration properties.');
}
    `;
    res.send(configScript);
});

// APIs
app.get('/api/projects', async (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not initialized' });
    }
    try {
        const projects = await db.query({}); // Return all
        console.log("DB QUERY RESULTS:", projects);
        console.log("IS ARRAY?", Array.isArray(projects));
        // It is better to return only metadata for the list to save bandwidth if decks are large, but for now we return all.
        res.json({ projects });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/projects', (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    const { source, voiceMapping, slides } = req.body;
    
    const id = db.insertWithPrefix('slideshow', {
        version: 1,
        source: source || {},
        voiceMapping: voiceMapping || {},
        slides: slides || [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    });
    res.json({ id, status: 'created' });
});

app.get('/api/projects/:id', (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    const doc = db.get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Project not found' });
    res.json(doc);
});

app.put('/api/projects/:id', (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    const existing = db.get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Project not found' });
    
    const updated = {
        ...existing,
        ...req.body,
        _id: req.params.id,
        updatedAt: Date.now()
    };
    db.update(req.params.id, updated);
    res.json({ status: 'updated' });
});

app.delete('/api/projects/:id', (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized' });
    db.delete(req.params.id);
    res.json({ status: 'deleted' });
});

// Serve the static client directory
app.use(express.static(path.join(__dirname, '../client')));

// Serve the NUI components directly mapping to /nui
app.use('/nui', express.static(path.join(__dirname, '../modules/nui_wc2/NUI')));

// Fallback to index.html for SPA routing
app.use((req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
});

app.listen(PORT, () => {
    console.log(`[Server] Slideshow backend running on http://localhost:${PORT}`);
    console.log(`[Server] Serving frontend from: ${path.join(__dirname, '../client')}`);
});
