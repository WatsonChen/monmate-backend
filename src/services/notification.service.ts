export const notificationService = {
  async sendPreEvent(eventId: string) {
    return {
      eventId,
      provider: "mock",
      queued: true,
      message: "已建立通知任務。MVP 目前保留 email / SMS / LINE 擴充介面。"
    };
  }
};
