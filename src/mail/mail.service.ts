import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as nodemailer from 'nodemailer';

// Portal identity. Per the NEURON standing rules, all Ministry-facing surfaces
// carry the Ministry's identity — no ZDT/Zionstand branding.
const PORTAL_NAME = 'NEURON LIE Portal';
const MINISTRY_NAME = 'Oyo State Ministry of Education, Science & Technology';
const BRAND_GREEN = '#0b6b3a';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: 'in-v3.mailjet.com',
      port: parseInt(process.env.SMTP_PORT || '2525', 10),
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.MAILJET_API_PUBLIC_KEY,
        pass: process.env.MAILJET_API_PRIVATE_KEY,
      },
    });

    this.logger.log(
      `Mailjet SMTP initialized on port ${process.env.SMTP_PORT || 2525}`,
    );
  }

  // ─── SHARED LAYOUT ──────────────────────────────────────────────────────────

  private wrap(headerColor: string, title: string, bodyHtml: string): string {
    return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">
  <div style="background:${headerColor};padding:20px;text-align:center;">
    <h2 style="color:#fff;margin:0;">${PORTAL_NAME}</h2>
  </div>
  <div style="padding:30px;background:#f9f9f9;">
    <h3 style="color:${headerColor};margin-top:0;">${title}</h3>
    ${bodyHtml}
  </div>
  <div style="background:#f0f0f0;padding:15px;text-align:center;border-top:1px solid #e5e5e5;">
    <p style="color:#999;font-size:12px;margin:0;">${PORTAL_NAME} — ${MINISTRY_NAME}</p>
  </div>
</div>`;
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    const from = `"${PORTAL_NAME}" <${process.env.SENDER_EMAIL_ADDRESS}>`;
    try {
      const info = await this.transporter.sendMail({ from, to, subject, html });
      this.logger.log(`Email sent to ${to} — ${subject} [${info.messageId}]`);
    } catch (err: any) {
      this.logger.error(`Failed to send email to ${to}: ${err.message}`);
    }
  }

  // ─── PASSWORD RESET OTP ─────────────────────────────────────────────────────

  async sendPasswordResetOtp(to: string, otp: string) {
    const html = this.wrap(
      BRAND_GREEN,
      'Password Reset Request',
      `
      <p style="color:#555;font-size:16px;line-height:1.5;">
        We received a request to reset your password. Here is your 6-digit authorization code:
      </p>
      <div style="text-align:center;margin:30px 0;">
        <span style="display:inline-block;font-size:32px;font-weight:bold;letter-spacing:5px;color:${BRAND_GREEN};background:#e6f2ed;padding:15px 30px;border-radius:8px;border:1px dashed ${BRAND_GREEN};">
          ${otp}
        </span>
      </div>
      <p style="color:#777;font-size:14px;text-align:center;">
        This code will expire in exactly 10 minutes.<br>
        If you did not request this, please ignore this email.
      </p>`,
    );

    try {
      const info = await this.transporter.sendMail({
        from: `"${PORTAL_NAME}" <${process.env.SENDER_EMAIL_ADDRESS}>`,
        to,
        subject: 'Your Password Reset Code',
        html,
      });
      this.logger.log(`Password reset OTP sent to ${to} [${info.messageId}]`);
      return info;
    } catch (error) {
      this.logger.error(`Failed to send password reset email: ${error}`);
      throw new InternalServerErrorException(
        'Failed to send password reset email',
      );
    }
  }

  // ─── WELCOME (account provisioned by SYS_ADMIN) ─────────────────────────────

  async sendWelcomeEmail(
    to: string,
    username: string,
    tempPassword: string,
    firstName: string,
  ) {
    const html = this.wrap(
      BRAND_GREEN,
      `Welcome, ${firstName}!`,
      `
      <p style="color:#555;font-size:16px;line-height:1.5;">
        An administrator has created an account for you on the ${PORTAL_NAME}. Please log in
        using the credentials below:
      </p>
      <div style="background:#fff;padding:20px;border-radius:8px;border:1px solid #ddd;margin:25px 0;">
        <p style="margin:0 0 10px 0;font-size:16px;"><strong>Email:</strong> ${to}</p>
        <p style="margin:0 0 15px 0;font-size:16px;"><strong>Username:</strong> ${username}</p>
        <p style="margin:0 0 5px 0;font-size:16px;"><strong>Temporary Password:</strong></p>
        <div style="text-align:center;margin-top:10px;">
          <span style="display:inline-block;font-size:24px;font-weight:bold;letter-spacing:2px;color:${BRAND_GREEN};background:#e6f2ed;padding:15px 30px;border-radius:8px;border:1px dashed ${BRAND_GREEN};">
            ${tempPassword}
          </span>
        </div>
      </div>
      <p style="color:#d9534f;font-size:14px;text-align:center;font-weight:bold;">
        For security reasons, you will be required to change this password immediately upon your first login.
      </p>`,
    );
    await this.send(
      to,
      `Welcome to the ${PORTAL_NAME} — Your Account Details`,
      html,
    );
  }

  // ─── ACCOUNT APPROVAL (PENDING → ACTIVE) ────────────────────────────────────

  async sendStaffApprovalEmail(to: string, name: string, roleLabel: string) {
    const loginUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const html = this.wrap(
      BRAND_GREEN,
      'Account Approved!',
      `
      <p style="color:#333;font-size:16px;line-height:1.6;">Dear <strong>${name}</strong>,</p>
      <p style="color:#333;font-size:16px;line-height:1.6;">
        Your <strong>${roleLabel}</strong> account has been approved. You can now log in and access the portal.
      </p>
      <div style="background:#e6f2ed;border-left:4px solid ${BRAND_GREEN};padding:15px 20px;margin:25px 0;border-radius:0 4px 4px 0;">
        <p style="color:#166534;margin:0;font-size:14px;"><strong>Role:</strong> ${roleLabel}<br><strong>Email:</strong> ${to}</p>
      </div>
      <a href="${loginUrl}" style="display:inline-block;background:${BRAND_GREEN};color:#fff;padding:14px 30px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;">Login Now</a>
      <p style="color:#666;font-size:13px;margin-top:25px;">If you have questions, contact your system administrator.</p>`,
    );
    await this.send(to, `Your ${PORTAL_NAME} Account Has Been Approved`, html);
  }

  // ─── ACCOUNT REJECTION ──────────────────────────────────────────────────────

  async sendStaffRejectionEmail(
    to: string,
    name: string,
    roleLabel: string,
    reason?: string,
  ) {
    const html = this.wrap(
      '#dc2626',
      'Registration Update',
      `
      <p style="color:#333;font-size:16px;line-height:1.6;">Dear <strong>${name}</strong>,</p>
      <p style="color:#333;font-size:16px;line-height:1.6;">
        We regret to inform you that your <strong>${roleLabel}</strong> account registration could not be approved at this time.
      </p>
      ${reason ? `<div style="background:#fef2f2;border-left:4px solid #dc2626;padding:15px 20px;margin:20px 0;border-radius:0 4px 4px 0;"><p style="color:#991b1b;margin:0;font-size:14px;"><strong>Reason:</strong> ${reason}</p></div>` : ''}
      <p style="color:#666;font-size:14px;">If you believe this is an error, please contact your system administrator.</p>`,
    );
    await this.send(to, `${PORTAL_NAME} — Account Registration Update`, html);
  }

  // ─── NEW REGISTRATION NOTIFICATION (to admin) ───────────────────────────────

  async sendNewStaffRegistrationEmail(
    newStaffName: string,
    newStaffEmail: string,
    newStaffRole: string,
  ) {
    const adminEmail = process.env.ADMIN_EMAIL_ADDRESS;
    if (!adminEmail) {
      this.logger.warn(
        'ADMIN_EMAIL_ADDRESS not set — skipping registration notification.',
      );
      return;
    }
    const dashboardUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/dashboard`;
    const html = this.wrap(
      '#ca8a04',
      'New Registration',
      `
      <p style="color:#333;font-size:16px;line-height:1.6;">A new user has registered and is awaiting your approval.</p>
      <div style="background:#fefce8;border:1px solid #fef08a;padding:20px;margin:20px 0;border-radius:8px;">
        <p style="margin:6px 0;font-size:15px;"><strong>Name:</strong> ${newStaffName}</p>
        <p style="margin:6px 0;font-size:15px;"><strong>Email:</strong> ${newStaffEmail}</p>
        <p style="margin:6px 0;font-size:15px;"><strong>Role:</strong> ${newStaffRole}</p>
      </div>
      <a href="${dashboardUrl}" style="display:inline-block;background:#ca8a04;color:#fff;padding:14px 30px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:16px;">Review &amp; Approve</a>`,
    );
    await this.send(
      adminEmail,
      `New Registration: ${newStaffName} (${newStaffRole})`,
      html,
    );
  }
}
