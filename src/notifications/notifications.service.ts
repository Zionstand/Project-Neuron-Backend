import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationType } from '../generated/prisma/client';

// Which notifications reach the inbox, and which stay in the app.
//
// The rule is deliberately conservative: email is for things that change your
// standing or need you to act. Routine capture chatter (a section submitted, a
// queued upload finally landing) is in-app by default, because an inbox that
// fills with routine mail is an inbox where the suspension notice goes unread.
// Users can opt the routine categories into email; they cannot opt out of the
// account-standing ones.
type Channel = 'email-always' | 'email-default' | 'email-optional' | 'in-app';

const CHANNEL: Record<NotificationType, Channel> = {
  // Account standing — always emailed. Not silenceable: if you have been
  // suspended, you need to be told somewhere other than an app you can't open.
  ACCOUNT_APPROVED: 'email-always',
  ACCOUNT_REJECTED: 'email-always',
  ACCOUNT_SUSPENDED: 'email-always',
  ACCOUNT_BANNED: 'email-always',
  ACCOUNT_REACTIVATED: 'email-always',
  ACCOUNT_DEACTIVATED: 'email-always',
  ROLE_CHANGED: 'email-always',
  PASSWORD_RESET: 'email-always',

  // Verification outcomes — emailed by default, can be turned off.
  SECTION_VERIFIED: 'email-default',
  SECTION_RETURNED: 'email-default',

  // Routine capture activity.
  SECTION_SUBMITTED: 'email-default',
  CAPTURE_PERIOD_OPENED: 'email-default',
  CAPTURE_PERIOD_CLOSED: 'email-default',

  // Noisy by nature — in-app unless explicitly requested.
  MEDIA_SYNCED: 'email-optional',

  SYSTEM: 'in-app',
};

// Which preference flag governs each opt-out-able type.
const PREFERENCE_KEY: Partial<
  Record<NotificationType, 'emailOnCaptureActivity' | 'emailOnVerification' | 'emailOnMediaSync'>
> = {
  SECTION_SUBMITTED: 'emailOnCaptureActivity',
  CAPTURE_PERIOD_OPENED: 'emailOnCaptureActivity',
  CAPTURE_PERIOD_CLOSED: 'emailOnCaptureActivity',
  SECTION_VERIFIED: 'emailOnVerification',
  SECTION_RETURNED: 'emailOnVerification',
  MEDIA_SYNCED: 'emailOnMediaSync',
};

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** In-app deep link. Also becomes the email's call-to-action when set. */
  link?: string | null;
  /** Overrides the channel table — used for one-off admin broadcasts. */
  forceEmail?: boolean;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
  ) {}

  private appUrl(): string {
    const configured = (process.env.FRONTEND_URL ?? '').split(',')[0]?.trim();
    return configured || 'http://localhost:3000';
  }

  /**
   * Record a notification and, where the type and the user's preferences call
   * for it, email them too.
   *
   * Never throws: notifying someone is a side effect of an action that has
   * already happened, and must not roll it back.
   */
  async notify(input: NotifyInput): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true, firstName: true, isDeleted: true },
      });
      if (!user || user.isDeleted) return;

      const wantsEmail =
        input.forceEmail ?? (await this.shouldEmail(input.userId, input.type));

      const row = await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          link: input.link ?? null,
        },
      });

      if (!wantsEmail) return;

      const sent = await this.mail.sendNotificationEmail(
        user.email,
        input.title,
        input.title,
        [`Hello ${user.firstName},`, input.body],
        input.link
          ? { label: 'Open NEURON', url: `${this.appUrl()}${input.link}` }
          : undefined,
      );

      if (sent) {
        await this.prisma.notification.update({
          where: { id: row.id },
          data: { emailSent: true, emailSentAt: new Date() },
        });
      }
    } catch (e) {
      this.logger.error(
        `Notification failed for ${input.userId} (${input.type}): ${(e as Error).message}`,
      );
    }
  }

  /** Fan a notification out to several people (e.g. every supervisor). */
  async notifyMany(userIds: string[], input: Omit<NotifyInput, 'userId'>) {
    const unique = [...new Set(userIds)].filter(Boolean);
    await Promise.all(unique.map((userId) => this.notify({ ...input, userId })));
  }

  private async shouldEmail(
    userId: string,
    type: NotificationType,
  ): Promise<boolean> {
    const channel = CHANNEL[type];
    if (channel === 'email-always') return true;
    if (channel === 'in-app') return false;

    const key = PREFERENCE_KEY[type];
    if (!key) return channel === 'email-default';

    const prefs = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    });
    // No row yet: fall back to the type's default rather than assuming silence.
    if (!prefs) return channel === 'email-default';
    return prefs[key];
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────

  async list(userId: string, opts: { unreadOnly?: boolean; take?: number }) {
    const take = Math.min(opts.take ?? 30, 100);
    const [rows, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId, ...(opts.unreadOnly ? { readAt: null } : {}) },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return { rows, unread };
  }

  async unreadCount(userId: string) {
    return {
      unread: await this.prisma.notification.count({
        where: { userId, readAt: null },
      }),
    };
  }

  async markRead(userId: string, id: string) {
    // Scoped by userId so one user cannot mark another's notification read.
    const result = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      const exists = await this.prisma.notification.findFirst({
        where: { id, userId },
      });
      if (!exists) throw new NotFoundException('Notification not found.');
    }
    return this.unreadCount(userId);
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { unread: 0 };
  }

  // ─── Preferences ────────────────────────────────────────────────────────────

  async getPreferences(userId: string) {
    const existing = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    });
    if (existing) return existing;
    // Lazily materialise defaults so the settings page always has a row to edit.
    return this.prisma.notificationPreference.create({ data: { userId } });
  }

  async updatePreferences(
    userId: string,
    data: {
      emailOnCaptureActivity?: boolean;
      emailOnVerification?: boolean;
      emailOnMediaSync?: boolean;
    },
  ) {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }
}
