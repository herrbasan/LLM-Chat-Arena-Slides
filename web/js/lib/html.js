// HTML-escape a value for interpolation into an innerHTML template.
//
// Model names and topics reach the DOM from imported Arena exports, so they
// are untrusted input. Escaping &, <, > and " covers both text nodes and
// quoted attribute values, which is all these templates use.
//
// Lived as a copy-pasted function at the bottom of editor.js and render.js;
// projects.js needed it too, and a third identical copy is how the three
// drift apart on the next edit.
export function escapeHtml(s) {
    if (!s) return '';
    return s.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
