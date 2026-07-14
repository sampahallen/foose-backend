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

const displayName = (user) => user?.name || user?.username || "there";

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const sendKycApprovedEmail = (user) => {
  const name = displayName(user);
  const safeName = escapeHtml(name);

  return sendEmail({
    to: user.email,
    subject: "Your Foose KYC has been approved",
    text: `Hi ${name},\n\nGood news. Your KYC submission has been approved and your Foose verification badge is now active.\n\nYou can now continue using verified seller features on Foose.`,
    html: `
      <p>Hi ${safeName},</p>
      <p>Good news. Your KYC submission has been approved and your Foose verification badge is now active.</p>
      <p>You can now continue using verified seller features on Foose.</p>
    `,
  });
};

const sendKycRejectedEmail = (user, reason = "") => {
  const name = displayName(user);
  const safeName = escapeHtml(name);
  const cleanReason = String(reason || "").trim();
  const reasonText = cleanReason ? `\n\nReason: ${cleanReason}` : "";
  const reasonHtml = cleanReason ? `<p><strong>Reason:</strong> ${escapeHtml(cleanReason)}</p>` : "";

  return sendEmail({
    to: user.email,
    subject: "Your Foose KYC needs another look",
    text: `Hi ${name},\n\nYour KYC submission was rejected. Please review your details and resubmit when you're ready.${reasonText}\n\nGo to your account KYC page to update your submission.`,
    html: `
      <p>Hi ${safeName},</p>
      <p>Your KYC submission was rejected. Please review your details and resubmit when you're ready.</p>
      ${reasonHtml}
      <p>Go to your account KYC page to update your submission.</p>
    `,
  });
};

const sendPasswordResetEmail = (user, resetLink) => {
  const name = displayName(user);
  const safeName = escapeHtml(name);
  const safeResetLink = escapeHtml(resetLink);

  return sendEmail({
    to: user.email,
    subject: "Reset your Foose password",
    text: `Hi ${name},\n\nWe received a request to reset your Foose password. Use this secure link to choose a new password:\n\n${resetLink}\n\nThis link expires in 1 hour. If you didn't request a password change, ignore this email. Your password will not change unless this link is used to set a new one.`,
    html: `
      <p>Hi ${safeName},</p>
      <p>We received a request to reset your Foose password.</p>
      <p><a href="${safeResetLink}">Choose a new password</a></p>
      <p>This link expires in 1 hour.</p>
      <p>If you didn't request a password change, ignore this email. Your password will not change unless this link is used to set a new one.</p>
    `,
  });
};

const sendDigiShopWelcomeEmail = (user, shop) =>
  sendEmail({
    to: user.email,
    subject: "Your DigiShop is live",
    text: `${shop.shopName} is now live on ThriftGH.`,
  });

const sendSellerOrderEmail = (seller, order, buyer) =>
  sendEmail({
    to: seller.email,
    subject: "New Foose order needs your action",
    text: `Order ${order._id} for ${order.items?.[0]?.title || "an item"} was placed by ${
      buyer.name || buyer.username || buyer.email
    }. Please process it within 48 hours from your shop dashboard.`,
  });

module.exports = {
  sendEmail,
  sendKycApprovedEmail,
  sendKycRejectedEmail,
  sendPasswordResetEmail,
  sendDigiShopWelcomeEmail,
  sendSellerOrderEmail,
};
