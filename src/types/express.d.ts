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
    }
  }
}

export {};
