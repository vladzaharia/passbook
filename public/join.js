// The join page's one script (src/worker/ssr/join-page.tsx): Turnstile, Copy link and the submit
// moment. Same-origin, so `script-src 'self'` covers it; the Turnstile api loads from its own allowed
// origin. The form works without it as a plain post (the server then fails the missing check closed).
(() => {
  const form = document.querySelector('form[data-join]');
  if (form) {
    const root = document.querySelector('.jn') ?? document.documentElement;
    const tokenField = form.querySelector('input[name="cf-turnstile-response"]');
    const submit = form.querySelector('[data-submit]');
    const siteKey = form.getAttribute('data-sitekey') ?? '';
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let widget = null;
    let sending = false;
    let settle = null;

    // Copy link: the join link only, never a pass link.
    const copy = document.querySelector('[data-copy]');
    if (copy) {
      const label = copy.textContent;
      const done = () => {
        copy.textContent = copy.getAttribute('data-copied') ?? label;
        copy.setAttribute('data-done', '');
        setTimeout(() => {
          copy.textContent = label;
          copy.removeAttribute('data-done');
        }, 2000);
      };
      const fallback = () => {
        const box = document.createElement('textarea');
        box.value = location.href;
        box.setAttribute('readonly', '');
        box.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(box);
        box.select();
        if (document.execCommand('copy')) done();
        document.body.removeChild(box);
      };
      copy.addEventListener('click', () => {
        if (navigator.clipboard?.writeText)
          navigator.clipboard.writeText(location.href).then(done, fallback);
        else fallback();
      });
    }

    // Turnstile: invisible unless it needs the visitor; the token fills the hidden field.
    const renderWidget = () => {
      const host = form.querySelector('[data-ts]');
      if (!window.turnstile || !host || widget !== null) return;
      widget = window.turnstile.render(host, {
        sitekey: siteKey,
        action: 'join',
        appearance: 'interaction-only',
        // Same as TURNSTILE_BASE_OPTIONS (src/web/lib/turnstile-script.ts): a check that cannot run stops; the post then fails closed.
        retry: 'never',
        theme: 'auto',
        callback: (token) => {
          tokenField.value = token;
          settle?.();
        },
        'expired-callback': () => {
          tokenField.value = '';
          window.turnstile?.reset(widget);
        },
        'error-callback': () => {
          tokenField.value = '';
          settle?.();
        },
      });
    };
    if (siteKey) {
      window.__joinTurnstile = renderWidget;
      const api = document.createElement('script');
      const apiUrl =
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__joinTurnstile';
      // The page's CSP requires Trusted Types: one named policy that admits this one address.
      api.src = window.trustedTypes
        ? window.trustedTypes
            .createPolicy('passbook-turnstile', {
              createScriptURL: (u) => {
                if (u !== apiUrl) throw new TypeError('Unexpected script address.');
                return u;
              },
            })
            .createScriptURL(apiUrl)
        : apiUrl;
      api.async = true;
      document.head.appendChild(api);
    }

    // Back from the next page: the form is ready again.
    addEventListener('pageshow', (e) => {
      if (!e.persisted) return;
      sending = false;
      settle = null;
      form.removeAttribute('data-go');
      root.removeAttribute('data-sending');
      submit?.removeAttribute('aria-busy');
    });

    form.addEventListener('submit', (e) => {
      if (form.hasAttribute('data-go')) return;
      e.preventDefault();
      if (sending) return;
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      sending = true;
      root.setAttribute('data-sending', '');
      submit?.setAttribute('aria-busy', 'true');
      // The moment plays while the check finishes; the post goes when both are done.
      let played = false;
      let checked = !siteKey || tokenField.value !== '';
      const go = () => {
        if (!played || !checked) return;
        form.setAttribute('data-go', '');
        form.submit();
      };
      settle = () => {
        checked = true;
        go();
      };
      setTimeout(
        () => {
          played = true;
          go();
        },
        reduce ? 0 : 640,
      );
      // A check that never answers posts anyway; the server refuses it and says so.
      setTimeout(settle, 15000);
    });
  }
})();
