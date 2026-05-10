const nodemailer = require("nodemailer");

const getTransporter = () => {
  if (
    !process.env.SMTP_HOST ||
    !process.env.SMTP_USER ||
    !process.env.SMTP_PASS
  ) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

const sendEmail = async ({ to, subject, text, html }) => {
  const transporter = getTransporter();

  if (!transporter) {
    console.log(`Email skipped: ${subject} -> ${to}`);
    return { skipped: true };
  }

  return transporter.sendMail({
    from: process.env.EMAIL_FROM || "noreply@thriftgh.com",
    to,
    subject,
    text,
    html,
  });
};

const sendKycApprovedEmail = (user) =>
  sendEmail({
    to: user.email,
    subject: "Your KYC has been approved",
    text: "Your ThriftGH verification badge is now active.",
  });

const sendKycRejectedEmail = (user, reason) =>
  sendEmail({
    to: user.email,
    subject: "Your KYC needs another look",
    text: `Your KYC submission was rejected. Reason: ${reason}`,
  });

const sendDigiShopWelcomeEmail = (user, shop) =>
  sendEmail({
    to: user.email,
    subject: "Your DigiShop is live",
    text: `${shop.shopName} is now live on ThriftGH.`,
  });

module.exports = {
  sendEmail,
  sendKycApprovedEmail,
  sendKycRejectedEmail,
  sendDigiShopWelcomeEmail,
};
