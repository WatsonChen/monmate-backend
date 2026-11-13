import { put } from "@vercel/blob";
import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../lib/async-handler.js";
import { AppError, ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";

export const uploadRouter = Router();

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }
});

// 瀏覽器宣告的 Content-Type 可以造假，改看檔案開頭的簽章判斷實際格式
function detectImageType(buf: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

uploadRouter.use(requireAuth);

uploadRouter.post(
  "/image",
  upload.single("file") as never,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, "FILE_REQUIRED", "請選擇圖片檔案");
    if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
      throw new AppError(400, "INVALID_FILE_TYPE", "僅支援 PNG、JPG、WebP 格式");
    }

    const detected = detectImageType(req.file.buffer);
    if (!detected || detected !== req.file.mimetype) {
      throw new AppError(400, "INVALID_FILE_TYPE", "檔案內容不是有效的 PNG、JPG、WebP 圖片");
    }

    const ext = detected.split("/")[1];
    const pathname = `event-logos/${req.user!.id}-${Date.now()}.${ext}`;

    const blob = await put(pathname, req.file.buffer, {
      access: "public",
      contentType: detected
    });

    return ok(res, { url: blob.url });
  })
);
