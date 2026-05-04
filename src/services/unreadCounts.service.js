const chatService = require("./chat.service");
const socialService = require("./social.service");

async function getUnreadCounts(userId) {
  const uid = String(userId || "").trim();
  if (!uid) {
    return { unreadChats: 0, unreadNotifications: 0 };
  }
  const [unreadChats, unreadNotifications] = await Promise.all([
    chatService.sumUnreadMessages(uid),
    socialService.countPendingIncomingFriendRequests(uid),
  ]);
  return {
    unreadChats: Math.max(0, Number(unreadChats) || 0),
    unreadNotifications: Math.max(0, Number(unreadNotifications) || 0),
  };
}

module.exports = {
  getUnreadCounts,
};
