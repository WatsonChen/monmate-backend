import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { env } from "../config/env";
import { AppError } from "../lib/http";
import { userRepository } from "../repositories/user.repository";

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
        eventCredits: user.eventCredits
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
      eventCredits: user.eventCredits
    };
  }
};
