import type { UserRole } from "@monmate/types";

declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      role: UserRole;
      assignedEventId?: string | null;
    }

    interface Request {
      user?: User;
      // 這個請求對該活動的身分：由活動關係決定（建立者／被指派的工作人員），與帳號角色無關
      eventAccess?: "OWNER" | "STAFF";
    }
  }
}

export {};
