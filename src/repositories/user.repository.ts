import { prisma } from "../lib/prisma.js";

export const userRepository = {
  // Email 不分大小寫：主辦方輸入 Staff@Gmail.com、本人用 Google 登入回傳 staff@gmail.com，必須是同一個帳號
  findByEmail(email: string) {
    return prisma.user.findFirst({ where: { email: { equals: email.trim(), mode: "insensitive" } } });
  },

  findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  }
};
