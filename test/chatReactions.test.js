const test = require("node:test");
const assert = require("node:assert/strict");
const Message = require("../src/models/Message");
const chatController = require("../src/controllers/chatController");
const socketConfig = require("../src/config/socket");
const { chatUserRoom } = require("../src/socket/rooms");

const invoke = (controller, req) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      resolve({ payload, statusCode: this.statusCode });
    },
  };
  controller(req, res, reject);
});

test("message reactions retain unread state for the other participant", () => {
  const reactionSchema = Message.schema.path("reactions").schema;
  assert.equal(reactionSchema.path("isRead").options.default, false);
});

test("selecting the same reaction again removes it", async () => {
  const originalFindOne = Message.findOne;
  const originalGetIO = socketConfig.getIO;
  const actorId = "actor";
  let emitted;
  const message = {
    conversationId: "actor_other_general",
    reactions: [{ isRead: false, reaction: "heart", userId: { toString: () => actorId } }],
    receiverId: { _id: "other" },
    senderId: { _id: actorId },
    populate: async () => undefined,
    save: async () => undefined,
  };
  Message.findOne = async () => message;
  socketConfig.getIO = () => ({
    to(rooms) {
      return {
        emit(event, payload) {
          emitted = { event, payload, rooms };
        },
      };
    },
  });

  try {
    const result = await invoke(chatController.reactToMessage, {
      body: { reaction: "heart" },
      params: { messageId: "message" },
      user: { id: actorId },
    });

    assert.equal(message.reactions.length, 0);
    assert.equal(result.payload.data.removed, true);
    assert.equal(result.payload.message, "Reaction removed");
    assert.equal(emitted.event, "message-reaction-updated");
    assert.deepEqual(emitted.rooms, [
      chatUserRoom(actorId),
      chatUserRoom("other"),
      "actor_other_general",
    ]);
    assert.equal(emitted.payload.removed, true);
  } finally {
    Message.findOne = originalFindOne;
    socketConfig.getIO = originalGetIO;
  }
});

test("marking reactions read only targets unread reactions from the other participant", async () => {
  const originalUpdateMany = Message.updateMany;
  let receivedUpdate;
  Message.updateMany = async (...args) => {
    receivedUpdate = args;
    return { modifiedCount: 1 };
  };

  try {
    await invoke(chatController.markReactionsRead, {
      params: { conversationId: "507f1f77bcf86cd799439011_507f191e810c19729de860ea_general" },
      user: { id: "507f1f77bcf86cd799439011" },
    });

    assert.deepEqual(receivedUpdate[1], { $set: { "reactions.$[reaction].isRead": true } });
    assert.equal(receivedUpdate[2].arrayFilters[0]["reaction.isRead"], false);
    assert.ok(receivedUpdate[2].arrayFilters[0]["reaction.userId"].$ne);
  } finally {
    Message.updateMany = originalUpdateMany;
  }
});
