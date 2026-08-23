// ################################# CORE SYSTEMS

const components = {};

const nuiBasePath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

let _readyResolve;
const _readyPromise = new Promise(resolve => { _readyResolve = resolve; });

const config = {
	sanitizeActions: true,
	sanitizeRoutes: true,
	iconSpritePath: `${nuiBasePath}/assets/material-icons-sprite.svg`,
	debug: true,
	a11y: {
		warnings: 'verbose', // 'verbose' | 'auto' | 'silent'
		autoLabel: true
	}
};

// ################################# MINIMAL EVENT DELEGATION

const builtinActionHandlers = {
	'banner-show': (t, _, e) => {
		if (t?.show) { e.stopImmediatePropagation(); t.show(); return true; }
		return false;
	},
	'banner-close': (t, _, e, p) => {
		if (t?.close) { e.stopImmediatePropagation(); t.close(p); return true; }
		return false;
	},
	'dialog-open': (t, _, e) => {
		if (t?.showModal) { e.stopImmediatePropagation(); t.showModal(); return true; }
		return false;
	},
	'dialog-show': (t, _, e) => {
		if (t?.show) { e.stopImmediatePropagation(); t.show(); return true; }
		return false;
	},
	'dialog-close': (t, _, e, p) => {
		if (t?.close) { e.stopImmediatePropagation(); t.close(p); return true; }
		return false;
	},
	'overlay-open': (t, _, e) => {
		if (t?.showModal) { e.stopImmediatePropagation(); t.showModal(); return true; }
		return false;
	},
	'overlay-close': (t, _, e, p) => {
		if (t?.close) { e.stopImmediatePropagation(); t.close(p); return true; }
		return false;
	},
	'select-open': (t, _, e) => {
		if (t?.open) { e.stopImmediatePropagation(); t.open(); return true; }
		return false;
	},
	'select-close': (t, _, e, p) => {
		if (t?.close) { e.stopImmediatePropagation(); t.close(p); return true; }
		return false;
	},
	'card-flip': (t, el, e) => {
		const card = (t !== el) ? t : el.closest('nui-card');
		if (card) { e.stopImmediatePropagation(); card.toggleAttribute('flipped'); return true; }
		return false;
	},
	'tabs-select': (t, _, e, p) => {
		if (t?.selectTab) { e.stopImmediatePropagation(); t.selectTab(p); return true; }
		return false;
	},
	'accordion-toggle': (t, _, e, p) => {
		if (t?.toggle) { e.stopImmediatePropagation(); t.toggle(p); return true; }
		return false;
	},
	'accordion-expand-all': (t, _, e) => {
		if (t?.expandAll) { e.stopImmediatePropagation(); t.expandAll(); return true; }
		return false;
	},
	'accordion-collapse-all': (t, _, e) => {
		if (t?.collapseAll) { e.stopImmediatePropagation(); t.collapseAll(); return true; }
		return false;
	},
	'scroll-to-top': (t, el, e) => {
		const scrollable = (t !== el) ? t : el.closest('nui-main') || document.querySelector('nui-main');
		if (scrollable) { e.stopImmediatePropagation(); scrollable.scrollTo({ top: 0, behavior: 'smooth' }); return true; }
		return false;
	}
};

function resolveAction(name) {
	let ctx = nui;
	for (const p of name.split('.')) {
		if (ctx && p in ctx) ctx = ctx[p];
		else return null;
	}
	return typeof ctx === 'function' ? ctx : null;
}

function setupActionDelegation() {
	document.addEventListener('click', (e) => {
		const el = e.target.closest('[data-action]');
		if (!el) return;

		const spec = el.dataset.action;
		if (!spec) return;

		const [part, sel] = spec.split('@');
		const [name, param] = part.split(':');

		const target = sel ? document.el(sel) : el;

		const fn = resolveAction(name);
		if (fn) return fn(target, el, e, param);

		if (registeredActions.get(name)?.(target, el, e, param)) return;

		if (builtinActionHandlers[name]?.(target, el, e, param)) return;

		const detail = { name, target, param, originalEvent: e };
		el.dispatchEvent(new CustomEvent('nui-action', { bubbles: true, detail }));
		el.dispatchEvent(new CustomEvent(`nui-action-${name}`, { bubbles: true, detail }));
	});
}

// ################################# ATTRIBUTE PROXY SYSTEM

function setupAttributeProxy(element, handlers = {}) {
	const original = {
		setAttribute: element.setAttribute.bind(element),
		removeAttribute: element.removeAttribute.bind(element),
		toggleAttribute: element.toggleAttribute.bind(element)
	};

	element.setAttribute = function (n, v) {
		const old = this.getAttribute(n);
		original.setAttribute(n, v);
		handlers[n]?.(v, old);
	};

	element.removeAttribute = function (n) {
		const old = this.getAttribute(n);
		original.removeAttribute(n);
		handlers[n]?.(null, old);
	};

	element.toggleAttribute = function (n, force) {
		const old = this.hasAttribute(n);
		const res = original.toggleAttribute(n, force);
		const now = this.hasAttribute(n);
		if (old !== now) handlers[n]?.(now ? '' : null, old ? '' : null);
		return res;
	};

	element._originalAttributeMethods = original;
	return original;
}

function defineAttributeProperty(element, propName, attrName = propName) {
	Object.defineProperty(element, propName, {
		get() { return this.getAttribute(attrName); },
		set(v) { v == null ? this.removeAttribute(attrName) : this.setAttribute(attrName, v); },
		enumerable: true, configurable: true
	});
}

// ################################# DOM UTILITIES

const dom = {
	create(tag, options = {}) {
		const el = document.createElement(tag);
		if (options.id) el.id = options.id;

		if (options.class) {
			const c = options.class;
			const classList = (Array.isArray(c) ? c : [c])
				.filter(Boolean)
				.flatMap(cls => typeof cls === 'string' ? cls.split(/\s+/).filter(Boolean) : []);
			if (classList.length) el.classList.add(...classList);
		}

		if (options.style) {
			if (typeof options.style === 'string') el.style.cssText = options.style;
			else Object.entries(options.style).forEach(([p, v]) => el.style[p] = v);
		}

		if (options.data) Object.entries(options.data).forEach(([k, v]) => el.dataset[k] = v);

		if (options.attrs) {
			Object.entries(options.attrs).forEach(([k, v]) => v != null && el.setAttribute(k, v));
		}

		if (options.events) Object.entries(options.events).forEach(([e, h]) => el.addEventListener(e, h));

		if (options.text) el.textContent = options.text;

		if (options.content) {
			if (typeof options.content === 'string') el.innerHTML = options.content;
			else if (Array.isArray(options.content)) el.append(...options.content.filter(Boolean));
			else el.append(options.content);
		}

		if (options.target) options.target.append(el);
		return el;
	},

	svg(tag, attrs = {}) {
		const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
		Object.entries(attrs).forEach(([k, v]) => v != null && el.setAttribute(k, v));
		return el;
	},

	fromHTML(html) {
		const fragment = document.createRange().createContextualFragment(html);
		if (fragment.children.length > 1) {
			const wrapper = document.createElement('div');
			wrapper.append(...fragment.children);
			return wrapper;
		}
		return fragment.firstElementChild;
	},

	el: (s, c = document) => s instanceof Element ? s : c.querySelector(s),
	els: (s, c = document) => s instanceof NodeList || s instanceof Array ? [...s] : [...c.querySelectorAll(s)]
};

// Extend native prototypes for convenience
if (typeof window !== 'undefined') {
	['Element', 'Document', 'DocumentFragment'].forEach(t => {
		if (!window[t]) return;
		Object.defineProperties(window[t].prototype, {
			el: { value: function (s) { return s instanceof Element ? s : this.querySelector(s); }, writable: true, configurable: true },
			els: { value: function (s) { return s instanceof NodeList || s instanceof Array ? [...s] : [...this.querySelectorAll(s)]; }, writable: true, configurable: true }
		});
	});
}

// ################################# COMPONENT FACTORY

function createComponent(tagName, setupFn, cleanupFn) {
	return class extends HTMLElement {
		connectedCallback() {
			if (this._nui_initialized) return;
			this._nui_initialized = true;
			const c = setupFn?.(this);
			if (typeof c === 'function') this._c = c;
		}
		disconnectedCallback() {
			if (this._originalAttributeMethods) {
				Object.assign(this, this._originalAttributeMethods);
				delete this._originalAttributeMethods;
			}
			this._c?.();
			cleanupFn?.(this);
		}
	};
}

function registerComponent(tagName, setupFn, cleanupFn) {
	components[tagName] = {
		class: createComponent(tagName, setupFn, cleanupFn),
		setup: setupFn,
		cleanup: cleanupFn
	};
}

function registerLayoutComponent(tagName) {
	components[tagName] = {
		class: createComponent(tagName),
		setup: () => { },
		cleanup: () => { }
	};
}

// ################################# ACCESSIBILITY

const a11y = {
	warn(type, message, element) {
		const setting = config.a11y?.warnings || (config.debug === false ? 'silent' : 'verbose');
		if (setting === 'silent' || config.debug === false) return;

		if (setting === 'auto') {
			this.warned = this.warned || new Set();
			const key = `${type}:${message}`;
			if (this.warned.has(key)) return;
			this.warned.add(key);
		}

		console.warn(message, element);
	},

	hasLabel(element) {
		return element.hasAttribute('aria-label') ||
			element.hasAttribute('aria-labelledby') ||
			element.hasAttribute('title');
	},

	hasFocusableChild(element) {
		return element.el('button, a[href], input, select, textarea, [tabindex]');
	},

	getTextLabel(element) {
		const span = element.el('span');
		return span ? span.textContent.trim() : element.textContent.trim();
	},

	makeInteractive(element, label = null) {
		const nativeButton = element.el('button');
		const nativeLink = element.el('a[href]');
		const hasFocusable = this.hasFocusableChild(element);

		const target = nativeButton || nativeLink || element;

		if (!nativeButton && !nativeLink && !element.hasAttribute('role')) {
			element.setAttribute('role', 'button');
		}

		if (!hasFocusable && !element.hasAttribute('tabindex')) {
			element.setAttribute('tabindex', '0');
		}

		if (label && !this.hasLabel(target)) {
			target.setAttribute('aria-label', label);
		}

		return target;
	},

	generateIconLabel(iconName, element) {
		const label = iconName
			.split(/[_-]/)
			.map(word => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');

		const parentNav = element.closest('nui-app-header, nui-sidebar, nav, header');
		return parentNav ? `${label} navigation` : label;
	},

	ensureButtonLabel(button) {
		if (this.hasLabel(button)) return;
		if (config.a11y?.autoLabel === false) return;

		const visibleText = Array.from(button.childNodes)
			.filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())
			.map(n => n.textContent.trim())
			.join(' ');

		if (visibleText) return;

		const icon = button.el('nui-icon');
		if (icon) {
			const iconName = icon.getAttribute('name');
			if (iconName) {
				const label = this.generateIconLabel(iconName, button);
				button.setAttribute('aria-label', label);
				this.warn('button-label',
					`Icon-only button missing aria-label. Auto-generated: "${label}". ` +
					`Consider adding explicit aria-label.`,
					button
				);
			}
		}
	},

	ensureLandmarkLabel(landmark, fallbackLabel = 'Navigation') {
		if (this.hasLabel(landmark)) return;
		if (config.a11y?.autoLabel === false) return;

		const heading = landmark.el('h1, h2, h3, h4, h5, h6');
		if (heading) {
			const id = heading.id || `nav-${Math.random().toString(36).substr(2, 9)}`;
			if (!heading.id) heading.id = id;
			landmark.setAttribute('aria-labelledby', id);
		} else {
			landmark.setAttribute('aria-label', fallbackLabel);
			this.warn('landmark-label', `Landmark missing aria-label. Adding: "${fallbackLabel}"`, landmark);
		}
	},

	announce(message, assertive = true) {
		let announcer = document.getElementById('nui-a11y-announcer');
		if (!announcer) {
			announcer = dom.create('div', {
				id: 'nui-a11y-announcer',
				style: 'position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;',
				attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' },
				target: document.body
			});
		}
		
		announcer.textContent = '';
		announcer.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
		
		setTimeout(() => {
			announcer.textContent = message;
		}, 50);
	},

	upgrade(element) {
		element.els('button').forEach(btn => this.ensureButtonLabel(btn));

		element.els('[onclick], [data-action]').forEach(el => {
			if (el.tagName !== 'BUTTON' && el.tagName !== 'A' && !this.hasFocusableChild(el)) {
				if (!el.hasAttribute('role')) {
					el.setAttribute('role', 'button');
					el.setAttribute('tabindex', '0');
					this.warn('non-semantic', 'Non-semantic clickable element. Adding role="button".', el);
				}
			}
		});

		element.els('nav, [role="navigation"]').forEach(nav => {
			this.ensureLandmarkLabel(nav);
		});
	}
};

function upgradeAccessibility(element) {
	a11y.upgrade(element);
}

// ################################# COMPONENT REGISTRATION

registerComponent('nui-button', (element) => {
	let button = element.el('button');

	// Auto-wrap: create inner <button> if missing (Proposal 2 Tier 1)
	if (!button && config.debug !== false) {
		button = document.createElement('button');
		button.type = 'button';

		// Precedence: explicit <button> > label attribute > textContent
		const label = element.getAttribute('label');
		if (element.children.length === 0 && label) {
			button.textContent = label;
		} else {
			// Move existing children into the button
			while (element.firstChild) {
				button.appendChild(element.firstChild);
			}
		}

		element.appendChild(button);

		// Copy variant-dependent attributes that might have been set on host
		const variant = element.getAttribute('variant');
		if (variant === 'icon' && !element.classList.contains('icon-only')) {
			element.classList.add('icon-only');
		}

		console.info(`[NUI] ℹ <nui-button> auto-created inner <button>. For zero-JS fallback, use:\n  <nui-button><button type="button">${button.textContent.trim() || '...'}</button></nui-button>`);
	}

	if (!button) return;

	upgradeAccessibility(element);

	const nonEmptyNodes = Array.from(button.childNodes).filter(n => 
		n.nodeType !== Node.TEXT_NODE || n.textContent.trim()
	);

	if (nonEmptyNodes.length === 1 && nonEmptyNodes[0].tagName === 'NUI-ICON') {
		element.classList.add('icon-only');
	}

	button.addEventListener('click', () => {
		const fileInput = element.el('input[type="file"]');
		if (fileInput) { fileInput.click(); }
		
		element.dispatchEvent(new CustomEvent('nui-click', {
			bubbles: true,
			detail: { source: element }
		}));
	});

	const fileInput = element.el('input[type="file"]');
	if (fileInput) {
		fileInput.addEventListener('change', () => {
			element.dispatchEvent(new CustomEvent('nui-file-selected', {
				bubbles: true,
				detail: { source: element, files: fileInput.files }
			}));
		});
	}

	element.setLoading = (isLoading) => {
		if (isLoading) {
			element.setAttribute('state', 'loading');
			button.disabled = true;
		} else {
			element.removeAttribute('state');
			button.disabled = false;
		}
	};
});

const iconTemplate = dom.svg('svg', {
	width: '24',
	height: '24',
	viewBox: '0 0 24 24',
	fill: 'currentColor',
	'aria-hidden': 'true',
	focusable: 'false'
});
iconTemplate.appendChild(dom.svg('use'));

registerComponent('nui-icon', (element) => {
	const name = element.getAttribute('name');
	if (!name) return console.warn('nui-icon: Missing "name" attribute');

	element.setAttribute('aria-hidden', 'true');
	element.textContent = '';

	let svg = element.el('svg') || iconTemplate.cloneNode(true);
	if (!element.contains(svg)) element.append(svg);

	let use = svg.el('use') || dom.svg('use');
	if (!svg.contains(use)) svg.append(use);

	const updateIcon = (n) => use.setAttribute('href', n ? `${config.iconSpritePath}#${n}` : '');
	updateIcon(name);

	setupAttributeProxy(element, {
		'name': updateIcon
	});
	
	defineAttributeProperty(element, 'iconName', 'name');
});

// ################################# nui-progress COMPONENT

registerComponent('nui-progress', (element) => {
	const render = () => {
		const type = element.getAttribute('type') || 'bar';
		const value = parseFloat(element.getAttribute('value')) || 0;
		const max = parseFloat(element.getAttribute('max')) || 100;
		const pct = Math.min(Math.max((value / max) * 100, 0), 100);
		const hideText = element.hasAttribute('hide-text');
		const size = element.getAttribute('size');

		if (size) {
			element.style.setProperty('--nui-progress-size', size);
		} else {
			element.style.removeProperty('--nui-progress-size');
		}

		if (type === 'circular') {
			const labelHtml = hideText ? '' : `<div class="progress-label">${Math.round(pct)}%</div>`;
			element.innerHTML = `
				<div class="progress-circular-wrapper">
					<svg class="progress-circular" viewBox="0 0 36 36">
						<path class="progress-bg" stroke-dasharray="100, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
						<path class="progress-value" stroke-dasharray="${pct}, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
					</svg>
					${labelHtml}
				</div>
			`;
			element.setAttribute('aria-valuenow', pct.toString());
			element.setAttribute('role', 'progressbar');
			element.setAttribute('aria-valuemin', '0');
			element.setAttribute('aria-valuemax', '100');
		} else if (type === 'circular-busy') {
			element.innerHTML = `
				<div class="progress-circular-wrapper">
					<svg class="progress-circular-busy" viewBox="0 0 36 36">
						<path class="progress-bg" stroke-dasharray="100, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
						<path class="progress-value" stroke-dasharray="25, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
					</svg>
				</div>
			`;
			element.setAttribute('role', 'progressbar');
			element.removeAttribute('aria-valuenow');
		} else if (type === 'busy') {
			element.innerHTML = `<div class="progress-busy"></div>`;
			element.setAttribute('role', 'progressbar');
			element.removeAttribute('aria-valuenow');
		} else {
			const labelHtml = hideText ? '' : `<div class="progress-label">${Math.round(pct)}%</div>`;
			element.innerHTML = `
				<div class="progress-bar-wrapper">
					<div class="progress-bar-track">
						<div class="progress-bar-fill" style="width: ${pct}%"></div>
					</div>
					${labelHtml}
				</div>
			`;
			element.setAttribute('aria-valuenow', pct.toString());
			element.setAttribute('role', 'progressbar');
			element.setAttribute('aria-valuemin', '0');
			element.setAttribute('aria-valuemax', '100');
		}
	};
	
	render();

	const observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.type === 'attributes' && ['value', 'max', 'type', 'hide-text', 'size'].includes(mutation.attributeName)) {
				render();
			}
		}
	});
	observer.observe(element, { attributes: true, attributeFilter: ['value', 'max', 'type', 'hide-text', 'size'] });

	return () => observer.disconnect();
});

// ################################# nui-loading COMPONENT (legacy overlay loader)

registerComponent('nui-loading', (element) => {
	const mode = element.getAttribute('mode') || 'overlay';

	if (mode === 'bar') {
		element.innerHTML = `
			<div class="loading-bar">
				<div class="loading-bar-progress"></div>
			</div>
		`;
	} else if (mode === 'overlay') {
		if (!element.el('.loading-overlay')) {
			element.innerHTML = `
				<div class="loading-overlay">
					<div class="loading-spinner"></div>
					<div class="loading-text">Loading...</div>
				</div>
			`;
		}
	}

	setupAttributeProxy(element, {
		'active': (newValue, oldValue) => {
			if (newValue !== null) {
				element.classList.add('active');
			} else {
				element.classList.remove('active');
			}
		}
	});

	if (element.hasAttribute('active')) {
		element.classList.add('active');
	}
});

// ################################# nui-dropzone COMPONENT

function setupDropzone(element) {
	let activeZone = null;
	let isOver = false;

	const content = element.querySelector('.nui-dropzone-content');
	if (!content) return;

	const zones = content.querySelectorAll('[data-drop]');
	const count = zones.length;
	const cols = Math.ceil(Math.sqrt(count));
	const remainder = count % cols;
	content.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

	for (let i = 0; i < count; i++) {
		if (!zones[i].style.minHeight) zones[i].style.minHeight = '6rem';
		if (remainder && i >= count - remainder) {
			zones[i].style.gridColumn = `span ${cols / remainder}`;
		}
	}

	function activate() {
		if (element.hasAttribute('active')) return;
		element.setAttribute('active', '');
		isOver = true;
		element.dispatchEvent(new CustomEvent('nui-dropzone-open', { bubbles: true }));
	}

	function deactivate() {
		element.removeAttribute('active');
		isOver = false;
		if (activeZone) {
			activeZone.classList.remove('active');
			activeZone = null;
		}
		element.dispatchEvent(new CustomEvent('nui-dropzone-close', { bubbles: true }));
	}

	function onWindowDragOver(e) {
		e.preventDefault();
	}

	function onWindowDragEnter(e) {
		e.preventDefault();
		activate();
	}

	function onWindowDragLeave(e) {
		if (e.relatedTarget === null) {
			deactivate();
		}
	}

	function onWindowDrop(e) {
		if (!isOver) return;
		e.preventDefault();
		const droppedZone = activeZone
			? activeZone.getAttribute('data-drop')
			: (e.target.closest ? e.target.closest('[data-drop]')?.dataset.drop : null);
		deactivate();
		element.dispatchEvent(new CustomEvent('nui-dropzone-drop', {
			bubbles: true,
			detail: {
				zone: droppedZone || null,
				dataTransfer: e.dataTransfer,
				originalEvent: e
			}
		}));
	}

	function onZoneDragEnter(e) {
		e.preventDefault();
		e.stopPropagation();
		if (activeZone && activeZone !== e.currentTarget) {
			activeZone.classList.remove('active');
		}
		activeZone = e.currentTarget;
		activeZone.classList.add('active');
	}

	function onZoneDragLeave(e) {
		if (e.currentTarget === activeZone && !e.currentTarget.contains(e.relatedTarget)) {
			e.currentTarget.classList.remove('active');
			activeZone = null;
		}
	}

	element.addEventListener('dragover', (e) => e.preventDefault());
	window.addEventListener('dragover', onWindowDragOver);
	window.addEventListener('dragenter', onWindowDragEnter);
	window.addEventListener('dragleave', onWindowDragLeave);
	window.addEventListener('drop', onWindowDrop);

	for (const zone of zones) {
		zone.addEventListener('dragenter', onZoneDragEnter);
		zone.addEventListener('dragleave', onZoneDragLeave);
	}

	return () => {
		window.removeEventListener('dragover', onWindowDragOver);
		window.removeEventListener('dragenter', onWindowDragEnter);
		window.removeEventListener('dragleave', onWindowDragLeave);
		window.removeEventListener('drop', onWindowDrop);
		for (const zone of zones) {
			zone.removeEventListener('dragenter', onZoneDragEnter);
			zone.removeEventListener('dragleave', onZoneDragLeave);
		}
	};
}

registerComponent('nui-dropzone', (element) => {
	const backdrop = document.createElement('div');
	backdrop.className = 'nui-dropzone-backdrop';

	const content = document.createElement('div');
	content.className = 'nui-dropzone-content';

	const zones = [...element.querySelectorAll(':scope > [data-drop]')];
	for (const zone of zones) {
		content.appendChild(zone);
	}

	element.appendChild(backdrop);
	element.appendChild(content);

	return setupDropzone(element);
});

registerComponent('nui-app', (element) => {
	// Prevent zoom on iOS Safari - zooming breaks the app shell layout
	document.addEventListener('gesturestart', (e) => e.preventDefault());
	document.addEventListener('gesturechange', (e) => e.preventDefault());
	document.addEventListener('gestureend', (e) => e.preventDefault());

	// Validate child structure and warn for common LLM mistakes
	if (config.debug !== false) {
		const directChildren = [...element.children].filter(c => c.tagName.includes('-') || ['HEADER', 'NAV', 'MAIN', 'FOOTER'].includes(c.tagName));
		const hasAppHeader = directChildren.some(c => c.tagName === 'NUI-APP-HEADER');
		const hasSidebar = directChildren.some(c => c.tagName === 'NUI-SIDEBAR');
		const hasContent = directChildren.some(c => c.tagName === 'NUI-CONTENT');
		const hasBareElements = [...element.children].some(c => ['HEADER', 'NAV', 'MAIN', 'FOOTER', 'DIV', 'SECTION'].includes(c.tagName) && !c.closest('nui-app-header, nui-sidebar, nui-content, nui-app-footer'));

		if (!hasAppHeader) console.warn('[NUI] <nui-app> is missing <nui-app-header>. The app shell requires: <nui-app-header>, <nui-sidebar>, <nui-content>.', element);
		if (!hasContent) console.warn('[NUI] <nui-app> is missing <nui-content>. The app shell requires: <nui-app-header>, <nui-sidebar>, <nui-content>.', element);
		if (hasBareElements) console.warn('[NUI] <nui-app> contains bare elements (e.g., <header>, <main>) outside layout wrappers. Each region must be wrapped: bare <header> → <nui-app-header><header>. Bare <main> → <nui-content><main>.', element);
	}

	let cachedBreakpoint = { left: null, right: null };

	function getSidebar(element, position) {
		const sidebars = element.querySelectorAll('nui-sidebar');
		for (const sb of sidebars) {
			const pos = sb.getAttribute('position') || 'left';
			if (pos === position) return sb;
		}
		return null;
	}
	// Backward compat
	const getSideNav = getSidebar;

	function getSidebarWidth(sidebar) {
		if (!sidebar) return 0;
		// Get width from CSS custom property or computed style
		const width = getComputedStyle(sidebar).width;
		return parseFloat(width) || 240; // Default 240px (15rem)
	}

	function getContentMinWidth(element) {
		const attr = element.getAttribute('content-min-width');
		if (!attr) return 0; // No minimum
		const m = attr.match(/^(\d+(?:\.\d+)?)(px|rem|em)?$/);
		if (!m) return 0;
		const v = parseFloat(m[1]);
		if (m[2] === 'rem' || m[2] === 'em') {
			const remBase = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
			return v * remBase;
		}
		return v;
	}

	function getHierarchicalBreakpoint(element, position) {
		if (cachedBreakpoint[position] !== null) return cachedBreakpoint[position];
		const sidebar = getSidebar(element, position);
		if (!sidebar) return null;

		// Unified behavior attribute: primary | secondary | manual
		let behavior = sidebar.getAttribute('behavior') || 'auto';
		
		// Legacy support: behavior="manual" still works
		if (behavior === 'manual') {
			return cachedBreakpoint[position] = Infinity;
		}

		// Legacy support: favored attribute maps to primary
		if (sidebar.hasAttribute('favored')) {
			behavior = 'primary';
		}

		// Check for individual breakpoint override
		const breakpointAttr = element.getAttribute('sidebar-breakpoint');
		if (breakpointAttr && breakpointAttr !== 'auto') {
			if (breakpointAttr === 'none' || breakpointAttr === 'false' || breakpointAttr === 'never') {
				return cachedBreakpoint[position] = Infinity;
			}
			const m = breakpointAttr.match(/^(\d+(?:\.\d+)?)(px|rem|em)?$/);
			if (m) {
				const v = parseFloat(m[1]);
				if (m[2] === 'rem' || m[2] === 'em') {
					const remBase = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
					return cachedBreakpoint[position] = v * remBase;
				}
				return cachedBreakpoint[position] = v;
			}
		}

		// Legacy attribute support
		let fb = element.getAttribute(`nui-vars-sidebar-${position}_force-breakpoint`);
		if (!fb && position === 'left') {
			fb = element.getAttribute('nui-vars-sidebar_force-breakpoint');
		}
		if (fb && fb !== 'auto') {
			if (fb === 'none' || fb === 'false' || fb === 'never') {
				return cachedBreakpoint[position] = Infinity;
			}
			const m = fb.match(/^(\d+(?:\.\d+)?)(px|rem|em)?$/);
			if (m) {
				const v = parseFloat(m[1]);
				if (m[2] === 'rem' || m[2] === 'em') {
					const remBase = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
					return cachedBreakpoint[position] = v * remBase;
				}
				return cachedBreakpoint[position] = v;
			}
		}

		// Hierarchical calculation
		const contentMin = getContentMinWidth(element);
		const thisWidth = getSidebarWidth(sidebar);

		// Check if any sidebar has explicit behavior="primary"
		const allSidebars = element.querySelectorAll('nui-sidebar');
		const hasPrimary = Array.from(allSidebars).some(sb => {
			const b = sb.getAttribute('behavior');
			return b === 'primary' || sb.hasAttribute('favored');
		});

		// Determine effective behavior
		let effectiveBehavior = behavior;
		if (behavior === 'auto') {
			// Auto-detect based on position and existence of primary
			if (position === 'left' && !hasPrimary) {
				effectiveBehavior = 'primary';
			} else {
				effectiveBehavior = 'secondary';
			}
		}

		if (effectiveBehavior === 'primary') {
			// Primary: contentMin + myWidth
			return cachedBreakpoint[position] = contentMin + thisWidth;
		} else {
			// Secondary (or fallback): find primary width
			let primaryWidth = 0;
			if (hasPrimary) {
				// Find the primary sidebar
				const primarySidebar = Array.from(allSidebars).find(sb => {
					const b = sb.getAttribute('behavior');
					return b === 'primary' || sb.hasAttribute('favored');
				});
				if (primarySidebar && primarySidebar !== sidebar) {
					primaryWidth = getSidebarWidth(primarySidebar);
				}
			}
			// If no primary found, treat this as primary
			if (primaryWidth === 0) {
				return cachedBreakpoint[position] = contentMin + thisWidth;
			}
			// Secondary: contentMin + primaryWidth + myWidth
			return cachedBreakpoint[position] = contentMin + primaryWidth + thisWidth;
		}
	}
	// Backward compat alias
	const getBreakpoint = getHierarchicalBreakpoint;

	function dispatchSidebarEvent(position, state) {
		element.dispatchEvent(new CustomEvent('nui-sidebar-change', {
			bubbles: true,
			detail: { position, state }
		}));
	}
	// Backward compat
	const dispatchSideNavEvent = dispatchSidebarEvent;

	function updateResponsiveStateForPosition(element, position) {
		const sidebar = getSidebar(element, position);
		if (!sidebar) return;

		const breakpoint = getBreakpoint(element, position);
		const viewportWidth = window.innerWidth;
		const isForced = viewportWidth >= breakpoint;

		let newState;
		const prefix = position === 'right' ? 'sidebar-right' : 'sidebar';

		if (isForced) {
			element.classList.remove(`${prefix}-open`, `${prefix}-closed`);
			element.classList.add(`${prefix}-forced`);
			newState = 'forced';
		} else {
			element.classList.remove(`${prefix}-forced`);
			if (!element.classList.contains(`${prefix}-open`)) {
				element.classList.add(`${prefix}-closed`);
				newState = 'closed';
			} else {
				newState = 'open';
			}
		}

		// Update menu toggle button state
		const menuToggle = element.querySelector(`[data-action="toggle-sidebar:${position}"]`) || 
			(position === 'left' ? element.querySelector('[data-action="toggle-sidebar"]') : null);
			
		if (menuToggle) {
			menuToggle.toggleAttribute('disabled', isForced);
			menuToggle.toggleAttribute('aria-hidden', isForced);
			if (isForced) menuToggle.setAttribute('tabindex', '-1');
			else menuToggle.removeAttribute('tabindex');
		}

		dispatchSidebarEvent(position, newState);
	}

	function updateResponsiveState(element) {
		let hasAny = false;
		['left', 'right'].forEach(pos => {
			if (getSideNav(element, pos)) {
				hasAny = true;
				updateResponsiveStateForPosition(element, pos);
			}
		});

		// Add nui-ready after first responsive state update (whether or not there are sidebars)
		if (!element.classList.contains('nui-ready')) {
			requestAnimationFrame(() => element.classList.add('nui-ready'));
		}
	}

	function toggleSidebar(element, position = 'left') {
		const prefix = position === 'right' ? 'sidebar-right' : 'sidebar';
		if (element.classList.contains(`${prefix}-forced`)) return;
		const isOpen = element.classList.toggle(`${prefix}-open`);
		element.classList.toggle(`${prefix}-closed`, !isOpen);
		dispatchSidebarEvent(position, isOpen ? 'open' : 'closed');
	}
	// Backward compat
	const toggleSideNav = toggleSidebar;

	function updateLayoutClasses(element) {
		const topNav = element.el('nui-app-header');
		const sidebarLeft = getSidebar(element, 'left');
		const sidebarRight = getSidebar(element, 'right');
		const footer = element.el('nui-app-footer');

		element.classList.toggle('has-top-nav', !!topNav);
		element.classList.toggle('has-sidebar', !!sidebarLeft);
		element.classList.toggle('has-sidebar-right', !!sidebarRight);
		element.classList.toggle('has-footer', !!footer);

		updateResponsiveState(element);
	}

	element.setAttribute('data-layout', 'app');

	// Apply declarative attributes as CSS custom properties (override :root defaults)
	const sidebarWidth = element.getAttribute('sidebar-width') || element.getAttribute('nui-vars-sidebar_width');
	if (sidebarWidth) {
		element.style.setProperty('--sidebar-width', sidebarWidth);
	}
	const breakpointOverride = element.getAttribute('sidebar-breakpoint') || element.getAttribute('nui-vars-sidebar_force-breakpoint');
	if (breakpointOverride) {
		element.style.setProperty('--nui-sidebar-breakpoint', breakpointOverride);
	}
	const contentWidth = element.getAttribute('content-width');
	if (contentWidth) {
		element.style.setProperty('--space-page-maxwidth', contentWidth);
	}

	updateLayoutClasses(element);

	element.toggleSidebar = (position = 'left') => toggleSidebar(element, position);
	element.toggleSideNav = (position = 'left') => toggleSidebar(element, position); // Backward compat
	element.invalidateBreakpointCache = () => { cachedBreakpoint = { left: null, right: null }; updateResponsiveState(element); };

	let mouseDownTarget = null;
	element.addEventListener('mousedown', (e) => {
		mouseDownTarget = e.target;
	});

	element.addEventListener('click', (e) => {
		['left', 'right'].forEach(pos => {
			const prefix = pos === 'right' ? 'sidebar-right' : 'sidebar';
			if (element.classList.contains(`${prefix}-open`) &&
				!element.classList.contains(`${prefix}-forced`)) {
				
				const sidebar = getSidebar(element, pos);
				
				const clickIsInThisSidebar = sidebar && sidebar.contains(e.target);
				const clickIsInOtherSidebar = getSidebar(element, pos === 'left' ? 'right' : 'left')?.contains(e.target);
				const clickIsInTopNav = element.el('nui-app-header')?.contains(e.target);

				if (!clickIsInThisSidebar && !clickIsInTopNav) {
					if (!sidebar || !sidebar.contains(mouseDownTarget)) {
						toggleSidebar(element, pos);
					}
				}
			}
		});
	});

	const resizeObserver = new ResizeObserver(() => {
		updateLayoutClasses(element);
	});
	resizeObserver.observe(element);

	return () => {
		resizeObserver.disconnect();
	};
}, (element) => {
	// Reset init guard so re-connection re-attaches observers after DOM moves
	element._nui_initialized = false;
});

registerComponent('nui-app-header', (element) => {
	const header = element.el('header');
	if (header) {
		if (!header.hasAttribute('role') && !header.closest('[role="banner"]') &&
			!header.closest('article, section, aside, main')) {
			header.setAttribute('role', 'banner');
		}
		upgradeAccessibility(header);
	}
});

registerComponent('nui-sidebar', (element) => {
	const linkList = element.el('nui-link-list');
	if (linkList && !linkList.hasAttribute('mode')) {
		linkList.setAttribute('mode', 'fold');
	}

	if (linkList) {
		element.setActive = (selector) => linkList.setActive?.(selector);
		element.getActive = () => linkList.getActive?.();
		element.getActiveData = () => linkList.getActiveData?.();
		element.clearActive = () => linkList.clearActive?.();
		element.clearSubs = () => linkList.clearSubs?.();
	}

	const app = element.closest('nui-app');

	if (app) {
		element.addEventListener('focusin', () => {
			const pos = element.getAttribute('position') || 'left';
			const prefix = pos === 'right' ? 'sidebar-right' : 'sidebar';
			if (app.classList.contains(`${prefix}-closed`) && !app.classList.contains(`${prefix}-forced`)) {
				app.toggleSidebar?.(pos);
			}
		});

		element.addEventListener('focusout', (event) => {
			const pos = element.getAttribute('position') || 'left';
			const prefix = pos === 'right' ? 'sidebar-right' : 'sidebar';
			if (!app.classList.contains(`${prefix}-open`) || app.classList.contains(`${prefix}-forced`)) return;
			const next = event.relatedTarget;
			
			// If focus moves to null (clicking on non-focusable area) or inside the sidebar, don't close
			if (!next || element.contains(next)) return;
			
			// Close if focus moved specifically outside the sidebar
			app.toggleSidebar?.(pos);
		});
	}
});

registerComponent('nui-code', (element) => {
	if (element._nui_code_ready) return;

	const exampleScript = element.querySelector('script[type="example"]');
	if (exampleScript) {
		const lang = exampleScript.getAttribute('data-lang') || 'html';
		const rawText = exampleScript.textContent.trim().replace(/<\\\/script/gi, '</script');
		const pre = document.createElement('pre');
		const codeBlock = document.createElement('code');

		codeBlock.setAttribute('data-lang', lang);
		codeBlock.textContent = rawText;
		pre.appendChild(codeBlock);
		exampleScript.replaceWith(pre);

		setupCodeBlock(element, pre, codeBlock, rawText);
		element._nui_code_ready = true;
		return;
	}

	const pre = element.el('pre');
	const codeBlock = element.el('pre code');
	if (!pre || !codeBlock) return;

	setupCodeBlock(element, pre, codeBlock, codeBlock.textContent);
	element._nui_code_ready = true;
}, (element) => {
	const copyButton = element.el('.nui-code-copy');
	if (copyButton) copyButton.remove();
	delete element._nui_code_ready;
});

function setupCodeBlock(element, pre, codeBlock, rawText) {
	const existingCopyButton = element.el('.nui-code-copy');
	if (existingCopyButton) existingCopyButton.remove();

	const copyButton = dom.create('button', {
		class: 'nui-code-copy',
		attrs: { type: 'button', 'aria-label': 'Copy code to clipboard', title: 'Copy code' },
		content: '<nui-icon name="content_copy"></nui-icon>'
	});

	copyButton.addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(rawText);
			copyButton.innerHTML = '<nui-icon name="done"></nui-icon>';
			copyButton.classList.add('copied');
			setTimeout(() => {
				copyButton.innerHTML = '<nui-icon name="content_copy"></nui-icon>';
				copyButton.classList.remove('copied');
			}, 2000);
		} catch (err) {
			console.error('Failed to copy code:', err);
		}
	});

	element.insertBefore(copyButton, pre);

	import('./lib/modules/nui-syntax-highlight.js').then(module => {
		if (!element.isConnected) return;

		let lang = codeBlock.getAttribute('data-lang');

		if (!lang) {
			const code = codeBlock.textContent.trim();
			const patterns = [
				[/^<[!/?\w]|<!DOCTYPE/i, 'html'],
				[/^\s*[{\[].*"[\w-]+":\s*/, 'json'],
				[/\b(interface|type|enum|namespace|declare)\b|:\s*(string|number|boolean|any)\b/, 'typescript'],
				[/[.#][\w-]+\s*{|@media|@import/, 'css'],
				[/\b(const|let|var|function|import|export|class|=>)\b/, 'js']
			];
			
			for (const [pattern, detected] of patterns) {
				if (pattern.test(code)) {
					lang = detected;
					codeBlock.setAttribute('data-lang', lang);
					break;
				}
			}
		}

		if (lang) {
			codeBlock.innerHTML = module.highlight(rawText, lang);
		}
	}).catch((err) => {
		if (config.debug !== false) {
			console.warn('[NUI] <nui-code> syntax highlighting unavailable. The module NUI/lib/modules/nui-syntax-highlight.js was not found. Code will display without highlighting. Copy the lib/modules/ directory alongside nui.js.', err.message || err);
		}
	});

	return () => {
		copyButton.remove();
	};
}

// ################################# nui-link-list COMPONENT

registerComponent('nui-link-list', (element) => {
	const mode = element.getAttribute('mode') || 'tree';
	let activeItem = null;

	function dispatchActiveEvent(data) {
		element.dispatchEvent(new CustomEvent('nui-active-change', {
			bubbles: true,
			detail: data
		}));
	}

	// ##### DATA LOADING & HTML GENERATION

	element.loadData = (data) => {
		const html = data.map(item => buildItemHTML(item, false, true)).join('');

		const columnFlow = element.el('nui-column-flow');
		if (columnFlow) {
			columnFlow.innerHTML = html;
		} else {
			element.innerHTML = html;
		}

		upgradeHtml();
		if (mode === 'fold') {
			element.els('.group-header').forEach(h => {
				setGroupState(h, false);
			});
		}
	};

	function buildItemHTML(item, nested = false, isRoot = false) {
		if (item.separator) return '<li class="separator" role="none"><hr></li>';
		if (item.items) {
			const children = item.items.map(i => buildItemHTML(i, true)).join('');
			return `<ul role="group">${buildGroupHeaderHTML(item)}<div class="group-items" role="presentation">${children}</div></ul>`;
		}
		const hrefAttr = item.href ? ` href="${item.href}"` : ' href=""';
		const dataAction = item.action ? ` data-action="${item.action}"` : '';
		const link = `<li class="list-item" role="none"><a${hrefAttr}${dataAction} role="treeitem">` +
			`${item.icon ? `<nui-icon name="${item.icon}"></nui-icon>` : ''}<span>${item.label}</span></a></li>`;
		return nested ? link : (isRoot ? `<ul role="group" class="root-item">${link}</ul>` : `<ul role="group">${link}</ul>`);
	}

	function buildGroupHeaderHTML(item) {
		const action = item.headerAction ? `<button type="button" class="action" data-action="${item.headerAction}" aria-label="Settings"><nui-icon name="settings"></nui-icon></button>` : '';
		return `<li class="group-header" role="none"><button type="button" class="group-toggle" role="treeitem" aria-expanded="false">${item.icon ? `<nui-icon name="${item.icon}"></nui-icon>` : ''}<span>${item.label}</span></button>${action}</li>`;
	}

	// ##### STATE MANAGEMENT

	function updateActive(newItem) {
		const toggle = (item, add) => {
			if (!item) return;
			item.classList.toggle('active', add);
			const p = item.parentElement;
			if (p) {
				p.classList.toggle('active', add);
			}
			add ? item.setAttribute('aria-selected', 'true') : item.removeAttribute('aria-selected');
		};
		toggle(activeItem, false);
		activeItem = newItem;
		toggle(activeItem, true);
	}

	function getPathHeaders(el) {
		const headers = new Set();
		let container = el.parentElement?.closest('.group-items');
		while (container) {
			headers.add(container.previousElementSibling);
			container = container.parentElement.closest('.group-items');
		}
		return headers;
	}

	function updateAccordionState(keepOpen) {
		element.els('.group-header').forEach(header => {
			setGroupState(header, keepOpen.has(header));
		});
	}

	function setGroupState(header, expand) {
		const button = header.el('.group-toggle') || header;
		button.setAttribute('aria-expanded', expand);
		const container = header.nextElementSibling;
		if (!container?.classList.contains('group-items')) return;

		if (expand && container.style.height === 'auto') return;
		if (!expand && container.style.height === '0px') return;

		if (container.scrollHeight === 0) {
			container.style.height = expand ? 'auto' : '0px';
			return;
		}

		container.style.height = container.scrollHeight + 'px';
		if (!expand) container.offsetHeight;
		container.style.height = expand ? container.scrollHeight + 'px' : '0px';

		const onEnd = (e) => {
			if (e.target === container && e.propertyName === 'height') {
				container.style.height = expand ? 'auto' : '0px';
				container.removeEventListener('transitionend', onEnd);
			}
		};
		container.addEventListener('transitionend', onEnd);
	}

	// ##### PUBLIC API

	element.setActive = (selector) => {
		const item = typeof selector === 'string' ? element.el(selector) : selector;
		if (!item) return false;

		updateActive(item);
		const path = getPathHeaders(item);

		if (mode === 'fold') updateAccordionState(path);
		else path.forEach(h => setGroupState(h, true));

		dispatchActiveEvent({
			element: item,
			href: item.getAttribute('href'),
			text: item.textContent.trim(),
			timestamp: Date.now()
		});
		return true;
	};

	element.getActive = () => activeItem;

	element.getActiveData = () => activeItem ? {
		element: activeItem,
		href: activeItem.getAttribute('href'),
		text: activeItem.textContent.trim()
	} : null;

	element.clearActive = (closeAll = false) => {
		if (activeItem) {
			updateActive(null);
			dispatchActiveEvent(null);
		}
		if (closeAll) {
			element.els('.group-header').forEach(h => setGroupState(h, false));
		}
	};

	element.clearSubs = () => {
		element.els('.group-header').forEach(h => setGroupState(h, false));
	};

	// ##### INITIALIZATION

	function upgradeHtml() {
		element.els('.group-header').forEach(header => {
			if (header.nextElementSibling?.classList.contains('group-items')) return;
			const items = [];
			let next = header.nextElementSibling;
			while (next && !next.classList.contains('group-header')) {
				if (next.tagName === 'LI') next.classList.add('list-item');
				items.push(next);
				next = next.nextElementSibling;
			}
			if (items.length) {
				header.after(dom.create('div', {
					class: 'group-items',
					attrs: { role: 'presentation' },
					content: items
				}));
			}
		});
	}

	function upgradeAccessibility() {
		if (!element.hasAttribute('role')) element.setAttribute('role', 'tree');
		element.els('ul').forEach(ul => {
			if (!ul.hasAttribute('role')) ul.setAttribute('role', 'group');
		});
		element.els('li:not(.group-header):not(.separator)').forEach(li => {
			if (!li.hasAttribute('role')) li.setAttribute('role', 'none');
		});
		element.els('a').forEach(link => {
			if (!link.hasAttribute('role')) link.setAttribute('role', 'treeitem');
			if (link.closest('.active')) link.setAttribute('aria-selected', 'true');
		});
		element.els('.group-header').forEach(header => {
			if (!header.hasAttribute('role')) header.setAttribute('role', 'none');
			const button = header.el('.group-toggle');
			if (button) {
				if (!button.hasAttribute('role')) button.setAttribute('role', 'treeitem');
				if (!button.hasAttribute('aria-expanded')) button.setAttribute('aria-expanded', 'false');
			}
		});
	}

	let isMouseDown = false;
	element.addEventListener('mousedown', () => {
		isMouseDown = true;
		setTimeout(() => isMouseDown = false, 500);
	});

	element.addEventListener('click', (e) => {
		const groupToggle = e.target.closest('.group-toggle');
		if (groupToggle) {
			const header = groupToggle.closest('.group-header');
			if (header) {
				const expand = groupToggle.getAttribute('aria-expanded') !== 'true';
				if (mode === 'fold' && expand) {
					const path = getPathHeaders(header);
					path.add(header);
					updateAccordionState(path);
				} else {
					setGroupState(header, expand);
					if (!expand) {
						header.nextElementSibling?.els('.group-header').forEach(h => setGroupState(h, false));
					}
				}
			}
			return;
		}

		const link = e.target.closest('a');
		if (link) {
			updateActive(link);
			dispatchActiveEvent({
				element: link,
				href: link.getAttribute('href'),
				text: link.textContent.trim()
			});

			if (!link.getAttribute('href')) {
				e.preventDefault();
			}
		}
	});

	element.addEventListener('focusin', (e) => {
		if (mode === 'fold') {
			const groupToggle = e.target.closest('.group-toggle');
			if (groupToggle) {
				if (isMouseDown) return;
				const header = groupToggle.closest('.group-header');
				const path = getPathHeaders(header);
				path.add(header);
				updateAccordionState(path);
			} else {
				const link = e.target.closest('a');
				if (link) {
					const path = getPathHeaders(link);
					updateAccordionState(path);
				}
			}
		}
	});

	element.addEventListener('keydown', (e) => {
		const target = e.target.closest('a, .group-toggle');
		if (!target) return;

		const items = element.els('a, .group-toggle').filter(el => {
			return el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
		});
		const idx = items.indexOf(target);

		if (e.key === 'ArrowDown' && idx < items.length - 1) { e.preventDefault(); items[idx + 1].focus(); }
		else if (e.key === 'ArrowUp' && idx > 0) { e.preventDefault(); items[idx - 1].focus(); }
		else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
		else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
		else if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			target.click();
		}
	});

	if (mode === 'fold') {
		upgradeHtml();
		element.els('.group-header').forEach(h => {
			setGroupState(h, false);
		});
	}

	upgradeAccessibility();
});

registerComponent('nui-content', (element) => {
	// nui-content is the positioning context for content area
	// nui-main handles the scroll behavior
	upgradeAccessibility(element);
});

registerComponent('nui-main', (element) => {
	// nui-main is the scroll container for content
	if (!element.hasAttribute('role')) {
		element.setAttribute('role', 'main');
	}
	if (!element.hasAttribute('id')) {
		element.setAttribute('id', 'main-content');
	}
	upgradeAccessibility(element);
});

registerComponent('nui-app-footer', (element) => {
	const footer = element.el('footer');
	if (footer) {
		const isMainFooter = !footer.closest('article, section, aside, main');
		if (isMainFooter && !footer.hasAttribute('role')) {
			footer.setAttribute('role', 'contentinfo');
		}
	}
});

registerComponent('nui-skip-links', (element) => {
	function buildSkipLink(target, label) {
		const targetEl = document.el(target);
		if (!targetEl) return null;

		if (!targetEl.id) {
			targetEl.id = `skip-target-${Math.random().toString(36).substr(2, 9)}`;
		}
		const targetId = targetEl.id;

		if (!targetEl.hasAttribute('tabindex')) {
			targetEl.setAttribute('tabindex', '-1');
		}

		const link = dom.create('a', {
			attrs: { href: `#${targetId}` },
			class: 'skip-link',
			text: label
		});

		link.addEventListener('click', (e) => {
			e.preventDefault();
			targetEl.focus();
		});

		return link;
	}

	if (element.children.length === 0) {
		const app = element.closest('nui-app') || document.el('nui-app');
		const defaultLinks = [];

		// In app mode, only provide skip to main content
		// (top nav and sidebar are already visible in fixed positions)
		const main = document.el('main');
		if (main) {
			defaultLinks.push({ target: main, label: 'Skip to main content' });
		}

		defaultLinks.forEach(({ target, label }) => {
			const link = buildSkipLink(target, label);
			if (link) element.appendChild(link);
		});
	} else {
		element.els('a[href^="#"]').forEach(link => {
			const target = link.getAttribute('href');
			if (target && target !== '#') {
				const targetEl = document.el(target);
				if (targetEl && !targetEl.hasAttribute('tabindex')) {
					targetEl.setAttribute('tabindex', '-1');
				}
			}

			link.addEventListener('click', (e) => {
				e.preventDefault();
				const targetId = link.getAttribute('href');
				const targetEl = document.el(targetId);
				if (targetEl) {
					targetEl.focus();
				}
			});
		});
	}

	if (!element.hasAttribute('role')) {
		element.setAttribute('role', 'navigation');
	}
	if (!element.hasAttribute('aria-label')) {
		element.setAttribute('aria-label', 'Skip links');
	}
});

registerLayoutComponent('nui-icon-button');
registerLayoutComponent('nui-badge');
registerLayoutComponent('nui-page');

// ################################# nui-card COMPONENT

registerComponent('nui-card', (element) => {
	const layout = element.getAttribute('layout');
	
	if (layout === 'flip') {
		if (!element.hasAttribute('role')) {
			element.setAttribute('role', 'button');
		}
		if (!element.hasAttribute('tabindex')) {
			element.setAttribute('tabindex', '0');
		}

		element.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				element.toggleAttribute('flipped');
			}
		});

		// Accessible flip indication
		const updateA11y = () => {
			const isFlipped = element.hasAttribute('flipped');
			element.setAttribute('aria-expanded', isFlipped);
		};
		updateA11y();

		// Observer for 'flipped' attribute to keeping ARIA updated
		const observer = new MutationObserver((mutations) => {
			mutations.forEach(m => {
				if (m.attributeName === 'flipped') {
					updateA11y();
				}
			});
		});
		observer.observe(element, { attributes: true, attributeFilter: ['flipped'] });

		return () => observer.disconnect();
	}

	if (element.hasAttribute('interactive')) {
		// Keyboard support for interactive cards, if they don't have a focusable link.
		// Usually handled better via standard a tags.
		const mainLink = element.querySelector('a.nui-card-link');
		if (mainLink) {
			// pure CSS handles the "cover" clickable area, we don't need JS delegation.
		} else {
			if (!element.hasAttribute('tabindex')) {
				element.setAttribute('tabindex', '0');
			}
			element.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					element.click();
				}
			});
		}
	}
});

// ################################# nui-layout COMPONENT

registerComponent('nui-layout', (element) => {
	const type = element.getAttribute('type') || 'grid';
	element.classList.add(`nui-layout-${type}`);

	if (type === 'grid') {
		handleGridLayout(element);
	} else if (type === 'flow') {
		handleFlowLayout(element);
	}
});

function handleGridLayout(element) {
	const n = parseInt(element.getAttribute('columns')) || 1;
	const gap = element.getAttribute('gap');

	if (gap) element.style.setProperty('--nui-layout-gap', gap);
	element.style.setProperty('--nui-layout-columns', n);
	element.style.setProperty('--nui-layout-columns-tablet', Math.min(n, 2));
}

function handleFlowLayout(element) {
	const n = parseInt(element.getAttribute('columns')) || 1;
	const columnWidth = element.getAttribute('column-width');
	const sort = element.getAttribute('sort');
	const gap = element.getAttribute('gap');

	if (gap) element.style.setProperty('--nui-layout-gap', gap);

	element.style.setProperty('--nui-layout-count', n);
	element.style.setProperty('--nui-layout-count-tablet', Math.min(n, 2));

	if (columnWidth?.startsWith('/')) {
		const divisor = parseInt(columnWidth.slice(1));
		if (!isNaN(divisor) && divisor > 0) {
			const containerWidth = element.offsetWidth;
			const gapValue = parseFloat(getComputedStyle(element).columnGap) || 0;
			const availableWidth = containerWidth - (gapValue * (divisor - 1));
			element.style.setProperty('--nui-layout-width', `${availableWidth / divisor}px`);
		}
	}

	if (sort === 'height') {
		const children = Array.from(element.children);
		children.sort((a, b) => b.offsetHeight - a.offsetHeight);
		children.forEach(child => element.appendChild(child));
	}
}

// ################################# nui-column-flow COMPONENT (Deprecated - use nui-layout type="flow")

registerComponent('nui-column-flow', (element) => {
	const sort = element.getAttribute('sort');
	const columns = element.getAttribute('columns');
	const columnWidth = element.getAttribute('column-width');

	if (columns) element.style.columnCount = columns;
	if (columnWidth) {
		if (columnWidth.startsWith('/')) {
			const divisor = parseInt(columnWidth.slice(1));
			if (!isNaN(divisor) && divisor > 0) {
				const containerWidth = element.offsetWidth;
				const gapValue = parseFloat(getComputedStyle(element).columnGap) || 0;
				const availableWidth = containerWidth - (gapValue * (divisor - 1));
				element.style.columnWidth = `${availableWidth / divisor}px`;
			}
		} else {
			element.style.columnWidth = columnWidth;
		}
	}

	if (sort && sort.includes('height')) {
		const descending = !sort.startsWith('!');
		const items = Array.from(element.children);
		items.sort((a, b) => {
			const diff = b.offsetHeight - a.offsetHeight;
			return descending ? diff : -diff;
		});
		items.forEach(item => element.appendChild(item));
	}
});

// ################################# nui-button-container COMPONENT

registerComponent('nui-button-container', (element) => {
	const align = element.getAttribute('align') || 'start';
	const gap = element.getAttribute('gap') || 'small';
	const direction = element.getAttribute('direction') || 'row';
	const mode = element.getAttribute('mode');

	if (direction === 'column') element.classList.add('direction-column');
	element.classList.add('align-' + align);

	if (mode === 'segmented') {
		element.setAttribute('variant', 'segmented');
	} else {
		element.classList.add('gap-' + gap);
	}

	if (mode === 'single-select' || mode === 'segmented' || element.getAttribute('variant') === 'segmented') {
		element.addEventListener('nui-click', (e) => {
			const btn = e.target.closest('nui-button');
			if (btn && element.contains(btn)) {
				element.els('nui-button').forEach(b => b.removeAttribute('state'));
				btn.setAttribute('state', 'active');
				element.value = btn.getAttribute('value') || btn.textContent.trim();
				element.dispatchEvent(new CustomEvent('nui-change', {
					bubbles: true,
					detail: { selected: btn, value: element.value }
				}));
			}
		});
	}
});

function setupDialogBehavior(element, dialog, eventPrefix) {
	const close = (ret) => {
		dialog.classList.add('closing');
		dialog.addEventListener('transitionend', () => {
			dialog.classList.remove('closing');
			dialog.close(ret);
			element.dispatchEvent(new CustomEvent(`${eventPrefix}-close`, { bubbles: true, detail: { returnValue: ret } }));
		}, { once: true });
	};

	element.showModal = () => {
		dialog.showModal();
		element.dispatchEvent(new CustomEvent(`${eventPrefix}-open`, { bubbles: true }));
	};

	element.close = (ret) => {
		if (!dialog.open || dialog.classList.contains('closing')) return;
		close(ret);
	};

	element.isOpen = () => dialog.open;

	dialog.addEventListener('close', () => {
		if (!dialog.classList.contains('closing')) {
			element.dispatchEvent(new CustomEvent(`${eventPrefix}-close`, { bubbles: true, detail: { returnValue: dialog.returnValue } }));
		}
	});

	dialog.addEventListener('cancel', (e) => {
		e.preventDefault();
		if (!element.hasAttribute('blocking')) element.close('cancel');
		element.dispatchEvent(new CustomEvent(`${eventPrefix}-cancel`, { bubbles: true }));
	});

	let backdropMouseDown = false;
	dialog.addEventListener('mousedown', (e) => {
		backdropMouseDown = e.target === dialog;
	});
	dialog.addEventListener('touchstart', (e) => {
		backdropMouseDown = e.target === dialog;
	}, { passive: true });

	dialog.addEventListener('click', (e) => {
		if (element.hasAttribute('blocking') || e.target !== dialog || !backdropMouseDown) return;
		backdropMouseDown = false;
		element.close('backdrop');
	});
}

// ################################# nui-dialog COMPONENT

registerComponent('nui-dialog', (element) => {
	let dialog = element.el('dialog');
	const mode = element.getAttribute('mode');

	if (!dialog) {
		dialog = document.createElement('dialog');
		
		if (mode === 'page') {
			const title = element.getAttribute('title') || '';
			const hasTitle = element.hasAttribute('title');
			
			// Move children that are NOT the new <dialog> into a <main> wrapper
			const main = document.createElement('main');
			while (element.firstChild) {
				main.appendChild(element.firstChild);
			}
			
			if (hasTitle || title) {
				const header = document.createElement('header');
				header.innerHTML = `
					<h2>${title}</h2>
					<nui-button variant="icon" class="icon-only">
						<button type="button" aria-label="Close" data-action="dialog-close">
							<nui-icon name="close"></nui-icon>
						</button>
					</nui-button>
				`;
				const closeBtn = header.querySelector('button');
				if (closeBtn) {
					closeBtn.addEventListener('click', (e) => {
						e.preventDefault();
						e.stopPropagation();
						element.close('cancel');
					});
				}
				dialog.appendChild(header);
			}
			
			dialog.appendChild(main);
			element._mainEl = main; // Expose main specifically
			
			const buttonsAttr = element.getAttribute('data-buttons');
			let buttons = element.buttons || [];
			if (buttonsAttr && (!buttons || buttons.length === 0)) {
				try { buttons = JSON.parse(buttonsAttr); } catch (e) {}
			}
			
			if (buttons && buttons.length) {
				const footer = document.createElement('footer');
				const container = document.createElement('nui-button-container');
				container.setAttribute('align', 'end');
				
				buttons.forEach(btn => {
					const variant = btn.type || 'outline';
					const iconHtml = btn.icon ? `<nui-icon name="${btn.icon}"></nui-icon>` : '';
					const btnHtml = `<nui-button variant="${variant}"><button type="button" data-value="${btn.value || btn.id || ''}">${iconHtml}${btn.label}</button></nui-button>`;
					
					const temp = document.createElement('div');
					temp.innerHTML = btnHtml;
					const btnEl = temp.firstElementChild;
					
					const nativeBtn = btnEl.querySelector('button');
					if (nativeBtn) {
						nativeBtn.addEventListener('click', (e) => {
							e.preventDefault();
							e.stopPropagation();
							element.close(btn.value || btn.id);
						});
					}
					
					container.appendChild(btnEl);
				});
				footer.appendChild(container);
				dialog.appendChild(footer);
			}
		} else {
			const content = document.createElement('div');
			content.className = 'nui-dialog-content';
			while (element.firstChild) {
				content.appendChild(element.firstChild);
			}
			dialog.appendChild(content);
		}
		
		element.appendChild(dialog);

		if (config.debug !== false) {
			console.info(`[NUI] ℹ <nui-dialog> auto-created inner <dialog>. For zero-JS fallback, use:\n  <nui-dialog><dialog>...</dialog></nui-dialog>`);
		}
	}

	setupDialogBehavior(element, dialog, 'nui-dialog');

	element.show = () => {
		dialog.show();
		element.dispatchEvent(new CustomEvent('nui-dialog-open', { bubbles: true }));
	};
});

// ################################# nui-overlay COMPONENT

registerComponent('nui-overlay', (element) => {
	const dialog = element.el('dialog');
	if (!dialog) return;

	setupDialogBehavior(element, dialog, 'nui-overlay');
});

// ################################# nui-tabs COMPONENT

registerComponent('nui-tabs', (element) => {
	const fillMode = element.hasAttribute('fill');

	// In fill mode, set flex layout explicitly via JS to ensure it works
	// regardless of CSS cascade order
	if (fillMode) {
		element.style.display = 'flex';
		element.style.flexDirection = 'column';
		element.style.flex = '1'; // Fill parent container
		element.style.minHeight = '0'; // Allow shrinking
		element.style.height = '100%'; // Explicit height for flex item
	}

	let tabList = element.el('[role="tablist"]');
	if (!tabList) {
		tabList = [...element.children].find(c => c.el('button, a'));
		tabList?.setAttribute('role', 'tablist');
	}

	// Auto-wrap: create <nav> if tabs has bare <button> children (Proposal 2 Tier 1)
	if (!tabList && config.debug !== false) {
		const bareButtons = [...element.children].filter(c => c.tagName === 'BUTTON' || c.tagName === 'A');
		if (bareButtons.length > 0) {
			tabList = document.createElement('nav');
			tabList.setAttribute('role', 'tablist');
			bareButtons.forEach(btn => tabList.appendChild(btn));
			element.insertBefore(tabList, element.firstChild);
			console.info('[NUI] ℹ <nui-tabs> auto-created <nav role="tablist"> for bare buttons. For zero-JS fallback, use:\n  <nui-tabs><nav><button>Tab</button></nav><section>Content</section></nui-tabs>');
		}
	}

	if (!tabList) return;

	const tabs = tabList.els('button, a');
	tabs.forEach(t => {
		t.setAttribute('role', 'tab');
		if (t.tagName === 'A') t.addEventListener('click', e => e.preventDefault());
	});

	let panels = element.els('[role="tabpanel"]');
	if (!panels.length) {
		panels = [...element.children].filter(c => c !== tabList);
		panels.forEach(p => p.setAttribute('role', 'tabpanel'));
	}

	// In fill mode, set panels to flex and fill available space
	if (fillMode) {
		panels.forEach(p => {
			p.style.display = 'flex';
			p.style.flexDirection = 'column';
			p.style.flex = '1';
			p.style.minHeight = '0';
			p.style.overflow = 'auto';
			p.style.height = '100%'; // Explicit height for flex item
		});
	}

	tabs.forEach((tab, i) => {
		let pid = tab.getAttribute('aria-controls') || tab.getAttribute('href')?.replace('#', '');
		let panel = pid ? element.el(`#${pid}`) : panels[i];

		if (panel) {
			if (!panel.id) panel.id = `nui-panel-${Date.now()}-${i}`;
			if (!tab.id) tab.id = `nui-tab-${Date.now()}-${i}`;

			tab.setAttribute('aria-controls', panel.id);
			panel.setAttribute('aria-labelledby', tab.id);
			if (!panels.includes(panel)) panels.push(panel);
		}
	});

	const activateTab = (targetTab, shouldAnimate = true) => {
		const panelId = targetTab.getAttribute('aria-controls');
		const targetPanel = element.el(`#${panelId}`);

		if (!targetPanel) return;

		// In fill mode, skip height animation - flex layout determines height
		const fillMode = element.hasAttribute('fill');
		const animate = shouldAnimate && !fillMode && !element.hasAttribute('no-animation') &&
			!window.matchMedia('(prefers-reduced-motion: reduce)').matches;

		let startHeight = 0;

		if (animate) {
			startHeight = element.offsetHeight;
			element.style.height = `${startHeight}px`;
			element.style.overflow = 'hidden';
			element.style.transition = 'height 0.3s ease-out';
		}

		tabs.forEach(t => {
			t.setAttribute('aria-selected', 'false');
			t.setAttribute('tabindex', '-1');
		});
		panels.forEach(p => {
			// In fill mode, use style.display instead of hidden attribute
			// because [hidden] CSS rule applies display:none !important which overrides inline styles
			if (fillMode) {
				p.style.display = 'none';
			} else {
				p.hidden = true;
				p.style.display = 'none';
			}
		});

		targetTab.setAttribute('aria-selected', 'true');
		targetTab.removeAttribute('tabindex');

		// In fill mode, use display:flex; in normal mode use hidden=false
		if (fillMode) {
			targetPanel.style.display = 'flex';
			targetPanel.style.flexDirection = 'column';
			targetPanel.style.flex = '1';
			targetPanel.style.minHeight = '0';
			targetPanel.style.overflow = 'auto';
			targetPanel.style.height = '100%';
		} else {
			targetPanel.hidden = false;
			targetPanel.style.display = '';
		}

		if (animate) {
			void element.offsetHeight;

			element.style.height = 'auto';
			const newHeight = element.scrollHeight;

			element.style.height = `${startHeight}px`;

			void element.offsetHeight;

			element.style.height = `${newHeight}px`;

			const cleanup = () => {
				element.style.height = '';
				element.style.overflow = '';
				element.removeEventListener('transitionend', cleanup);
				element.removeEventListener('transitioncancel', cleanup);
			};

			element.addEventListener('transitionend', cleanup);
			element.addEventListener('transitioncancel', cleanup);

			// Fallback: ensure styles are cleaned up even if transitionend never fires
			// (e.g., when startHeight equals newHeight, no transition occurs)
			element._tabsCleanupTimeout = setTimeout(cleanup, 400);
		}

		element.dispatchEvent(new CustomEvent('nui-tab-change', {
			bubbles: true,
			detail: { tab: targetTab, panel: targetPanel }
		}));
	};

	tabList.addEventListener('click', (e) => {
		const tab = e.target.closest('[role="tab"]');
		if (tab && tabs.includes(tab)) {
			activateTab(tab);
		}
	});

	tabList.addEventListener('keydown', (e) => {
		const currentTab = e.target.closest('[role="tab"]');
		if (!currentTab) return;

		const index = tabs.indexOf(currentTab);
		const keyMap = {
			'ArrowRight': (index + 1) % tabs.length,
			'ArrowDown': (index + 1) % tabs.length,
			'ArrowLeft': (index - 1 + tabs.length) % tabs.length,
			'ArrowUp': (index - 1 + tabs.length) % tabs.length,
			'Home': 0,
			'End': tabs.length - 1
		};

		const nextIndex = keyMap[e.key];
		if (nextIndex !== undefined) {
			e.preventDefault();
			const nextTab = tabs[nextIndex];
			nextTab.focus();
			activateTab(nextTab);
		}
	});

	const initialTab = tabs.find(t => t.getAttribute('aria-selected') === 'true') || tabs[0];
	if (initialTab) {
		activateTab(initialTab, false);
	}

	element.selectTab = (indexOrId) => {
		let targetTab = null;
		if (typeof indexOrId === 'number' || !isNaN(indexOrId)) {
			targetTab = tabs[parseInt(indexOrId, 10)];
		} else {
			targetTab = tabs.find(t => t.id === indexOrId || t.getAttribute('aria-controls') === indexOrId);
		}
		if (targetTab) activateTab(targetTab);
	};
});

// ################################# nui-accordion COMPONENT

registerComponent('nui-accordion', (element) => {
	const details = element.els(':scope > details');
	const animate = !element.hasAttribute('no-animation') &&
		!window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	const animateDetails = (detail, opening) => {
		if (!animate) return;

		const summary = detail.el('summary');
		const content = detail.el('.accordion-content') || detail.lastElementChild;
		if (!summary || !content) return;

		const start = opening ? summary.offsetHeight : detail.offsetHeight;
		detail.style.cssText = `height: ${start}px; overflow: hidden; transition: height 0.3s ease-out`;

		if (opening) detail.open = true;
		void detail.offsetHeight;

		const end = opening ? detail.scrollHeight : summary.offsetHeight;
		detail.style.height = `${end}px`;

		const onEnd = (e) => {
			if (e.target !== detail) return;

			detail.style.cssText = '';

			if (!opening) detail.open = false;
			detail.removeEventListener('transitionend', onEnd);
		};
		detail.addEventListener('transitionend', onEnd);
	};

	if (animate) {
		details.forEach(detail => {
			const summary = detail.el('summary');
			if (!summary) return;

			summary.addEventListener('click', (e) => {
				e.preventDefault();

				if (element.hasAttribute('exclusive') && !detail.open) {
					details.forEach(d => {
						if (d !== detail && d.open) {
							animateDetails(d, false);
						}
					});
				}

				animateDetails(detail, !detail.open);
			});
		});
	} else if (element.hasAttribute('exclusive')) {
		details.forEach(targetDetail => {
			targetDetail.addEventListener('toggle', () => {
				if (targetDetail.open) {
					details.forEach(d => d !== targetDetail && d.open && d.removeAttribute('open'));
				}
			});
		});
	}

	element.toggle = (index) => {
		const target = details[index];
		if (target) {
			const summary = target.el('summary');
			if (summary && animate) summary.click();
			else target.open = !target.open;
		}
	};

	element.expandAll = () => {
		if (element.hasAttribute('exclusive')) return;
		details.forEach(detail => {
			if (!detail.open) {
				const summary = detail.el('summary');
				if (summary && animate) summary.click();
				else detail.open = true;
			}
		});
	};

	element.collapseAll = () => {
		details.forEach(detail => {
			if (detail.open) {
				const summary = detail.el('summary');
				if (summary && animate) summary.click();
				else detail.open = false;
			}
		});
	};
});

// ################################# nui-details COMPONENT

registerComponent('nui-details', (element) => {
	const src = element.getAttribute('src');
	if (!src) return; // No src — children render as-is, no lazy loading needed

	const summaryText = element.getAttribute('summary') || '';
	const isLazy = element.hasAttribute('lazy');

	// Build the details structure
	const detailsEl = document.createElement('details');
	const summaryEl = document.createElement('summary');
	if (summaryText) {
		const strong = document.createElement('strong');
		strong.textContent = summaryText;
		summaryEl.appendChild(strong);
	}
	detailsEl.appendChild(summaryEl);
	element.appendChild(detailsEl);

	let loaded = false;

	function loadContent() {
		if (loaded) return;
		loaded = true;

		const isMarkdown = src.endsWith('.md');
		const contentDiv = document.createElement('nui-details-content');

		fetch(src)
			.then(res => {
				if (!res.ok) throw new Error(`Failed to load ${src}`);
				return res.text();
			})
			.then(text => {
				if (isMarkdown) {
					const mdEl = document.createElement('nui-markdown');
					mdEl.setAttribute('src', src);
					contentDiv.appendChild(mdEl);
				} else if (src.endsWith('.html')) {
					contentDiv.innerHTML = text;
				} else {
					contentDiv.textContent = text;
				}
				detailsEl.appendChild(contentDiv);
			})
			.catch(err => {
				contentDiv.textContent = `Error loading content: ${err.message}`;
				contentDiv.style.color = 'var(--palette-alert)';
				contentDiv.style.padding = 'var(--nui-space)';
				detailsEl.appendChild(contentDiv);
			});
	}

	if (isLazy) {
		// Load only when user opens the details
		detailsEl.addEventListener('toggle', () => {
			if (detailsEl.open) loadContent();
		}, { once: true });
	} else {
		// Load immediately (on upgrade)
		loadContent();
	}
});

// ################################# nui-table COMPONENT

registerComponent('nui-table', (element) => {
	const table = element.querySelector('table');
	if (!table) return;

	// Add enhanced class
	table.classList.add('nui-table-enhanced');

	// Get headers
	const ths = Array.from(table.querySelectorAll('thead th'));
	const headers = ths.map(th => th.textContent.trim());

	// Process rows
	const rows = Array.from(table.querySelectorAll('tbody tr'));
	const totalCells = rows.reduce((sum, row) => sum + row.children.length, 0);
	let tableCellIndex = 1;

	rows.forEach(row => {
		const cells = [...row.children];
		cells.forEach((cell, i) => {
			if (headers[i]) {
				cell.setAttribute('data-label', headers[i]);
			}
			cell.setAttribute('data-row-cell-index', i + 1);
			cell.setAttribute('data-row-cell-total', cells.length);
			cell.setAttribute('data-table-cell-total', totalCells);
			cell.setAttribute('data-table-cell-index', tableCellIndex);
			tableCellIndex++;
		});
	});
});

// ################################# nui-slider COMPONENT

registerComponent('nui-slider', (element) => {
	// Find or create the native input
	let input = element.el('input[type="range"]');
	if (!input) {
		input = dom.create('input', {
			attrs: { type: 'range', min: '0', max: '100', value: '50' }
		});
		element.appendChild(input);
	}

	// Hide native input but keep it accessible
	input.classList.add('nui-slider-native');

	// Create visual elements
	const track = dom.create('div', { class: 'nui-slider-track', target: element });
	const fill = dom.create('div', { class: 'nui-slider-fill', target: track });
	const thumb = dom.create('div', { class: 'nui-slider-thumb', target: track });

	const getRange = () => ({
		min: parseFloat(input.min) || 0,
		max: parseFloat(input.max) || 100,
		step: parseFloat(input.step) || 1
	});

	// Update visual position from input value
	function updateVisuals() {
		const { min, max } = getRange();
		const value = parseFloat(input.value);
		const percent = ((value - min) / (max - min)) * 100;
		fill.style.width = percent + '%';
		thumb.style.left = percent + '%';
	}

	// Set value from percentage
	function setValueFromPercent(percent) {
		const { min, max, step } = getRange();
		let value = min + (percent * (max - min));

		// Snap to step
		if (step > 0) {
			value = Math.round(value / step) * step;
		}

		// Clamp to range
		value = Math.max(min, Math.min(max, value));

		if (parseFloat(input.value) !== value) {
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
		}
	}

	// Initial sync
	updateVisuals();

	// Listen to native input changes
	input.addEventListener('input', updateVisuals);

	// Enable drag interaction on track
	const cleanup = enableDrag(track, (data) => {
		setValueFromPercent(data.percentX);
		updateVisuals();

		if (data.type === 'start') {
			thumb.classList.add('active');
			element.classList.add('dragging');
		} else if (data.type === 'end') {
			thumb.classList.remove('active');
			element.classList.remove('dragging');
			input.dispatchEvent(new Event('change', { bubbles: true }));
		}
	});

	// Expose API on element
	element.getValue = () => parseFloat(input.value);
	element.setValue = (val) => {
		input.value = val;
		updateVisuals();
	};

	// Return cleanup function
	return cleanup;
});

// ################################# nui-banner COMPONENT

registerComponent('nui-banner', (element) => {
	let wrapper = element.el('.nui-banner-wrapper');
	let contentEl = element.el('.nui-banner-content');
	
	if (!wrapper) {
		contentEl = dom.create('div', { class: 'nui-banner-content', content: Array.from(element.childNodes) });
		wrapper = dom.create('div', { class: 'nui-banner-wrapper', content: contentEl, target: element });
	} else if (!contentEl) {
		contentEl = dom.create('div', { class: 'nui-banner-content', content: Array.from(wrapper.childNodes), target: wrapper });
	}

	let autoCloseTimer = null;
	let originalParent = null;
	let originalNextSibling = null;

	if (element._bannerInitialized) return;
	element._bannerInitialized = true;

	const priority = element.getAttribute('priority') || 'info';
	element.setAttribute('role', priority === 'alert' ? 'alert' : 'status');
	element.setAttribute('aria-live', priority === 'alert' ? 'assertive' : 'polite');

	const moveToBannerLayer = () => {
		const contentArea = document.el('nui-app nui-content');
		if (!contentArea) return;

		let bannerLayer = contentArea.el(':scope > .nui-banner-layer');
		if (!bannerLayer) bannerLayer = dom.create('div', { class: 'nui-banner-layer', target: contentArea });

		if (element.parentElement === bannerLayer) return;

		originalParent = element.parentElement;
		originalNextSibling = element.nextSibling;
		bannerLayer.appendChild(element);
	};

	const restorePosition = () => {
		if (!originalParent) return;
		if (originalNextSibling && originalNextSibling.parentElement === originalParent) {
			originalParent.insertBefore(element, originalNextSibling);
		} else if (originalParent.isConnected) {
			originalParent.appendChild(element);
		}
		originalParent = null;
		originalNextSibling = null;
	};

	element.show = () => {
		if (element.hasAttribute('open')) return;
		if (element.closest('nui-content, nui-main')) moveToBannerLayer();

		element.setAttribute('open', '');
		element.dispatchEvent(new CustomEvent('nui-banner-open', { bubbles: true }));

		const autoClose = parseInt(element.getAttribute('auto-close'), 10);
		if (autoClose > 0) {
			if (autoCloseTimer) clearTimeout(autoCloseTimer);
			autoCloseTimer = setTimeout(() => element.close('timeout'), autoClose);
		}
	};

	element.close = (action = 'close') => {
		if (!element.hasAttribute('open')) return;
		if (autoCloseTimer) clearTimeout(autoCloseTimer);

		element.classList.add('closing');
		element.addEventListener('transitionend', () => {
			element.classList.remove('closing');
			element.removeAttribute('open');
			restorePosition();
			element.dispatchEvent(new CustomEvent('nui-banner-close', { bubbles: true, detail: { action } }));
		}, { once: true });
	};

	element.update = (content) => {
		if (typeof content === 'string') {
			const textEl = element.el('p, span, [data-content]');
			if (textEl) textEl.textContent = content;
		}
	};

	element.isOpen = () => element.hasAttribute('open');
});

// ################################# INPUT COMPONENTS

let _idCounter = 0;
function generateId(prefix = 'nui') {
	return `${prefix}-${++_idCounter}`;
}

function generateInputId(prefix = 'nui-input') {
	return generateId(prefix);
}

function setupInputBehavior(element, input, config = {}) {
	const { autoResize, showCount } = config;
	let errorEl, countEl, clearBtn;

	// Add search icon prefix for type="search" (as clickable button like clear button)
	const isSearchInput = input.type === 'search';
	if (isSearchInput) {
		const searchBtn = dom.create('button', {
			class: 'nui-input-icon nui-input-icon-start',
			attrs: { type: 'button', 'aria-label': 'Search' },
			content: '<nui-icon name="search"></nui-icon>'
		});
		element.insertBefore(searchBtn, input);
	}
	
	// Cache computed styles for auto-resize (calculated once)
	let cachedLineHeight, cachedPadding, cachedBorder;
	if (autoResize) {
		const style = getComputedStyle(input);
		cachedLineHeight = parseInt(style.lineHeight) || parseInt(style.fontSize) * 1.5;
		cachedPadding = parseInt(style.paddingTop) + parseInt(style.paddingBottom);
		cachedBorder = parseInt(style.borderTopWidth) + parseInt(style.borderBottomWidth);
	}

	const dispatch = (name, detail = {}) => {
		element.dispatchEvent(new CustomEvent(name, {
			bubbles: true,
			detail: { ...detail, name: input.name || input.id || '' }
		}));
	};

	const ensureErrorIndicator = () => {
		if (errorEl) return errorEl;

		const icon = dom.create('nui-icon', { attrs: { name: 'warning', role: 'status', tabindex: '0' }, target: element });
		icon.id = generateInputId('error-icon');
		icon.classList.add('nui-error-indicator');

		const tooltip = document.createElement('nui-tooltip');
		tooltip.id = generateInputId('error-tooltip');
		tooltip.setAttribute('for', icon.id);
		document.body.appendChild(tooltip);

		errorEl = { icon, tooltip };
		return errorEl;
	};

	const validate = () => {
		const valid = input.validity.valid;
		const hasValue = input.value !== '';
		const hasValidationRules = ['required', 'pattern', 'minlength', 'maxlength', 'min', 'max']
			.some(attr => input.hasAttribute(attr)) || element.hasAttribute('validate');

		if (hasValidationRules) {
			element.classList.toggle('is-valid', valid && hasValue);
			element.classList.toggle('is-invalid', !valid);
		}

		if (!valid && input.validationMessage) {
			const err = ensureErrorIndicator();
			err.tooltip.textContent = input.validationMessage;
			input.setAttribute('aria-invalid', 'true');
			input.setAttribute('aria-describedby', err.tooltip.id);
		} else {
			if (errorEl) errorEl.tooltip.textContent = '';
			input.removeAttribute('aria-invalid');
			input.removeAttribute('aria-describedby');
		}
		return valid;
	};

	const updateState = () => {
		if (autoResize) {
			const minRows = parseInt(element.getAttribute('min-rows')) || 1;
			const maxRows = parseInt(element.getAttribute('max-rows')) || 999;
			
			const minHeight = (cachedLineHeight * minRows) + cachedPadding + cachedBorder;
			const maxHeight = (cachedLineHeight * maxRows) + cachedPadding + cachedBorder;
			
			input.style.height = minHeight + 'px';
			const scrollHeight = input.scrollHeight;
			
			input.style.height = Math.max(minHeight, Math.min(scrollHeight, maxHeight)) + 'px';
			input.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
		}
		if (showCount) {
			if (!countEl) countEl = dom.create('div', { class: 'nui-char-count', target: element });
			const max = input.maxLength > 0 ? input.maxLength : null;
			const len = input.value.length;
			countEl.textContent = max ? `${len} / ${max}` : len;
			if (max) countEl.classList.toggle('at-limit', len >= max);
		}
		if (clearBtn) clearBtn.style.display = input.value ? 'flex' : 'none';
	};

	if (element.hasAttribute('clearable')) {
		clearBtn = dom.create('button', {
			class: 'nui-clear-btn',
			attrs: { type: 'button', 'aria-label': 'Clear input' },
			style: 'display: none',
			content: '<nui-icon name="close"></nui-icon>',
			target: element
		});
		clearBtn.addEventListener('click', () => {
			input.value = '';
			input.focus();
			updateState();
			dispatch('nui-clear');
			dispatch('nui-input', { value: '', valid: true });
		});
	}

	input.addEventListener('input', () => {
		updateState();
		if (input.value !== '') {
			validate();
		} else {
			element.classList.remove('is-valid', 'is-invalid');
			if (errorEl) errorEl.textContent = '';
			input.removeAttribute('aria-invalid');
		}
		dispatch('nui-input', { value: input.value, valid: input.validity.valid });
	});

	input.addEventListener('blur', () => {
		validate();
		dispatch('nui-change', { value: input.value, valid: input.validity.valid });
	});

	element.validate = () => {
		const valid = validate();
		dispatch('nui-validate', { valid, message: input.validationMessage });
		return valid;
	};

	element.clear = () => {
		input.value = '';
		updateState();
		element.classList.remove('is-valid', 'is-invalid');
		if (errorEl) errorEl.textContent = '';
		dispatch('nui-clear');
	};

	element.focus = () => input.focus();

	updateState();
}

function setupCheckableBehavior(element, type) {
	const input = element.el(`input[type="${type}"]`);
	if (!input) return;

	const label = element.el('label');
	if (label && !label.htmlFor) {
		if (!input.id) input.id = generateInputId(type);
		label.htmlFor = input.id;
	}

	const isRadio = type === 'radio';
	const indicator = dom.create('span', {
		class: isRadio ? 'nui-radio-circle' : 'nui-check-box',
		attrs: { 'aria-hidden': 'true' },
		content: isRadio ? '' : `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>`
	});

	input.after(indicator);

	element.addEventListener('click', (e) => {
		if (input.disabled) return;
		if (e.target === input) return;
		
		// If clicked inside a label that controls this input, let the browser handle it natively
		const clickLabel = e.target.closest && e.target.closest('label');
		if (clickLabel && clickLabel.control === input) return;

		if (isRadio && input.checked) return;

		input.checked = isRadio ? true : !input.checked;
		input.dispatchEvent(new Event('change', { bubbles: true }));
	});

	input.addEventListener('change', () => {
		element.dispatchEvent(new CustomEvent('nui-change', {
			bubbles: true,
			detail: {
				checked: input.checked,
				value: input.value,
				name: input.name || input.id || ''
			}
		}));
	});

	// Expose checked property on the element for external access
	Object.defineProperty(element, 'checked', {
		get() { return input.checked; },
		set(val) {
			input.checked = val;
			input.dispatchEvent(new Event('change', { bubbles: true }));
		}
	});
}

// ################################# nui-input-group COMPONENT

registerComponent('nui-input-group', (element) => {
	const label = element.el(':scope > label');
	const inputComponent = element.el('nui-input, nui-textarea, nui-checkbox, nui-radio');
	const input = inputComponent?.el('input, textarea');

	if (label && input && !input.id && !label.htmlFor) {
		const id = generateInputId();
		input.id = id;
		label.htmlFor = id;
	}

	if (input) {
		const updateState = () => {
			element.classList.toggle('has-error', !input.validity.valid && input.value !== '');
			element.classList.toggle('is-disabled', input.disabled);
			element.classList.toggle('is-required', input.required);
		};

		input.addEventListener('blur', updateState);
		input.addEventListener('input', () => {
			// Clear error on typing
			if (element.classList.contains('has-error') && input.validity.valid) {
				element.classList.remove('has-error');
			}
		});

		// Initial state
		updateState();
	}
});

// ################################# nui-input COMPONENT

registerComponent('nui-input', (element) => {
	let input = element.el('input');
	if (!input && element.el('textarea')) return; // nui-textarea handles textarea

	// Auto-wrap: create inner <input> if missing (Proposal 2 Tier 1)
	if (!input && config.debug !== false) {
		input = document.createElement('input');
		const type = element.getAttribute('type') || 'text';
		input.type = type;
		const placeholder = element.getAttribute('placeholder');
		if (placeholder) input.placeholder = placeholder;
		element.appendChild(input);
		console.info(`[NUI] ℹ <nui-input> auto-created inner <input type="${type}">. For zero-JS fallback, use:\n  <nui-input><input type="${type}"${placeholder ? ` placeholder="${placeholder}"` : ''}></nui-input>`);
	}

	if (!input) return;

	// Pass through type attribute from nui-input to internal input
	const inputType = element.getAttribute('type');
	if (inputType) input.type = inputType;

	setupInputBehavior(element, input);
});

// ################################# nui-textarea COMPONENT

registerComponent('nui-textarea', (element) => {
	let textarea = element.el('textarea');

	// Auto-wrap: create inner <textarea> if missing (Proposal 2 Tier 1)
	if (!textarea && config.debug !== false) {
		textarea = document.createElement('textarea');
		const placeholder = element.getAttribute('placeholder');
		if (placeholder) textarea.placeholder = placeholder;
		// Move text content into textarea
		if (element.textContent.trim()) {
			textarea.textContent = element.textContent.trim();
			element.textContent = '';
		}
		element.appendChild(textarea);
		console.info(`[NUI] ℹ <nui-textarea> auto-created inner <textarea>. For zero-JS fallback, use:\n  <nui-textarea><textarea${placeholder ? ` placeholder="${placeholder}"` : ''}>${textarea.value}</textarea></nui-textarea>`);
	}

	if (!textarea) return;

	const autoResize = element.hasAttribute('auto-resize');
	const showCount = element.hasAttribute('show-count');

	setupInputBehavior(element, textarea, { autoResize, showCount });
});

// ################################# nui-checkbox COMPONENT

registerComponent('nui-checkbox', (element) => {
	setupCheckableBehavior(element, 'checkbox');
});

// ################################# nui-radio COMPONENT

registerComponent('nui-radio', (element) => {
	setupCheckableBehavior(element, 'radio');
});

// ################################# nui-tag-input COMPONENT
// Lightweight tag management for multi-select and standalone use

registerComponent('nui-tag-input', (element) => {
	const name = element.getAttribute('name') || '';
	const isEditable = element.hasAttribute('editable');
	const placeholder = element.getAttribute('placeholder') || 'Add tag...';

	// Internal state
	const tags = [];
	let activeIdx = -1;

	// Parse existing hidden inputs
	element.els('input[type="hidden"]').forEach(inp => {
		const val = inp.value?.trim();
		if (val && !tags.some(t => t.value === val)) {
			tags.push({ value: val, label: val });
		}
	});

	// Build DOM - tags container only focusable when there are tags to navigate
	const container = dom.create('div', {
		class: 'nui-tag-input-tags',
		attrs: { role: 'listbox', 'aria-label': 'Selected tags' },
		target: element
	});
	let input = null;
	let nuiInput = null;

	// Keyboard navigation for tags container
	container.addEventListener('keydown', e => {
		if (!tags.length) return;
		const nav = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
		if (nav !== undefined) {
			e.preventDefault();
			let next = activeIdx + nav;
			if (next < 0) next = tags.length - 1;
			else if (next >= tags.length) next = isEditable ? -1 : 0;
			if (next === -1 && isEditable) { input.focus(); return; }
			setActive(next);
		} else if (e.key === 'Home') {
			e.preventDefault(); setActive(0);
		} else if (e.key === 'End') {
			e.preventDefault();
			if (isEditable) { input.focus(); activeIdx = -1; updateHighlight(); }
			else setActive(tags.length - 1);
		} else if ((e.key === 'Backspace' || e.key === 'Delete' || e.key === 'Enter' || e.key === ' ') && activeIdx >= 0) {
			e.preventDefault();
			const nextIdx = Math.min(activeIdx, tags.length - 2);
			element.removeTag(tags[activeIdx].value);
			if (tags.length) setActive(Math.max(0, nextIdx));
			else if (isEditable) input.focus();
		} else if (e.key === 'Escape') {
			activeIdx = -1; updateHighlight(); container.blur();
		}
	});

	container.addEventListener('focus', () => { if (tags.length && activeIdx < 0) setActive(0); });
	container.addEventListener('blur', () => { activeIdx = -1; updateHighlight(); });

	if (isEditable) {
		// Use nui-input wrapper for consistent styling
		nuiInput = dom.create('nui-input', { class: 'nui-tag-input-wrapper', target: element });
		input = dom.create('input', {
			attrs: { type: 'text', placeholder, autocomplete: 'off' },
			target: nuiInput
		});
		input.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const val = input.value.trim();
				if (val && element.addTag(val)) input.value = '';
			} else if (e.key === 'Backspace' && !input.value && tags.length) {
				e.preventDefault();
				setActive(tags.length - 1);
				container.focus();
			} else if ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') && input.selectionStart === 0 && tags.length) {
				e.preventDefault();
				setActive(tags.length - 1);
				container.focus();
			} else if (e.key === 'Home' && input.selectionStart === 0 && tags.length) {
				e.preventDefault();
				setActive(0);
				container.focus();
			}
		});
	}

	const dispatch = (name, detail) => element.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));

	const setActive = idx => {
		activeIdx = idx;
		updateHighlight();
		if (idx >= 0 && idx < container.children.length) {
			const el = container.children[idx];
			container.setAttribute('aria-activedescendant', el.id);
			el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		} else {
			container.removeAttribute('aria-activedescendant');
		}
	};

	const updateHighlight = () => {
		Array.from(container.children).forEach((el, i) => el.classList.toggle('is-active', i === activeIdx));
	};

	const updateContainerTabindex = () => {
		// Only focusable when there are tags to navigate; otherwise input gets focus
		container.tabIndex = tags.length > 0 ? 0 : -1;
	};

	const render = () => {
		container.innerHTML = '';
		tags.forEach((tag, i) => {
			const el = dom.create('span', {
				class: 'nui-tag',
				id: `${element.id || 'tag'}-${i}`,
				attrs: { role: 'option', 'aria-selected': 'true', 'data-value': tag.value },
				target: container
			});
			dom.create('span', { class: 'nui-tag-text', text: tag.label, target: el });
			const btn = dom.create('button', {
				class: 'nui-tag-remove',
				attrs: { type: 'button', 'aria-label': `Remove ${tag.label}`, tabindex: '-1' },
				target: el
			});
			dom.create('nui-icon', { attrs: { name: 'close' }, target: btn });
			btn.onclick = e => { e.stopPropagation(); element.removeTag(tag.value); };
		});
		element.classList.toggle('has-tags', tags.length > 0);
		if (activeIdx >= tags.length) activeIdx = tags.length - 1;
		updateHighlight();
		updateContainerTabindex();
		syncHiddenInputs();
	};

	const syncHiddenInputs = () => {
		element.els('input[type="hidden"]').forEach(inp => inp.remove());
		if (name) {
			tags.forEach(tag => {
				element.insertBefore(dom.create('input', { attrs: { type: 'hidden', name, value: tag.value } }), container);
			});
		}
	};

	// Public API
	element.addTag = (value, label) => {
		if (!value || typeof value !== 'string') return false;
		value = value.trim();
		if (!value || tags.some(t => t.value === value)) return false;
		const tag = { value, label: label || value };
		tags.push(tag);
		render();
		a11y.announce(`${tag.label} added`);
		dispatch('nui-tag-add', tag);
		dispatch('nui-change', { values: element.getValues(), tags: element.listTags() });
		return true;
	};

	element.removeTag = value => {
		const idx = tags.findIndex(t => t.value === value);
		if (idx === -1) return false;
		const tag = tags.splice(idx, 1)[0];
		render();
		a11y.announce(`${tag.label} removed`);
		dispatch('nui-tag-remove', tag);
		dispatch('nui-change', { values: element.getValues(), tags: element.listTags() });
		return true;
	};

	element.hasTag = value => tags.some(t => t.value === value);
	element.listTags = () => tags.map(t => ({ ...t }));
	element.getValues = () => tags.map(t => t.value);
	element.clear = () => { while (tags.length) element.removeTag(tags[0].value); };
	element.focus = () => (input || container).focus();

	render();
});

// ################################# nui-select COMPONENT
// Enhanced select with search and multi-select tag support

// Track all open selects to ensure only one is open at a time
const openSelects = new Set();

// ################################# MOBILE MODAL (Singleton)
let mobileModal = null;

const getMobileSelectModal = () => {
	if (mobileModal) return mobileModal;

	const backdrop = dom.create('div', {
		class: 'nui-modal-backdrop',
		attrs: { hidden: '' },
		events: { click: (e) => e.target === backdrop && mobileModal.activeSelect?.close() }
	});

	const modal = dom.create('div', { class: 'nui-select-sheet', target: backdrop });
	const header = dom.create('div', { class: 'nui-select-sheet-header', target: modal });
	const label = dom.create('span', { class: 'nui-select-sheet-label', target: header });
	
	const closeWrap = dom.create('nui-button', { 
		target: header 
	});
	dom.create('button', { 
		attrs: { 'aria-label': 'Done', type: 'button' },
		content: '<nui-icon name="done"></nui-icon>',
		events: { click: () => mobileModal.activeSelect?.close() }, 
		target: closeWrap 
	});

	const tags = dom.create('div', { class: 'nui-select-sheet-tags', attrs: { hidden: '' }, target: modal });
	const content = dom.create('div', { class: 'nui-select-sheet-content', target: modal });
	const search = dom.create('div', { class: 'nui-select-sheet-search', target: modal });

	mobileModal = {
		backdrop, modal, content, tags, search, label, activeSelect: null,
		open(sel) {
			this.activeSelect = sel;
			document.body.append(backdrop);
			backdrop.hidden = false;
			requestAnimationFrame(() => backdrop.classList.add('is-open'));
		},
		close() {
			if (!this.activeSelect) return;
			backdrop.classList.remove('is-open');
			setTimeout(() => {
				backdrop.hidden = true;
				backdrop.remove();
				this.activeSelect.onMobileClose();
				this.activeSelect = null;
			}, 200);
		}
	};

	return mobileModal;
};

registerComponent('nui-select', (element) => {
	let select = element.el('select');

	// Auto-wrap: create inner <select> if missing (Proposal 2 Tier 1)
	// Only handles flat <option> children — warns for complex cases
	if (!select && config.debug !== false) {
		const options = element.querySelectorAll(':scope > option');
		const optgroups = element.querySelectorAll(':scope > optgroup');

		if (optgroups.length > 0) {
			console.warn('[NUI] <nui-select> has <optgroup> children but no inner <select>. Auto-wrap only handles flat <option> children. Add <select> explicitly.');
		} else if (options.length > 0) {
			select = document.createElement('select');
			const isMulti = element.hasAttribute('multiple') || element.querySelector('option[selected]');
			if (isMulti) select.multiple = true;
			while (element.firstChild) {
				select.appendChild(element.firstChild);
			}
			element.appendChild(select);
			console.info('[NUI] ℹ <nui-select> auto-created inner <select>. For zero-JS fallback, use:\n  <nui-select><select>...</select></nui-select>');
		}
	}

	if (!select) return;

	const isMulti = select.multiple;
	const isSearchable = element.hasAttribute('searchable');
	const isMobileEnabled = element.hasAttribute('mobile-sheet');
	
	// Ensure select has a placeholder option if not multi-select
	if (!isMulti && !select.querySelector('option[value=""]')) {
		const placeholderOpt = document.createElement('option');
		placeholderOpt.value = '';
		placeholderOpt.textContent = element.getAttribute('placeholder') || 'Select...';
		select.prepend(placeholderOpt);
	}
	
	const placeholder = element.getAttribute('placeholder') ||
		select.querySelector('option[value=""]')?.textContent || 'Select...';

	// Extract label from parent nui-input-group or element attributes
	const label = element.getAttribute('label') || 
		select.getAttribute('aria-label') || 
		element.closest('nui-input-group')?.querySelector('label')?.textContent?.trim() || 
		placeholder;
	
	element.dataset.label = label;

	// Cache option->row mapping
	const rowCache = new WeakMap();
	let isOpen = false;

	// Hide native select (styled via CSS)
	select.tabIndex = -1;

	// Build control button
	const control = dom.create('button', {
		class: 'nui-select-control',
		attrs: { type: 'button' },
		target: element
	});

	// Set aria-label on control if not already present
	if (!control.hasAttribute('aria-label') && label) {
		control.setAttribute('aria-label', label);
	}

	// Control inner content
	let valueDisplay, previewTags, countBadge;
	if (isMulti) {
		const preview = dom.create('span', { class: 'nui-select-preview', target: control });
		previewTags = dom.create('span', { class: 'nui-select-preview-tags', target: preview });
		// Add placeholder text for multi-select
		const placeholderSpan = dom.create('span', { 
			class: 'nui-select-value is-placeholder', 
			text: placeholder, 
			target: preview 
		});
		dom.create('span', { class: 'nui-select-preview-fade', attrs: { 'aria-hidden': 'true' }, target: preview });
		countBadge = dom.create('span', { class: 'nui-select-count', target: control });
	} else {
		valueDisplay = dom.create('span', { class: 'nui-select-value', text: placeholder, target: control });
		valueDisplay.classList.add('is-placeholder');
	}
	dom.create('span', { class: 'nui-select-arrow', target: control });

	// Build popup
	const popup = dom.create('div', { class: 'nui-select-popup', attrs: { hidden: '' }, target: element });

	// Tags section for multi-select
	let tagInput = null;
	if (isMulti) {
		const tagsSection = dom.create('div', { class: 'nui-select-popup-tags', target: popup });
		tagInput = dom.create('nui-tag-input', { target: tagsSection });
		tagInput.addEventListener('nui-tag-remove', e => {
			const opt = Array.from(select.options).find(o => o.value === e.detail.value);
			if (opt?.selected) { 
				opt.selected = false; 
				select.dispatchEvent(new Event('change', { bubbles: true }));
				syncState(); 
			}
		});
	}

	// Search input
	let searchInput = null;
	if (isSearchable) {
		const searchWrap = dom.create('div', { class: 'nui-select-search', target: popup });
		searchInput = document.createElement('input');
		searchInput.type = 'text';
		searchInput.placeholder = 'Search...';
		searchInput.autocomplete = 'off';
		const nuiInput = dom.create('nui-input', { content: searchInput, target: searchWrap });
		searchInput.addEventListener('input', () => filter(searchInput.value));
	}

	// Options list
	const list = dom.create('div', { class: 'nui-select-options', target: popup });
	const noResults = dom.create('div', { class: 'nui-select-no-results', text: 'No results', attrs: { hidden: '' }, target: list });

	// ##### PRIVATE FUNCTIONS

	// Build option rows from native select
	const buildOptions = () => {
		list.els('.nui-select-option, .nui-select-group').forEach(el => el.remove());

		const addOption = (opt, parent) => {
			if (opt.value === '' && !isMulti) return; // Skip placeholder
			const row = dom.create('div', {
				class: 'nui-select-option' + (opt.disabled ? ' is-disabled' : ''),
				attrs: { 'data-value': opt.value },
				target: parent
			});
			if (isMulti) dom.create('span', { class: 'nui-select-option-check', target: row });
			dom.create('span', { class: 'nui-select-option-text', text: opt.textContent, target: row });
			row.onclick = e => { e.stopPropagation(); pick(opt); };
			rowCache.set(opt, row);
		};

		Array.from(select.children).forEach(child => {
			if (child.tagName === 'OPTGROUP') {
				const group = dom.create('div', { class: 'nui-select-group', target: list });
				dom.create('div', { class: 'nui-select-group-label', text: child.label, target: group });
				Array.from(child.children).forEach(opt => opt.tagName === 'OPTION' && addOption(opt, group));
			} else if (child.tagName === 'OPTION') {
				addOption(child, list);
			}
		});
		syncState(false); // Don't dispatch change event during initial build
	};

	// Sync visual state with native select
	const syncState = (dispatchChange = true) => {
		const selected = Array.from(select.selectedOptions).filter(o => o.value !== '');

		// Update option rows
		Array.from(select.options).forEach(opt => {
			const row = rowCache.get(opt);
			if (row) row.classList.toggle('is-selected', opt.selected);
		});

		if (isMulti) {
			// Sync tag input
			if (tagInput?.addTag) {
				const current = new Set(tagInput.getValues?.() || []);
				const wanted = new Set(selected.map(o => o.value));
				current.forEach(v => { if (!wanted.has(v)) tagInput.removeTag(v); });
				selected.forEach(o => { if (!current.has(o.value)) tagInput.addTag(o.value, o.textContent); });
			}
			// Update preview
			const placeholderSpan = previewTags.parentElement.querySelector('.nui-select-value');
			previewTags.innerHTML = '';
			if (selected.length) {
				selected.slice(0, 3).forEach(o => dom.create('span', { class: 'nui-tag nui-tag--readonly', text: o.textContent, target: previewTags }));
				if (placeholderSpan) placeholderSpan.hidden = true;
			} else {
				if (placeholderSpan) placeholderSpan.hidden = false;
			}
			countBadge.textContent = selected.length || '';
			countBadge.hidden = !selected.length;
		} else {
			const sel = selected[0];
			valueDisplay.textContent = sel?.textContent || placeholder;
			valueDisplay.classList.toggle('is-placeholder', !sel);
		}

		element.classList.toggle('is-invalid', !select.validity.valid);
		
		if (dispatchChange) {
			element.dispatchEvent(new CustomEvent('nui-change', { 
				bubbles: true, 
				detail: { 
					values: selected.map(o => o.value),
					labels: selected.map(o => o.textContent),
					options: selected.map(o => ({ value: o.value, label: o.textContent }))
				} 
			}));
		}
	};

	// Pick an option
	const pick = opt => {
		if (opt.disabled) return;
		if (isMulti) {
			opt.selected = !opt.selected;
		} else {
			Array.from(select.options).forEach(o => o.selected = (o === opt));
			close();
		}
		select.dispatchEvent(new Event('change', { bubbles: true }));
		syncState();
		element.dispatchEvent(new CustomEvent('nui-select', { 
			bubbles: true, 
			detail: { 
				value: opt.value, 
				label: opt.textContent,
				selected: opt.selected 
			} 
		}));
	};

	// Filter options
	const filter = q => {
		q = q.toLowerCase().trim();
		let count = 0;
		Array.from(select.options).forEach(opt => {
			const row = rowCache.get(opt);
			if (!row) return;
			const match = opt.textContent.toLowerCase().includes(q);
			row.hidden = !match;
			if (match) count++;
		});
		// Show/hide groups
		list.els('.nui-select-group').forEach(g => {
			g.hidden = !Array.from(g.querySelectorAll('.nui-select-option')).some(r => !r.hidden);
		});
		noResults.hidden = count > 0;
	};

	// Open/close
	const open = () => {
		if (isOpen || select.disabled) return;

		// Check mobile (auto-trigger below 640px or if explicitly set)
		if ((isMobileEnabled || window.innerWidth <= 640) && window.innerHeight > 400) {
			openMobile();
			return;
		}

		// Close all other open selects
		openSelects.forEach(otherSelect => {
			if (otherSelect !== element && otherSelect.close) {
				otherSelect.close();
			}
		});

		isOpen = true;
		openSelects.add(element);
		element.classList.add('is-open');
		popup.hidden = false;

		// Reset scroll position
		list.scrollTop = 0;

		// Position above/below
		const rect = control.getBoundingClientRect();
		const below = window.innerHeight - rect.bottom;
		element.classList.toggle('is-above', below < 300 && rect.top > below);
		element.classList.toggle('is-below', !(below < 300 && rect.top > below));

		// Make options focusable
		const options = getVisibleOptions();
		options.forEach(opt => opt.tabIndex = -1);

		// Reset focus state
		clearFocus();

		if (isSearchable) {
			searchInput.value = '';
			filter('');
			// Focus search input for immediate typing
			queueMicrotask(() => searchInput.focus());
		}
		
		element.dispatchEvent(new CustomEvent('nui-open', { bubbles: true }));
	};

	const openMobile = () => {
		openSelects.forEach(s => s !== element && s.close?.());

		const m = getMobileSelectModal();
		isOpen = true;
		openSelects.add(element);
		element.classList.add('is-open');

		// Move elements
		m.content.appendChild(list);
		list.hidden = false;

		const searchWrap = popup.querySelector('.nui-select-search');
		if (searchInput && searchWrap) {
			m.search.appendChild(searchWrap);
			searchInput.value = '';
			filter('');
		}

		m.label.textContent = label;

		// Multi-select tags
		const desktopTags = popup.querySelector('.nui-select-popup-tags');
		m.tags.innerHTML = '';
		m.tags.hidden = !isMulti;

		if (isMulti && desktopTags) {
			const toggle = dom.create('button', { class: 'nui-sheet-tags-toggle', target: m.tags });
			const text = dom.create('span', { target: toggle });
			dom.create('span', { text: '▼', target: toggle });
			const wrap = dom.create('div', { attrs: { hidden: '' }, target: m.tags });
			wrap.appendChild(desktopTags);

			toggle.onclick = () => {
				wrap.hidden = !wrap.hidden;
				toggle.classList.toggle('is-expanded', !wrap.hidden);
			};

			const updateCount = () => {
				const count = select.selectedOptions.length;
				text.textContent = `${count} items selected`;
				m.tags.hidden = !count;
			};
			updateCount();
			element.addEventListener('nui-change', updateCount);

			element.onMobileClose = () => {
				element.removeEventListener('nui-change', updateCount);
				popup.appendChild(list);
				searchWrap && popup.insertBefore(searchWrap, list);
				popup.prepend(desktopTags);
				element.onMobileClose = null;
			};
		} else {
			element.onMobileClose = () => {
				popup.appendChild(list);
				searchWrap && popup.insertBefore(searchWrap, list);
				element.onMobileClose = null;
			};
		}

		m.open(element);
		element.dispatchEvent(new CustomEvent('nui-open', { bubbles: true }));
	};

	const close = () => {
		if (!isOpen) return;

		// Check if we are in mobile mode
		const mobileModal = getMobileSelectModal();
		if (mobileModal.activeSelect === element) {
			mobileModal.close();
		}

		isOpen = false;
		openSelects.delete(element);
		element.classList.remove('is-open', 'is-above', 'is-below');
		popup.hidden = true;

		// Clear focus state
		clearFocus();
		typeAheadString = '';
		if (typeAheadTimeout) {
			clearTimeout(typeAheadTimeout);
			typeAheadTimeout = null;
		}

		element.dispatchEvent(new CustomEvent('nui-close', { bubbles: true }));
	};

	// ##### VALUE MANAGEMENT

	const setValue = (value) => {
		if (isMulti) {
			// For multi-select, accept array or single value
			const values = Array.isArray(value) ? value : value ? [value] : [];
			Array.from(select.options).forEach(opt => {
				opt.selected = values.includes(opt.value);
			});
		} else {
			// For single select, find matching option
			const targetOpt = Array.from(select.options).find(o => o.value === value);
			Array.from(select.options).forEach(o => o.selected = (o === targetOpt));
		}
		select.dispatchEvent(new Event('change', { bubbles: true }));
		syncState();
	};

	const getValue = () => {
		if (isMulti) {
			return Array.from(select.selectedOptions).map(o => o.value);
		}
		return select.value;
	};

	const getSelected = () => {
		const selected = Array.from(select.selectedOptions);
		return selected.map(o => ({ value: o.value, label: o.textContent, element: o }));
	};

	const selectValue = (value) => {
		const opt = Array.from(select.options).find(o => o.value === value);
		if (opt && !opt.disabled) {
			if (isMulti) {
				opt.selected = true;
			} else {
				Array.from(select.options).forEach(o => o.selected = (o === opt));
			}
			select.dispatchEvent(new Event('change', { bubbles: true }));
			syncState();
			element.dispatchEvent(new CustomEvent('nui-select', { 
				bubbles: true, 
				detail: { value: opt.value, label: opt.textContent, selected: opt.selected } 
			}));
		}
	};

	const unselectValue = (value) => {
		if (!isMulti) return;
		const opt = Array.from(select.options).find(o => o.value === value);
		if (opt) {
			opt.selected = false;
			select.dispatchEvent(new Event('change', { bubbles: true }));
			syncState();
		}
	};

	const clear = () => {
		if (isMulti) {
			Array.from(select.options).forEach(o => o.selected = false);
		} else {
			select.value = '';
		}
		select.dispatchEvent(new Event('change', { bubbles: true }));
		syncState();
		element.dispatchEvent(new CustomEvent('nui-clear', { bubbles: true }));
	};

	// ##### OPTIONS MANAGEMENT

	const addItem = (value, label, options = {}) => {
		const existing = Array.from(select.options).find(o => o.value === value);
		if (existing) return false;

		const opt = document.createElement('option');
		opt.value = value;
		opt.textContent = label || value;
		if (options.disabled) opt.disabled = true;
		if (options.selected) opt.selected = true;

		if (options.group) {
			// Find or create optgroup
			let group = Array.from(select.querySelectorAll('optgroup')).find(g => g.label === options.group);
			if (!group) {
				group = document.createElement('optgroup');
				group.label = options.group;
				select.appendChild(group);
			}
			group.appendChild(opt);
		} else {
			select.appendChild(opt);
		}
		buildOptions();
		element.dispatchEvent(new CustomEvent('nui-item-add', { 
			bubbles: true, 
			detail: { value, label, options } 
		}));
		return true;
	};

	const removeItem = (value) => {
		const opt = Array.from(select.options).find(o => o.value === value);
		if (!opt) return false;
		opt.remove();
		rowCache.delete(opt);
		buildOptions();
		element.dispatchEvent(new CustomEvent('nui-item-remove', { 
			bubbles: true, 
			detail: { value } 
		}));
		return true;
	};

	const setItems = (items) => {
		// Clear existing options (except placeholder for single select)
		const placeholderOpt = !isMulti ? select.querySelector('option[value=""]') : null;
		select.innerHTML = '';
		if (placeholderOpt) select.appendChild(placeholderOpt);

		// Add new items
		items.forEach(item => {
			if (typeof item === 'string') {
				const opt = document.createElement('option');
				opt.value = item;
				opt.textContent = item;
				select.appendChild(opt);
			} else if (item.group) {
				const group = document.createElement('optgroup');
				group.label = item.group;
				item.options?.forEach(sub => {
					const opt = document.createElement('option');
					opt.value = sub.value || sub;
					opt.textContent = sub.label || sub.value || sub;
					opt.disabled = sub.disabled || false;
					group.appendChild(opt);
				});
				select.appendChild(group);
			} else {
				const opt = document.createElement('option');
				opt.value = item.value;
				opt.textContent = item.label || item.value;
				opt.disabled = item.disabled || false;
				select.appendChild(opt);
			}
		});
		buildOptions();
		element.dispatchEvent(new CustomEvent('nui-items-replace', { 
			bubbles: true, 
			detail: { count: items.length } 
		}));
	};

	const getItems = () => {
		return Array.from(select.options)
			.filter(o => o.value !== '')
			.map(o => ({ value: o.value, label: o.textContent, disabled: o.disabled }));
	};

	// ##### STATE MANAGEMENT

	const enable = () => {
		select.disabled = false;
		control.disabled = false;
		element.classList.remove('is-disabled');
		element.dispatchEvent(new CustomEvent('nui-enable', { bubbles: true }));
	};

	const disable = () => {
		select.disabled = true;
		control.disabled = true;
		element.classList.add('is-disabled');
		close();
		element.dispatchEvent(new CustomEvent('nui-disable', { bubbles: true }));
	};

	const setDisabled = (disabled) => {
		disabled ? disable() : enable();
	};

	// ##### ASYNC LOADING SUPPORT

	let isLoading = false;
	let savedPlaceholder = null;

	// Show loading state - displays loading text and disables
	const showLoading = (loadingText = 'Loading...') => {
		if (isLoading) return;
		isLoading = true;
		savedPlaceholder = placeholder; // Always save the actual placeholder, not current display
		disable();
		if (valueDisplay) {
			valueDisplay.textContent = loadingText;
			valueDisplay.classList.add('is-loading');
		}
		element.classList.add('is-loading');
		element.dispatchEvent(new CustomEvent('nui-loading', { bubbles: true }));
	};

	// Hide loading state - enables and restores placeholder
	const hideLoading = (newPlaceholder) => {
		if (!isLoading) return;
		isLoading = false;
		enable();
		if (valueDisplay) {
			valueDisplay.textContent = newPlaceholder || savedPlaceholder || placeholder;
			valueDisplay.classList.remove('is-loading');
		}
		element.classList.remove('is-loading');
		element.dispatchEvent(new CustomEvent('nui-loaded', { bubbles: true }));
	};

	// Load options from an async function - handles all loading states
	// Returns { data, error } after the async function resolves or rejects
	const loadOptions = async (asyncFn) => {
		showLoading();
		try {
			const result = await asyncFn();
			// Assume result is an array of items - set them
			if (Array.isArray(result)) {
				setItems(result);
			} else if (result && typeof result === 'object' && 'items' in result) {
				// Support { items: [...] } format
				setItems(result.items);
			}
			hideLoading();
			element.dispatchEvent(new CustomEvent('nui-options-loaded', {
				bubbles: true,
				detail: { data: result }
			}));
			return { data: result, error: null };
		} catch (err) {
			hideLoading();
			element.dispatchEvent(new CustomEvent('nui-options-error', {
				bubbles: true,
				detail: { error: err }
			}));
			return { data: null, error: err };
		}
	};

	// ##### KEYBOARD NAVIGATION

	let typeAheadString = '';
	let typeAheadTimeout = null;
	let activeOptionIndex = -1;

	const getVisibleOptions = () => {
		return Array.from(list.querySelectorAll('.nui-select-option:not([hidden])'))
			.filter(opt => !opt.classList.contains('is-disabled'));
	};

	const focusOption = (index, scroll = true) => {
		const options = getVisibleOptions();
		if (!options.length) return;

		// Clamp index
		if (index < 0) index = 0;
		if (index >= options.length) index = options.length - 1;

		activeOptionIndex = index;

		// Update tabindex and visual focus
		options.forEach((opt, i) => {
			opt.tabIndex = i === index ? 0 : -1;
			opt.classList.toggle('is-focused', i === index);
		});

		if (scroll) {
			options[index].scrollIntoView({ block: 'nearest' });
		}

		options[index].focus();
	};

	const clearFocus = () => {
		list.querySelectorAll('.nui-select-option').forEach(opt => {
			opt.classList.remove('is-focused');
			opt.tabIndex = -1;
		});
		activeOptionIndex = -1;
	};

	const getOptionIndexByValue = (value) => {
		const options = getVisibleOptions();
		return options.findIndex(opt => opt.dataset.value === value);
	};

	const getOptionIndexByChar = (char) => {
		const options = getVisibleOptions();
		const search = char.toLowerCase();

		// First try from current position
		let startIdx = activeOptionIndex + 1;
		for (let i = 0; i < options.length; i++) {
			const idx = (startIdx + i) % options.length;
			const text = options[idx].textContent.toLowerCase();
			if (text.startsWith(search)) return idx;
		}
		return -1;
	};

	const getOptionIndexByString = (str) => {
		const options = getVisibleOptions();
		const search = str.toLowerCase();

		for (let i = 0; i < options.length; i++) {
			const text = options[i].textContent.toLowerCase();
			if (text.startsWith(search)) return i;
		}
		return -1;
	};

	// Control button keyboard handling
	control.addEventListener('keydown', (e) => {
		switch (e.key) {
			case 'Enter':
			case ' ':
				e.preventDefault();
				if (isOpen) {
					close();
				} else {
					open();
					// If not searchable, focus first option
					if (!isSearchable) {
						const selected = list.querySelector('.nui-select-option.is-selected:not([hidden])');
						if (selected) {
							const idx = getVisibleOptions().indexOf(selected);
							focusOption(idx >= 0 ? idx : 0);
						} else {
							focusOption(0);
						}
					}
				}
				break;

			case 'ArrowDown':
				e.preventDefault();
				if (!isOpen) {
					open();
					// If not searchable, focus first option
					if (!isSearchable) focusOption(0);
				}
				break;

			case 'ArrowUp':
				e.preventDefault();
				if (!isOpen) {
					open();
					// If not searchable, focus last option
					if (!isSearchable) {
						const options = getVisibleOptions();
						focusOption(options.length - 1);
					}
				}
				break;

			case 'Home':
				e.preventDefault();
				if (isOpen && !isSearchable) focusOption(0);
				break;

			case 'End':
				e.preventDefault();
				if (isOpen && !isSearchable) {
					const options = getVisibleOptions();
					focusOption(options.length - 1);
				}
				break;

			default:
				// Type-ahead when closed
				if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
					e.preventDefault();
					if (!isOpen) open();
					// If not searchable, jump to matching option
					if (!isSearchable) {
						const idx = getOptionIndexByChar(e.key);
						if (idx >= 0) focusOption(idx);
					}
				}
				break;
		}
	});

	// Options list keyboard handling
	list.addEventListener('keydown', (e) => {
		const options = getVisibleOptions();
		if (!options.length) return;

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				focusOption(activeOptionIndex + 1);
				break;

			case 'ArrowUp':
				e.preventDefault();
				if (activeOptionIndex <= 0 && isSearchable && searchInput) {
					// Move focus to search input when at first option
					clearFocus();
					searchInput.focus();
				} else {
					focusOption(activeOptionIndex - 1);
				}
				break;

			case 'Home':
				e.preventDefault();
				focusOption(0);
				break;

			case 'End':
				e.preventDefault();
				focusOption(options.length - 1);
				break;

			case 'Enter':
			case ' ':
				e.preventDefault();
				if (activeOptionIndex >= 0 && activeOptionIndex < options.length) {
					const value = options[activeOptionIndex].dataset.value;
					const opt = Array.from(select.options).find(o => o.value === value);
					if (opt) pick(opt);
					if (!isMulti) {
						control.focus();
					}
				}
				break;

			case 'Escape':
				e.preventDefault();
				close();
				control.focus();
				break;

			case 'Tab':
				// Close on tab, let default behavior move focus
				close();
				break;

			default:
				// Type-ahead search
				if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
					e.preventDefault();

					// Reset type-ahead after delay
					if (typeAheadTimeout) clearTimeout(typeAheadTimeout);
					typeAheadTimeout = setTimeout(() => {
						typeAheadString = '';
					}, 500);

					typeAheadString += e.key;
					const idx = getOptionIndexByString(typeAheadString);
					if (idx >= 0) focusOption(idx);
				}
				break;
		}
	});

	// Focus management for search input
	if (searchInput) {
		searchInput.addEventListener('keydown', (e) => {
			switch (e.key) {
				case 'ArrowDown':
					e.preventDefault();
					// Move focus to first option
					focusOption(0);
					break;

				case 'ArrowUp':
					e.preventDefault();
					// Move focus to last option
					{
						const options = getVisibleOptions();
						focusOption(options.length - 1);
					}
					break;

				case 'Escape':
					e.preventDefault();
					close();
					control.focus();
					break;

				case 'Tab':
					// Tab from search moves to first option instead of closing
					if (!e.shiftKey) {
						e.preventDefault();
						focusOption(0);
					}
					break;
			}
		});
	}

	// ##### EVENT LISTENERS

	control.addEventListener('click', e => { e.stopPropagation(); isOpen ? close() : open(); });

	const onOutsideClick = e => {
		if (isOpen && !element.contains(e.target)) {
			// Ignore if click is within mobile modal
			const mobileModal = getMobileSelectModal();
			if (mobileModal?.modal?.contains(e.target)) return;
			close();
		}
	};
	document.addEventListener('click', onOutsideClick);

	// Setup
	element.classList.add(isMulti ? 'is-multi' : 'is-single');
	if (select.disabled) {
		element.classList.add('is-disabled');
		control.disabled = true;
	}
	buildOptions();

	// ##### PUBLIC API
	element.open = open;
	element.close = close;
	element.syncOptions = buildOptions;
	element.refresh = buildOptions; // Proxy for backward compatibility
	element.validate = () => {
		const valid = select.checkValidity();
		element.classList.toggle('is-invalid', !valid);
		return valid;
	};

	// Value management
	element.getValue = getValue;
	element.setValue = setValue;
	element.getSelected = getSelected;
	element.select = selectValue;
	element.unselect = unselectValue;
	element.clear = clear;

	// Options management
	element.addItem = addItem;
	element.removeItem = removeItem;
	element.setItems = setItems;
	element.getItems = getItems;

	// State management
	element.enable = enable;
	element.disable = disable;
	element.setDisabled = setDisabled;

	// Status
	element.isOpen = () => isOpen;
	element.isMulti = () => isMulti;
	element.isDisabled = () => select.disabled;
	element.isSearchable = () => isSearchable;
	element.isLoading = () => isLoading;

	// Async loading helpers
	element.showLoading = showLoading;
	element.hideLoading = hideLoading;
	element.loadOptions = loadOptions;

	// Cleanup function
	return () => {
		openSelects.delete(element);
		document.removeEventListener('click', onOutsideClick);
	};
});

// ################################# nui-sortable COMPONENT

registerComponent('nui-sortable', (element) => {
	element.classList.add('nui-sortable');
	element.setAttribute('role', 'list');
	let dragItem = null;
	let dragOrigRect = null;
	let pointerId = null;
	let startX = 0;
	let startY = 0;
	
	const animateFlip = (el, oldRect) => {
		if (el.getAnimations) {
			el.getAnimations().forEach(a => a.cancel());
		}
		const newRect = el.getBoundingClientRect();
		const deltaX = oldRect.left - newRect.left;
		const deltaY = oldRect.top - newRect.top;
		if (deltaX === 0 && deltaY === 0) return;
		
		el.animate([
			{ transform: `translate(${deltaX}px, ${deltaY}px)` },
			{ transform: 'translate(0, 0)' }
		], {
			duration: 250,
			easing: 'cubic-bezier(0.2, 0, 0, 1)'
		});
	};

	const onPointerDown = (e) => {
		if (e.button !== 0) return;
		
		const item = e.target.closest('nui-sortable-item');
		if (!item || !element.contains(item)) return;
		
		// Ignore if clicking an interactive element (unless it specifically IS the drag handle)
		const interactive = e.target.closest('button, a, input, select, textarea, [data-action]');
		if (interactive && !interactive.closest('.drag-handle')) {
			return;
		}
		
		// If the item specifies a drag handle, ensure we clicked it
		if (item.querySelector('.drag-handle') && !e.target.closest('.drag-handle')) {
			return;
		}
		
		e.preventDefault();
		dragItem = item;
		pointerId = e.pointerId;
		startX = e.clientX;
		startY = e.clientY;
		dragOrigRect = dragItem.getBoundingClientRect();
		
		const containerRect = element.getBoundingClientRect();
		const itemTop = dragOrigRect.top - containerRect.top - element.clientTop + element.scrollTop;
		const itemLeft = dragOrigRect.left - containerRect.left - element.clientLeft + element.scrollLeft;
		const itemWidth = dragOrigRect.width;
		const itemHeight = dragOrigRect.height;

		element.setPointerCapture(pointerId);
		
		const placeholder = document.createElement('div');
		placeholder.className = 'nui-sortable-placeholder';
		placeholder.style.width = `${itemWidth}px`;
		placeholder.style.height = `${itemHeight}px`;
		element.insertBefore(placeholder, dragItem);
		
		dragItem.classList.add('nui-sortable-dragged');
		dragItem.style.top = `${itemTop}px`;
		dragItem.style.left = `${itemLeft}px`;
		dragItem.style.width = `${itemWidth}px`;
		dragItem.style.height = `${itemHeight}px`;
		dragItem.style.transform = `translate(0px, 0px)`;
		
		dragItem.dataset.isDragging = "true";
	};

	const onPointerMove = (e) => {
		if (!dragItem || e.pointerId !== pointerId) return;
		
		const currentX = e.clientX - startX;
		const currentY = e.clientY - startY;
		dragItem.style.transform = `translate(${currentX}px, ${currentY}px)`;
		
		const placeholder = element.querySelector('.nui-sortable-placeholder');
		const items = Array.from(element.children).filter(c => 
			c !== dragItem && (c.tagName === 'NUI-SORTABLE-ITEM' || c === placeholder)
		);
		
		const containerRect = element.getBoundingClientRect();
		const scrollLeft = element.scrollLeft;
		const scrollTop = element.scrollTop;
		const clientLeft = element.clientLeft;
		const clientTop = element.clientTop;
		
		let targetObj = null;
		for (const item of items) {
			if (item === placeholder) continue;
			
			const left = containerRect.left + clientLeft + item.offsetLeft - scrollLeft;
			const top = containerRect.top + clientTop + item.offsetTop - scrollTop;
			const right = left + item.offsetWidth;
			const bottom = top + item.offsetHeight;
			
			if (e.clientX >= left && e.clientX <= right &&
				e.clientY >= top && e.clientY <= bottom) {
				targetObj = item;
				break;
			}
		}
		
		if (targetObj) {
			const currentIndex = items.indexOf(placeholder);
			const targetIndex = items.indexOf(targetObj);
			
			const rects = new Map();
			items.forEach(i => {
				if (i !== placeholder) rects.set(i, i.getBoundingClientRect());
			});
			
			if (currentIndex < targetIndex) {
				element.insertBefore(placeholder, targetObj.nextSibling);
			} else {
				element.insertBefore(placeholder, targetObj);
			}
			
			items.forEach(i => {
				const oldRect = rects.get(i);
				if (oldRect) animateFlip(i, oldRect);
			});
		}
	};

	const onPointerUp = (e) => {
		if (!dragItem || e.pointerId !== pointerId) return;
		
		element.releasePointerCapture(pointerId);
		
		const placeholder = element.querySelector('.nui-sortable-placeholder');
		if (placeholder) {
			element.insertBefore(dragItem, placeholder);
			placeholder.remove();
		}
		
		dragItem.classList.remove('nui-sortable-dragged');
		dragItem.style.transform = '';
		dragItem.style.top = '';
		dragItem.style.left = '';
		dragItem.style.width = '';
		dragItem.style.height = '';
		delete dragItem.dataset.isDragging;
		dragItem = null;
		pointerId = null;
		
		const newOrder = Array.from(element.querySelectorAll('nui-sortable-item'))
			.map(item => item.dataset.id || item.textContent.trim());
		element.dispatchEvent(new CustomEvent('nui-sortable-change', {
			bubbles: true,
			detail: { order: newOrder }
		}));
	};

	element.addEventListener('pointerdown', onPointerDown);
	element.addEventListener('pointermove', onPointerMove);
	element.addEventListener('pointerup', onPointerUp);
	element.addEventListener('pointercancel', onPointerUp);
	
	element.addEventListener('nui-action-sortable-item-delete', (e) => {
		const item = e.target.closest('nui-sortable-item');
		if (item && element.contains(item)) {
			const items = Array.from(element.querySelectorAll('nui-sortable-item'));
			const rects = new Map();
			items.forEach(i => rects.set(i, i.getBoundingClientRect()));
			
			item.remove();
			
			const remainingItems = Array.from(element.querySelectorAll('nui-sortable-item'));
			remainingItems.forEach(i => {
				const oldRect = rects.get(i);
				if (oldRect) animateFlip(i, oldRect);
			});
		}
	});

	element.addItem = (htmlString) => {
		const wrapper = document.createElement('div');
		wrapper.innerHTML = htmlString.trim();
		const item = wrapper.firstElementChild;
		if (item) {
			element.appendChild(item);
		}
	};
	
	element.getItems = () => {
		return Array.from(element.querySelectorAll('nui-sortable-item')).map(item => ({
			id: item.dataset.id || null,
			element: item
		}));
	};

	element.setItems = (htmlStrings) => {
		element.innerHTML = '';
		htmlStrings.forEach(html => element.addItem(html));
	};

	element.clear = () => {
		element.innerHTML = '';
	};

	element.addEventListener('keydown', (e) => {
		const targetItem = e.target.closest('nui-sortable-item');
		if (!targetItem || !element.contains(targetItem)) return;

		const items = Array.from(element.querySelectorAll('nui-sortable-item'));
		const currentIndex = items.indexOf(targetItem);
		if (currentIndex === -1) return;

		const isDragging = targetItem.dataset.keyboardDrag === "true";

		if (e.key === ' ' || e.key === 'Enter') {
			e.preventDefault();
			if (isDragging) {
				targetItem.removeAttribute('data-keyboard-drag');
				a11y.announce(`Dropped item at position ${currentIndex + 1} of ${items.length}.`);
				const newOrder = items.map(item => item.dataset.id || item.textContent.trim());
				element.dispatchEvent(new CustomEvent('nui-sortable-change', {
					bubbles: true,
					detail: { order: newOrder }
				}));
			} else {
				targetItem.dataset.keyboardDrag = "true";
				a11y.announce(`Grabbed item ${currentIndex + 1} of ${items.length}. Use arrow keys to move, Space to drop, Escape to cancel.`);
				targetItem.dataset.origIndex = currentIndex;
			}
			return;
		}

		if (e.key === 'Escape' && isDragging) {
			e.preventDefault();
			targetItem.removeAttribute('data-keyboard-drag');
			const origIndex = parseInt(targetItem.dataset.origIndex, 10);
			if (!isNaN(origIndex) && origIndex !== currentIndex) {
				const rects = new Map();
				items.forEach(i => rects.set(i, i.getBoundingClientRect()));
				
				if (origIndex >= items.length - 1) {
					element.appendChild(targetItem);
				} else if (origIndex < currentIndex) {
					element.insertBefore(targetItem, items[origIndex]);
				} else {
					element.insertBefore(targetItem, items[origIndex].nextSibling);
				}
				
				Array.from(element.querySelectorAll('nui-sortable-item')).forEach(i => {
					const oldRect = rects.get(i);
					if (oldRect) animateFlip(i, oldRect);
				});
				targetItem.focus();
			}
			a11y.announce('Drag cancelled.');
			return;
		}

		if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			let nextIndex = currentIndex;
			if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') nextIndex = Math.max(0, currentIndex - 1);
			if (e.key === 'ArrowDown' || e.key === 'ArrowRight') nextIndex = Math.min(items.length - 1, currentIndex + 1);

			if (nextIndex !== currentIndex) {
				e.preventDefault();
				
				if (isDragging) {
					const nextItem = items[nextIndex];
					const rects = new Map();
					items.forEach(i => rects.set(i, i.getBoundingClientRect()));
					
					if (nextIndex < currentIndex) {
						element.insertBefore(targetItem, nextItem);
					} else {
						element.insertBefore(targetItem, nextItem.nextSibling);
					}
					
					items.forEach(i => {
						const oldRect = rects.get(i);
						if (oldRect) animateFlip(i, oldRect);
					});
					
					targetItem.focus();
					a11y.announce(`Moved to position ${nextIndex + 1} of ${items.length}.`);
				} else {
					targetItem.setAttribute('tabindex', '-1');
					items[nextIndex].setAttribute('tabindex', '0');
					items[nextIndex].focus();
				}
			}
		}
	});

	const observer = new MutationObserver((mutations) => {
		const items = Array.from(element.querySelectorAll('nui-sortable-item'));
		let hasFocusable = false;
		items.forEach(i => {
			if (i.getAttribute('tabindex') === '0') hasFocusable = true;
			if (!i.hasAttribute('tabindex')) i.setAttribute('tabindex', '-1');
		});
		if (!hasFocusable && items.length > 0) {
			items[0].setAttribute('tabindex', '0');
		}
	});
	observer.observe(element, { childList: true });
	
	requestAnimationFrame(() => {
		const items = Array.from(element.querySelectorAll('nui-sortable-item'));
		items.forEach((item, index) => {
			if (!item.hasAttribute('tabindex')) item.setAttribute('tabindex', index === 0 ? '0' : '-1');
		});
	});

	return () => observer.disconnect();
});

registerComponent('nui-sortable-item', (element) => {
	element.classList.add('nui-sortable-item');
	element.setAttribute('role', 'listitem');
});

registerComponent('nui-tooltip', (element) => {
	const targetParam = element.getAttribute('for');
	let target = targetParam ? document.getElementById(targetParam) : element.previousElementSibling;
	
	if (!target || element._tooltipInitialized) return;
	element._tooltipInitialized = true;

	element.setAttribute('role', 'tooltip');
	target.setAttribute('aria-describedby', element.id || (element.id = 'nui-tooltip-' + Math.random().toString(36).substr(2, 9)));

	element.setAttribute('popover', 'manual');

	const positionTip = () => {
		const rect = target.getBoundingClientRect();
		const tipRect = element.getBoundingClientRect();
		let pos = element.getAttribute('position') || 'auto';
		const offset = parseInt(element.getAttribute('offset') || '16', 10);

		if (pos === 'auto') {
			const spaceTop = rect.top;
			const spaceBottom = window.innerHeight - rect.bottom;
			const spaceLeft = rect.left;
			const spaceRight = window.innerWidth - rect.right;

			if (spaceTop >= tipRect.height + offset) {
				pos = 'top';
			} else if (spaceBottom >= tipRect.height + offset) {
				pos = 'bottom';
			} else if (spaceRight >= tipRect.width + offset) {
				pos = 'right';
			} else if (spaceLeft >= tipRect.width + offset) {
				pos = 'left';
			} else {
				pos = spaceTop >= spaceBottom ? 'top' : 'bottom';
			}
		}

		element.setAttribute('data-placement', pos);

		let top, left;
		if (pos === 'top') {
			top = rect.top - tipRect.height - offset;
			left = rect.left + (rect.width / 2) - (tipRect.width / 2);
		} else if (pos === 'bottom') {
			top = rect.bottom + offset;
			left = rect.left + (rect.width / 2) - (tipRect.width / 2);
		} else if (pos === 'left') {
			top = rect.top + (rect.height / 2) - (tipRect.height / 2);
			left = rect.left - tipRect.width - offset;
		} else if (pos === 'right') {
			top = rect.top + (rect.height / 2) - (tipRect.height / 2);
			left = rect.right + offset;
		}

		const padding = 8;
		top = Math.max(padding, Math.min(top, window.innerHeight - tipRect.height - padding));
		left = Math.max(padding, Math.min(left, window.innerWidth - tipRect.width - padding));

		element.style.top = `${top}px`;
		element.style.left = `${left}px`;
		element.style.margin = '0';

		if (pos === 'top' || pos === 'bottom') {
			let arrowLeft = (rect.left + rect.width / 2) - left;
			arrowLeft = Math.max(16, Math.min(arrowLeft, tipRect.width - 16));
			element.style.setProperty('--arrow-left', `${arrowLeft}px`);
			element.style.removeProperty('--arrow-top');
		} else {
			let arrowTop = (rect.top + rect.height / 2) - top;
			arrowTop = Math.max(16, Math.min(arrowTop, tipRect.height - 16));
			element.style.setProperty('--arrow-top', `${arrowTop}px`);
			element.style.removeProperty('--arrow-left');
		}
	};

	let hideTimeout;

	const show = () => {
		if (element.hasAttribute('disabled')) return;
		clearTimeout(hideTimeout);
		try {
			element.showPopover();
			positionTip();
		} catch (e) {}
	};

	const hide = () => {
		hideTimeout = setTimeout(() => {
			try {
				element.hidePopover();
			} catch (e) {}
		}, 150);
	};

	target.addEventListener('mouseenter', show);
	target.addEventListener('mouseleave', hide);
	target.addEventListener('focus', show);
	target.addEventListener('blur', hide);

	element.addEventListener('mouseenter', show);
	element.addEventListener('mouseleave', hide);

	const hideOnScroll = () => { if (element.matches(':popover-open')) hide(); };
	window.addEventListener('scroll', hideOnScroll, { passive: true, capture: true });

	return () => {
		if (target) {
			target.removeAttribute('aria-describedby');
			target.removeEventListener('mouseenter', show);
			target.removeEventListener('mouseleave', hide);
			target.removeEventListener('focus', show);
			target.removeEventListener('blur', hide);
		}
		element.removeEventListener('mouseenter', show);
		element.removeEventListener('mouseleave', hide);
		window.removeEventListener('scroll', hideOnScroll, { capture: true });
	};
});

// ################################# BANNER FACTORY

const activeBanners = { top: null, bottom: null };

const bannerFactory = {
	create(options = {}) {
		const placement = options.placement || 'bottom';
		let target = options.target;
		if (!target) {
			const contentArea = document.el('nui-app nui-content');
			if (contentArea) {
				let bannerLayer = contentArea.el(':scope > .nui-banner-layer') || 
					dom.create('div', { class: 'nui-banner-layer', target: contentArea });
				target = bannerLayer;
			} else {
				target = document.body;
			}
		}

		if (activeBanners[placement]) {
			activeBanners[placement].element.close('replaced');
		}

		const banner = dom.create('nui-banner', {
			id: 'nui-banner-' + Date.now(),
			attrs: {
				placement: placement,
				priority: options.priority,
				'auto-close': options.autoClose
			}
		});

		const contentEl = dom.create('div', {
			class: 'nui-banner-content',
			content: options.content
		});

		const wrapper = dom.create('div', {
			class: 'nui-banner-wrapper',
			content: contentEl,
			target: banner
		});

		if (options.showCloseButton !== false) {
			dom.create('button', {
				class: 'nui-banner-close',
				attrs: { type: 'button' },
				text: '✕',
				events: { click: () => banner.close('dismiss') },
				target: wrapper
			});
		}

		if (options.autoClose && options.showProgress !== false) {
			dom.create('div', {
				class: 'nui-banner-progress',
				style: `animation-duration: ${options.autoClose}ms; animation-name: nui-banner-progress`,
				target: banner
			});
		}

		if (target) target.append(banner);

		const controller = {
			element: banner,
			close(action) {
				banner.close(action);
			},
			update(content) {
				banner.update(content);
			},
			onClose(callback) {
				banner.addEventListener('nui-banner-close', (e) => {
					callback(e.detail.action);
				}, { once: true });
			}
		};

		activeBanners[placement] = controller;

		banner.addEventListener('nui-banner-close', () => {
			if (activeBanners[placement]?.element === banner) {
				activeBanners[placement] = null;
			}
			banner.remove();
		}, { once: true });

		banner.show();

		return controller;
	},

	show(options = {}) {
		return this.create(options);
	},

	hide(ref) {
		if (ref === 'all' || ref === undefined || ref === null) {
			return this.hideAll();
		}

		if (ref?.element instanceof HTMLElement) {
			ref.element.close('dismiss');
			return true;
		}

		if (ref instanceof HTMLElement) {
			ref.close?.('dismiss');
			return true;
		}

		return false;
	},

	hideAll() {
		Object.values(activeBanners).forEach(controller => {
			controller?.element?.close('dismiss');
		});
		return true;
	}
};

// ################################# DIALOG SYSTEM

const dialogSystem = {
	_createDialog(target, placement, blocking = false) {
		const dialog = dom.create('nui-dialog', {
			id: 'nui-system-dialog-' + Date.now(),
			attrs: {
				placement: placement,
				blocking: blocking ? '' : null
			},
			content: '<dialog><div class="nui-dialog-content"></div></dialog>',
			target: target || document.body
		});
		return dialog;
	},

	_buildFieldHtml(field) {
		const id = field.id;
		const type = field.type || 'text';
		const value = field.value || '';
		const placeholder = field.placeholder || '';
		const required = field.required ? 'required' : '';
		const pattern = field.pattern ? `pattern="${field.pattern}"` : '';
		const min = field.min !== undefined ? `min="${field.min}"` : '';
		const max = field.max !== undefined ? `max="${field.max}"` : '';
		const minlength = field.minlength !== undefined ? `minlength="${field.minlength}"` : '';
		const maxlength = field.maxlength !== undefined ? `maxlength="${field.maxlength}"` : '';

		if (type === 'textarea') {
			return `
				<nui-input-group>
					<label>${field.label}</label>
					<nui-textarea>
						<textarea id="${id}" placeholder="${placeholder}" ${required} ${minlength} ${maxlength}>${value}</textarea>
					</nui-textarea>
				</nui-input-group>
			`;
		}

		if (type === 'checkbox') {
			const checked = field.checked ? 'checked' : '';
			return `
				<nui-input-group>
					<nui-checkbox>
						<input type="checkbox" id="${id}" ${checked}>
						<label>${field.label}</label>
					</nui-checkbox>
				</nui-input-group>
			`;
		}

		return `
			<nui-input-group>
				<label>${field.label}</label>
				<nui-input>
					<input id="${id}" value="${value}" type="${type}" placeholder="${placeholder}" ${required} ${pattern} ${min} ${max} ${minlength} ${maxlength}>
				</nui-input>
			</nui-input-group>
		`;
	},

	_buildButtonHtml(button) {
		const variant = button.type || 'outline';
		const id = button.id ? `id="${button.id}"` : '';
		const icon = button.icon ? `<nui-icon name="${button.icon}"></nui-icon>` : '';
		return `<nui-button variant="${variant}"><button type="button" ${id}>${icon}${button.label}</button></nui-button>`;
	},

	_buildButtonsHtml(buttons) {
		if (!buttons || buttons.length === 0) return '';
		return `<nui-button-container align="end">${buttons.map(b => this._buildButtonHtml(b)).join('')}</nui-button-container>`;
	},

	page(title, htmlContent, options = {}) {
		const buttons = options.buttons || [];

		return new Promise((resolve) => {
			const dialog = dom.create('nui-dialog', {
				id: 'nui-system-dialog-' + Date.now(),
				attrs: {
					mode: 'page',
					title: title,
					blocking: options.blocking ? '' : null,
					'content-scroll': options.contentScroll === false ? 'false' : null
				},
				content: htmlContent
			});

			dialog.buttons = buttons;

			const target = options.target || document.body;
			target.appendChild(dialog);

			// Now it has been upgraded (or will be immediately)
			// Return a custom object containing the resolution and references
			resolve({
				dialog: dialog,
				main: dialog._mainEl || dialog.querySelector('main'),
				result: new Promise((res) => {
					dialog.addEventListener('nui-dialog-close', (e) => {
						dialog.remove();
						res(e.detail?.returnValue);
					}, { once: true });
				})
			});
			
			// Show it automatically or let user do it?
			// Other dialogs show automatically:
			if (options.modal !== false) {
				dialog.showModal();
			} else {
				dialog.show();
			}
		});
	},

	_defaultButtons: {
		alert: [
			{ id: 'nui-dialog-ok', label: 'OK', type: 'primary', value: 'ok' }
		],
		confirm: [
			{ id: 'nui-dialog-cancel', label: 'Cancel', type: 'outline', value: 'cancel' },
			{ id: 'nui-dialog-ok', label: 'OK', type: 'primary', value: 'ok' }
		],
		prompt: [
			{ id: 'nui-dialog-cancel', label: 'Cancel', type: 'outline', value: null },
			{ id: 'nui-dialog-ok', label: 'OK', type: 'primary', value: 'ok' }
		]
	},

	_show(htmlContent, options = {}) {
		const { classes = [], target, placement, modal = true, blocking = false } = options;
		const dialog = this._createDialog(target, placement, blocking);
		const content = dialog.el('.nui-dialog-content');
		const nativeDialog = dialog.el('dialog');

		if (classes.length) nativeDialog.classList.add(...classes);

		if (typeof htmlContent === 'string') {
			content.innerHTML = htmlContent;
		} else {
			content.innerHTML = '';
			content.appendChild(htmlContent);
		}

		if (modal) {
			dialog.showModal();
		} else {
			dialog.show();
		}

		nativeDialog.addEventListener('close', () => dialog.remove(), { once: true });

		return dialog;
	},

	alert(title, message, options = {}) {
		const buttons = options.buttons || this._defaultButtons.alert;

		return new Promise((resolve) => {
			const html = `
				<div class="nui-dialog-alert">
					<div class="nui-headline">${title}</div>
					<div class="nui-copy">${message}</div>
					${this._buildButtonsHtml(buttons)}
				</div>
			`;
			const dialog = this._show(html, { classes: ['nui-alert'], ...options });
			const nativeDialog = dialog.el('dialog');

			buttons.forEach(btn => {
				const el = dialog.el(`#${btn.id}`);
				if (el) {
					el.addEventListener('click', () => {
						dialog.close(btn.value || btn.id);
						resolve(btn.value);
					}, { once: true });
				}
			});

			nativeDialog.addEventListener('close', () => resolve(), { once: true });

			// Enter key submits the OK button
			nativeDialog.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					const okBtn = buttons.find(b => b.value === 'ok');
					if (okBtn) {
						dialog.close(okBtn.value);
						resolve(okBtn.value);
					}
				}
			}, { once: true });
		});
	},

	confirm(title, message, options = {}) {
		const buttons = options.buttons || this._defaultButtons.confirm;

		return new Promise((resolve) => {
			const html = `
				<div class="nui-dialog-alert">
					<div class="nui-headline">${title}</div>
					<div class="nui-copy">${message}</div>
					${this._buildButtonsHtml(buttons)}
				</div>
			`;
			const dialog = this._show(html, { classes: ['nui-alert'], ...options });
			const nativeDialog = dialog.el('dialog');

			buttons.forEach(btn => {
				const el = dialog.el(`#${btn.id}`);
				if (el) {
					el.addEventListener('click', () => {
						dialog.close(btn.value || btn.id);
						resolve(btn.value === 'ok' || btn.value === true);
					}, { once: true });
				}
			});

			nativeDialog.addEventListener('close', () => resolve(false), { once: true });

			// Enter key submits the OK button
			nativeDialog.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					const okBtn = buttons.find(b => b.value === 'ok');
					if (okBtn) {
						dialog.close(okBtn.value);
						resolve(true);
					}
				}
			}, { once: true });
		});
	},

	prompt(title, message, options = {}) {
		const fields = options.fields || [];
		const buttons = options.buttons || this._defaultButtons.prompt;

		return new Promise((resolve) => {
			const inputsHtml = fields.map(f => this._buildFieldHtml(f)).join('');

			const html = `
				<div class="nui-dialog-prompt">
					<div class="nui-headline">${title}</div>
					${message ? `<div class="nui-copy">${message}</div>` : ''}
					<div class="nui-dialog-body">${inputsHtml}</div>
					${this._buildButtonsHtml(buttons)}
				</div>
			`;
			const dialog = this._show(html, { classes: ['nui-prompt'], ...options });
			const nativeDialog = dialog.el('dialog');

			const getValues = () => {
				const values = {};
				fields.forEach(f => {
					const input = dialog.el(`#${f.id}`);
					if (input) {
						values[f.id] = f.type === 'checkbox' ? input.checked : input.value;
					}
				});
				return values;
			};

			buttons.forEach(btn => {
				const el = dialog.el(`#${btn.id}`);
				if (el) {
					el.addEventListener('click', () => {
						dialog.close(btn.value || btn.id);
						if (btn.value === 'ok' || btn.value === true) {
							resolve(getValues());
						} else {
							resolve(btn.value);
						}
					}, { once: true });
				}
			});

			nativeDialog.addEventListener('close', () => resolve(null), { once: true });

			// Enter key submits on single-line inputs, not on textarea
			nativeDialog.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
					e.preventDefault();
					const okBtn = buttons.find(b => b.value === 'ok');
					if (okBtn) {
						dialog.close(okBtn.value);
						resolve(getValues());
					}
				}
			}, { once: true });

			setTimeout(() => {
				const first = dialog.el('input, textarea');
				if (first) first.focus();
			}, 50);
		});
	}
};

function createLinkList(data = [], options = {}) {
	const element = dom.create('nui-link-list', {
		id: options.id,
		class: options.class,
		attrs: {
			mode: options.mode,
			...options.attrs
		}
	});

	if (data && element.loadData) {
		element.loadData(data);
	}

	return element;
}

// ################################# CONTENT LOADER & ROUTER

const registeredFeatures = new Map();
const registeredTypes = new Map();
const registeredActions = new Map();

function sanitizeRouteId(id) {
	if (!config.sanitizeRoutes) return id;
	return id
		.replace(/\.\./g, '')
		.replace(/[<>'"]/g, '')
		.replace(/^\/+/, '')
		.replace(/\/+/g, '/');
}

function parseUrl() {
	const hash = location.hash.slice(1);
	if (!hash) return null;

	// If hash doesn't contain '=', it's an anchor link, not a route
	if (!hash.includes('=')) return null;

	const hashParams = new URLSearchParams(hash);
	const entries = [...hashParams.entries()];
	if (entries.length === 0) return null;

	const [type, id] = entries[0];
	const searchParams = Object.fromEntries(new URLSearchParams(location.search));
	const hashQuery = Object.fromEntries(entries.slice(1));
	const mergedParams = { ...searchParams, ...hashQuery };

	return {
		type,
		id: sanitizeRouteId(id),
		params: mergedParams
	};
}

function executePageScript(wrapper, params) {
	const scriptEl = wrapper.el('script[type="nui/page"]');
	if (!scriptEl) return;

	const scriptContent = scriptEl.textContent;
	scriptEl.remove();

	// Validate script has an init function
	if (!scriptContent.includes('function init(') && !scriptContent.includes('init(')) {
		console.warn('[NUI] Page script is missing an init(element, params, nui) function. Page scripts MUST define function init(element, params, nui) { ... }.', wrapper);
	}

	try {
		const initFn = new Function(
			'element',
			'params',
			'nui',
			scriptContent + '\nif (typeof init === "function") init(element, params, nui);'
		);
		initFn(wrapper, params, nui);
	} catch (e) {
		if (e instanceof EvalError || e.message?.includes('eval')) {
			console.error('[NUI] CSP blocks page script execution. Add \'unsafe-eval\' to script-src in your Content Security Policy. Without it, <script type="nui/page"> scripts will silently fail.', e);
		} else {
			console.error('[NUI] Page script execution failed:', e);
		}
	}
}

async function loadFragment(url, wrapper, params) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to load ${url} (${response.status})`);
	}

	let html = await response.text();

	// Strip Live Server injection (development only)
	html = html.replace(/<!-- Code injected by live-server -->[\s\S]*?<\/script>/gi, '');

	// Check if fragment uses nui-page as its root element
	const trimmedHtml = html.trim();
	const isNuiPageRoot = trimmedHtml.startsWith('<nui-page') || trimmedHtml.startsWith('<nui-page ');

	if (isNuiPageRoot && wrapper.tagName.toLowerCase() === 'nui-page') {
		// Fragment already has nui-page root, transfer classes and replace wrapper
		const tempDiv = document.createElement('div');
		tempDiv.innerHTML = html;
		const fragmentPage = tempDiv.querySelector('nui-page');
		
		if (fragmentPage) {
			// Transfer classes from wrapper to fragment's nui-page
			wrapper.classList.forEach(cls => fragmentPage.classList.add(cls));
			// Replace wrapper's content with fragment's children
			wrapper.innerHTML = fragmentPage.innerHTML;
			// Copy attributes
			Array.from(fragmentPage.attributes).forEach(attr => {
				if (attr.name !== 'class') {
					wrapper.setAttribute(attr.name, attr.value);
				}
			});
		} else {
			wrapper.innerHTML = html;
		}
	} else {
		wrapper.innerHTML = html;
	}

	customElements.upgrade(wrapper);
	executePageScript(wrapper, params);
}

function pageContent(type, id, params, options = {}) {
	const wrapper = document.createElement(type === 'page' ? 'nui-page' : 'div');
	wrapper.className = `content-${type} content-${type}-${id.replace(/\//g, '-').replace(/[^a-z0-9-]/gi, '')}`;
	wrapper.innerHTML = '<div class="loading">Loading...</div>';

	if (type === 'page') {
		const basePath = options.basePath || '/pages';

		// Check for registered page handler (nui.registerPage())
		const registered = registeredFeatures.get(`page:${id}`);
		if (registered) {
			const fragmentPath = registered.html || `${id}.html`;
			wrapper.nuiLoaded = loadFragment(`${basePath}/${fragmentPath}`, wrapper, params)
				.then(() => {
					if (registered.init) {
						registered.init(wrapper, params, nui);
					}
				});
		} else {
			wrapper.nuiLoaded = loadFragment(`${basePath}/${id}.html`, wrapper, params);
		}
	} else if (type === 'feature') {
		const initFn = registeredFeatures.get(id);
		if (initFn) {
			wrapper.innerHTML = '';
			try {
				initFn(wrapper, params);
			} catch (error) {
				console.error(`[NUI] Feature init error (${id}):`, error);
				wrapper.innerHTML = `<div class="error">Feature error: ${error.message}</div>`;
			}
		} else {
			wrapper.innerHTML = `<div class="error">Unknown feature: ${id}</div>`;
		}
	} else {
		const typeHandler = registeredTypes.get(type);
		if (typeHandler) {
			wrapper.innerHTML = '';
			try {
				typeHandler(id, params, wrapper);
			} catch (error) {
				console.error(`[NUI] Type handler error (${type}):`, error);
				wrapper.innerHTML = `<div class="error">Handler error: ${error.message}</div>`;
			}
		} else {
			wrapper.innerHTML = `<div class="error">Unknown route type: ${type}</div>`;
		}
	}

	return wrapper;
}

function createRouter(container, options = {}) {
	const cache = new Map();
	const defaultRoute = options.default || null;
	const basePath = options.basePath || '/pages';
	let currentElement = null;
	let currentRoute = null;
	let isStarted = false;
	let isInitialLoad = true;
	let navigationId = 0;

	container = typeof container === 'string'
		? document.el(container)
		: container;

	if (!container) {
		console.error('[NUI Router] Container not found');
		return null;
	}

	function getCacheKey(type, id) {
		return `${type}:${id}`;
	}

	function hideElement(element) {
		if (!element) return;
		element.inert = true;
		element.style.display = 'none';
		element.classList.remove('nui-page-active');
		element.hide?.();
	}

	function showElement(element, params) {
		element.inert = false;
		element.show?.(params);

		element.classList.add('nui-page-active');

		const focusTarget = element.el('h1, h2, [autofocus], main') || element;
		if (focusTarget.tabIndex < 0) focusTarget.tabIndex = -1;
		focusTarget.focus({ preventScroll: true });
	}

	function handleDeepLink(element, params) {
		// Find the actual scroll container (nui-main in app mode)
		const scrollContainer = container.closest('nui-main') || container.closest('nui-content')?.el('nui-main') || container;

		if (params.id) {
			const target = element.el(`#${params.id}`);
			if (target) {
				requestAnimationFrame(() => {
					target.scrollIntoView({ behavior: 'smooth', block: 'start' });
				});
			}
		} else {
			scrollContainer.scrollTop = 0;
		}
	}

	async function navigate(route) {
		if (!route) {
			if (defaultRoute) {
				location.hash = defaultRoute;
			}
			return;
		}

		const currentNavId = ++navigationId;
		const { type, id, params } = route;
		const cacheKey = getCacheKey(type, id);

		let element = cache.get(cacheKey);
		if (!element) {
			element = pageContent(type, id, params, { basePath });
			cache.set(cacheKey, element);
			container.appendChild(element);
			element.style.display = 'none';
		}

		if (element.nuiLoaded) {
			try {
				await element.nuiLoaded;
			} catch (e) {
			}
		}

		if (currentNavId !== navigationId) {
			return;
		}

		if (currentElement !== element) {
			hideElement(currentElement);

			element.style.display = '';

			void element.offsetHeight;

			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					// Only focus content on navigation, not on initial page load
					if (!isInitialLoad) {
						showElement(element, params);
					} else {
						element.inert = false;
						element.show?.(params);
						element.classList.add('nui-page-active');
						isInitialLoad = false;
					}
					handleDeepLink(element, params);
				});
			});

			currentElement = element;
			currentRoute = { type, id, params, element };

			container.dispatchEvent(new CustomEvent('nui-route-change', {
				bubbles: true,
				detail: currentRoute
			}));
		} else {
			handleDeepLink(element, params);
		}
	}

	function handleHashChange() {
		const route = parseUrl();

		// If parseUrl returns null, check if it's an anchor link (no route)
		if (!route) {
			const hash = location.hash.slice(1);
			// If there's a hash but no route, it's an anchor link
			if (hash) {
				console.log('Anchor link detected:', hash);

				// Immediately reset any body scroll that may have occurred
				window.scrollTo(0, 0);
				document.documentElement.scrollTop = 0;
				document.body.scrollTop = 0;

				console.log('Body scrollTop AFTER reset:', document.body.scrollTop, 'documentElement scrollTop:', document.documentElement.scrollTop);
				console.log('Window pageYOffset:', window.pageYOffset, 'scrollY:', window.scrollY);

				// Find and scroll the content container
				const target = document.getElementById(hash);
				if (target) {
					const contentScroll = document.querySelector('nui-main') ||
						document.querySelector('nui-content');
					if (contentScroll) {
						// Calculate position relative to content container
						const containerRect = contentScroll.getBoundingClientRect();
						const targetRect = target.getBoundingClientRect();
						const scrollOffset = targetRect.top - containerRect.top + contentScroll.scrollTop;
						console.log('Container top:', containerRect.top, 'Target top:', targetRect.top, 'Scrolling to:', scrollOffset);

						requestAnimationFrame(() => {
							contentScroll.scrollTo({ top: scrollOffset, behavior: 'smooth' });
							// Remove hash from URL
							history.replaceState(null, '', location.pathname + location.search);
						});
					} else {
						// Fallback
						target.scrollIntoView({ behavior: 'smooth', block: 'start' });
						history.replaceState(null, '', location.pathname + location.search);
					}
				}

				return;
			}
			// Otherwise, no hash at all - navigate to default
		}

		navigate(route);
	}

	function handleAnchorClick(e) {
		const link = e.target.closest('a[href^="#"]');
		if (!link) return;

		const hash = link.getAttribute('href').slice(1);
		// Skip if it's a route (contains '=')
		if (hash.includes('=')) return;

		console.log('Intercepted anchor click:', hash);
		e.preventDefault();
		e.stopPropagation();

		// Find and scroll the content container
		const target = document.getElementById(hash);
		if (!target) {
			console.log('Target not found:', hash);
			return;
		}

		// Find the scrollable container from the link's context
		let contentScroll = link.closest('nui-main');
		console.log('Link closest nui-main:', contentScroll);

		// If link is not inside nui-main, find the target's container
		if (!contentScroll) {
			contentScroll = target.closest('nui-main');
			console.log('Target closest nui-main:', contentScroll);
		}

		// Last resort: find first visible nui-main
		if (!contentScroll) {
			contentScroll = document.querySelector('nui-main:not([hidden])');
			console.log('querySelector nui-main:', contentScroll);
		}

		// Try without :not([hidden])
		if (!contentScroll) {
			contentScroll = document.querySelector('nui-main');
			console.log('querySelector nui-main (any):', contentScroll);
		}

		if (contentScroll) {
			// Immediately prevent any pending scroll
			window.scrollTo(0, 0);

			// Get positions
			const containerRect = contentScroll.getBoundingClientRect();
			const targetRect = target.getBoundingClientRect();

			// Calculate absolute position within scrollable content
			const scrollOffset = targetRect.top - containerRect.top + contentScroll.scrollTop;

			// Use native smooth scroll
			contentScroll.scrollTo({ top: scrollOffset, behavior: 'smooth' });
		} else {
			console.log('No content scroll container found');
			// Fallback
			target.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	}

	function start() {
		if (isStarted) return;
		isStarted = true;
		document.addEventListener('click', handleAnchorClick);
		window.addEventListener('hashchange', handleHashChange);
		handleHashChange();
	}

	function stop() {
		if (!isStarted) return;
		isStarted = false;
		document.removeEventListener('click', handleAnchorClick);
		window.removeEventListener('hashchange', handleHashChange);
	}

	function go(type, id, params = {}) {
		const hashValue = `${type}=${id}`;
		const search = new URLSearchParams(params).toString();
		
		if (search) {
			history.pushState(null, '', `?${search}#${hashValue}`);
		} else {
			location.hash = hashValue;
		}
	}

	function uncache(type, id) {
		const cacheKey = getCacheKey(type, id);
		const element = cache.get(cacheKey);
		if (element) {
			element.remove();
			cache.delete(cacheKey);
		}
	}

	return {
		start,
		stop,
		go,
		uncache,
		get current() { return currentRoute; },
		get cache() { return cache; }
	};
}

function setupRouter(options = {}) {
	const containerSelector = options.container || 'nui-content nui-main';
	const navigationSelector = options.navigation || 'nui-sidebar';
	const basePath = options.basePath || '/pages';
	const defaultPage = options.defaultPage || null;

	const container = typeof containerSelector === 'string'
		? document.el(containerSelector)
		: containerSelector;

	if (!container) {
		console.error('[NUI] Content container not found:', containerSelector);
		return null;
	}

	const router = createRouter(container, {
		default: defaultPage ? `page=${defaultPage}` : null,
		basePath
	});

	const navigation = typeof navigationSelector === 'string'
		? document.el(navigationSelector)
		: navigationSelector;

	if (navigation) {
		container.addEventListener('nui-route-change', (e) => {
			const route = e.detail;
			if (!route) return;

			const app = navigation.closest('nui-app');
			if (app && app.classList.contains('sidebar-open') && !app.classList.contains('sidebar-forced')) {
				app.toggleSidebar();
			}

			const hash = location.hash;
			let found = navigation.setActive?.(`a[href="${hash}"]`);
			if (!found && route.id) {
				found = navigation.setActive?.(`a[href*="${route.type}=${route.id}"]`);
			}
		});
	}

	router.start();

	return router;
}

// ################################# INIT & PUBLIC API

function ensureBaseStyles() {
	const rootStyles = getComputedStyle(document.documentElement);
	const hasBaseVariables = rootStyles.getPropertyValue('--nui-space').trim() !== '';

	if (!hasBaseVariables) {
		const scriptPath = document.currentScript?.src || import.meta.url;
		const basePath = scriptPath.substring(0, scriptPath.lastIndexOf('/'));
		const cssPath = `${basePath}/css/nui-theme.css`;

		dom.create('link', {
			attrs: { rel: 'stylesheet', href: cssPath },
			target: document.head
		});

		if (config.debug !== false) {
			console.warn('[NUI] Default theme auto-loaded from:', cssPath, '(Include nui.js in <head> to prevent layout shifts)');
		}
	}


}

// ################################# STORAGE SYSTEM

function parseTTL(ttl) {
	if (!ttl || ttl === 'forever') return null;
	if (ttl === 'session') return 0;

	if (typeof ttl === 'number') {
		if (ttl > 1e12) return new Date(ttl);
		return new Date(ttl * 1000);
	}

	if (/^\d{4}-\d{2}-\d{2}$/.test(ttl)) {
		return new Date(ttl + 'T23:59:59');
	}

	const match = ttl.match(/^(\d+)-(minutes?|hours?|days?|months?|years?)$/);
	if (match) {
		const value = parseInt(match[1], 10);
		const unit = match[2].replace(/s$/, '');
		const now = new Date();

		switch (unit) {
			case 'minute': return new Date(now.getTime() + value * 60 * 1000);
			case 'hour': return new Date(now.getTime() + value * 60 * 60 * 1000);
			case 'day': return new Date(now.getTime() + value * 24 * 60 * 60 * 1000);
			case 'month': return new Date(now.setMonth(now.getMonth() + value));
			case 'year': return new Date(now.setFullYear(now.getFullYear() + value));
		}
	}

	return null;
}

const storage = {
	set({ name, value, target = 'cookie', ttl = 'forever' }) {
		if (!name || value === undefined || value === null) return false;

		const expires = parseTTL(ttl);

		if (target === 'localStorage') {
			try {
				const entry = { value };
				if (expires) entry.expires = expires.getTime();
				localStorage.setItem(name, JSON.stringify(entry));
				return true;
			} catch {
				return false;
			}
		}

		let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
		cookie += '; path=/';
		cookie += '; SameSite=Lax';

		if (location.protocol === 'https:') {
			cookie += '; Secure';
		}

		if (expires === 0) {
			// Session cookie - no expires attribute
		} else if (expires) {
			cookie += `; expires=${expires.toUTCString()}`;
		} else {
			// "forever" = 10 years
			const far = new Date();
			far.setFullYear(far.getFullYear() + 10);
			cookie += `; expires=${far.toUTCString()}`;
		}

		document.cookie = cookie;
		return true;
	},

	get({ name, target = 'cookie' }) {
		if (!name) return undefined;

		if (target === 'localStorage') {
			try {
				const raw = localStorage.getItem(name);
				if (!raw) return undefined;

				const entry = JSON.parse(raw);
				if (entry.expires && Date.now() > entry.expires) {
					localStorage.removeItem(name);
					return undefined;
				}
				return entry.value;
			} catch {
				return undefined;
			}
		}

		const cookies = document.cookie.split('; ');
		for (const cookie of cookies) {
			const [cookieName, ...rest] = cookie.split('=');
			if (decodeURIComponent(cookieName) === name) {
				return decodeURIComponent(rest.join('='));
			}
		}
		return undefined;
	},

	remove({ name, target = 'cookie' }) {
		if (!name) return false;

		if (target === 'localStorage') {
			try {
				if (localStorage.getItem(name) === null) return false;
				localStorage.removeItem(name);
				return true;
			} catch {
				return false;
			}
		}

		const exists = this.get({ name, target: 'cookie' }) !== undefined;
		if (!exists) return false;

		const parts = [
			`${encodeURIComponent(name)}=`,
			'path=/',
			'expires=Thu, 01 Jan 1970 00:00:00 GMT',
			'SameSite=Lax'
		];
		if (location.protocol === 'https:') parts.push('Secure');

		document.cookie = parts.join('; ');
		return true;
	}
};

function enableDrag(target, callback, options = {}) {
	const subtarget = options.subtarget || target;
	let activePointerId = null;

	function handleDown(e) {
		e.preventDefault();
		activePointerId = e.pointerId;
		target.setPointerCapture(e.pointerId);

		['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => {
			target.addEventListener(type, type === 'pointermove' ? handleMove : handleUp);
		});

		report(e, 'start');
	}

	function handleMove(e) {
		if (e.pointerId !== activePointerId) return;
		report(e, 'move');
	}

	function handleUp(e) {
		if (e.pointerId !== activePointerId) return;
		report(e, 'end');
		cleanup();
	}

	function report(e, type) {
		const rect = subtarget.getBoundingClientRect();
		const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
		const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));

		callback({
			type,
			x,
			y,
			percentX: x / rect.width,
			percentY: y / rect.height,
			clientX: e.clientX,
			clientY: e.clientY,
			isTouch: e.pointerType === 'touch'
		});
	}

	function cleanup() {
		if (activePointerId !== null) {
			try { target.releasePointerCapture(activePointerId); } catch { }
		}
		activePointerId = null;
		target.removeEventListener('pointermove', handleMove);
		target.removeEventListener('pointerup', handleUp);
		target.removeEventListener('pointercancel', handleUp);
		target.removeEventListener('lostpointercapture', handleUp);
	}

	target.addEventListener('pointerdown', handleDown);

	// Return cleanup function that fully removes all listeners
	return () => {
		cleanup();
		target.removeEventListener('pointerdown', handleDown);
	};
}

// ################################# ICON SYSTEM

const iconSystem = {
	_cache: null,
	async getAvailable() {
		if (this._cache) return this._cache;
		try {
			const response = await fetch(config.iconSpritePath);
			const text = await response.text();
			const parser = new DOMParser();
			const doc = parser.parseFromString(text, 'image/svg+xml');
			const symbols = doc.querySelectorAll('symbol');
			this._cache = Array.from(symbols).map(s => s.id).sort();
			return this._cache;
		} catch (e) {
			console.error('Failed to load icon sprite:', e);
			return [];
		}
	},

	create(name, asElement = false) {
		if (asElement) {
			return dom.create('nui-icon', { attrs: { name } });
		}
		return `<nui-icon name="${name}"></nui-icon>`;
	}
};

const util = {
	createElement: dom.create,
	createSvgElement: dom.svg,
	dom,
	enableDrag,
	storage,
	generateId,

	sortByKey(array, path, numeric = false) {
		const parts = path.split('.');
		const getValue = (obj) => {
			let value = obj;
			for (const part of parts) {
				value = value?.[part];
				if (value === undefined) return undefined;
			}
			return value;
		};
		
		return array.sort((a, b) => {
			let x = getValue(a);
			let y = getValue(b);
			
			if (x === undefined || y === undefined) return 0;
			
			if (typeof x === 'string' && typeof y === 'string') {
				x = x.toLowerCase();
				y = y.toLowerCase();
			}
			
			if (numeric) return x - y;
			return x < y ? -1 : x > y ? 1 : 0;
		});
	},
	
	filter(options) {
		const { data, search, prop = [], ignore_case = true } = options;
		if (!search || search.trim() === '') return data;
		
		const searchTerm = ignore_case ? search.toLowerCase() : search;
		const results = [];
		
		for (const item of data) {
			let found = false;
			for (const path of prop) {
				const parts = path.split('.');
				let value = item;
				for (const part of parts) {
					value = value?.[part];
					if (value === undefined) break;
				}
				
				if (value !== undefined) {
					const stringValue = ignore_case ? String(value).toLowerCase() : String(value);
					if (stringValue.includes(searchTerm)) {
						found = true;
						break;
					}
				}
			}
			if (found) results.push(item);
		}
		
		return results;
	},
	
	/**
	 * Detect browser/device environment
	 * @returns {Object} Environment flags
	 */
	detectEnv() {
		return {
			isTouch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
			isMac: window.navigator.platform.toUpperCase().indexOf('MAC') >= 0,
			isIOS: ['iPad Simulator','iPhone Simulator','iPod Simulator','iPad','iPhone','iPod'].includes(navigator.platform) 
				|| (navigator.userAgent.includes("Mac") && "ontouchend" in document),
			isSafari: /^((?!chrome|android).)*safari/i.test(navigator.userAgent),
			isFF: navigator.userAgent.toLowerCase().indexOf('firefox') > -1,
		};
	}
};

const dropzoneFactory = {
	create(zones, callback, target) {
		const el = document.createElement('nui-dropzone');
		for (const zone of zones) {
			const div = document.createElement('div');
			div.setAttribute('data-drop', zone.name);
			div.innerHTML = zone.label;
			el.appendChild(div);
		}
		if (callback) {
			el.addEventListener('nui-dropzone-drop', (e) => callback(e.detail, e));
		}
		if (target) target.appendChild(el);
		return el;
	}
};

const componentsApi = {
	dialog: dialogSystem,
	banner: bannerFactory,
	dropzone: dropzoneFactory,
	linkList: {
		create: createLinkList
	},
	icon: iconSystem
};

export const nui = {
	config,
	util,
	components: componentsApi,

	ready() {
		return _readyPromise;
	},

	init(options) {
		if (options) {
			this.configure(options);
		}

		ensureBaseStyles();
		setupActionDelegation();

		const savedTheme = localStorage.getItem('nui-theme');
		if (savedTheme) {
			document.documentElement.style.colorScheme = savedTheme;
		} else {
			const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
			document.documentElement.style.colorScheme = prefersDark ? 'dark' : 'light';
		}

		const baseValue = getComputedStyle(document.documentElement)
			.getPropertyValue('--nui-rem-base')
			.trim();
		config.baseFontSize = parseFloat(baseValue) || 14;

		Object.entries(components).forEach(([tagName, { class: ComponentClass }]) => {
			if (!customElements.get(tagName)) {
				customElements.define(tagName, ComponentClass);
			}
		});

		// Addon auto-loading (dev-only) — Proposal 4
		if (config.debug !== false) {
			const ADDON_MAP = {
				'nui-list':         { js: 'lib/modules/nui-list.js',         css: 'css/modules/nui-list.css' },
				'nui-lightbox':     { js: 'lib/modules/nui-lightbox.js',     css: 'css/modules/nui-lightbox.css' },
				'nui-code-editor':  { js: 'lib/modules/nui-code-editor.js',  css: 'css/modules/nui-code-editor.css' },
				'nui-media-player': { js: 'lib/modules/nui-media-player.js', css: 'css/modules/nui-media-player.css' },
				'nui-wizard':       { js: 'lib/modules/nui-wizard.js',       css: 'css/modules/nui-wizard.css' },
				'nui-menu':         { js: 'lib/modules/nui-menu.js',         css: 'css/modules/nui-menu.css' },
				'nui-context-menu': { js: 'lib/modules/nui-context-menu.js', css: 'css/modules/nui-context-menu.css' },
				'nui-rich-text':    { js: 'lib/modules/nui-rich-text.js',    css: 'css/modules/nui-rich-text.css' },
			};

			const _loading = new Set();

			async function tryAutoLoad(tag) {
				const map = ADDON_MAP[tag];
				if (!map) return;
				if (_loading.has(tag)) return;
				_loading.add(tag);

				try {
					// Inject CSS
					if (map.css) {
						const cssHref = `${nuiBasePath}/${map.css}`;
						if (!document.querySelector(`link[href$="${map.css}"]`)) {
							const link = document.createElement('link');
							link.rel = 'stylesheet';
							link.href = cssHref;
							document.head.appendChild(link);
						}
					}

					// Dynamic import JS
					const jsPath = `${nuiBasePath}/${map.js}`;
					await import(jsPath);

					console.info(`[NUI] Auto-loaded <${tag}> (JS + CSS). Add explicit imports for production:\n  <link rel="stylesheet" href="NUI/${map.css}">\n  <script type="module" src="NUI/${map.js}"></script>`);
				} catch (err) {
					console.warn(`[NUI] Failed to auto-load <${tag}>. Add explicit imports:\n  <link rel="stylesheet" href="NUI/${map.css}">\n  <script type="module" src="NUI/${map.js}"></script>`, err);
				} finally {
					_loading.delete(tag);
				}
			}

			function checkAndAutoLoad(root) {
				Object.keys(ADDON_MAP).forEach(tag => {
					root.querySelectorAll(tag).forEach(el => {
						if (!customElements.get(tag)) {
							tryAutoLoad(tag);
						}
					});
				});
			}

			// Initial scan
			checkAndAutoLoad(document);

			// Ongoing observer
			new MutationObserver((mutations) => {
				for (const m of mutations) {
					for (const node of m.addedNodes) {
						if (node.nodeType !== Node.ELEMENT_NODE) continue;
						const tag = node.tagName?.toLowerCase();
						if (tag && ADDON_MAP[tag] && !customElements.get(tag)) {
							tryAutoLoad(tag);
						}
						if (node.querySelectorAll) {
							checkAndAutoLoad(node);
						}
					}
				}
			}).observe(document.documentElement, { childList: true, subtree: true });
		}

		// Resolve ready promise so consumers can await nui.ready()
		_readyResolve();
		_readyResolve = null; // Release closure
	},

	registerFeature(name, initFn) {
		registeredFeatures.set(name, initFn);
	},

	/**
	 * Register a page handler with optional HTML fragment.
	 * Preferred pattern for page logic — uses standard JS modules, no <script type="nui/page"> needed.
	 * 
	 * @param {string} id - Page ID matching the hash route (e.g., "components/button")
	 * @param {object} options
	 * @param {string} [options.html] - Path to HTML fragment (relative to basePath)
	 * @param {function} options.init - init(element, params, nui) called after upgrade
	 */
	registerPage(id, options = {}) {
		registeredFeatures.set(`page:${id}`, {
			html: options.html || null,
			init: options.init
		});
	},

	registerAction(name, handler) {
		registeredActions.set(name, handler);
	},

	registerType(type, handler) {
		registeredTypes.set(type, handler);
	},

	configure(options) {
		if (!options) return;
		if (options.a11y) {
			config.a11y = { ...config.a11y, ...options.a11y };
			const { a11y, ...rest } = options;
			Object.assign(config, rest);
		} else {
			Object.assign(config, options);
		}
	},

	createRouter(container, options = {}) {
		return createRouter(container, options);
	},

	setupRouter(options = {}) {
		return setupRouter(options);
	},

	// Backward compatibility alias (deprecated)
	enableContentLoading(options = {}) {
		console.warn('[NUI] enableContentLoading() is deprecated. Use setupRouter() instead.');
		return setupRouter(options);
	}
};

// ################################# MARKDOWN COMPONENT

/**
 * Converts Markdown to HTML using a lightweight parser.
 * Supports headers, lists, links, code blocks (with nui-code), tables, bold/italic, etc.
 */
function markdownToHtml(md) {
	if (typeof md !== 'string' || !md.trim()) return '';
	
	let html = md.trim().replace(/\r\n/g, '\n');
	const codeBlocks = [];
	html = html.replace(/^[ \t]*```(\w+)?\n([\s\S]*?)\n[ \t]*```/gm, (match, lang, code) => {
		const token = `\uE000${codeBlocks.length}\uE001`;
		codeBlocks.push({ token, lang, code });
		return token;
	});
	html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

	// Simple tables
	html = html.replace(/^[ \t]*\|(.+)\|\n[ \t]*\|([-:| ]+)\|\n((?:[ \t]*\|.+\|\n?)*)/gm, (match, header, sep, body) => {
		const headCells = header.trim().replace(/^\||\|$/g, '').split('|').map(c => `<th>${c.trim()}</th>`).join('');
		const bodyRows = body.trim().split('\n').filter(r => r.trim()).map(row => {
			const cells = row.trim().replace(/^\||\|$/g, '').split('|').map(c => `<td>${c.trim()}</td>`).join('');
			return `<tr>${cells}</tr>`;
		}).join('');
		return `<table class="nui-table"><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table>`;
	});

	// Headers
	html = html.replace(/^[ \t]*(#{1,6})\s+(.+)$/gm, (match, hashes, text) => `<h${hashes.length}>${text}</h${hashes.length}>`);

	// Blockquotes
	html = html.replace(/^[ \t]*(&gt;\s+.+(:?\n[ \t]*&gt;\s+.+)*)/gm, (match) => `<blockquote>${match.replace(/^[ \t]*&gt;\s+/gm, '')}</blockquote>`);

	// Unordered lists
	html = html.replace(/^((?:[ \t]*(?:-|\*)\s.+\n?)+)/gm, (match) => {
		const items = match.trim().split('\n').map(item => `<li>${item.replace(/^[ \t]*(?:-|\*)\s+/, '')}</li>`).join('');
		return `<ul>${items}</ul>`;
	});
	
	// Ordered lists
	html = html.replace(/^((?:[ \t]*\d+\.\s.+\n?)+)/gm, (match) => {
		const items = match.trim().split('\n').map(item => `<li>${item.replace(/^[ \t]*\d+\.\s+/, '')}</li>`).join('');
		return `<ol>${items}</ol>`;
	});

	// Horizontal rules
	html = html.replace(/^[ \t]*(={3,})[ \t]*$/gm, '<hr class="equals">');
	html = html.replace(/^[ \t]*(-{3,})[ \t]*$/gm, '<hr class="dash">');
	html = html.replace(/^[ \t]*(\*{3,})[ \t]*$/gm, '<hr class="stars">');
	html = html.replace(/^[ \t]*(_{3,})[ \t]*$/gm, '<hr>');

	// Block separation
	const blocks = html.split(/\n{2,}/);
	const htmlBlocks = blocks.map(block => {
		block = block.trim();
		if (!block) return '';
		if (/^\uE000\d+\uE001$/.test(block)) return block;
		if (/^<(h\d|ul|ol|pre|blockquote|table|hr|nui-code)/i.test(block)) return block;
		return `<p>${block.replace(/\n/g, '<br>')}</p>`;
	});
	html = htmlBlocks.join('\n');

	// Inline elements
	html = html.replace(/!\[([^\]]+)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
	html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
	html = html.replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>');
	html = html.replace(/(\*|_)(.*?)\1/g, '<em>$2</em>');
	html = html.replace(/~~(.*?)~~/g, '<s>$1</s>');
	html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
	html = codeBlocks.reduce((result, { token, lang, code }) => {
		const safeCode = code.replace(/<\/script/gi, '<\\/script');
		return result.replace(token, `<nui-code><script type="example"${lang ? ` data-lang="${lang}"` : ''}>${safeCode}</script></nui-code>`);
	}, html);

	return html;
}

// Add to util for global access
util.markdownToHtml = markdownToHtml;

class NuiMarkdown extends HTMLElement {
	constructor() {
		super();
		this._streamText = '';
		this._activeBuffer = '';
		this._isStreaming = false;
	}

	async connectedCallback() {
		if (this._isStreaming) return;

		let rawText = '';
		const src = this.getAttribute('src');

		if (src) {
			try {
				const response = await fetch(src);
				if (response.ok) {
					rawText = await response.text();
				} else {
					console.warn(`[NuiMarkdown] Failed to fetch source: ${src}`);
				}
			} catch (err) {
				console.error(`[NuiMarkdown] Error fetching source: ${src}`, err);
			}
		} else {
			// Read from <script type="text/markdown"> element
			const mdScript = this.querySelector('script[type="text/markdown"]');
			if (mdScript) {
				rawText = mdScript.textContent.trim();
			} else {
				rawText = this.textContent.trim();
			}
		}

		if (!rawText) return;

		this.innerHTML = markdownToHtml(rawText);
	}

	_isInsideCodeBlock(text) {
		const matches = text.match(/```/g);
		return matches && matches.length % 2 !== 0;
	}

	beginStream() {
		this._isStreaming = true;
		this._streamText = '';
		this._activeBuffer = '';
		
		this.innerHTML = '';
		this._stableContainer = document.createElement('div');
		this._stableContainer.className = 'nui-md-stable';
		
		this._tempContainer = document.createElement('div');
		this._tempContainer.className = 'nui-md-temp';
		
		this.appendChild(this._stableContainer);
		this.appendChild(this._tempContainer);
	}

	appendChunk(chunk) {
		if (!this._isStreaming) this.beginStream();

		this._streamText += chunk;
		this._activeBuffer += chunk;

		this._processBuffer(false);
	}

	endStream() {
		if (this._isStreaming) {
			this._processBuffer(true);
			this._isStreaming = false;
		}
	}

	_processBuffer(forceDrain) {
		while (true) {
			if (!forceDrain && this._isInsideCodeBlock(this._streamText)) {
				break;
			}
			
			let boundary = -1;
			let searchIndex = 0;
			
			while (true) {
				const nextIndex = this._activeBuffer.indexOf('\n\n', searchIndex);
				if (nextIndex === -1) break;
				
				const blockSoFar = this._activeBuffer.substring(0, nextIndex);
				if (!this._isInsideCodeBlock(blockSoFar)) {
					boundary = nextIndex;
					break;
				}
				searchIndex = nextIndex + 1;
			}

			if (boundary !== -1) {
				const block = this._activeBuffer.substring(0, boundary + 2);
				this._activeBuffer = this._activeBuffer.substring(boundary + 2);
				
				const tempDiv = document.createElement('div');
				tempDiv.innerHTML = markdownToHtml(block);
				while (tempDiv.firstChild) {
					this._stableContainer.appendChild(tempDiv.firstChild);
				}
			} else {
				break;
			}
		}

		if (forceDrain && this._activeBuffer) {
			const drainDiv = document.createElement('div');
			drainDiv.innerHTML = markdownToHtml(this._activeBuffer);
			while (drainDiv.firstChild) {
				this._stableContainer.appendChild(drainDiv.firstChild);
			}
			this._activeBuffer = '';
		}
		
		this._tempContainer.innerHTML = markdownToHtml(this._activeBuffer);
	}
}

if (!customElements.get('nui-markdown')) {
	customElements.define('nui-markdown', NuiMarkdown);
}

// ################################# AUTO-INITIALIZATION

if (typeof window !== 'undefined') {
	window.nui = nui;

	if (!window.nuiInitialized) {
		const urlParams = new URLSearchParams(window.location.search);
		const skipInit = urlParams.has('skip-init');

		if (!skipInit) {
			nui.init();
			window.nuiInitialized = true;
		} else {
			console.log('[NUI] Auto-initialization skipped (skip-init parameter present)');
			window.nuiInitialized = false;
		}
	}
}
