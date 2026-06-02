import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { z } from "zod";

const configDir = dirname(fileURLToPath(import.meta.url));

config({ path: resolve(configDir, "../../.env") });
config({ path: resolve(configDir, "../../../../.env"), override: false });

const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  API_PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default("7d"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  WEB_APP_URL: z.string().url().default("http://localhost:3000"),
  API_BASE_URL: z
    .string()
    .url()
    .default(process.env.BACKEND_URL ?? "http://localhost:4000"),
  NEWEBPAY_ENV: z.enum(["test", "production"]).default("production"),
  NEWEBPAY_MERCHANT_ID: optionalSecret,
  NEWEBPAY_HASH_KEY: optionalSecret,
  NEWEBPAY_HASH_IV: optionalSecret,
  NEWEBPAY_API_URL: z
    .string()
    .url()
    .default("https://core.newebpay.com/MPG/mpg_gateway"),
  NEWEBPAY_VERSION: z.string().default("2.2")
});

export const env = envSchema.parse(process.env);

export const corsOrigins = env.CORS_ORIGIN.split(",").map((origin) =>
  origin.trim()
);
