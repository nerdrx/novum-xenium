"""Exercise Compare search rerolls through their real pane handlers."""

import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest


_REPO = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(not shutil.which("node"), reason="node binary not on PATH")
def test_old_search_reroll_cleanup_preserves_new_controller():
    script = textwrap.dedent(r"""
        import fs from 'node:fs';
        import assert from 'node:assert/strict';

        const source = fs.readFileSync('static/js/compare/panes.js', 'utf8');
        const start = source.indexOf('function stopPane(paneIdx) {');
        const end = source.indexOf('// ── Expand / preview / copy ──', start);
        assert.ok(start >= 0 && end > start, 'pane handlers found');

        class El {
          constructor(text = '') {
            this.children = []; this.style = {}; this.textContent = text;
            this.scrollTop = 0; this.classList = { remove() {} };
          }
          set innerHTML(value) {
            this._html = String(value);
            if (this._html.includes('class="body"')) this.body = new El();
          }
          get innerHTML() { return this._html || ''; }
          appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
          querySelector(selector) {
            if (selector === '.body') return this.body || null;
            if (selector === '.pane-stop-btn') return this.stop || null;
            return null;
          }
          querySelectorAll(selector) {
            return selector === '.msg-user .body' ? [userBody] : [];
          }
        }

        const userBody = new El('search query');
        const history = new El();
        const pane = new El(); pane.stop = new El();
        pane.querySelector = selector => selector === '.pane-stop-btn' ? pane.stop : null;
        const state = {
          _abortControllers: [null], _compareMode: 'search',
          _paneSessionIds: ['sid'], _selectedModels: [{ model: 'provider' }],
          _blindMode: false, _timeout: 20, API_BASE: '',
        };
        const document = {
          getElementById(id) { return id === 'cmp-history-0' ? history : null; },
          createElement() { return new El(); },
          querySelector(selector) { return selector === '.compare-pane[data-pane="0"]' ? pane : null; },
          querySelectorAll() { return []; },
        };
        const requests = [];
        const fetch = (_url, options) => new Promise((resolve, reject) => {
          const request = { signal: options.signal, resolve, reject };
          requests.push(request);
          options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
        const spinnerModule = { create() {
          const element = new El();
          return { element, createElement: () => element, start() {}, stop() {}, destroy() {} };
        } };
        const uiModule = { showToast() {} };
        const _renderSearchResults = () => new El();
        const _updateCheckBtnState = () => {};
        const _persistSelections = () => {};
        const _rerollPane = () => {};
        const _autoPreviewHtml = () => {};
        const _setSendBtn = () => {};
        const _syncCompareBusyFromPanes = () => {};
        const escapeHtml = value => String(value);
        const WAVE_FRAMES = [];
        new Function(
          'state', 'document', 'fetch', 'spinnerModule', 'uiModule', 'FormData',
          'performance', '_renderSearchResults', '_updateCheckBtnState',
          '_persistSelections', '_rerollPane', '_autoPreviewHtml', '_setSendBtn',
          '_syncCompareBusyFromPanes', 'escapeHtml', 'WAVE_FRAMES',
          `${source.slice(start, end)}; globalThis.rerollPane = rerollPane; globalThis.stopPane = stopPane;`,
        )(state, document, fetch, spinnerModule, uiModule, FormData, performance,
          _renderSearchResults, _updateCheckBtnState, _persistSelections,
          _rerollPane, _autoPreviewHtml, _setSendBtn, _syncCompareBusyFromPanes,
          escapeHtml, WAVE_FRAMES);

        const firstRun = globalThis.rerollPane(0, 40);
        const firstController = state._abortControllers[0];
        const secondRun = globalThis.rerollPane(0, 40);
        const secondController = state._abortControllers[0];
        assert.notEqual(secondController, firstController);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(requests.length, 2);
        assert.equal(firstController.signal.aborted, true);
        assert.equal(state._abortControllers[0], secondController,
          'aborted first reroll must not clear second reroll controller');

        globalThis.stopPane(0);
        assert.equal(secondController.signal.aborted, true,
          'Stop must still abort the active reroll');
        await Promise.allSettled([firstRun, secondRun]);
    """)
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=_REPO,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
