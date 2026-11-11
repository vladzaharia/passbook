(() => {
  const announce = (message) => {
    const node = document.querySelector('[data-announcer]');
    if (node) node.textContent = message;
  };
  const passTemplates = new Map(
    Array.from(document.querySelectorAll('template[data-pass-template]'), (template) => [
      template.dataset.passTemplate,
      template,
    ]),
  );
  document.querySelectorAll('[data-pass-mount]').forEach((mount) => {
    const template = passTemplates.get(mount.dataset.passMount);
    if (!template) return;
    const fragment = template.content.cloneNode(true);
    const values = {
      member: mount.dataset.member || 'Alex Morgan',
      tier: mount.dataset.tier || 'Gold',
      expiry: mount.dataset.expiry || '30 June 2027',
      points: mount.dataset.points || '1,200',
      memberId: mount.dataset.memberId || 'HBR-1042',
    };
    fragment.querySelectorAll('.pc-field[data-fk]').forEach((field) => {
      const value = values[field.dataset.fk];
      if (value === undefined) return;
      field.querySelector('.pc-value')?.replaceChildren(value);
      field.toggleAttribute('data-mid', value.length > 8);
      field.toggleAttribute('data-long', value.length > 12);
    });
    const backValues = {
      Member: values.member,
      Tier: values.tier,
      'Valid through': values.expiry,
      'Member ID': values.memberId,
    };
    fragment.querySelectorAll('.pc-item').forEach((item) => {
      const label = item.querySelector('.pc-label')?.textContent.trim();
      const value = label ? backValues[label] : undefined;
      if (value !== undefined) item.querySelector('.pc-value')?.replaceChildren(value);
    });
    const caption = fragment.querySelector('.pc-barcode-caption > span:not(.pc-sr)');
    if (caption) caption.textContent = values.memberId;
    mount.append(fragment);
  });


  const showView = (view) => {
    const viewArea = {
      delivery: 'passes',
      'pass-issue': 'passes',
      directory: 'organizations',
      workspace: 'organizations',
      people: 'users',
      'service-access': 'api-keys',
    }[view];
    document.querySelectorAll('[data-view]').forEach((button) => {
      if (button.tagName === 'BUTTON') {
        const active = button.dataset.view === view || (viewArea && button.dataset.navArea === viewArea);
        button.setAttribute('aria-current', active ? 'page' : 'false');
      }
    });
    document.querySelectorAll('[data-view-select]').forEach((select) => {
      if ([...select.options].some((option) => option.value === view)) select.value = view;
    });
    document.querySelectorAll('[data-screen]').forEach((screen) => {
      screen.hidden = screen.dataset.screen !== view;
      if (!screen.hidden) {
        screen.classList.remove('view-enter');
        void screen.offsetWidth;
        screen.classList.add('view-enter');
      }
    });
    const activeScreen = document.querySelector(`[data-screen="${view}"]`);
    const scope = document.querySelector('[data-context-scope]');
    const role = document.querySelector('[data-context-role]');
    const mode = document.querySelector('[data-context-mode]');
    if (scope && activeScreen?.dataset.scopeContext) scope.textContent = activeScreen.dataset.scopeContext;
    if (role && activeScreen?.dataset.roleContext) role.textContent = activeScreen.dataset.roleContext;
    if (mode) {
      mode.hidden = !activeScreen?.dataset.modeContext;
      if (activeScreen?.dataset.modeContext) mode.textContent = activeScreen.dataset.modeContext;
    }
    document.body.dataset.view = view;
    const portalChrome = document.querySelector('.topbar [data-shell="portal"]');
    const workChrome = document.querySelector('.topbar [data-shell="work"]');
    if (portalChrome) portalChrome.hidden = view !== 'wallet';
    if (workChrome) workChrome.hidden = view === 'wallet' || view === 'result';
    window.scrollTo(0, 0);
    const title = document.querySelector(`[data-screen="${view}"] h1`);
    announce(title ? `Showing ${title.textContent}` : 'Mockup screen changed');
  };
  const requestedView = location.hash.slice(1);
  const deepLinkedScreen = [...document.querySelectorAll('[data-screen]')].find(
    (screen) => screen.dataset.screen === requestedView,
  );
  if (deepLinkedScreen) showView(deepLinkedScreen.dataset.screen);
  else document.body.dataset.view = document.querySelector('[data-screen]:not([hidden])')?.dataset.screen || '';
  let modeSetId = 0;
  document.querySelectorAll('[data-mode-set]').forEach((container) => {
    const owns = (element) => element.closest('[data-mode-set]') === container;
    const panels = [...container.querySelectorAll('[data-mode-panel]')].filter(owns);
    const groups = [...container.querySelectorAll('[role="tablist"], [role="group"]')].filter(owns);

    groups.forEach((group, groupIndex) => {
      const buttons = [...group.querySelectorAll('[data-mode]')].filter(
        (button) =>
          button.closest('[role="tablist"], [role="group"]') === group && owns(button),
      );
      if (!buttons.length) return;

      const isTablist = group.getAttribute('role') === 'tablist';
      const active =
        buttons.find(
          (button) =>
            button.getAttribute(isTablist ? 'aria-selected' : 'aria-pressed') === 'true',
        ) || buttons[0];
      const complete = buttons.every((button) =>
        panels.some((panel) => panel.dataset.modePanel === button.dataset.mode),
      );
      const useTabs = isTablist && complete;
      if (isTablist && !complete) group.setAttribute('role', 'group');

      if (useTabs) {
        const idBase = `${container.id || `mode-set-${++modeSetId}`}-${groupIndex + 1}`;
        buttons.forEach((button, index) => {
          const matchingPanels = panels.filter(
            (panel) => panel.dataset.modePanel === button.dataset.mode,
          );
          button.id ||= `${idBase}-tab-${index + 1}`;
          const panelIds = matchingPanels.map((panel, panelIndex) => {
            panel.id ||= `${idBase}-panel-${index + 1}-${panelIndex + 1}`;
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', button.id);
            if (!panel.hasAttribute('tabindex')) panel.tabIndex = 0;
            return panel.id;
          });
          button.setAttribute('role', 'tab');
          button.setAttribute('aria-controls', panelIds.join(' '));
          button.setAttribute('aria-selected', String(button === active));
          button.tabIndex = button === active ? 0 : -1;
        });
      } else {
        buttons.forEach((button) => {
          button.removeAttribute('role');
          button.removeAttribute('aria-selected');
          button.removeAttribute('tabindex');
          button.setAttribute('aria-pressed', String(button === active));
        });
      }

      const modes = new Set(buttons.map((button) => button.dataset.mode));
      panels
        .filter((panel) => modes.has(panel.dataset.modePanel))
        .forEach((panel) => {
          const button = buttons.find((item) => item.dataset.mode === panel.dataset.modePanel);
          if (useTabs) {
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', button.id);
            if (!panel.hasAttribute('tabindex')) panel.tabIndex = 0;
          }
          panel.hidden = panel.dataset.modePanel !== active.dataset.mode;
        });
    });

    container.querySelectorAll('[data-mode]').forEach((button) => {
      if (!owns(button) || button.closest('[role="tablist"], [role="group"]')) return;
      button.removeAttribute('role');
      button.removeAttribute('aria-selected');
      button.removeAttribute('aria-pressed');
      button.removeAttribute('tabindex');
    });
  });

  document.addEventListener('keydown', (event) => {
    const current = event.target.closest?.('[role="tab"]');
    if (!current) return;
    const tablist = current.closest('[role="tablist"]');
    if (!tablist) return;
    const tabs = [...tablist.querySelectorAll('[role="tab"]')].filter(
      (tab) => tab.closest('[role="tablist"]') === tablist,
    );
    const currentIndex = tabs.indexOf(current);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : event.key === 'ArrowRight' || event.key === 'ArrowDown'
            ? (currentIndex + 1) % tabs.length
            : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
              ? (currentIndex - 1 + tabs.length) % tabs.length
              : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  });




  document.addEventListener('click', (event) => {
    const target = event.target.closest('button, a');
    if (!target) return;

    if (target.dataset.view) {
      showView(target.dataset.view);
      return;
    }

    if (target.dataset.mode) {
      const mode = target.dataset.mode;
      const container = target.closest('[data-mode-set]');
      if (!container) return;
      const group = target.closest('[role="tablist"], [role="group"]');
      const tablist =
        group?.getAttribute('role') === 'tablist'
          ? group
          : [...container.querySelectorAll('[data-mode]')]
              .find(
                (button) =>
                  button.closest('[data-mode-set]') === container &&
                  button.dataset.mode === mode &&
                  button.getAttribute('role') === 'tab',
              )
              ?.closest('[role="tablist"]');
      const selectionGroup = tablist || group;
      if (selectionGroup) {
        [...selectionGroup.querySelectorAll('[data-mode]')]
          .filter(
            (button) =>
              button.closest('[role="tablist"], [role="group"]') === selectionGroup &&
              button.closest('[data-mode-set]') === container,
          )
          .forEach((button) => {
            const selected = button.dataset.mode === mode;
            if (button.getAttribute('role') === 'tab') {
              button.setAttribute('aria-selected', String(selected));
              button.tabIndex = selected ? 0 : -1;
            } else if (selectionGroup.getAttribute('role') === 'group') {
              button.setAttribute('aria-pressed', String(selected));
            }
          });
      }
      container.querySelectorAll('[data-mode-panel]').forEach((panel) => {
        if (panel.closest('[data-mode-set]') === container) {
          panel.hidden = panel.dataset.modePanel !== mode;
        }
      });
      announce(`${mode} preview`);
      return;
    }

    if (target.hasAttribute('data-theme-toggle')) {
      const root = document.documentElement;
      const light = root.dataset.theme !== 'light';
      root.dataset.theme = light ? 'light' : 'dark';
      document.querySelectorAll('[data-buddy-image]').forEach((image) => {
        image.src = light ? image.dataset.buddyLight : image.dataset.buddyDark;
      });
      target.textContent = light ? 'Use dark theme' : 'Use light theme';
      announce(`${light ? 'Light' : 'Dark'} theme preview`);
      return;
    }

    if (target.matches('[role="switch"]')) {
      const next = target.getAttribute('aria-checked') !== 'true';
      target.setAttribute('aria-checked', String(next));
      const label = (target.getAttribute('aria-label') || 'Setting').replace(/ enabled| disabled$/i, '');
      target.setAttribute('aria-label', `${label} ${next ? 'enabled' : 'disabled'}`);
      const help = target.dataset.toggleHelp && document.getElementById(target.dataset.toggleHelp);
      if (help) help.textContent = next ? 'On · Allow holders without Polaris ID to sign in by verified email.' : 'Off · Holders need Polaris ID to sign in.';
      const impact = target.dataset.toggleImpact && document.getElementById(target.dataset.toggleImpact);
      if (impact) impact.hidden = next;
      announce(`${label} ${next ? 'enabled' : 'disabled'}. Review the draft before saving.`);
      return;
    }

    if (target.dataset.openDialog) {
      document.getElementById(target.dataset.openDialog)?.showModal();
      return;
    }

    if (target.hasAttribute('data-close-dialog')) {
      target.closest('dialog')?.close();
      return;
    }

    if (target.dataset.mockAction) {
      event.preventDefault();
      const message = target.dataset.mockAction;
      target.closest('dialog')?.close();
      announce(`${message}. Prototype only; no data was changed.`);
    }
  });

  document.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-view-select]');
    if (select) showView(select.value);
  });
})();
