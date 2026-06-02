export type ApiError = {
  code: string;
  message: string;
};

export type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: ApiError;
};

export type UserRole = "OWNER" | "ADMIN" | "STAFF";
export type CheckInStatus = "NOT_CHECKED_IN" | "CHECKED_IN";
export type CheckInMethod = "QR_CODE" | "MANUAL_CODE";
export type CheckInLogStatus =
  | "SUCCESS"
  | "ALREADY_CHECKED_IN"
  | "NOT_FOUND"
  | "INVALID";
export type PaymentStatus =
  | "PENDING"
  | "PAID"
  | "EXPIRED"
  | "CANCELED"
  | "FAILED"
  | "REFUNDED";
export type PaymentProduct = "EVENT_CREDIT";

export type UserDTO = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  eventCredits: number;
};

export type EventDTO = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  startAt: string;
  endAt?: string | null;
  location?: string | null;
  attendeeLimit?: number | null;
  attendeeCount?: number;
  checkInLogCount?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type AttendeeDTO = {
  id: string;
  eventId: string;
  name: string;
  phone: string;
  checkInCode: string;
  qrToken: string;
  checkInStatus: CheckInStatus;
  checkedInAt?: string | null;
};

export type CheckInResultDTO = {
  status: CheckInLogStatus;
  attendee?: Pick<
    AttendeeDTO,
    "id" | "name" | "phone" | "checkInStatus" | "checkedInAt"
  > & {
    phoneLastThree: string;
  };
  checkedInAt?: string;
};

export type PaymentDTO = {
  id: string;
  status: PaymentStatus;
  product: PaymentProduct;
  quantity: number;
  creditsGranted: number;
  amountTotal?: number | null;
  currency?: string | null;
  pricingTier?: string | null;
  attendeeLimit?: number | null;
  providerOrderNo?: string | null;
  providerTradeNo?: string | null;
  consumedAt?: string | null;
  paidAt?: string | null;
  createdAt: string;
};

export type BillingStatusDTO = {
  eventCredits: number;
  recentPayments: PaymentDTO[];
};

export type CheckoutSessionDTO = {
  paymentId: string;
  action: string;
  method: "POST";
  fields: Record<string, string>;
};

export type PricingTierDTO = {
  id: string;
  label: string;
  attendeeRange: string;
  attendeeLimit: number;
  amount: number;
  currency: "TWD";
};
