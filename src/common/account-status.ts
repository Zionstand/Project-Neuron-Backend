import { AccountStatus } from '../generated/prisma/client';

// Every place that refuses a request because of the account's standing — login,
// refresh, and the per-request JWT check — speaks with one voice. The payload
// carries a stable `code` so the client can react (hard redirect, banner copy)
// without string-matching prose, plus a human message that names the next step
// and who to contact.

export const ACCOUNT_BLOCKED_CODE = 'ACCOUNT_BLOCKED' as const;

export function supportEmail(): string {
  return process.env.SUPPORT_EMAIL_ADDRESS ?? 'support@oyomoest.ng';
}

type Copy = { title: string; detail: string };

const COPY: Record<Exclude<AccountStatus, 'ACTIVE'>, Copy> = {
  PENDING: {
    title: 'Your account is awaiting approval',
    detail:
      'A system administrator still needs to approve your registration before you can sign in. You will receive an email the moment that happens.',
  },
  SUSPENDED: {
    title: 'Your account has been suspended',
    detail:
      'Access has been paused by a system administrator. Suspensions are usually temporary and can be lifted once the issue is resolved.',
  },
  BANNED: {
    title: 'Your account has been banned',
    detail:
      'A system administrator has permanently revoked access to this account.',
  },
  REJECTED: {
    title: 'Your registration was not approved',
    detail:
      'A system administrator reviewed your registration and did not approve it.',
  },
  DEACTIVATED: {
    title: 'Your account has been deactivated',
    detail:
      'This account is no longer active. If you still require access, it can be reactivated by a system administrator.',
  },
};

export interface AccountBlockedPayload {
  code: typeof ACCOUNT_BLOCKED_CODE;
  accountStatus: AccountStatus;
  title: string;
  message: string;
  supportEmail: string;
}

/**
 * Build the refusal payload for a non-ACTIVE account. `reason` is the free-text
 * note the administrator left when they changed the status — surfaced verbatim so
 * the user is not left guessing.
 */
export function accountBlockedPayload(
  accountStatus: AccountStatus,
  reason?: string | null,
): AccountBlockedPayload {
  const copy = COPY[accountStatus as Exclude<AccountStatus, 'ACTIVE'>] ?? {
    title: 'You cannot sign in right now',
    detail: 'This account is not currently active.',
  };

  const email = supportEmail();
  const parts = [copy.detail];
  if (reason?.trim()) parts.push(`Reason given: “${reason.trim()}”.`);
  parts.push(`For help, contact ${email}.`);

  return {
    code: ACCOUNT_BLOCKED_CODE,
    accountStatus,
    title: copy.title,
    message: parts.join(' '),
    supportEmail: email,
  };
}
