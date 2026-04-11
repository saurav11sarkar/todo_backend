import nodemailer from 'nodemailer';
import config from '../config';

const sendMailer = async (email: string, subject?: string, html?: string) => {
  const transporter = nodemailer.createTransport({
    host: config.email.host,
    port: Number(config.email.port),
    secure: false,
    auth: {
      user: config.email.address,
      pass: config.email.pass,
    },
  });
  const info = await transporter.sendMail({
    from: `"your company name" ${config.email.from}`,
    to: email,
    subject,
    html,
  });

  console.log('Message sent:', info.messageId);
};

export default sendMailer;
