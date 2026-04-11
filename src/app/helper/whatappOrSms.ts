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
            (config.twilio.phoneNumber ||
              config.twilio.messagingServiceSid))),
    );
  }

  /**
   * Bangladesh number normalize: 01XXXXXXXXX → +8801XXXXXXXXX
   * Also handles: 1XXXXXXXXX, 880XXXXXXXXX, +880XXXXXXXXX
   */
  formatBDNumber(number: string): string {
    if (!number) return '';
    const cleaned = number.replace(/[\s\-\(\)]/g, '');
    if (cleaned.startsWith('+880')) return cleaned;
    if (cleaned.startsWith('880')) return `+${cleaned}`;
    if (cleaned.startsWith('0')) return `+880${cleaned.slice(1)}`;
    if (/^1[3-9]\d{8}$/.test(cleaned)) return `+880${cleaned}`;
    return `+880${cleaned}`;
  }

  /**
   * Try WhatsApp first → fallback to SMS automatically.
   * Verifies delivery status to ensure message is actually sent.
   *
   * IMPORTANT FOR TRIAL ACCOUNTS:
   * - Destination number MUST be verified in Twilio Console → Verified Caller IDs
   * - For WhatsApp: User must join Sandbox first (send "join <keyword>" to +14155238886)
   * - For SMS to Bangladesh: Enable BD in Twilio Console → Messaging → Geo Permissions
   */
  async sendMessage(phone: string, message: string): Promise<boolean> {
    if (!this.client) {
      this.logger.warn('Twilio client not initialized. Skipping notification.');
      return false;
    }

    const formattedPhone = this.formatBDNumber(phone);
    if (!formattedPhone || formattedPhone.length < 13) {
      this.logger.warn(`Invalid phone number: "${phone}" → "${formattedPhone}"`);
      return false;
    }

    this.logger.log(`Attempting to send message to ${formattedPhone}...`);

    // ─── 1) Try WhatsApp ────────────────────────────────────────────
    if (config.twilio.whatsappEnabled && config.twilio.whatsappNumber) {
      try {
        const whatsappFrom = config.twilio.whatsappNumber.startsWith('whatsapp:')
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

        // Check if message was accepted (not failed immediately)
        if (
          result.status === 'failed' ||
          result.status === 'undelivered'
        ) {
          this.logger.warn(
            `WhatsApp message FAILED immediately → Status: ${result.status}, Error: ${result.errorCode} ${result.errorMessage}`,
          );
          // Fall through to SMS
        } else {
          // Status is 'queued', 'sent', 'delivered' — accepted by Twilio
          this.logger.log(`WhatsApp sent successfully to ${formattedPhone}`);
          return true;
        }
      } catch (whatsappError: any) {
        const errorCode = whatsappError.code || 'unknown';
        const errorMsg = whatsappError.message || 'unknown error';

        this.logger.warn(
          `WhatsApp FAILED for ${formattedPhone} → Code: ${errorCode} | ${errorMsg}`,
        );

        // Common Twilio WhatsApp errors:
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
          this.logger.error(
            '>>> This number is not a valid WhatsApp number.',
          );
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

      if (
        result.status === 'failed' ||
        result.status === 'undelivered'
      ) {
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

      // Common Twilio SMS errors:
      if (errorCode === 21408) {
        this.logger.error(
          '>>> Geographic permission not enabled for Bangladesh! ' +
            'Go to Twilio Console → Messaging → Settings → Geo Permissions → Enable Bangladesh.',
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
