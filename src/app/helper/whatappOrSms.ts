/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable no-useless-escape */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { Injectable, Logger } from '@nestjs/common';
import Twilio from 'twilio';
import config from '../config';

@Injectable()
export class WhatsappOrSmsService {
  private readonly logger = new Logger(WhatsappOrSmsService.name);
  private client?: Twilio.Twilio;

  constructor() {
    if (!this.isEnabled()) {
      this.logger.warn(
        'Twilio is DISABLED. Check your .env: TWILIO_ENABLED, SID, TOKEN, PHONE_NUMBER',
      );
      return;
    }
    

    try {
      this.client = Twilio(config.twilio.sid!, config.twilio.token!);
      this.logger.log('Twilio client initialized successfully');
      this.logger.log(
        `WhatsApp: ${config.twilio.whatsappEnabled ? 'ON' : 'OFF'} | SMS: ${config.twilio.smsEnabled ? 'ON' : 'OFF'}`,
      );
    } catch (err: any) {
      this.logger.error(`Failed to initialize Twilio: ${err.message}`);
    }
  }

  isEnabled(): boolean {
    return Boolean(
      config.twilio.enabled &&
      config.twilio.sid &&
      config.twilio.token &&
      ((config.twilio.whatsappEnabled && config.twilio.whatsappNumber) ||
        (config.twilio.smsEnabled &&
          (config.twilio.phoneNumber || config.twilio.messagingServiceSid))),
    );
  }

  /**
   * Smart international phone number formatter.
   *
   * Supports:
   *   - Bangladesh (+880): 01XXXXXXXXX, 8801XXXXXXXXX, +8801XXXXXXXXX
   *   - India (+91):       9XXXXXXXXX, 919XXXXXXXXX, +919XXXXXXXXX
   *   - Any number already starting with + → returned as-is
   *
   * Examples:
   *   +919609745594  → +919609745594  (already valid)
   *   919609745594   → +919609745594
   *   9609745594     → +919609745594
   *   01711111111    → +8801711111111
   *   8801711111111  → +8801711111111
   */
  formatPhoneNumber(number: string): string {
    if (!number) return '';

    // Remove spaces, dashes, parentheses
    const cleaned = number.replace(/[\s\-\(\)]/g, '');

    // Already has + prefix → return as-is (trust the caller)
    if (cleaned.startsWith('+')) return cleaned;

    // ── India: starts with 91 + 10 digit number (total 12 digits) ──
    // e.g. 919609745594 → +919609745594
    if (/^91[6-9]\d{9}$/.test(cleaned)) {
      return `+${cleaned}`;
    }

    // ── India: bare 10-digit mobile number starting with 6-9 ──
    // e.g. 9609745594 → +919609745594
    if (/^[6-9]\d{9}$/.test(cleaned)) {
      return `+91${cleaned}`;
    }

    // ── Bangladesh: starts with 880 ──
    // e.g. 8801711111111 → +8801711111111
    if (cleaned.startsWith('880')) {
      return `+${cleaned}`;
    }

    // ── Bangladesh: starts with 0 (local format) ──
    // e.g. 01711111111 → +8801711111111
    if (cleaned.startsWith('0') && cleaned.length === 11) {
      return `+880${cleaned.slice(1)}`;
    }

    // ── Bangladesh: bare 10-digit starting with 1 (after country code) ──
    // e.g. 1711111111 → +8801711111111
    if (/^1[3-9]\d{8}$/.test(cleaned)) {
      return `+880${cleaned}`;
    }

    // Fallback: return with + as-is (let Twilio validate)
    this.logger.warn(
      `Could not detect country for number "${number}" → sending as "+${cleaned}"`,
    );
    return `+${cleaned}`;
  }

  /**
   * @deprecated Use formatPhoneNumber() instead.
   * Kept for backward compatibility.
   */
  formatBDNumber(number: string): string {
    return this.formatPhoneNumber(number);
  }

  /**
   * Try WhatsApp first → fallback to SMS automatically.
   * Verifies delivery status to ensure message is actually sent.
   *
   * IMPORTANT FOR TRIAL ACCOUNTS:
   * - Destination number MUST be verified in Twilio Console → Verified Caller IDs
   * - For WhatsApp: User must join Sandbox first (send "join <keyword>" to +14155238886)
   * - For SMS to Bangladesh: Enable BD in Twilio Console → Messaging → Geo Permissions
   * - For SMS to India: Enable IN in Twilio Console → Messaging → Geo Permissions
   */
  async sendMessage(phone: string, message: string): Promise<boolean> {
    if (!this.client) {
      this.logger.warn('Twilio client not initialized. Skipping notification.');
      return false;
    }

    const formattedPhone = this.formatPhoneNumber(phone);
    if (!formattedPhone || formattedPhone.length < 10) {
      this.logger.warn(
        `Invalid phone number: "${phone}" → "${formattedPhone}"`,
      );
      return false;
    }

    this.logger.log(`Attempting to send message to ${formattedPhone}...`);

    // ─── 1) Try WhatsApp ────────────────────────────────────────────
    if (config.twilio.whatsappEnabled && config.twilio.whatsappNumber) {
      try {
        const whatsappFrom = config.twilio.whatsappNumber.startsWith(
          'whatsapp:',
        )
          ? config.twilio.whatsappNumber
          : `whatsapp:${config.twilio.whatsappNumber}`;

        const result = await this.client.messages.create({
          from: whatsappFrom,
          to: `whatsapp:${formattedPhone}`,
          body: message,
        });

        this.logger.log(
          `WhatsApp message queued → SID: ${result.sid} | Status: ${result.status} | To: whatsapp:${formattedPhone}`,
        );

        if (result.status === 'failed' || result.status === 'undelivered') {
          this.logger.warn(
            `WhatsApp message FAILED immediately → Status: ${result.status}, Error: ${result.errorCode} ${result.errorMessage}`,
          );
          // Fall through to SMS
        } else {
          this.logger.log(`WhatsApp sent successfully to ${formattedPhone}`);
          return true;
        }
      } catch (whatsappError: any) {
        const errorCode = whatsappError.code || 'unknown';
        const errorMsg = whatsappError.message || 'unknown error';

        this.logger.warn(
          `WhatsApp FAILED for ${formattedPhone} → Code: ${errorCode} | ${errorMsg}`,
        );

        if (errorCode === 21608) {
          this.logger.error(
            '>>> The recipient has NOT joined the WhatsApp Sandbox! ' +
              'They must send "join <keyword>" to +14155238886 on WhatsApp first.',
          );
        } else if (errorCode === 21211) {
          this.logger.error(
            '>>> Invalid "To" phone number. Check the number format.',
          );
        } else if (errorCode === 21614) {
          this.logger.error('>>> This number is not a valid WhatsApp number.');
        } else if (errorCode === 63032) {
          this.logger.error(
            '>>> User has not opted in to receive WhatsApp messages from this sandbox.',
          );
        }

        if (config.twilio.smsEnabled) {
          this.logger.log('Falling back to SMS...');
        } else {
          this.logger.warn('SMS fallback is DISABLED. Message not sent.');
          return false;
        }
      }
    }

    // ─── 2) Try SMS ─────────────────────────────────────────────────
    if (
      !config.twilio.smsEnabled ||
      (!config.twilio.phoneNumber && !config.twilio.messagingServiceSid)
    ) {
      this.logger.warn('SMS is not configured. Cannot send message.');
      return false;
    }

    try {
      const smsPayload: any = {
        to: formattedPhone,
        body: message,
      };

      if (config.twilio.messagingServiceSid) {
        smsPayload.messagingServiceSid = config.twilio.messagingServiceSid;
      } else {
        smsPayload.from = config.twilio.phoneNumber;
      }

      const result = await this.client.messages.create(smsPayload);

      this.logger.log(
        `SMS message queued → SID: ${result.sid} | Status: ${result.status} | To: ${formattedPhone}`,
      );

      if (result.status === 'failed' || result.status === 'undelivered') {
        this.logger.error(
          `SMS FAILED → Status: ${result.status}, Error: ${result.errorCode} ${result.errorMessage}`,
        );
        return false;
      }

      this.logger.log(`SMS sent successfully to ${formattedPhone}`);
      return true;
    } catch (smsError: any) {
      const errorCode = smsError.code || 'unknown';
      const errorMsg = smsError.message || 'unknown error';

      this.logger.error(
        `SMS FAILED for ${formattedPhone} → Code: ${errorCode} | ${errorMsg}`,
      );

      if (errorCode === 21408) {
        this.logger.error(
          '>>> Geographic permission not enabled! ' +
            'Go to Twilio Console → Messaging → Settings → Geo Permissions → Enable the target country.',
        );
      } else if (errorCode === 21610) {
        this.logger.error(
          '>>> This number has been blacklisted/unsubscribed from SMS.',
        );
      } else if (errorCode === 21211) {
        this.logger.error('>>> Invalid "To" phone number format.');
      } else if (errorCode === 21606 || errorCode === 21607) {
        this.logger.error(
          '>>> TRIAL ACCOUNT: This number is NOT verified! ' +
            'Go to Twilio Console → Phone Numbers → Verified Caller IDs → Add this number.',
        );
      }

      return false;
    }
  }

  // ─── Message Templates ────────────────────────────────────────────

  overdueMessage(taskTitle: string): string {
    return (
      `*Task Overdue!*\n\n` +
      `Your task *"${taskTitle}"* deadline has passed.\n` +
      `Please complete it as soon as possible!`
    );
  }

  reminderMessage(taskTitle: string, minutesLeft: number): string {
    return (
      `*Task Reminder!*\n\n` +
      `Your task *"${taskTitle}"* is due in *${minutesLeft} minutes*.\n` +
      `Time to wrap it up!`
    );
  }

  completedMessage(taskTitle: string): string {
    return (
      `*Task Completed!*\n\n` +
      `Great job! You completed *"${taskTitle}"*.\n` +
      `Keep up the excellent work!`
    );
  }
}
