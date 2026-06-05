// ============================================
// Slideshow Application Configuration
// ============================================
// DO NOT HARDCODE VALUES HERE.
// This configuration acts as the single source of truth for the client.
// In production, these should be dynamically injected by the server or loaded via an API.

window.SLIDESHOW_CONFIG = {
    // --------------------------------------------------------
    // External APIs (Must fail-fast if omitted unexpectedly)
    // --------------------------------------------------------
    GATEWAY_URL: 'http://127.0.0.1:3400',
    NSPEECH_URL: 'http://192.168.0.145:2233',
    NVOICE_URL: 'https://192.168.0.100:2244',
    
    // --------------------------------------------------------
    // UI Settings
    // --------------------------------------------------------
    DEFAULT_NARRATOR_VOICE: 'en-US-Male',
    DEFAULT_NARRATOR_SPEED: 0.95
};

// Fail-fast validation
if (!window.SLIDESHOW_CONFIG.GATEWAY_URL || !window.SLIDESHOW_CONFIG.NSPEECH_URL || !window.SLIDESHOW_CONFIG.NVOICE_URL) {
    throw new Error('FATAL: Slideshow client is missing required configuration properties.');
}
