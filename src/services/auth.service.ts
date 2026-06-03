import bcrypt from "bcryptjs";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { userRepository } from "../repositories/user.repository.js";

export const authService = {
  async login(email: string, password: string) {
    const user = await userRepository.findByEmail(email);

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new AppError(401, "INVALID_CREDENTIALS", "帳號或密碼錯誤");
    }

    const signOptions: SignOptions = {
      subject: user.id,
      expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"]
    };

    const token = jwt.sign(
      { email: user.email, role: user.role },
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

    let user = await userRepository.findByEmail(googlePayload.email);

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: googlePayload.email,
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
      { email: user.email, role: user.role },
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

  async me(userId: string) {
    const user = await userRepository.findById(userId);

    if (!user) {
      throw new AppError(404, "USER_NOT_FOUND", "找不到使用者");
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      attendeeCredits: user.attendeeCredits
    };
  }
};
