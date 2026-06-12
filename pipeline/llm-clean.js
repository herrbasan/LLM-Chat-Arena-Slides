// pipeline/llm-clean.js
// BACKWARD-COMPAT SHIM - re-exports from build-deck.js.
//
// This file exists so existing code that require('./llm-clean.js')
// doesn't break. New code should require('./build-deck.js') directly.
//
// TODO: remove this shim once all consumers have migrated.

module.exports = require('./build-deck.js');
