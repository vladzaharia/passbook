/**
 * HTML error pages for worker routes a browser opens (never problem+json there). Built on the
 * hosted shell with the app's state art; one h1, one line, one action. The words and the action's
 * weight are the SPA's (shared/copy/states.ts, ui/layout/error-pages.tsx, ui/error-state.tsx).
 */
import { ArrowLeft, RefreshCw, WalletCards } from 'lucide-react';
import { AUTH_PAGE_COPY } from '../../shared/copy/sign-in.ts';
import { STATE_COPY, waitLine } from '../../shared/copy/states.ts';
import type { PageTheme } from './head.ts';
import { actionHtml, type HostedArt, hostedPage, type PageAction, postButton } from './hosted.ts';
import { escapeHtml } from './theme.ts';

export interface ErrorPageInput {
  status: number;
  nonce: string;
  /** The visitor's theme choice (requestTheme). */
  theme?: PageTheme;
  /** Overrides the status default. */
  title?: string;
  line?: string;
  /** The one action. Retry defaults to the current URL (`href` "" reloads the page). */
  action?: PageAction;
  /** Seconds from a 429's Retry-After header. */
  retryAfter?: number | null;
}

/** Not found and forbidden lead home, as the app's pages do. */
export const GO_TO_MY_PASSES: PageAction = {
  label: STATE_COPY.goToMyPasses,
  href: '/',
  icon: WalletCards,
};

export const backToSignIn = (href = '/login'): PageAction => ({
  label: AUTH_PAGE_COPY.backToSignIn,
  href,
  icon: ArrowLeft,
});

/** Forbidden: another account may have the access (sign out, then sign in). */
const SWITCH_ACCOUNT = postButton('/auth/logout?next=%2Flogin', STATE_COPY.switchAccount).replace(
  'class="btn"',
  'class="btn outline"',
);

const RETRY: PageAction = { label: STATE_COPY.retry, href: '', icon: RefreshCw };

/** Each status's meaning: its words, its art (a sad buddy with the prop) and its way on. */
function defaults(input: ErrorPageInput): {
  title: string;
  line?: string;
  art: HostedArt;
  action: PageAction;
} {
  if (input.status === 404) {
    return {
      title: STATE_COPY.pageNotFound,
      line: STATE_COPY.notFoundLine,
      art: 'lost',
      action: GO_TO_MY_PASSES,
    };
  }
  if (input.status === 403) {
    return {
      title: STATE_COPY.forbidden,
      line: STATE_COPY.forbiddenLine,
      art: 'no-access',
      action: GO_TO_MY_PASSES,
    };
  }
  if (input.status === 429) {
    const line = waitLine(input.retryAfter);
    return { title: STATE_COPY.rateLimited, line, art: 'throttled', action: RETRY };
  }
  return { title: STATE_COPY.errorTitle, line: STATE_COPY.tryAgain, art: 'broken', action: RETRY };
}

export function renderErrorPage(input: ErrorPageInput): string {
  const d = defaults(input);
  const line = input.line ?? d.line;
  return hostedPage({
    nonce: input.nonce,
    theme: input.theme,
    title: input.title ?? d.title,
    art: d.art,
    ...(line ? { lede: escapeHtml(line) } : {}),
    body:
      input.status === 403 && !input.action
        ? `<div class="stack">${actionHtml(d.action)}${SWITCH_ACCOUNT}</div>`
        : actionHtml(input.action ?? d.action),
  });
}
