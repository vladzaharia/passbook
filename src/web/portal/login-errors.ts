import { isSignInErrorCode, SIGN_IN_ERROR_COPY } from '@/shared/copy/sign-in.ts';
import { errorMessage, isApiError } from '../lib/errors.ts';

export interface SignInError {
  title?: string;
  message: string;
}

/** A failed sign-in request, worded as the SSR pages word it (title and sentence) when known. */
export function signInError(error: unknown): SignInError {
  if (isApiError(error) && isSignInErrorCode(error.code)) return SIGN_IN_ERROR_COPY[error.code];
  return { message: errorMessage(error) };
}
