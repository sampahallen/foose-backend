const { createNotification } = require("./notificationService");

const idOf = (value) => String(value?._id || value || "");

const actorLabel = (actor) => {
  const username = String(actor?.username || "").trim();
  if (username) return `@${username}`;
  return String(actor?.name || "A Foose member").trim() || "A Foose member";
};

const excerpt = (value, maxLength = 90) => {
  const normalized = String(value || "").trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
};

const commentLink = (postId, commentId) =>
  `/community/finspo/${encodeURIComponent(idOf(postId))}?comments=1&comment=${encodeURIComponent(idOf(commentId))}`;

const postLink = (postId) => `/community/finspo/${encodeURIComponent(idOf(postId))}`;

const createFinspoActivityNotification = async ({
  actor,
  actorId,
  body,
  eventKey,
  link,
  recipientId,
  title,
}) => {
  const recipient = idOf(recipientId);
  const actingUser = idOf(actorId || actor);
  if (!recipient || !actingUser || recipient === actingUser) return null;

  try {
    return await createNotification({
      body,
      eventKey,
      link,
      title,
      type: "system",
      userId: recipient,
    });
  } catch (error) {
    console.warn(`Finspo notification failed: ${error.message}`);
    return null;
  }
};

const notifyFinspoPostLike = ({ actor, postId, recipientId }) =>
  createFinspoActivityNotification({
    actor,
    body: `${actorLabel(actor)} liked your Finspo.`,
    eventKey: `finspo:post:${idOf(postId)}:like:${idOf(actor)}`,
    link: postLink(postId),
    recipientId,
    title: "New Finspo like",
  });

const notifyFinspoComment = ({ actor, comment, postId, recipientId }) =>
  createFinspoActivityNotification({
    actor,
    body: `${actorLabel(actor)} commented: "${excerpt(comment?.body)}"`,
    eventKey: `finspo:comment:${idOf(comment)}:created`,
    link: commentLink(postId, comment),
    recipientId,
    title: "New Finspo comment",
  });

const notifyFinspoReply = ({ actor, postId, recipientId, reply }) =>
  createFinspoActivityNotification({
    actor,
    body: `${actorLabel(actor)} replied: "${excerpt(reply?.body)}"`,
    eventKey: `finspo:reply:${idOf(reply)}:created`,
    link: commentLink(postId, reply),
    recipientId,
    title: "New reply",
  });

const notifyFinspoCommentLike = ({ actor, comment, postId, recipientId }) => {
  const isReply = Boolean(comment?.rootCommentId);
  return createFinspoActivityNotification({
    actor,
    body: `${actorLabel(actor)} liked your ${isReply ? "reply" : "comment"}.`,
    eventKey: `finspo:comment:${idOf(comment)}:like:${idOf(actor)}`,
    link: commentLink(postId, comment),
    recipientId,
    title: `${isReply ? "Reply" : "Comment"} liked`,
  });
};

module.exports = {
  actorLabel,
  commentLink,
  createFinspoActivityNotification,
  excerpt,
  notifyFinspoComment,
  notifyFinspoCommentLike,
  notifyFinspoPostLike,
  notifyFinspoReply,
};
