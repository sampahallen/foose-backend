const nodemailer = require("nodemailer");
const { clientUrl } = require("./oauthService");

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

const clientBasePath = () =>
  (process.env.CLIENT_BASE_PATH || "").trim().replace(/^\/?/, "/").replace(/\/$/, "");

const clientPathUrl = (path) => `${clientUrl()}${clientBasePath()}${path}`;

// Brand palette mirrored from frontend/src/index.css so transactional emails
// look like the same product, not a bare-bones system notice.
const BRAND = {
  accent: "#2642fb",
  accentStrong: "#0026d6",
  bg: "#f4f2ff",
  surface: "#ffffff",
  text: "#1a1b25",
  muted: "#5e5f5c",
  border: "#e2e1ef",
  success: "#16833d",
  successBg: "#dff7e7",
  danger: "#ba1a1a",
  dangerBg: "#ffdad6",
};

const BADGE_TONES = {
  danger: { bg: BRAND.dangerBg, text: BRAND.danger },
  success: { bg: BRAND.successBg, text: BRAND.success },
};

/**
 * Wraps email body content in the shared Foose branded shell (header band,
 * card, optional CTA button/badge, footer). Table-based markup with inline
 * styles throughout for compatibility with Outlook/older email clients.
 */
const renderEmailLayout = ({ badge, bodyHtml, cta, heading, preheader = "" }) => {
  const badgeHtml = badge
    ? `<p style="margin:0 0 16px;">
        <span style="display:inline-block; padding:4px 12px; border-radius:999px; background-color:${BADGE_TONES[badge.tone]?.bg || BRAND.successBg}; color:${BADGE_TONES[badge.tone]?.text || BRAND.success}; font-size:12px; font-weight:700; letter-spacing:0.02em; text-transform:uppercase;">${escapeHtml(badge.label)}</span>
      </p>`
    : "";

  const ctaHtml = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 4px;">
        <tr>
          <td style="border-radius:10px; background-color:${BRAND.accent};">
            <a href="${escapeHtml(cta.url)}" style="display:inline-block; padding:13px 28px; font-size:15px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:10px;">${escapeHtml(cta.label)}</a>
          </td>
        </tr>
      </table>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>Foose</title>
  </head>
  <body style="margin:0; padding:0; background-color:${BRAND.bg}; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
    ${preheader ? `<span style="display:none; max-height:0; max-width:0; overflow:hidden; opacity:0;">${escapeHtml(preheader)}</span>` : ""}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.bg};">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background-color:${BRAND.surface}; border-radius:20px; overflow:hidden; box-shadow:0 20px 45px rgba(38,66,251,0.12);">
            <tr>
              <td style="background:linear-gradient(135deg, ${BRAND.accent}, ${BRAND.accentStrong}); padding:32px; text-align:center;">
                <span style="font-family: Georgia, 'Times New Roman', serif; font-size:26px; font-weight:700; letter-spacing:-0.02em; color:#ffffff;">Foose</span>
                <div style="margin-top:4px; font-size:12px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase; color:rgba(255,255,255,0.75);">Ghana&rsquo;s digital thrift hub</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 32px 8px;">
                ${badgeHtml}
                ${heading ? `<h1 style="margin:0 0 14px; font-size:21px; line-height:1.3; color:${BRAND.text}; font-weight:800;">${heading}</h1>` : ""}
                <div style="font-size:15px; line-height:1.65; color:${BRAND.text};">
                  ${bodyHtml}
                </div>
                ${ctaHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px;">
                <div style="border-top:1px solid ${BRAND.border}; padding-top:20px;">
                  <p style="margin:0; font-size:12px; line-height:1.6; color:${BRAND.muted};">
                    You&rsquo;re receiving this email because of activity on your Foose account. If this wasn&rsquo;t you, you can safely ignore this message.
                  </p>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
};

const sendKycApprovedEmail = (user) => {
  const name = displayName(user);
  const safeName = escapeHtml(name);

  return sendEmail({
    to: user.email,
    subject: "Your Foose KYC has been approved",
    text: `Hi ${name},\n\nGood news. Your KYC submission has been approved and your Foose verification badge is now active.\n\nYou can now continue using verified seller features on Foose.`,
    html: renderEmailLayout({
      badge: { label: "Verified", tone: "success" },
      heading: "You&rsquo;re verified! 🎉",
      preheader: "Your Foose verification badge is now active.",
      bodyHtml: `
        <p>Hi ${safeName},</p>
        <p>Good news &mdash; your KYC submission has been approved and your Foose verification badge is now active.</p>
        <p>You can now continue using verified seller features on Foose.</p>
      `,
      cta: { label: "Go to your profile", url: clientPathUrl("/profile") },
    }),
  });
};

const sendKycRejectedEmail = (user, reason = "") => {
  const name = displayName(user);
  const safeName = escapeHtml(name);
  const cleanReason = String(reason || "").trim();
  const reasonText = cleanReason ? `\n\nReason: ${cleanReason}` : "";
  const reasonHtml = cleanReason
    ? `<div style="margin:8px 0 16px; padding:14px 16px; border-radius:12px; background-color:${BRAND.dangerBg}; border-left:3px solid ${BRAND.danger};">
        <p style="margin:0; font-size:14px; color:${BRAND.text};"><strong>Reason:</strong> ${escapeHtml(cleanReason)}</p>
      </div>`
    : "";

  return sendEmail({
    to: user.email,
    subject: "Your Foose KYC needs another look",
    text: `Hi ${name},\n\nYour KYC submission was rejected. Please review your details and resubmit when you're ready.${reasonText}\n\nGo to your account KYC page to update your submission.`,
    html: renderEmailLayout({
      badge: { label: "Needs attention", tone: "danger" },
      heading: "Let&rsquo;s fix your KYC submission",
      preheader: "Your KYC submission needs another look before it can be approved.",
      bodyHtml: `
        <p>Hi ${safeName},</p>
        <p>Your KYC submission was rejected. Please review your details and resubmit when you&rsquo;re ready.</p>
        ${reasonHtml}
        <p>Head to your account KYC page to update your submission.</p>
      `,
      cta: { label: "Update your submission", url: clientPathUrl("/kyc") },
    }),
  });
};

const sendPasswordResetEmail = (user, resetLink) => {
  const name = displayName(user);
  const safeName = escapeHtml(name);

  return sendEmail({
    to: user.email,
    subject: "Reset your Foose password",
    text: `Hi ${name},\n\nWe received a request to reset your Foose password. Use this secure link to choose a new password:\n\n${resetLink}\n\nThis link expires in 1 hour. If you didn't request a password change, ignore this email. Your password will not change unless this link is used to set a new one.`,
    html: renderEmailLayout({
      heading: "Reset your password",
      preheader: "Use this secure link to choose a new Foose password.",
      bodyHtml: `
        <p>Hi ${safeName},</p>
        <p>We received a request to reset your Foose password. Use the button below to choose a new one.</p>
        <p style="color:${BRAND.muted}; font-size:13px;">This link expires in 1 hour.</p>
        <p style="color:${BRAND.muted}; font-size:13px;">If you didn&rsquo;t request a password change, ignore this email &mdash; your password will not change unless this link is used.</p>
      `,
      cta: { label: "Choose a new password", url: resetLink },
    }),
  });
};

const sendDigiShopWelcomeEmail = (user, shop) => {
  const name = displayName(user);
  const safeName = escapeHtml(name);
  const safeShopName = escapeHtml(shop?.shopName || "Your DigiShop");
  const shopUrl = shop?.slug ? clientPathUrl(`/shops/${shop.slug}`) : clientPathUrl("/manage-shop");

  return sendEmail({
    to: user.email,
    subject: "Your DigiShop is live",
    text: `Hi ${name},\n\n${shop?.shopName || "Your DigiShop"} is now live on Foose. Buyers can find and shop it right away.\n\nManage it here: ${shopUrl}`,
    html: renderEmailLayout({
      badge: { label: "Live", tone: "success" },
      heading: `🎉 ${safeShopName} is live!`,
      preheader: `${shop?.shopName || "Your DigiShop"} is now live on Foose.`,
      bodyHtml: `
        <p>Hi ${safeName},</p>
        <p><strong>${safeShopName}</strong> is now live on Foose. Buyers can find and shop it right away.</p>
        <p>Add your first listings to start getting seen.</p>
      `,
      cta: { label: "Open your shop", url: shopUrl },
    }),
  });
};

const sendSellerOrderEmail = (seller, order, buyer) => {
  const buyerName = buyer?.name || buyer?.username || buyer?.email || "A buyer";
  const itemTitle = order?.items?.[0]?.title || "an item";
  const orderUrl = clientPathUrl(`/orders/${order._id}`);

  return sendEmail({
    to: seller.email,
    subject: "New Foose order needs your action",
    text: `Order ${order._id} for ${itemTitle} was placed by ${buyerName}. Please prepare it within 72 hours from your shop dashboard.`,
    html: renderEmailLayout({
      heading: "New order needs your action",
      preheader: `${buyerName} placed an order for ${itemTitle}.`,
      bodyHtml: `
        <p><strong>${escapeHtml(buyerName)}</strong> placed an order for <strong>${escapeHtml(itemTitle)}</strong>.</p>
        <p>Please prepare it within 72 hours from your shop dashboard.</p>
      `,
      cta: { label: "View order", url: orderUrl },
    }),
  });
};

const sendEmailChangeConfirmationEmail = (user, newEmail, confirmationLink) => {
  const name = displayName(user);
  const safeName = escapeHtml(name);

  return sendEmail({
    to: newEmail,
    subject: "Confirm your new Foose email address",
    text: `Hi ${name},\n\nUse this secure link to confirm this address as your new Foose account email:\n\n${confirmationLink}\n\nThis link expires in 30 minutes. If you didn't request this change, ignore this email and your account email will stay the same.`,
    html: renderEmailLayout({
      heading: "Confirm your new email",
      preheader: "Confirm this address to finish updating your Foose account email.",
      bodyHtml: `
        <p>Hi ${safeName},</p>
        <p>Use the button below to confirm this address as your new Foose account email.</p>
        <p style="color:${BRAND.muted}; font-size:13px;">This link expires in 30 minutes.</p>
        <p style="color:${BRAND.muted}; font-size:13px;">If you didn&rsquo;t request this change, ignore this email &mdash; your account email will stay the same.</p>
      `,
      cta: { label: "Confirm new email", url: confirmationLink },
    }),
  });
};

const sendOrderLifecycleEmail = ({ user, order, subject, message }) => {
  if (!user?.email) return Promise.resolve({ skipped: true });

  const clientUrlBase = String(process.env.CLIENT_URL || "").replace(/\/$/, "");
  const orderUrl = clientUrlBase ? `${clientUrlBase}/orders/${order._id}` : `/orders/${order._id}`;

  return sendEmail({
    to: user.email,
    subject,
    text: `${message}\n\nOpen order ${order._id}: ${orderUrl}`,
    html: renderEmailLayout({
      heading: escapeHtml(subject),
      preheader: message,
      bodyHtml: `<p>${escapeHtml(message)}</p>`,
      cta: { label: "View order", url: orderUrl },
    }),
  });
};

module.exports = {
  sendEmail,
  escapeHtml,
  renderEmailLayout,
  clientPathUrl,
  sendKycApprovedEmail,
  sendKycRejectedEmail,
  sendPasswordResetEmail,
  sendDigiShopWelcomeEmail,
  sendEmailChangeConfirmationEmail,
  sendOrderLifecycleEmail,
  sendSellerOrderEmail,
};
