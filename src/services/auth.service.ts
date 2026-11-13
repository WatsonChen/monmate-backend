import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { userRepository } from "../repositories/user.repository.js";
import { hashIp } from "../lib/client-ip.js";
import { hit, rateLimited } from "./rate-limit.service.js";
import { createHash } from "node:crypto";

// 密碼登入防暴力破解：同一個 email、同一個來源 IP 各自在視窗內的嘗試次數上限（不分成功失敗，
// 正常使用者不會在 15 分鐘內登入超過 10 次）。IP 維度只在有設定可信 IP 標頭時才啟用。
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_MAX_PER_EMAIL = Number(process.env.LOGIN_MAX_PER_EMAIL) > 0 ? Number(process.env.LOGIN_MAX_PER_EMAIL) : 10;
const LOGIN_MAX_PER_IP = Number(process.env.LOGIN_MAX_PER_IP) > 0 ? Number(process.env.LOGIN_MAX_PER_IP) : 60;

// 帳號不存在、或是 Google 帳號（沒有密碼雜湊）時也跑一次 bcrypt，
// 讓回應時間不會洩漏「這個 email 有沒有帳號」。
const DUMMY_HASH = bcrypt.hashSync("monmate-dummy-password", 10);
const looksLikeBcrypt = (h: string | undefined) => !!h && /^\$2[aby]\$\d{2}\$/.test(h);

export const authService = {
  async assertLoginAllowed(email: string, ip: string | null) {
    const emailKey = createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
    if ((await hit(`login:email:${emailKey}`, LOGIN_WINDOW_SECONDS)) > LOGIN_MAX_PER_EMAIL) throw rateLimited();
    if (ip && (await hit(`login:ip:${hashIp(ip)}`, LOGIN_WINDOW_SECONDS)) > LOGIN_MAX_PER_IP) throw rateLimited();
  },

  async login(email: string, password: string, ip: string | null = null) {
    await this.assertLoginAllowed(email, ip);
    const user = await userRepository.findByEmail(email);

    const hash = looksLikeBcrypt(user?.passwordHash) ? user!.passwordHash : DUMMY_HASH;
    const passwordOk = await bcrypt.compare(password, hash);
    if (!user || !looksLikeBcrypt(user.passwordHash) || !passwordOk) {
      throw new AppError(401, "INVALID_CREDENTIALS", "帳號或密碼錯誤");
    }

    // 任何帳號都可能被指派為某些活動的工作人員（同時也是其他活動的主辦）
    const assignedEventIds = await prisma.eventStaffAssignment.findMany({
      where: { userId: user.id },
      select: { eventId: true },
      orderBy: { createdAt: "desc" }
    });
    const primaryAssignedEventId = user.assignedEventId ?? assignedEventIds[0]?.eventId ?? null;

    const signOptions: SignOptions = {
      subject: user.id,
      expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"]
    };

    const token = jwt.sign(
      { email: user.email, role: user.role, assignedEventId: primaryAssignedEventId, tv: user.tokenVersion },
      env.JWT_SECRET,
      signOptions
    );

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        attendeeCredits: user.attendeeCredits,
        assignedEventId: primaryAssignedEventId,
        assignedEventIds: assignedEventIds.map((assignment) => assignment.eventId)
      }
    };
  },

  async googleLogin(credential: string) {
    if (!env.GOOGLE_CLIENT_ID) {
      throw new AppError(503, "GOOGLE_AUTH_DISABLED", "Google 登入未啟用");
    }

    const client = new OAuth2Client(env.GOOGLE_CLIENT_ID);
    let googlePayload;

    try {
      const ticket = await client.verifyIdToken({
        idToken: credential,
        audience: env.GOOGLE_CLIENT_ID
      });
      googlePayload = ticket.getPayload();
    } catch {
      throw new AppError(401, "GOOGLE_TOKEN_INVALID", "Google 登入憑證無效");
    }

    if (!googlePayload?.email) {
      throw new AppError(400, "GOOGLE_EMAIL_MISSING", "Google 帳號無法取得 email");
    }
    // Email 必須是 Google 已驗證過的；否則別人可能用未驗證的 Email 冒用既有帳號（含工作人員帳號）
    if (googlePayload.email_verified !== true) {
      throw new AppError(401, "GOOGLE_EMAIL_UNVERIFIED", "此 Google 帳號的 Email 尚未驗證，無法登入");
    }

    let user = await userRepository.findByEmail(googlePayload.email);

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: googlePayload.email.trim().toLowerCase(),
          name: googlePayload.name ?? googlePayload.email.split("@")[0],
          passwordHash: "google-oauth"
        }
      });
    }

    const signOptions: SignOptions = {
      subject: user.id,
      expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"]
    };

    const token = jwt.sign(
      { email: user.email, role: user.role, tv: user.tokenVersion },
      env.JWT_SECRET,
      signOptions
    );

    return {
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        attendeeCredits: user.attendeeCredits
      }
    };
  },

  // 登出所有裝置：憑證版本 +1，所有已發出的 JWT（含被偷走的）立刻失效，需要重新登入
  async logoutAll(userId: string) {
    await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
    return { loggedOut: true };
  },

  async me(userId: string) {
    const user = await userRepository.findById(userId);

    if (!user) {
      throw new AppError(404, "USER_NOT_FOUND", "找不到使用者");
    }

    // 任何帳號都可能被指派為某些活動的工作人員（同時也是其他活動的主辦）
    const assignedEventIds = await prisma.eventStaffAssignment.findMany({
      where: { userId: user.id },
      select: { eventId: true },
      orderBy: { createdAt: "desc" }
    });
    const primaryAssignedEventId = user.assignedEventId ?? assignedEventIds[0]?.eventId ?? null;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      attendeeCredits: user.attendeeCredits,
      assignedEventId: primaryAssignedEventId,
      assignedEventIds: assignedEventIds.map((assignment) => assignment.eventId)
    };
  }
};
