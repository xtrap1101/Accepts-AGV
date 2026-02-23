/**
 * Auto Accept Agent - Combined Script v10.1
 *
 * Combines:
 * - simple_poll.js (button clicking, 300ms interval) - ALWAYS runs
 * - background_mode.js (tab cycling + overlay) - runs ONLY if background mode enabled
 *
 * Both loops run concurrently with NO race conditions because:
 * - Clicking loop: Only clicks buttons, doesn't touch tabs
 * - Tab/overlay loop: Only cycles tabs and updates overlay, doesn't click buttons
 *
 * API:
 *   window.__autoAcceptStart(config)  // config: {ide, isBackgroundMode}
 *   window.__autoAcceptStop()
 *   window.__autoAcceptGetStats()
 */
(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    const log = (msg) => console.log(`[AutoAccept] ${msg}`);
    log('Script loaded');

    // =================================================================
    // SHARED: DOM UTILITIES
    // =================================================================

    const getDocuments = (root = document) => {
        let docs = [root];
        try {
            const iframes = root.querySelectorAll('iframe, frame');
            for (const iframe of iframes) {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (iframeDoc) docs.push(...getDocuments(iframeDoc));
                } catch (e) { }
            }
        } catch (e) { }
        return docs;
    };

    const queryAll = (selector) => {
        const results = [];
        getDocuments().forEach(doc => {
            try {
                results.push(...Array.from(doc.querySelectorAll(selector)));
            } catch (e) { }
        });
        return results;
    };

    // =================================================================
    // SIMPLE POLL: BUTTON CLICKING (optimized - zero layout thrashing)
    // =================================================================

    // Pre-compiled regex for fast matching (no array iteration)
    // NOTE: 'confirm' removed - too generic, catches undo/delete/revert dialogs
    const ACCEPT_RE = /^(run|accept|retry|apply|execute|allow)/i;
    const REJECT_RE = /^(skip|reject|cancel|close|refine|always|ask every|undo|confirm)/i;

    function isAcceptButton(el) {
        if (el.disabled) return false;
        // offsetParent === null means element or ancestor is display:none (super lightweight)
        if (el.offsetParent === null) return false;

        const text = (el.innerText || '').trim();
        if (text.length === 0 || text.length > 50) return false;

        // Reject first (fast exit for non-action buttons)
        if (REJECT_RE.test(text)) return false;
        if (!ACCEPT_RE.test(text)) return false;

        // Skip dropdown/mode selector items
        const role = el.getAttribute('role');
        if (role === 'option' || role === 'menuitem' || role === 'menuitemradio') return false;
        if (el.hasAttribute('aria-selected')) return false;

        return true;
    }

    // Banned commands list (updated from extension via CDP)
    let _bannedCommands = [];

    /**
     * Extract command text from the "Run command?" dialog
     * Walks up the DOM from the Run button to find the code block
     */
    function getCommandTextNearButton(btn) {
        // Walk up to find the container (max 10 levels)
        let container = btn.parentElement;
        for (let i = 0; i < 10 && container; i++) {
            // Look for code/pre elements inside the container
            const codeEl = container.querySelector('code, pre, [class*="code"], [class*="terminal"], [class*="command"]');
            if (codeEl) {
                const text = (codeEl.innerText || '').trim();
                if (text.length > 5) return text;
            }
            container = container.parentElement;
        }
        return '';
    }

    /**
     * Check if a command matches any banned pattern
     */
    function isCommandBanned(cmdText) {
        if (!cmdText || _bannedCommands.length === 0) return false;
        const lower = cmdText.toLowerCase();
        return _bannedCommands.some(pattern => {
            if (typeof pattern === 'string') {
                return lower.includes(pattern.toLowerCase());
            }
            return false;
        });
    }

    /**
     * Check if a button is inside the Agent panel or a command/terminal dialog.
     * Prevents auto-clicking buttons that appear in the code editor area.
     */
    function isInAgentZone(el) {
        let node = el.parentElement;
        for (let i = 0; i < 20 && node; i++) {
            const cls = (node.className || '').toLowerCase();
            const id = (node.id || '').toLowerCase();
            const role = (node.getAttribute && node.getAttribute('role') || '').toLowerCase();

            // Agent panel / chat panel selectors (Antigravity/Cursor/Windsurf)
            if (
                cls.includes('agent') ||
                cls.includes('cascade') ||
                cls.includes('chat') ||
                cls.includes('terminal-command') ||
                cls.includes('command-dialog') ||
                cls.includes('quick-input') ||
                cls.includes('notification') ||
                id.includes('agent') ||
                id.includes('chat') ||
                role === 'dialog' ||
                role === 'alertdialog'
            ) {
                return true;
            }
            node = node.parentElement;
        }
        return false;
    }

    function clickAcceptButtons() {
        // Only query 'button' - covers 99% of cases, much lighter than 4 selectors
        const buttons = queryAll('button');
        let clicked = 0;

        for (const el of buttons) {
            if (isAcceptButton(el)) {
                const buttonText = (el.innerText || '').trim();

                // Safety check: if button is "Run", extract and check the command
                if (/^run/i.test(buttonText)) {
                    const cmdText = getCommandTextNearButton(el);
                    if (cmdText) {
                        log(`[CMD] Detected: "${cmdText.substring(0, 120)}"`);
                        if (isCommandBanned(cmdText)) {
                            log(`[BLOCKED] Banned command detected! Skipping: "${cmdText.substring(0, 80)}"`);
                            continue;
                        }
                    }
                    // Run buttons in terminal dialogs → always in agent zone, skip zone check
                } else {
                    // Non-Run buttons: only click if inside agent/dialog zone
                    if (!isInAgentZone(el)) {
                        continue; // Skip buttons outside agent panel (e.g. editor inline suggestions)
                    }
                }

                log(`Clicking: "${buttonText}"`);
                el.click();
                clicked++;
            }
        }

        if (clicked > 0 && window.__autoAcceptState) {
            window.__autoAcceptState.clicks += clicked;
        }
        return clicked;
    }

    // =================================================================
    // BACKGROUND MODE: OVERLAY (from background_mode.js - proven working)
    // =================================================================

    const OVERLAY_ID = '__autoAcceptBgOverlay';
    const STYLE_ID = '__autoAcceptBgStyles';

    const OVERLAY_STYLES = `
        #__autoAcceptBgOverlay {
            position: fixed;
            background: rgba(0, 0, 0, 0.97);
            z-index: 2147483647;
            font-family: system-ui, -apple-system, sans-serif;
            color: #fff;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.3s ease;
            overflow: hidden;
        }
        #__autoAcceptBgOverlay.visible { opacity: 1; }

        .aab-container {
            width: 90%;
            max-width: 420px;
            padding: 24px;
        }

        .aab-slot {
            margin-bottom: 16px;
            padding: 12px 16px;
            background: rgba(255, 255, 255, 0.03);
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .aab-header {
            display: flex;
            align-items: center;
            margin-bottom: 8px;
            gap: 10px;
        }

        .aab-name {
            flex: 1;
            font-size: 13px;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: #e0e0e0;
        }

        .aab-status {
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            padding: 3px 8px;
            border-radius: 4px;
        }

        .aab-slot.in-progress .aab-status {
            color: #a855f7;
            background: rgba(168, 85, 247, 0.15);
        }

        .aab-slot.completed .aab-status {
            color: #22c55e;
            background: rgba(34, 197, 94, 0.15);
        }

        .aab-progress-track {
            height: 4px;
            background: rgba(255, 255, 255, 0.08);
            border-radius: 2px;
            overflow: hidden;
        }

        .aab-progress-fill {
            height: 100%;
            border-radius: 2px;
            transition: width 0.4s ease, background 0.3s ease;
        }

        .aab-slot.in-progress .aab-progress-fill {
            width: 60%;
            background: linear-gradient(90deg, #a855f7, #8b5cf6);
            animation: pulse-progress 1.5s ease-in-out infinite;
        }

        .aab-slot.completed .aab-progress-fill {
            width: 100%;
            background: linear-gradient(90deg, #22c55e, #16a34a);
        }

        @keyframes pulse-progress {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }
    `;

    // --- Tab name utilities (from background_mode.js) ---

    const stripTimeSuffix = (text) => {
        return (text || '').trim().replace(/\s*\d+[smh]$/, '').trim();
    };

    const deduplicateNames = (names) => {
        const counts = {};
        return names.map(name => {
            if (counts[name] === undefined) {
                counts[name] = 1;
                return name;
            } else {
                counts[name]++;
                return `${name} (${counts[name]})`;
            }
        });
    };

    const updateTabNames = (tabs) => {
        const rawNames = Array.from(tabs).map((tab) => {
            const fullText = tab.textContent.trim();
            const lines = fullText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            if (lines.length > 0) {
                const lastLine = lines[lines.length - 1];
                if (lastLine.length > 0 && lastLine.length < 100) {
                    return stripTimeSuffix(lastLine);
                }
                for (let i = lines.length - 1; i >= 0; i--) {
                    const line = lines[i];
                    if (line.length > 0 && line.length < 100 && !line.startsWith('//') && !line.startsWith('/*') && !line.includes('{')) {
                        return stripTimeSuffix(line);
                    }
                }
            }

            return stripTimeSuffix(fullText.substring(0, 50));
        });
        const tabNames = deduplicateNames(rawNames);

        if (tabNames.length === 0 && window.__autoAcceptState?.tabNames?.length > 0) {
            return;
        }

        const tabNamesChanged = JSON.stringify(window.__autoAcceptState?.tabNames) !== JSON.stringify(tabNames);

        if (tabNamesChanged) {
            log(`[Tabs] Detected ${tabNames.length} tabs: ${tabNames.join(', ')}`);
            if (window.__autoAcceptState) {
                window.__autoAcceptState.tabNames = tabNames;
            }
        }

        if (tabNames.length >= 3) {
            const container = document.getElementById(OVERLAY_ID + '-c');
            const needsLoad = tabNamesChanged || (container && container.children.length === 0);
            if (needsLoad) {
                loadTabsOntoOverlay(tabNames);
            }
        }
    };

    // --- Overlay functions (from background_mode.js) ---

    function mountOverlay() {
        if (document.getElementById(OVERLAY_ID)) {
            log('[Overlay] Already mounted');
            return;
        }

        log('[Overlay] Mounting overlay...');

        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = OVERLAY_STYLES;
            document.head.appendChild(style);
        }

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;

        const container = document.createElement('div');
        container.className = 'aab-container';
        container.id = OVERLAY_ID + '-c';

        overlay.appendChild(container);
        document.body.appendChild(overlay);

        const panelSelectors = [
            '#antigravity\\.agentPanel',
            '#workbench\\.parts\\.auxiliarybar',
            '.auxiliary-bar-container',
            '#workbench\\.parts\\.sidebar'
        ];

        let panel = null;
        for (const selector of panelSelectors) {
            const found = queryAll(selector).find(p => p.offsetWidth > 50);
            if (found) {
                panel = found;
                log(`[Overlay] Found AI panel: ${selector}`);
                break;
            }
        }

        const syncPosition = () => {
            if (panel) {
                const rect = panel.getBoundingClientRect();
                overlay.style.top = rect.top + 'px';
                overlay.style.left = rect.left + 'px';
                overlay.style.width = rect.width + 'px';
                overlay.style.height = rect.height + 'px';
            } else {
                overlay.style.top = '0';
                overlay.style.left = '0';
                overlay.style.width = '100%';
                overlay.style.height = '100%';
            }
        };

        syncPosition();

        if (panel) {
            const resizeObserver = new ResizeObserver(syncPosition);
            resizeObserver.observe(panel);
            overlay._resizeObserver = resizeObserver;
        }

        requestAnimationFrame(() => overlay.classList.add('visible'));
        log('[Overlay] Overlay mounted');
    }

    function dismountOverlay() {
        const overlay = document.getElementById(OVERLAY_ID);
        if (!overlay) return;

        log('[Overlay] Dismounting overlay...');
        if (overlay._resizeObserver) {
            overlay._resizeObserver.disconnect();
        }
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 300);
    }

    function loadTabsOntoOverlay(tabNames) {
        const container = document.getElementById(OVERLAY_ID + '-c');
        if (!container || !tabNames || tabNames.length === 0) return;

        log(`[Overlay] Loading ${tabNames.length} tabs onto overlay`);

        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }

        const completionStatus = window.__autoAcceptState?.completionStatus || {};

        tabNames.forEach(name => {
            const isCompleted = completionStatus[name] === 'done' || completionStatus[name] === 'done-errors';
            const stateClass = isCompleted ? 'completed' : 'in-progress';
            const statusText = isCompleted ? 'COMPLETED' : 'IN PROGRESS';

            const slot = document.createElement('div');
            slot.className = `aab-slot ${stateClass}`;
            slot.setAttribute('data-name', name);

            const header = document.createElement('div');
            header.className = 'aab-header';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'aab-name';
            nameSpan.textContent = name;
            header.appendChild(nameSpan);

            const statusSpan = document.createElement('span');
            statusSpan.className = 'aab-status';
            statusSpan.textContent = statusText;
            header.appendChild(statusSpan);

            slot.appendChild(header);

            const track = document.createElement('div');
            track.className = 'aab-progress-track';
            const fill = document.createElement('div');
            fill.className = 'aab-progress-fill';
            track.appendChild(fill);
            slot.appendChild(track);

            container.appendChild(slot);
        });
    }

    function markTabCompleted(tabName) {
        const container = document.getElementById(OVERLAY_ID + '-c');
        if (!container) return;

        const slots = container.querySelectorAll('.aab-slot');
        for (const slot of slots) {
            if (slot.getAttribute('data-name') === tabName) {
                if (!slot.classList.contains('completed')) {
                    log(`[Overlay] Marking "${tabName}" as completed`);
                    slot.classList.remove('in-progress');
                    slot.classList.add('completed');
                    const statusSpan = slot.querySelector('.aab-status');
                    if (statusSpan) statusSpan.textContent = 'COMPLETED';
                }
                break;
            }
        }
    }

    // --- Compilation error detection (from background_mode.js) ---

    function hasCompilationErrors() {
        const errorBadges = queryAll('.codicon-error, .codicon-warning, [class*="marker-count"]');
        for (const badge of errorBadges) {
            const text = (badge.textContent || '').trim();
            const num = parseInt(text, 10);
            if (!isNaN(num) && num > 0) return true;
        }

        const errorDecorations = queryAll('.squiggly-error, .monaco-editor .squiggly-error');
        if (errorDecorations.length > 0) return true;

        return false;
    }

    // --- Completion state tracking (from background_mode.js) ---

    const updateConversationCompletionState = (rawTabName, status) => {
        const tabName = stripTimeSuffix(rawTabName);
        const current = window.__autoAcceptState?.completionStatus?.[tabName];
        if (current !== status) {
            log(`[State] ${tabName}: ${current} -> ${status}`);
            if (window.__autoAcceptState) {
                window.__autoAcceptState.completionStatus[tabName] = status;
            }
        }
    };

    // =================================================================
    // BACKGROUND MODE: TAB CYCLING LOOPS (from background_mode.js)
    // ONLY tab switching + overlay updating. NO button clicking.
    // Button clicking is handled by the simple poll interval above.
    // =================================================================

    const CURSOR_TAB_SELECTORS = [
        '#workbench\\.parts\\.auxiliarybar ul[role="tablist"] li[role="tab"]',
        '.monaco-pane-view .monaco-list-row[role="listitem"]',
        'div[role="tablist"] div[role="tab"]',
        '.chat-session-item'
    ];

    const ANTIGRAVITY_TAB_SELECTOR = 'button.grow';
    const NEW_CONVERSATION_SELECTOR = "[data-tooltip-id='new-conversation-tooltip']";

    // Helper: check if this loop session is still active
    function isSessionActive(state, sessionID) {
        return state.isRunning && state.sessionID === sessionID;
    }

    async function cursorTabLoop(sessionID) {
        log('[TabLoop] Cursor tab cycling started');
        let index = 0;
        let cycle = 0;
        const state = window.__autoAcceptState;
        state._noTabCycles = 0;

        while (isSessionActive(state, sessionID)) {
            cycle++;

            // Find tabs (try multiple selectors)
            let tabs = [];
            for (const selector of CURSOR_TAB_SELECTORS) {
                tabs = queryAll(selector);
                if (tabs.length > 0) break;
            }

            if (tabs.length === 0) {
                state._noTabCycles++;
            } else {
                state._noTabCycles = 0;
            }

            // Update tab names on overlay
            updateTabNames(tabs);

            // Click next tab in rotation
            if (tabs.length > 0) {
                const targetTab = tabs[index % tabs.length];
                const tabLabel = targetTab.getAttribute('aria-label') || targetTab.textContent?.trim() || 'unnamed';
                log(`[TabLoop] Cycle ${cycle}: Switching to tab "${tabLabel.substring(0, 40)}"`);
                targetTab.dispatchEvent(new MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true
                }));
                index++;
            }

            // Wait 3s before next cycle (let tab content load, let clicking loop work)
            await new Promise(r => setTimeout(r, 3000));
        }

        log('[TabLoop] Cursor tab cycling stopped');
    }

    async function antigravityTabLoop(sessionID) {
        log('[TabLoop] Antigravity tab cycling started');
        let index = 0;
        let cycle = 0;
        const state = window.__autoAcceptState;
        state._noTabCycles = 0;

        while (isSessionActive(state, sessionID)) {
            cycle++;

            // Check for completion badges (Good/Bad) on current tab
            const allSpans = queryAll('span');
            const feedbackBadges = allSpans.filter(s => {
                const t = s.textContent.trim();
                return t === 'Good' || t === 'Bad';
            });
            log(`[TabLoop] Cycle ${cycle}: ${feedbackBadges.length} badges on current tab`);

            // Step 1: Click "New Conversation" button to show tabs panel
            const nt = queryAll(NEW_CONVERSATION_SELECTOR)[0];
            if (nt) nt.click();

            // Step 2: Wait 1500ms for panel to appear (critical timing from v9.0.0)
            await new Promise(r => setTimeout(r, 1500));
            if (!isSessionActive(state, sessionID)) break;

            // Step 3: Find tabs
            const tabs = queryAll(ANTIGRAVITY_TAB_SELECTOR);

            if (tabs.length === 0) {
                state._noTabCycles++;
                log(`[TabLoop] Cycle ${cycle}: No tabs found (consecutive: ${state._noTabCycles})`);
            } else {
                state._noTabCycles = 0;
            }

            // Update tab names on overlay
            updateTabNames(tabs);

            // Step 4: Click next tab in rotation
            let clickedTabName = null;
            if (tabs.length > 0) {
                const targetTab = tabs[index % tabs.length];
                clickedTabName = stripTimeSuffix(targetTab.textContent);
                log(`[TabLoop] Cycle ${cycle}: Switching to tab "${clickedTabName}"`);
                targetTab.dispatchEvent(new MouseEvent('click', {
                    view: window,
                    bubbles: true,
                    cancelable: true
                }));
                index++;
            }

            // Step 5: Wait 1500ms for tab content to load
            await new Promise(r => setTimeout(r, 1500));
            if (!isSessionActive(state, sessionID)) break;

            // Step 6: Check for completion badges AFTER tab switch
            const allSpansAfter = queryAll('span');
            const feedbackTexts = allSpansAfter
                .filter(s => {
                    const t = s.textContent.trim();
                    return t === 'Good' || t === 'Bad';
                })
                .map(s => s.textContent.trim());

            // Update completion status on overlay
            if (clickedTabName && feedbackTexts.length > 0) {
                const hasErrors = hasCompilationErrors();
                const finalStatus = hasErrors ? 'done-errors' : 'done';
                updateConversationCompletionState(clickedTabName, finalStatus);

                const deduplicatedNames = state.tabNames || [];
                const currentIndex = (index - 1) % deduplicatedNames.length;
                const deduplicatedName = deduplicatedNames[currentIndex];
                if (deduplicatedName) {
                    markTabCompleted(deduplicatedName);
                }

                if (hasErrors) {
                    log(`[TabLoop] Cycle ${cycle}: Tab "${clickedTabName}" completed WITH errors`);
                }
            }

            log(`[TabLoop] Cycle ${cycle}: ${state.tabNames?.length || 0} tabs, completions: ${JSON.stringify(state.completionStatus)}`);

            // Step 7: Wait 3s before next cycle (let clicking loop work on new tab)
            await new Promise(r => setTimeout(r, 3000));
        }

        log('[TabLoop] Antigravity tab cycling stopped');
    }

    // =================================================================
    // STATE & PUBLIC API
    // =================================================================

    if (!window.__autoAcceptState) {
        window.__autoAcceptState = {
            isRunning: false,
            sessionID: 0,
            clicks: 0,
            clickInterval: null,
            mode: null,
            ide: null,
            // Background mode fields (from background_mode.js)
            tabNames: [],
            completionStatus: {},
            _noTabCycles: 0
        };
    }

    window.__autoAcceptGetStats = function () {
        return { clicks: window.__autoAcceptState.clicks || 0 };
    };

    window.__autoAcceptStart = function (config) {
        const state = window.__autoAcceptState;

        // Stop if already running
        if (state.isRunning) {
            log('Already running, stopping first...');
            window.__autoAcceptStop();
        }

        state.isRunning = true;
        state.sessionID++;
        state.mode = config.isBackgroundMode ? 'background' : 'simple';
        state.ide = (config.ide || 'cursor').toLowerCase();
        state.tabNames = [];
        state.completionStatus = {};
        state._noTabCycles = 0;

        log(`Starting ${state.mode} mode for ${state.ide}...`);

        // ALWAYS start clicking loop - use configured frequency (default 1000ms)
        const freq = config.pollFrequency || 1000;
        state.clickInterval = setInterval(() => {
            if (state.isRunning) {
                clickAcceptButtons();
            }
        }, freq);

        log(`Clicking loop started (${freq}ms interval)`);

        // ONLY start tab cycling + overlay if background mode enabled
        if (config.isBackgroundMode) {
            // Mount overlay immediately
            mountOverlay();

            // Start tab cycling loop after 1s delay
            // (let clicking loop stabilize first)
            const sessionID = state.sessionID;
            setTimeout(() => {
                if (state.isRunning && state.sessionID === sessionID) {
                    if (state.ide === 'cursor') {
                        cursorTabLoop(sessionID);
                    } else {
                        antigravityTabLoop(sessionID);
                    }
                }
            }, 1000);

            log('Background mode: overlay mounted, tab cycling starting in 1s');
        }

        log('Active!');
    };

    window.__autoAcceptStop = function () {
        const state = window.__autoAcceptState;
        state.isRunning = false;

        if (state.clickInterval) {
            clearInterval(state.clickInterval);
            state.clickInterval = null;
        }

        // Dismount overlay if it was mounted (safe to call even if no overlay)
        dismountOverlay();

        log('Stopped');
    };

    // Compatibility placeholders for cdp-handler.js
    window.__autoAcceptSetFocusState = function () { };
    window.__autoAcceptUpdateBannedCommands = function (commands) {
        _bannedCommands = Array.isArray(commands) ? commands : [];
        log(`[Safety] Banned commands updated: ${_bannedCommands.length} patterns`);
    };

    log('Ready');
})();
