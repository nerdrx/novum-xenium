// ============================================
// Sidebar Layout — icon rail, hamburger cycling, mobile backdrop & swipe
// ============================================

let _syncRailSideFn = null;

/**
 * Get the current syncRailSide function reference.
 * Needed because it gets patched after initial setup.
 */
export function syncRailSide() {
  if (_syncRailSideFn) _syncRailSideFn();
}

/**
 * Initialize sidebar layout: icon rail, hamburger cycling, mobile backdrop, swipe gestures.
 * @param {Object} Storage - Storage module
 * @param {Object} opts
 * @param {Object} opts.documentModule - Document module (for swapSide)
 * @param {Function} opts._closeCompareIfActive
 * @param {Function} opts._deactivateIncognito
 * @param {Object} opts.presetsModule
 * @param {Object} opts.sessionModule
 * @param {Function} opts.el - Element lookup helper
 * @param {*} opts._defaultChat - Default chat config
 * @param {Function} opts._syncResearchIndicator
 */
export function initSidebarLayout(Storage, opts) {
  const {
    documentModule, _closeCompareIfActive, _deactivateIncognito,
    presetsModule, sessionModule, el, _defaultChat, _syncResearchIndicator
  } = opts;

  // ── Icon rail + sidebar toggle ──
  const iconRail = document.getElementById('icon-rail');
  const hamburgerBtn = document.getElementById('hamburger-btn');
  const SIDEBAR_MODE_KEY = 'odysseus-sidebar-mode';

  function _setSidebarModeClasses(mode) {
    document.documentElement.classList.remove('ody-mobile-startup-sidebar-hidden');
    document.documentElement.classList.toggle('ody-sidebar-mini', mode === 'mini');
    document.documentElement.classList.toggle('ody-sidebar-off', mode === 'off');
  }

  function _saveSidebarMode(mode) {
    try { localStorage.setItem(SIDEBAR_MODE_KEY, mode); } catch (_) {}
    _setSidebarModeClasses(mode);
  }

  function _applyStoredSidebarMode() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    if (window.innerWidth < 768 && document.getElementById('app-loader')) {
      sidebar.classList.add('hidden');
      if (iconRail) {
        iconRail.classList.add('rail-hidden');
        iconRail.classList.remove('mobile-mini');
        iconRail.style.cssText = '';
      }
      _setSidebarModeClasses('off');
      return;
    }
    let mode = 'full';
    try { mode = localStorage.getItem(SIDEBAR_MODE_KEY) || 'full'; } catch (_) {}
    if (mode === 'mini') {
      sidebar.classList.add('hidden');
      if (iconRail) iconRail.classList.remove('rail-hidden');
    } else if (mode === 'off') {
      sidebar.classList.add('hidden');
      if (iconRail) iconRail.classList.add('rail-hidden');
    } else {
      sidebar.classList.remove('hidden');
      if (iconRail) iconRail.classList.remove('rail-hidden');
    }
    _setSidebarModeClasses(mode);
  }

  function _syncRailSideCore() {
    const sidebar = document.getElementById('sidebar');
    if (!iconRail) return;
    const isRight = sidebar.classList.contains('right-side');
    const sidebarHidden = sidebar.classList.contains('hidden');
    const railHidden = iconRail.classList.contains('rail-hidden');
    const isMobileMini = iconRail.classList.contains('mobile-mini');
    iconRail.classList.toggle('right-side', isRight);
    // On mobile mini mode, JS already set inline styles — don't touch
    if (isMobileMini) {
      // Just update side positioning
      if (isRight) {
        iconRail.style.left = 'auto';
        iconRail.style.right = '0';
      } else {
        iconRail.style.left = '0';
        iconRail.style.right = 'auto';
      }
    } else {
      iconRail.style.display = (sidebarHidden && !railHidden) ? '' : 'none';
    }
    // Hamburger is always visible — just update body classes for CSS layout adjustments
    if (hamburgerBtn) {
      document.body.classList.toggle('hamburger-right', isRight);
      document.body.classList.toggle('hamburger-left', !isRight);
      document.body.classList.toggle('hamburger-only', sidebarHidden && railHidden);
      document.body.classList.toggle('sidebar-collapsed', sidebarHidden);
      _setSidebarModeClasses(!sidebarHidden ? 'full' : (railHidden ? 'off' : 'mini'));
    }
    // Keep incognito button clear of hamburger
    const incogBtn = document.getElementById('incognito-btn');
    if (incogBtn) {
      if (isRight && sidebarHidden) {
        incogBtn.style.right = '48px';
      } else {
        incogBtn.style.right = '';
      }
    }
  }

  // Set initial reference and expose globally
  _syncRailSideFn = _syncRailSideCore;
  window.syncRailSide = syncRailSide;

  // Restore sidebar side preference
  if (Storage.get(Storage.KEYS.SIDEBAR_SIDE) === 'right') {
    document.getElementById('sidebar').classList.add('right-side');
  }
  _applyStoredSidebarMode();
  syncRailSide();

  // In-sidebar toggle button — same behavior as hamburger
  const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', (e) => {
      if (hamburgerBtn) hamburgerBtn.click();
    });
  }

  // Header-only new-chat aliases. #sidebar-new-chat-btn is wired in app.js
  // because it needs the full default-model/pending-chat flow; wiring it here
  // as well caused duplicate click handling and occasional no-op/race behavior.
  const chatNewBtn = document.getElementById('chat-new-btn');
  [chatNewBtn].forEach(btn => {
    if (btn) btn.addEventListener('click', () => {
      const newChatBtn = document.getElementById('sidebar-new-chat-btn');
      if (newChatBtn) newChatBtn.click();
    });
  });

  // Hamburger cycles: full sidebar → mini → off → full
  let _userToggledSidebar = false;
  let _wasAutoCollapsed = false;
  let _wasMobileViewport = window.innerWidth < 768;

  function _restoreDesktopSidebarSide() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const wantRight = Storage.get(Storage.KEYS.SIDEBAR_SIDE) === 'right';
    const changed = sidebar.classList.contains('right-side') !== wantRight;
    sidebar.classList.toggle('right-side', wantRight);
    if (iconRail) {
      iconRail.classList.remove('mobile-mini');
      iconRail.style.cssText = '';
    }
    if (changed && documentModule && documentModule.swapSide) {
      try { documentModule.swapSide(); } catch (_) {}
    }
    syncRailSide();
  }

  if (hamburgerBtn) {
    hamburgerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sidebar = document.getElementById('sidebar');

      _userToggledSidebar = true;
      const isSidebarVisible = !sidebar.classList.contains('hidden');

      if (window.innerWidth < 768) {
        // Mobile: full sidebar ↔ hidden — simple toggle, no mini rail
        const backdrop = document.getElementById('sidebar-backdrop');
        if (iconRail) { iconRail.classList.remove('mobile-mini'); iconRail.style.cssText = ''; }

        if (isSidebarVisible) {
          // Closing sidebar
          sidebar.classList.add('hidden');
          _saveSidebarMode('off');
          if (backdrop) backdrop.classList.remove('visible');
        } else {
          // Mobile: the hamburger always opens the sidebar from the RIGHT.
          // (Not persisted — keeps the desktop side preference untouched.)
          if (!sidebar.classList.contains('right-side')) {
            sidebar.classList.add('right-side');
            if (documentModule && documentModule.swapSide) { try { documentModule.swapSide(); } catch (_) {} }
          }
          // Opening sidebar — blur keyboard first, then open after layout settles
          if (document.activeElement && document.activeElement !== document.body
              && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
            document.activeElement.blur();
            // Wait for keyboard dismiss to settle, then open
            setTimeout(() => {
              sidebar.classList.remove('hidden');
              _saveSidebarMode('full');
              if (backdrop) backdrop.classList.add('visible');
              syncRailSide();
            }, 250);
          } else {
            sidebar.classList.remove('hidden');
            _saveSidebarMode('full');
            if (backdrop) backdrop.classList.add('visible');
          }
        }
        syncRailSide();
        return;
      }

      // Desktop: full sidebar ↔ mini (icon rail) — simple toggle
      if (isSidebarVisible) {
        sidebar.classList.add('hidden');
        if (iconRail) iconRail.classList.remove('rail-hidden');
        _saveSidebarMode('mini');
      } else {
        _wasAutoCollapsed = false;
        iconRail.classList.remove('rail-hidden');
        sidebar.classList.remove('hidden');
        _saveSidebarMode('full');
      }
      syncRailSide();
    });
  }

  // Icon rail section clicks — open sidebar and scroll to section
  if (iconRail) {
    iconRail.addEventListener('click', (e) => {
      const btn = e.target.closest('.icon-rail-btn');
      if (!btn || btn.id === 'rail-new-session' || btn.id === 'rail-delete-session' || btn.id === 'rail-search-btn' || btn.id === 'rail-settings' || btn.id === 'rail-admin') return;
      const sectionId = btn.dataset.section;
      if (!sectionId) return;
      const sidebar = document.getElementById('sidebar');
      sidebar.classList.remove('hidden');
      syncRailSide();
      const section = document.getElementById(sectionId);
      if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        section.classList.remove('collapsed');
      }
    });
  }

  // Auto-collapse sidebar when window gets small or chat area is squeezed
  const AUTO_COLLAPSE_WIDTH = 700;
  const MIN_CHAT_WIDTH = 380; // collapse sidebar if chat gets narrower than this

  function checkSidebarAutoCollapse() {
    if (_userToggledSidebar) return;
    // Mobile uses a fixed overlay drawer.  Keyboard and orientation changes
    // emit resize events there, but should not run the desktop width-based
    // auto-collapse logic against an intentionally opened drawer.
    if (window.innerWidth < 768) return;
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const isHidden = sidebar.classList.contains('hidden');

    // Check if chat area is too narrow (e.g. sidebar + doc panel both open).
    // BUT — if a tile-snapped modal exists, IT is what's making chat narrow,
    // and that's the user's explicit choice. Don't auto-collapse the sidebar
    // in response, or we get a reactive loop: snap → narrow chat → hide
    // sidebar → safe-rect changes → reclamp modal → new chat width → ...
    const chatContainer = document.querySelector('.chat-container');
    const hasTileSnapped = document.querySelector('.modal-content[data-_tile-zone], .research-pane[data-_tile-zone]');
    const chatTooNarrow = chatContainer && chatContainer.offsetWidth < MIN_CHAT_WIDTH && !isHidden && !hasTileSnapped;

    if ((window.innerWidth < AUTO_COLLAPSE_WIDTH || chatTooNarrow) && !isHidden) {
      sidebar.classList.add('hidden');
      _wasAutoCollapsed = true;
      syncRailSide();
    } else if (window.innerWidth >= AUTO_COLLAPSE_WIDTH && isHidden && _wasAutoCollapsed) {
      // Only restore if chat won't be too narrow
      sidebar.classList.remove('hidden');
      void document.body.offsetWidth; // reflow
      if (chatContainer && chatContainer.offsetWidth < MIN_CHAT_WIDTH) {
        sidebar.classList.add('hidden');
      } else {
        _wasAutoCollapsed = false;
      }
      syncRailSide();
    }
  }

  window.addEventListener('resize', () => {
    const isMobileViewport = window.innerWidth < 768;
    if (_wasMobileViewport && !isMobileViewport) _restoreDesktopSidebarSide();
    _wasMobileViewport = isMobileViewport;
    if (!isMobileViewport) _userToggledSidebar = false; // allow auto-collapse on desktop resize
    requestAnimationFrame(checkSidebarAutoCollapse);
  });
  // Re-check when the document split is opened or closed. Do not react to
  // every body class mutation: floating tools (notably Research) add their
  // own view class, and re-evaluating a narrow document split there caused a
  // hide → restore → hide loop in the sidebar.
  let _lastDocView = document.body.classList.contains('doc-view');
  new MutationObserver(() => {
    const docView = document.body.classList.contains('doc-view');
    if (docView === _lastDocView) return;
    _lastDocView = docView;
    requestAnimationFrame(checkSidebarAutoCollapse);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // Auto-collapse on initial load if window is small
  if (window.innerWidth < AUTO_COLLAPSE_WIDTH) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('hidden')) {
      sidebar.classList.add('hidden');
      _wasAutoCollapsed = true;
      syncRailSide();
    }
  }

  // ── Mobile sidebar backdrop + swipe-to-close ──
  // Backdrop overlay: tapping it closes the sidebar
  const mobileBackdrop = document.createElement('div');
  mobileBackdrop.id = 'sidebar-backdrop';
  document.body.appendChild(mobileBackdrop);

  function updateMobileBackdrop() {
    if (window.innerWidth >= 768) { mobileBackdrop.classList.remove('visible'); return; }
    const sb = document.getElementById('sidebar');
    const rail = document.getElementById('icon-rail');
    const sidebarOpen = sb && !sb.classList.contains('hidden');
    const miniOpen = rail && rail.classList.contains('mobile-mini');
    mobileBackdrop.classList.toggle('visible', sidebarOpen || miniOpen);
  }

  // Suppress sidebar close briefly after dropdown actions
  window._suppressSidebarClose = false;
  mobileBackdrop.addEventListener('click', (e) => {
    if (window._suppressSidebarClose) return;
    // Don't close while a session is being renamed inline — the rename input
    // lives inside the sidebar, and a backdrop tap (e.g. to dismiss the
    // keyboard) would otherwise kick the user out mid-rename.
    if (document.querySelector('.session-rename-input')) return;
    // Don't close if a dropdown or submenu is visible
    const openDD = document.querySelector('.session-dropdown-menu[style*="display: block"], .session-dropdown-menu[style*="display:block"]');
    const openSub = document.querySelector('.session-folder-submenu[style*="display: block"], .session-folder-submenu[style*="display:block"]');
    if (openDD || openSub) {
      if (openSub) openSub.style.display = 'none';
      if (openDD) openDD.style.display = 'none';
      return;
    }
    const sb = document.getElementById('sidebar');
    if (sb && !sb.classList.contains('hidden')) {
      sb.classList.add('hidden');
    }
    mobileBackdrop.classList.remove('visible');
    syncRailSide();
  });

  // Patch syncRailSide to also update backdrop
  const _origSyncRailSideCore = _syncRailSideCore;
  _syncRailSideFn = function() { _origSyncRailSideCore(); updateMobileBackdrop(); };
  window.syncRailSide = syncRailSide;

  // Swipe sidebar toward edge to close
  const sidebar = document.getElementById('sidebar');
  if (sidebar && 'ontouchstart' in window) {
    let _swStartX = 0, _swStartY = 0, _swSwiping = false;
    sidebar.addEventListener('touchstart', (e) => {
      if (e.target.closest('.list-item')) { _swSwiping = false; return; }
      _swStartX = e.touches[0].clientX;
      _swStartY = e.touches[0].clientY;
      _swSwiping = true;
    }, { passive: true });
    sidebar.addEventListener('touchmove', (e) => {
      if (!_swSwiping) return;
      const dx = e.touches[0].clientX - _swStartX;
      const dy = Math.abs(e.touches[0].clientY - _swStartY);
      if (dy > 40) { _swSwiping = false; return; }
      const isRight = sidebar.classList.contains('right-side');
      if ((!isRight && dx < -60) || (isRight && dx > 60)) {
        _swSwiping = false;
        const _backdrop = document.getElementById('sidebar-backdrop');
        if (_backdrop) _backdrop.classList.remove('visible');
        sidebar.classList.add('hidden');
        syncRailSide();
      }
    }, { passive: true });
    sidebar.addEventListener('touchend', () => { _swSwiping = false; }, { passive: true });
  }

  // ── Click outside sidebar / icon rail to close (mobile only) ──
  document.addEventListener('click', (e) => {
    if (window.innerWidth >= 700) return; // desktop keeps sidebar open
    const sb = document.getElementById('sidebar');
    const rail = document.getElementById('icon-rail');
    // Ignore clicks on elements removed from DOM (e.g. session list re-render during folder toggle)
    if (!e.target.isConnected) return;
    // Ignore clicks on the sidebar, icon rail, or hamburger button itself
    if (e.target.closest('#sidebar') || e.target.closest('#icon-rail') || e.target.closest('#hamburger-btn')) return;
    // Ignore clicks inside modals or the chat input area
    if (e.target.closest('.modal') || e.target.closest('.input-bar') || e.target.closest('#message')) return;
    // Ignore clicks on session/folder dropdowns and the styled prompt
    // overlay — they're body-level elements logically tied to a sidebar
    // action (e.g. "Move to folder → New Folder…"), so closing the
    // sidebar when the user clicks one yanks the action mid-flight.
    if (e.target.closest('.session-dropdown, .folder-submenu, #styled-prompt-overlay, #styled-confirm-overlay')) return;
    // Close full sidebar if open (with animation)
    if (sb && !sb.classList.contains('hidden')) {
      const backdrop = document.getElementById('sidebar-backdrop');
      if (backdrop) backdrop.classList.remove('visible');
      sb.classList.add('hidden');
      syncRailSide();
      return;
    }
    // Close mobile-mini icon rail overlay if open
    if (rail && rail.classList.contains('mobile-mini')) {
      rail.classList.remove('mobile-mini');
      rail.style.cssText = '';
      const backdrop = document.getElementById('sidebar-backdrop');
      if (backdrop) backdrop.classList.remove('visible');
      syncRailSide();
    }
  });

  // ── Mobile: close sidebar/rail when a tool button is tapped ──
  // The user expects the sidebar to get out of the way the moment a tool
  // window opens — otherwise the modal lands behind the sidebar on phones.
  // We remember whether the sidebar was open at the moment the tool was
  // tapped so we can re-open it when the tool's modal is dismissed; that
  // way clicking around the app doesn't leave the sidebar permanently
  // shut.
  let _sidebarWasOpenBeforeTool = false;
  let _railWasOpenBeforeTool = false;
  document.addEventListener('click', (e) => {
    if (window.innerWidth >= 700) return;
    const btn = e.target.closest('[id^="tool-"], [id^="rail-"]');
    if (!btn) return;
    setTimeout(() => {
      const sb = document.getElementById('sidebar');
      const rail = document.getElementById('icon-rail');
      const backdrop = document.getElementById('sidebar-backdrop');
      let changed = false;
      if (sb && !sb.classList.contains('hidden')) {
        _sidebarWasOpenBeforeTool = true;
        sb.classList.add('hidden');
        changed = true;
      }
      if (rail && rail.classList.contains('mobile-mini')) {
        _railWasOpenBeforeTool = true;
        rail.classList.remove('mobile-mini');
        rail.style.cssText = '';
        changed = true;
      }
      if (changed) {
        if (backdrop) backdrop.classList.remove('visible');
        syncRailSide();
      }
    }, 0);
  });

  // When a tool is dismissed by swiping it down (ui.js fires `modal-dismissed`),
  // don't bounce the sidebar back open — the swipe should just dismiss the tool.
  // Button-close still restores the prior sidebar state (no event fired there).
  window.addEventListener('modal-dismissed', () => {
    _sidebarWasOpenBeforeTool = false;
    _railWasOpenBeforeTool = false;
  });

  // ── Mobile: when a tool modal closes, restore the sidebar/rail to
  // whatever state it was in before the tool was opened. ──
  // We watch every .modal for the .hidden class going on, and if our
  // remembered "sidebar-was-open" flag is set, undo the auto-close.
  if (window.innerWidth < 700) {
    const _restoreSidebar = () => {
      const sb = document.getElementById('sidebar');
      const rail = document.getElementById('icon-rail');
      const backdrop = document.getElementById('sidebar-backdrop');
      // Skip if any modal is still visible (.modal without .hidden) — we only
      // restore once the user is back to bare chat. A tool swiped DOWN to a
      // dock chip is minimized (display:none via .modal-minimized), not closed
      // — it's still "around", so don't bounce the sidebar open behind it. Only
      // a full close (no minimized modal, no dock chips) should restore.
      const anyOpen = [...document.querySelectorAll('.modal')]
        .some(m => (!m.classList.contains('hidden') && getComputedStyle(m).display !== 'none')
                   || m.classList.contains('modal-minimized'));
      const anyDocked = document.querySelectorAll('.minimized-dock-chip').length > 0;
      if (anyOpen || anyDocked) {
        // A tool is still minimized/docked. The user has left the "launched
        // from the sidebar" context — drop the restore intent so that later
        // FULLY closing the tool (e.g. dragging its chip to the trash) doesn't
        // bounce the sidebar open. (The modal-dismissed listener that normally
        // clears these gets blocked by modalManager's stopImmediatePropagation.)
        _sidebarWasOpenBeforeTool = false;
        _railWasOpenBeforeTool = false;
        return;
      }
      if (_sidebarWasOpenBeforeTool && sb && sb.classList.contains('hidden')) {
        sb.classList.remove('hidden');
        if (backdrop) backdrop.classList.add('visible');
      }
      if (_railWasOpenBeforeTool && rail && !rail.classList.contains('mobile-mini')) {
        rail.classList.add('mobile-mini');
      }
      _sidebarWasOpenBeforeTool = false;
      _railWasOpenBeforeTool = false;
      if (_sidebarWasOpenBeforeTool || _railWasOpenBeforeTool) syncRailSide();
    };
    const _modalObs = new MutationObserver((muts) => {
      let triggered = false;
      for (const m of muts) {
        if (m.type !== 'attributes' || m.attributeName !== 'class') continue;
        const t = m.target;
        if (!(t instanceof HTMLElement) || !t.classList) continue;
        if (t.classList.contains('modal')) { triggered = true; break; }
      }
      if (triggered) setTimeout(_restoreSidebar, 50);
    });
    _modalObs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

}
